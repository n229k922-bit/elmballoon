import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import vm from 'node:vm';
import { managerApi, managerConsole } from '../workers/admin-line-secretary/src/manager-console.js';
import { buildBundle } from './build-order-knowledge.mjs';
import { createManagerLoginLink, managerSessionEndpoint, authorizeManagerRequest } from '../workers/admin-line-secretary/src/manager-auth.js';
import { managerPwaAsset } from '../workers/admin-line-secretary/src/manager-pwa.js';
import { receiveManagerEvents, drainManagerInbox, flushManagerOutbox, handleManagerCommand,
  monitorManagerTasks, businessDeadline, loadCustomerHistory, eventTime } from '../workers/admin-line-secretary/src/manager-runtime.js';

const root = new URL('../workers/admin-line-secretary/migrations/', import.meta.url);
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of fs.readdirSync(root).filter(f => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(file, root), 'utf8'));
  class Statement {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...args) { this.args = args; return this; }
    async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
    async first() { return db.prepare(this.sql).get(...this.args) || null; }
    async run() { const result = db.prepare(this.sql).run(...this.args); return { meta: { changes: result.changes } }; }
  }
  const env = { ORDER_ENGINE: 'v2', ADMIN_LINE_USER_IDS: 'OWNER', LINE_CHANNEL_ACCESS_TOKEN: 'owner-test', CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN: 'customer-test',
    DB: { prepare: sql => new Statement(sql), async batch(statements) {
      db.exec('BEGIN'); try { const result = []; for (const s of statements) result.push(await s.run()); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } } };
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const now = '2026-09-30T01:00:00.000Z';
  const later = '2026-09-30T01:01:00.000Z';
  const event = (text, eventId = 'E1', userId = 'CUSTOMER') => ({type:'message', webhookEventId:eventId, timestamp:Date.parse(now), source:{userId}, message:{type:'text',id:eventId,text}});
  async function receive(text, eventId='E1', userId='CUSTOMER') { await receiveManagerEvents([event(text,eventId,userId)], env, now); await drainManagerInbox(env,later); }
  return { db,env,get,all,now,later,event,receive };
}

test('all migrations apply and ordinary natural messages create persistent cards and reviewed replies', async () => {
  const f=fixture(); await f.receive('10月10日に卒業のブーケを3つ。合計3000円で店頭受取をお願いします');
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_orders').n,1);
  assert.equal(f.get("SELECT value_text FROM manager_fields WHERE field_key='quantity'").value_text,'3');
  const draft=f.get('SELECT * FROM manager_drafts');
  assert.equal(draft.status,'pending');
  assert.ok(f.all('SELECT * FROM manager_questions').length<=2);
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,0);
  const command=await handleManagerCommand(`承認送信 ${draft.id}`,'OWNER',f.env,f.later);
  assert.match(command,/送信待ち/);
  const requests=[];
  await flushManagerOutbox(f.env,f.later,async (url,init)=>{requests.push(JSON.parse(init.body)); return new Response('{}',{status:200});});
  assert.equal(requests.filter(r=>r.to==='CUSTOMER').length,1);
  assert.equal(f.get('SELECT status FROM manager_drafts').status,'sent');
  assert.ok(f.all('SELECT * FROM manager_questions').every(q=>q.sent_at));
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_events WHERE direction='assistant'").n,1);
});

test('duplicate events do not duplicate cards and processing failures leave a recoverable inbox', async () => {
  const f=fixture(); await receiveManagerEvents([f.event('ブーケ希望'),f.event('ブーケ希望')],f.env,f.now);
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_events').n,1);
  f.db.exec("CREATE TRIGGER fail_draft BEFORE INSERT ON manager_drafts BEGIN SELECT RAISE(ABORT,'test failure'); END");
  await assert.rejects(drainManagerInbox(f.env,f.later));
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_orders').n,0);
  assert.equal(f.get('SELECT processed_at FROM manager_events').processed_at,null);
  f.db.exec('DROP TRIGGER fail_draft');
  await drainManagerInbox(f.env,f.later);
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_drafts').n,1);
  await f.receive('ブーケ希望');
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_drafts').n,1);
});

test('consecutive messages are bundled and images remain explicitly unverified', async () => {
  const f=fixture(); const image=f.event('', 'IMG'); image.message={type:'image',id:'image-content'};
  await receiveManagerEvents([f.event('ブーケ3つ'),f.event('予算3000円','E2'),image],f.env,f.now);
  await drainManagerInbox(f.env,f.now);
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_drafts').n,0);
  await drainManagerInbox(f.env,f.later);
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_drafts').n,1);
  assert.equal(f.get("SELECT media_message_id FROM manager_events WHERE id='IMG'").media_message_id,'image-content');
  assert.match(f.get('SELECT reasons_json FROM manager_drafts').reasons_json,/未判読/);
});

test('parallel orders do not overwrite each other and arbitrary customer IDs cannot be routed', async () => {
  const f=fixture(); await f.receive('ブーケ希望'); await f.receive('別の注文：スタンド希望','E2');
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_orders').n,2);
  await f.receive('赤にしたいです','E3');
  assert.equal(f.get("SELECT order_id FROM manager_events WHERE id='E3'").order_id,null);
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_fields WHERE field_key='color_vibe'").n,0);
  await f.receive('ブーケ希望','E4','OTHER');
  const other=f.get("SELECT id FROM manager_orders WHERE customer_id='OTHER'");
  assert.match(await handleManagerCommand(`振分 E3 ${other.id}`,'OWNER',f.env,f.later),/同じお客様/);
});

test('new customer evidence invalidates an old approved but not yet sent reply', async () => {
  const f=fixture(); await f.receive('ブーケ希望'); const draft=f.get('SELECT * FROM manager_drafts');
  await handleManagerCommand(`承認送信 ${draft.id}`,'OWNER',f.env,f.later);
  await f.receive('やっぱりスタンド希望','E2');
  const sent=[]; await flushManagerOutbox(f.env,f.later,async (_,init)=>{sent.push(JSON.parse(init.body));return new Response('{}');});
  assert.equal(sent.filter(x=>x.to==='CUSTOMER').length,0);
  assert.equal(f.get('SELECT status FROM manager_outbox WHERE draft_id=?',draft.id).status,'cancelled');
});

test('confirmed changes require explicit review, and production is blocked while pending', async () => {
  const f=fixture(); await f.receive('予算3000円でブーケ希望');
  const order=f.get('SELECT * FROM manager_orders');
  f.db.exec("UPDATE manager_fields SET status='confirmed',confirmed_at='2026-09-30T00:00:00Z' WHERE field_key='budget'");
  await f.receive('予算5000円に変更','E2');
  const change=f.get('SELECT * FROM manager_changes'); assert.ok(change);
  assert.match(f.get("SELECT value_text FROM manager_fields WHERE field_key='budget'").value_text,/3,000/);
  assert.match(await handleManagerCommand(`制作開始 ${order.id}`,'OWNER',f.env,f.later),/変更判断待ち/);
  await handleManagerCommand(`変更承認 ${change.id}`,'OWNER',f.env,f.later);
  assert.match(f.get("SELECT value_text FROM manager_fields WHERE field_key='budget'").value_text,/5,000/);
});

test('retry uses an identical key/payload and accepted 409 closes the outbox once', async () => {
  const f=fixture(); await f.receive('ブーケ希望'); const draft=f.get('SELECT * FROM manager_drafts');
  await handleManagerCommand(`承認送信 ${draft.id}`,'OWNER',f.env,f.later);
  const calls=[]; await flushManagerOutbox(f.env,f.later,async (_,init)=>{calls.push(init);throw new Error('timeout');});
  await flushManagerOutbox(f.env,'2026-09-30T01:03:00.000Z',async (_,init)=>{const old=calls.find(x=>x.body===init.body);assert.equal(old.headers['X-Line-Retry-Key'],init.headers['X-Line-Retry-Key']);return new Response('{}',{status:409,headers:{'x-line-accepted-request-id':'accepted'}});});
  assert.equal(f.get('SELECT status FROM manager_drafts').status,'sent');
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_events WHERE direction='assistant'").n,1);
});

test('expired retry keys stop instead of producing a duplicate a day later', async () => {
  const f=fixture(); await f.receive('ブーケ希望');
  f.db.exec("UPDATE manager_outbox SET first_attempt_at='2026-09-28T00:00:00Z'");
  let called=false; await flushManagerOutbox(f.env,f.later,async()=>{called=true;return new Response('{}');});
  assert.equal(called,false); assert.equal(f.get('SELECT status FROM manager_outbox').status,'uncertain');
});

test('business-hour deadlines skip explicit closures and monitor is internally deduplicated', async () => {
  assert.equal(businessDeadline('2026-09-30T06:00:00.000Z',false,[{date:'2026-10-01',status:'closed'}],2),'2026-10-02T02:00:00.000Z');
  const f=fixture();await f.receive('明日ブーケ希望');
  await monitorManagerTasks(f.env,'2026-09-30T03:00:00.000Z');
  const count=f.get('SELECT COUNT(*) n FROM manager_outbox').n;
  await monitorManagerTasks(f.env,'2026-09-30T03:01:00.000Z');
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_outbox').n,count);
});

test('history is scoped to explicitly verified customer links, not names', async()=>{
  const f=fixture();f.db.prepare(`INSERT INTO manager_imports(id,source_hash,source_file,source_heading,source_line,raw_text,review_status,linked_customer_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run('import1','hash','file','same name',1,'private','needs_review','CUSTOMER',f.now);
  assert.equal((await loadCustomerHistory('CUSTOMER',f.env)).imported.length,0);
  f.db.exec("UPDATE manager_imports SET review_status='verified'");
  assert.equal((await loadCustomerHistory('OTHER',f.env)).imported.length,0);
  assert.equal((await loadCustomerHistory('CUSTOMER',f.env)).imported.length,1);
});

test('payment, fulfillment and collection remain independent; thanks does not close an order',async()=>{
  const f=fixture();await f.receive('ありがとうございます');const order=f.get('SELECT * FROM manager_orders');
  assert.equal(order.status,'open');
  assert.match(await handleManagerCommand(`案件終了 ${order.id}`,'OWNER',f.env,f.later),/揃っていません/);
  await handleManagerCommand(`受渡完了 ${order.id}`,'OWNER',f.env,f.later);
  assert.equal(f.get('SELECT payment_status FROM manager_orders').payment_status,'unconfirmed');
  await handleManagerCommand(`支払完了 ${order.id}`,'OWNER',f.env,f.later);
  await handleManagerCommand(`回収必要 ${order.id}`,'OWNER',f.env,f.later);
  assert.match(await handleManagerCommand(`案件終了 ${order.id}`,'OWNER',f.env,f.later),/揃っていません/);
  await handleManagerCommand(`回収完了 ${order.id}`,'OWNER',f.env,f.later);
  const pendingDraft=f.get('SELECT id FROM manager_drafts');
  await handleManagerCommand(`返信取消 ${pendingDraft.id}`,'OWNER',f.env,f.later);
  await handleManagerCommand(`案件終了 ${order.id}`,'OWNER',f.env,f.later);
  assert.equal(f.get('SELECT status FROM manager_orders').status,'closed');
});

test('original timestamp is preserved and unauthorized owner command is ignored',async()=>{
  const f=fixture();assert.equal(eventTime(f.event('明日'),f.later),f.now);
  assert.equal(await handleManagerCommand('案件一覧','OTHER',f.env,f.later),null);
});

test('authenticated console import is review-only, idempotent and verifies source hashes',async()=>{
  const f=fixture();f.env.ADMIN_API_TOKEN='local-test';
  const request=(path,body,token='local-test')=>new Request('https://test.example/api/manager/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined});
  assert.equal((await managerApi(request('orders',null,'wrong'),f.env)).status,401);
  const bundle=buildBundle('### A-01 Example\n電話：000-0000-0000\n','# Knowledge');
  bundle.records[0].review_status='verified';bundle.records[0].linked_customer_id='CUSTOMER';
  assert.equal((await managerApi(request('import',bundle),f.env)).status,200);
  assert.equal((await managerApi(request('import',bundle),f.env)).status,200);
  const imported=f.get('SELECT * FROM manager_imports');
  assert.equal(imported.review_status,'needs_review');assert.equal(imported.linked_customer_id,null);
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_imports').n,1);
  bundle.records[0].raw_text+='tamper';assert.equal((await managerApi(request('import',bundle),f.env)).status,400);
  await f.receive('ブーケ希望');const order=f.get('SELECT id FROM manager_orders');
  await handleManagerCommand(`履歴紐付 ${order.id} ${imported.id}`,'OWNER',f.env,f.later);
  assert.equal((await loadCustomerHistory('CUSTOMER',f.env)).imported.length,0);
  await handleManagerCommand(`履歴承認 ${order.id} ${imported.id}`,'OWNER',f.env,f.later);
  assert.equal((await loadCustomerHistory('CUSTOMER',f.env)).imported.length,1);
});

test('routing an ambiguous message preserves old drafts and reprocesses only the selected customer',async()=>{
  const f=fixture();await f.receive('ブーケ希望');await f.receive('別の注文：スタンド','E2');await f.receive('赤でお願いします','E3');
  const order=f.get('SELECT id FROM manager_orders ORDER BY created_at,rowid LIMIT 1');
  assert.match(await handleManagerCommand(`振分 E3 ${order.id}`,'OWNER',f.env,f.later),/再整理待ち/);
  await drainManagerInbox(f.env,f.later);
  assert.equal(f.get("SELECT value_text FROM manager_fields WHERE order_id=? AND field_key='color_vibe'",order.id).value_text,'赤');
});

test('unprocessed incoming messages prevent sending an obsolete approval',async()=>{
  const f=fixture();await f.receive('ブーケ');const draft=f.get('SELECT id FROM manager_drafts');
  await handleManagerCommand(`承認送信 ${draft.id}`,'OWNER',f.env,f.later);
  await receiveManagerEvents([f.event('変更があります','E2')],f.env,f.later);
  let customerCalls=0;await flushManagerOutbox(f.env,f.later,async(_,init)=>{if(JSON.parse(init.body).to==='CUSTOMER')customerCalls++;return new Response('{}');});
  assert.equal(customerCalls,0);assert.equal(f.get('SELECT status FROM manager_outbox WHERE draft_id=?',draft.id).status,'pending');
});

test('explicit order switches in one customer burst never mix their fields',async()=>{
  const f=fixture();await f.receive('ブーケ希望');await f.receive('別の注文：スタンド希望','E2');
  const orders=f.all('SELECT id FROM manager_orders ORDER BY created_at,rowid');
  await receiveManagerEvents([f.event(`${orders[0].id} 予算3000円`,'E3'),f.event('数量2個','E4'),f.event(`${orders[1].id} 予算9000円`,'E5'),f.event('数量5個','E6')],f.env,f.now);
  await drainManagerInbox(f.env,f.later);
  for(const [index,quantity,budget] of [[0,'2','3,000'],[1,'5','9,000']]){
    assert.equal(f.get("SELECT value_text FROM manager_fields WHERE order_id=? AND field_key='quantity'",orders[index].id).value_text,quantity);
    assert.match(f.get("SELECT value_text FROM manager_fields WHERE order_id=? AND field_key='budget'",orders[index].id).value_text,new RegExp(budget));
  }
  assert.equal(f.get("SELECT order_id FROM manager_events WHERE id='E4'").order_id,orders[0].id);
  assert.equal(f.get("SELECT order_id FROM manager_events WHERE id='E6'").order_id,orders[1].id);
  await receiveManagerEvents([f.event(`${orders[0].id} と ${orders[1].id} の色を赤に`,'E7')],f.env,f.now);
  await drainManagerInbox(f.env,f.later);
  assert.equal(f.get("SELECT order_id FROM manager_events WHERE id='E7'").order_id,null);
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_fields WHERE field_key='color_vibe'").n,0);
});

test('completion cannot bypass production confirmation or restart completed production',async()=>{
  const f=fixture();await f.receive('ブーケ');const order=f.get('SELECT id FROM manager_orders');
  assert.match(await handleManagerCommand(`完成 ${order.id}`,'OWNER',f.env,f.later),/制作開始/);
  assert.equal(f.get('SELECT production_status FROM manager_orders').production_status,'consulting');
  f.db.exec("UPDATE manager_orders SET production_status='ready'");
  assert.match(await handleManagerCommand(`制作開始 ${order.id}`,'OWNER',f.env,f.later),/完成済み/);
  assert.equal(f.get('SELECT production_status FROM manager_orders').production_status,'ready');
});

test('production requires individually confirmed facts and generates a tracked production task',async()=>{
  const f=fixture();await f.receive('ブーケ');const order=f.get('SELECT id FROM manager_orders');
  assert.match(await handleManagerCommand(`制作開始 ${order.id}`,'OWNER',f.env,f.later),/店長確認が必要/);
  for(const [key,value] of Object.entries({product_type:'ブーケ',quantity:'3',budget:'3000円',receive_date:'2026-10-10',fulfillment_method:'店頭受取'})) {
    assert.match(await handleManagerCommand(`項目確定 ${order.id} ${key}：${value}`,'OWNER',f.env,f.later),/保存しました/);
  }
  await handleManagerCommand(`制作開始 ${order.id}`,'OWNER',f.env,f.later);
  assert.equal(f.get('SELECT production_status FROM manager_orders').production_status,'production');
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_tasks WHERE kind='production' AND status='open'").n,1);
  await handleManagerCommand(`完成 ${order.id}`,'OWNER',f.env,f.later);
  assert.equal(f.get("SELECT status FROM manager_tasks WHERE kind='production'").status,'done');
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_tasks WHERE kind='handoff'").n,1);
});

test('console inline code compiles and does not expose a key or render user HTML',async()=>{
  const response=managerConsole(),html=await response.text();
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
  const source=html.match(/<script>([\s\S]+)<\/script>/)[1];
  assert.doesNotThrow(()=>new vm.Script(source));
  assert.doesNotMatch(source,/innerHTML|localStorage/);
});

test('today overview and search include stored customer fields and reject SQL-like search tricks',async()=>{
  const f=fixture();f.env.ADMIN_API_TOKEN='test';await f.receive('ブーケ');const order=f.get('SELECT id FROM manager_orders');
  const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  await handleManagerCommand(`項目確定 ${order.id} customer_name：検索用サンプル`,'OWNER',f.env,f.later);
  await handleManagerCommand(`項目確定 ${order.id} receive_date：${today}`,'OWNER',f.env,f.later);
  const request=q=>new Request('https://shop.example/api/manager/orders?q='+encodeURIComponent(q),{headers:{Authorization:'Bearer test'}});
  const found=await (await managerApi(request('検索用'),f.env)).json();assert.equal(found.orders.length,1);assert.equal(found.today.handoffs.length,1);
  assert.equal((await (await managerApi(request("' OR 1=1 --"),f.env)).json()).orders.length,0);
  assert.equal((await (await managerApi(request('存在しない'),f.env)).json()).today.handoffs.length,1);
});

test('manual cards cannot approve or transmit a customer LINE reply',async()=>{
  const f=fixture();await f.receive('ブーケ','MANUAL','manual:sample');const draft=f.get('SELECT id FROM manager_drafts');
  assert.match(await handleManagerCommand(`承認送信 ${draft.id}`,'OWNER',f.env,f.later),/接続していません/);
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,0);
  f.db.prepare("INSERT INTO manager_outbox(id,recipient,channel,text,retry_key,next_attempt_at,created_at) VALUES ('MAL','manual:sample','customer','test','retry',?,?)").run(f.now,f.now);
  await flushManagerOutbox(f.env,f.later,()=>{throw new Error('must not send')});
  assert.equal(f.get("SELECT status FROM manager_outbox WHERE id='MAL'").status,'cancelled');
});

test('mobile login links are owner-only, single-use and create a private cookie session',async()=>{
  const f=fixture();f.env.MANAGER_APP_ORIGIN='https://shop.example';
  assert.equal(await createManagerLoginLink('CUSTOMER',f.env,f.now),null);
  const link=await createManagerLoginLink('OWNER',f.env,f.now);
  const token=new URLSearchParams(new URL(link).hash.slice(1)).get('login');
  assert.ok(token);assert.notEqual(f.get('SELECT token_hash FROM manager_login_links').token_hash,token);
  const req=(origin='https://shop.example')=>new Request('https://shop.example/api/manager/session',{method:'POST',headers:{Origin:origin,'X-Manager-Request':'1'},body:JSON.stringify({token})});
  assert.equal((await managerSessionEndpoint(req('https://other.example'),f.env,f.later)).status,403);
  const response=await managerSessionEndpoint(req(),f.env,f.later);
  assert.equal(response.status,200);
  const setCookie=response.headers.get('Set-Cookie');assert.match(setCookie,/Secure; HttpOnly; SameSite=Strict/);
  assert.equal((await managerSessionEndpoint(req(),f.env,f.later)).status,401);
  const cookie=setCookie.split(';')[0];
  const authenticated=await authorizeManagerRequest(new Request('https://shop.example/api/manager/orders',{headers:{Cookie:cookie}}),f.env,f.later);
  assert.equal(authenticated.actor,'OWNER');
  const badMutation=await authorizeManagerRequest(new Request('https://shop.example/api/manager/command',{method:'POST',headers:{Cookie:cookie,Origin:'https://other.example','X-Manager-Request':'1'}}),f.env,f.later);
  assert.equal(badMutation.denied.status,403);
  await managerSessionEndpoint(new Request('https://shop.example/api/manager/logout',{method:'POST',headers:{Cookie:cookie,Origin:'https://shop.example','X-Manager-Request':'1'}}),f.env,f.later);
  assert.equal((await authorizeManagerRequest(new Request('https://shop.example/api/manager/orders',{headers:{Cookie:cookie}}),f.env,f.later)).denied.status,401);
});

test('mobile link expiry and admin revocation stop access; offline cache excludes customer data',async()=>{
  const f=fixture();f.env.MANAGER_APP_ORIGIN='https://shop.example';
  const link=await createManagerLoginLink('OWNER',f.env,f.now),token=new URLSearchParams(new URL(link).hash.slice(1)).get('login');
  const request=()=>new Request('https://shop.example/api/manager/session',{method:'POST',headers:{Origin:'https://shop.example','X-Manager-Request':'1'},body:JSON.stringify({token})});
  assert.equal((await managerSessionEndpoint(request(),f.env,'2026-09-30T02:00:00Z')).status,401);
  f.env.ADMIN_LINE_USER_IDS='';assert.equal((await managerSessionEndpoint(request(),f.env,f.later)).status,401);
  const manifest=await managerPwaAsset('/manager.webmanifest').json();assert.equal(manifest.display,'standalone');
  const sw=await managerPwaAsset('/manager-sw.js').text();assert.match(sw,/url.pathname.startsWith\('\/api\/'\)/);
  assert.doesNotThrow(()=>new vm.Script(sw));
});
