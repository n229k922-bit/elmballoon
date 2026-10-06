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

test('friendly order menu uses explicit numbered confirmation and rejects stale or repeated actions', async()=>{
  const f=fixture();await f.receive('ブーケを3つお願いします');
  const listing=await handleManagerCommand('案件一覧','OWNER',f.env,f.later);
  assert.match(listing,/1：/);assert.doesNotMatch(listing,/M[A-F0-9]{16}|pending|consulting/);
  assert.match(await handleManagerCommand('1','OWNER',f.env,f.later),/何を確認/);
  const card=await handleManagerCommand('1','OWNER',f.env,f.later);
  assert.doesNotMatch(card,/M[A-F0-9]{16}|D[A-F0-9]{16}|（版|pending|unconfirmed/);
  assert.match(await handleManagerCommand('6','OWNER',f.env,f.later),/まだ変更/);
  assert.notEqual(f.get('SELECT payment_status FROM manager_orders').payment_status,'paid');
  assert.match(await handleManagerCommand('1','OTHER',f.env,f.later)||'',/^$/);
  await handleManagerCommand('1','OWNER',f.env,f.later);
  assert.equal(f.get('SELECT payment_status FROM manager_orders').payment_status,'paid');
  const revision=f.get('SELECT revision FROM manager_orders').revision;
  await handleManagerCommand('1','OWNER',f.env,f.later);
  assert.equal(f.get('SELECT revision FROM manager_orders').revision,revision);
  await handleManagerCommand('案件一覧','OWNER',f.env,f.later);
  await handleManagerCommand('1','OWNER',f.env,f.later);
  await handleManagerCommand('5','OWNER',f.env,f.later);
  f.db.exec('UPDATE manager_orders SET revision=revision+1');
  assert.match(await handleManagerCommand('1','OWNER',f.env,f.later),/変わりました/);
  assert.notEqual(f.get('SELECT fulfillment_status FROM manager_orders').fulfillment_status,'fulfilled');
});

test('all migrations apply and ordinary natural messages create persistent cards and reviewed replies', async () => {
  const f=fixture(); await f.receive('10月10日に卒業のブーケを3つ。合計3000円で店頭受取をお願いします');
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_orders').n,1);
  assert.equal(f.get("SELECT value_text FROM manager_fields WHERE field_key='quantity'").value_text,'3');
  const draft=f.get('SELECT * FROM manager_drafts');
  assert.equal(draft.status,'pending');
  if (JSON.parse(draft.reasons_json).length) assert.match(draft.message,/店休日・営業時間外/);
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

test('manager numbers revise, hold and approve only one valid draft', async () => {
  const f=fixture(); await f.receive('10月10日にブーケ3個、3000円で店頭受取');
  assert.match(await handleManagerCommand('1','OWNER',f.env,f.later),/どの注文/);
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,0);
  await handleManagerCommand('1','OWNER',f.env,f.later);
  assert.match(await handleManagerCommand('2','OWNER',f.env,f.later),/全文/);
  assert.match(await handleManagerCommand('２ ご希望の色を教えてください。','OWNER',f.env,f.later),/まだ送信していません/);
  assert.equal(f.get('SELECT message FROM manager_drafts').message,'ご希望の色を教えてください。');
  await handleManagerCommand('3','OWNER',f.env,f.later);
  assert.equal(f.get('SELECT status FROM manager_drafts').status,'held');
  assert.equal(await handleManagerCommand('1','STRANGER',f.env,f.later),null);
  assert.match(await handleManagerCommand('１','OWNER',f.env,f.later),/送信待ち/);
  assert.match(await handleManagerCommand('1','OWNER',f.env,f.later),/処理済み/);
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,1);
  const g=fixture(); await g.receive('ブーケ希望','A','CUSTOMER_A'); await g.receive('スタンド希望','B','CUSTOMER_B');
  assert.match(await handleManagerCommand('1','OWNER',g.env,g.later),/どの注文/);
  assert.equal(g.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,0);
  assert.match(await handleManagerCommand('1','OWNER',g.env,g.later),/選んだ注文/);
  assert.equal(g.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,0);
  assert.match(await handleManagerCommand('1','OWNER',g.env,g.later),/送信待ち/);
  await handleManagerCommand('1','OWNER',g.env,g.later);
  assert.equal(g.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,1);
  assert.match(await handleManagerCommand('返信待ち','OWNER',g.env,g.later),/どの注文/);
  assert.match(await handleManagerCommand('1','OWNER',g.env,'2026-09-30T02:00:00.000Z'),/有効時間/);
  assert.equal(g.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,1);
});

test('number selection is actor scoped and rejects a draft updated after selection', async () => {
  const f=fixture(); f.env.ADMIN_LINE_USER_IDS='OWNER,OTHER';
  await f.receive('ブーケ希望','A','CUSTOMER_A'); await f.receive('スタンド希望','B','CUSTOMER_B');
  await handleManagerCommand('返信待ち','OWNER',f.env,f.later);
  assert.match(await handleManagerCommand('1','OTHER',f.env,f.later),/どの注文/);
  const ids=JSON.parse(f.get("SELECT draft_ids_json FROM manager_reply_selection WHERE actor='OWNER'").draft_ids_json);
  f.db.prepare("UPDATE manager_drafts SET status='stale' WHERE id=?").run(ids[0]);
  assert.match(await handleManagerCommand('1','OWNER',f.env,f.later),/更新または処理/);
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,0);
});

test('manager accepts attached reply text without normalizing or sending it', async () => {
  const f=fixture(); await f.receive('ブーケ希望');
  await handleManagerCommand('返信待ち','OWNER',f.env,f.later);
  await handleManagerCommand('1','OWNER',f.env,f.later);
  for (const input of ['2かしこまりました。','２かしこまりました。','2\nかしこまりました。']) {
    assert.match(await handleManagerCommand(input,'OWNER',f.env,f.later),/まだ送信していません/);
    assert.equal(f.get('SELECT message FROM manager_drafts').message,'かしこまりました。');
  }
  await handleManagerCommand('２ＡＢＣ①の仕様で確認します。','OWNER',f.env,f.later);
  assert.equal(f.get('SELECT message FROM manager_drafts').message,'ＡＢＣ①の仕様で確認します。');
  assert.match(await handleManagerCommand('1かしこまりました。','OWNER',f.env,f.later),/まだ送信しません/);
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,0);
});

test('manager waiting lists show actionable Japanese content without internal states or samples', async () => {
  const f=fixture(); await f.receive('10月10日にブーケ3個、3000円で店頭受取','REAL');
  await f.receive('スタンド希望','DEMO','DEMO');
  f.db.prepare("UPDATE manager_orders SET title='【架空サンプル】テスト' WHERE customer_id='DEMO'").run();
  for (const command of ['確認待ち一覧','受注判断','返信待ち']) {
    const result=await handleManagerCommand(command,'OWNER',f.env,f.later);
    assert.match(result,/1：.*ブーケ.*3個.*10月10日.*店頭受取/);
    assert.match(result,/確認：/);
    assert.doesNotMatch(result,/consulting|pending|unconfirmed|架空サンプル|M[A-F0-9]{16}|review_collected_details/);
  }
  assert.match(await handleManagerCommand('1','OWNER',f.env,f.later),/選んだ注文/);
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,0);
  assert.doesNotMatch(await handleManagerCommand('案件一覧','OWNER',f.env,f.later),/consulting|pending|unconfirmed|架空サンプル|M[A-F0-9]{16}/);
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
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_questions q JOIN manager_drafts d ON d.id=q.draft_id WHERE d.source_event_id='E2'").n,0,'replaced reply must not mark unsent intake questions as asked');
  const notice=f.get("SELECT text FROM manager_outbox WHERE channel='owner' ORDER BY rowid DESC LIMIT 1").text;
  assert.match(notice,/予算の変更希望/);assert.doesNotMatch(notice,/C[A-F0-9]{16}|変更承認|budget/);
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

test('natural separate order markers split a burst without inheriting previous facts', async()=>{
  for(const marker of ['別件で','別のご注文：','新しい注文：','もう一つお願いしたいです。']){
    const f=fixture();
    await receiveManagerEvents([f.event('10月10日にブーケ3個、合計3000円で店頭受取','A'),f.event(`${marker}スタンド花を1台、予算15000円で配達希望です`,'B')],f.env,f.now);
    await drainManagerInbox(f.env,f.later);
    const orders=f.all('SELECT id,title FROM manager_orders ORDER BY rowid');
    assert.equal(orders.length,2,marker);
    const fields=id=>Object.fromEntries(f.all('SELECT field_key,value_text FROM manager_fields WHERE order_id=?',id).map(r=>[r.field_key,r.value_text]));
    const bouquet=fields(orders[0].id),stand=fields(orders[1].id);
    assert.equal(bouquet.quantity,'3');assert.equal(bouquet.product_type,'ブーケ');
    assert.equal(stand.quantity,'1');assert.equal(stand.product_type,'バルーンスタンド');
    assert.equal(stand.fulfillment_method,'配達');assert.equal(stand.receive_date,undefined);
    assert.match(stand.budget,/15,000/);assert.match(bouquet.budget,/3,000/);
    await f.receive('予算は20000円です','UNROUTED');
    assert.equal(fields(orders[0].id).budget,bouquet.budget);
    assert.equal(fields(orders[1].id).budget,stand.budget);
    assert.equal(f.get("SELECT COUNT(*) n FROM manager_tasks WHERE kind='routing'").n,1);
    assert.doesNotMatch(f.get('SELECT message FROM manager_drafts WHERE order_id IS NULL').message,/M[A-F0-9]{16}/);
  }
});

test('429 retries keep identical payload and retry key, and do not duplicate delivery',async()=>{
 const f=fixture();await f.receive('ブーケ希望');
 const draft=f.get('SELECT * FROM manager_drafts');await handleManagerCommand(`承認送信 ${draft.id}`,'OWNER',f.env,f.later);
 const calls=[];
 await flushManagerOutbox(f.env,f.later,async(_,init)=>{calls.push(init);return new Response('{}',{status:429})});
 assert.equal(f.get("SELECT status FROM manager_outbox WHERE channel='customer'").status,'pending');
 await flushManagerOutbox(f.env,'2026-09-30T01:03:00.000Z',async(_,init)=>{
   const old=calls.find(x=>x.body===init.body);assert.ok(old);assert.equal(old.headers['X-Line-Retry-Key'],init.headers['X-Line-Retry-Key']);
   return new Response('{}',{status:200});
 });
 assert.equal(f.get("SELECT status FROM manager_outbox WHERE channel='customer'").status,'sent');
 assert.equal(f.get("SELECT COUNT(*) n FROM manager_events WHERE direction='assistant'").n,1);
 await flushManagerOutbox(f.env,'2026-09-30T01:05:00.000Z',async()=>assert.fail('already sent'));
});

test('test-only auto intake asks missing facts without owner noise and escalates completed details',async()=>{
 const f=fixture();Object.assign(f.env,{MANAGER_TEST_MODE:'true',MANAGER_AUTO_INTAKE_ENABLED:'true',MANAGER_TEST_CUSTOMER_IDS:'CUSTOMER',ADMIN_LINE_USER_IDS:'OWNER,SECOND'});
 await f.receive('娘の誕生日にバルーンをお願いしたいんですが、1万円くらいでできますか？');
 assert.equal(f.get('SELECT approved_by FROM manager_drafts').approved_by,'system:intake');
 assert.equal(f.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='owner'").n,0);
 const sent=[];const fetcher=async(_,init)=>{sent.push(JSON.parse(init.body));return new Response('{}',{status:200})};
 await flushManagerOutbox(f.env,f.later,fetcher);
 assert.equal(sent.length,1);assert.equal(sent[0].to,'CUSTOMER');
 assert.match(sent[0].messages[0].text,/いつ頃/);
 assert.equal(f.get("SELECT COUNT(*) n FROM manager_audit WHERE action='intake.auto_queued'").n,1);
 await f.receive('10月10日、ブーケ3個、店頭受取、合計10000円、色はおまかせ','AUTO-DETAILS');
 const draft=f.get("SELECT * FROM manager_drafts WHERE source_event_id='AUTO-DETAILS'");
 assert.equal(draft.status,'pending');
 assert.ok(JSON.parse(draft.reasons_json).includes('review_collected_details'));
 assert.equal(f.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='owner'").n,2);
 await flushManagerOutbox(f.env,f.later,fetcher);
 assert.equal(sent.filter(s=>s.to==='CUSTOMER').length,1,'acceptance still needs manager review');
});

test('auto intake fails closed for production, flags, exceptions, manual review and pending changes',async()=>{
 for(const blocked of ['flag_off','production','urgent','delivery','image','history','manual_review','pending_change','confirmed','ambiguity','unauthorized']){
  const f=fixture();Object.assign(f.env,{MANAGER_TEST_MODE:'true',MANAGER_AUTO_INTAKE_ENABLED:'true',MANAGER_TEST_CUSTOMER_IDS:'CUSTOMER'});
  if(blocked==='production')f.env.MANAGER_TEST_MODE='false';
  if(blocked==='flag_off')f.env.MANAGER_AUTO_INTAKE_ENABLED='false';
  if(blocked==='unauthorized')f.env.MANAGER_TEST_CUSTOMER_IDS='OTHER';
  if(['manual_review','pending_change','confirmed'].includes(blocked)){
   f.env.MANAGER_AUTO_INTAKE_ENABLED='false';await f.receive('ブーケ希望');f.env.MANAGER_AUTO_INTAKE_ENABLED='true';
   const order=f.get('SELECT id FROM manager_orders').id;
   if(blocked==='manual_review')f.db.prepare("INSERT INTO manager_tasks(id,order_id,kind,detail,due_at,created_at) VALUES ('MANUAL',?,'manual_review','review',?,?)").run(order,f.now,f.now);
   if(blocked==='pending_change')f.db.prepare("INSERT INTO manager_changes(id,order_id,field_key,old_value,new_value,source_event_id,base_revision) VALUES ('C1111111111111111',?,'budget','3000','5000','E1',1)").run(order);
   if(blocked==='confirmed')f.db.exec("UPDATE manager_fields SET status='confirmed'");
  }
  const text={urgent:'至急、誕生日のバルーンをお願いします',delivery:'配達でブーケ希望',history:'去年と同じブーケ希望',ambiguity:'来週ブーケ希望'}[blocked]||'誕生日のブーケ希望';
  if(blocked==='image'){
   const event=f.event(text,'BLOCKED');event.message={type:'image',id:'IMAGE'};
   await receiveManagerEvents([event],f.env,f.now);await drainManagerInbox(f.env,f.later);
  }else await f.receive(text,'BLOCKED');
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,0,blocked);
 }
});

test('auto intake kill switch cancels unattempted sends but keeps attempted retry payload immutable',async()=>{
 const f=fixture();Object.assign(f.env,{MANAGER_TEST_MODE:'true',MANAGER_AUTO_INTAKE_ENABLED:'true',MANAGER_TEST_CUSTOMER_IDS:'CUSTOMER'});
 await f.receive('誕生日のバルーンをお願いしたいです');
 f.env.MANAGER_AUTO_INTAKE_ENABLED='false';
 await flushManagerOutbox(f.env,f.later,async()=>assert.fail('disabled automation must not send'));
 assert.equal(f.get('SELECT last_error FROM manager_outbox').last_error,'auto_intake_disabled');
 const g=fixture();Object.assign(g.env,{MANAGER_TEST_MODE:'true',MANAGER_AUTO_INTAKE_ENABLED:'true',MANAGER_TEST_CUSTOMER_IDS:'CUSTOMER'});
 await g.receive('誕生日のバルーンをお願いしたいです');let initial;
 await flushManagerOutbox(g.env,g.later,async(_,init)=>{initial=init;throw new Error('ambiguous network timeout')});
 g.env.MANAGER_AUTO_INTAKE_ENABLED='false';
 await flushManagerOutbox(g.env,'2026-09-30T01:03:00.000Z',async(_,init)=>{assert.equal(init.body,initial.body);assert.equal(init.headers['X-Line-Retry-Key'],initial.headers['X-Line-Retry-Key']);return new Response('{}',{status:200})});
 assert.equal(g.get('SELECT status FROM manager_outbox').status,'sent');
});

test('saved notification buttons stay identical across retries and rollout setting changes',async()=>{
 const f=fixture();Object.assign(f.env,{MANAGER_TEST_MODE:'true',MANAGER_TEST_CUSTOMER_IDS:'CUSTOMER'});await f.receive('ブーケ希望');
 const initial=[];await flushManagerOutbox(f.env,f.later,async(_,init)=>{initial.push(init);return new Response('{}',{status:429})});
 f.env.MANAGER_TEST_MODE='false';
 await flushManagerOutbox(f.env,'2026-09-30T01:03:00.000Z',async(_,init)=>{
  assert.equal(init.body,initial[0].body);assert.equal(init.headers['X-Line-Retry-Key'],initial[0].headers['X-Line-Retry-Key']);
  assert.equal(JSON.parse(init.body).messages[0].quickReply.items[0].action.label,'この注文を確認');
  return new Response('{}',{status:200});
 });
});

test('manual reply revision does not record removed questions as sent',async()=>{
 const f=fixture();await f.receive('ブーケ希望');const draft=f.get('SELECT id FROM manager_drafts');
 assert.ok(f.get('SELECT COUNT(*) n FROM manager_questions').n>0);
 await handleManagerCommand(`返信修正 ${draft.id} 内容を確認いたします。`,'OWNER',f.env,f.later);
 assert.equal(f.get('SELECT COUNT(*) n FROM manager_questions').n,0);
 await handleManagerCommand(`承認送信 ${draft.id}`,'OWNER',f.env,f.later);
 await flushManagerOutbox(f.env,f.later,async()=>new Response('{}',{status:200}));
 assert.equal(f.get('SELECT status FROM manager_drafts').status,'sent');
});

test('fresh test session retains earlier records without inheriting or sending earlier orders',async()=>{
 const f=fixture();await f.receive('10月10日にブーケ3個、合計3000円で店頭受取');
 const oldOrder=f.get('SELECT id FROM manager_orders').id,oldDraft=f.get('SELECT id FROM manager_drafts').id;
 Object.assign(f.env,{MANAGER_TEST_MODE:'true',MANAGER_TEST_CUSTOMER_IDS:'CUSTOMER',MANAGER_TEST_SESSION_STARTED_AT:'2026-09-30T01:02:00.000Z'});
 assert.match(await handleManagerCommand('案件一覧','OWNER',f.env,'2026-09-30T01:03:00.000Z'),/進行中の注文はありません/);
 assert.match(await handleManagerCommand(`承認送信 ${oldDraft}`,'OWNER',f.env,'2026-09-30T01:03:00.000Z'),/以前のテスト/);
 await receiveManagerEvents([f.event('娘の誕生日にバルーンをお願いしたいです','FRESH')],f.env,'2026-09-30T01:03:00.000Z');
 await drainManagerInbox(f.env,'2026-09-30T01:04:00.000Z');
 assert.equal(f.get('SELECT COUNT(*) n FROM manager_orders').n,2);
 const fresh=f.get('SELECT id FROM manager_orders WHERE id<>?',oldOrder).id;
 assert.equal(f.get("SELECT COUNT(*) n FROM manager_fields WHERE order_id=? AND field_key IN ('quantity','receive_date','budget')",fresh).n,0);
 assert.equal(f.get("SELECT value_text FROM manager_fields WHERE order_id=? AND field_key='quantity'",oldOrder).value_text,'3');
 const list=await handleManagerCommand('案件一覧','OWNER',f.env,'2026-09-30T01:04:00.000Z');
 assert.match(list,/誕生日/);assert.doesNotMatch(list,/2：/);
 f.env.ADMIN_API_TOKEN='test';
 const overview=await (await managerApi(new Request('https://shop.example/api/manager/orders',{headers:{Authorization:'Bearer test'}}),f.env)).json();
 assert.equal(overview.orders.length,1);assert.equal(overview.orders[0].id,fresh);
 assert.ok(overview.tasks.every(t=>t.order_id===fresh));assert.equal(overview.today.replyCount,1);
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
  assert.match(await handleManagerCommand(`制作開始 ${order.id}`,'OWNER',f.env,f.later),/枠が未確認/);
  assert.match(await handleManagerCommand('受付上限 2026-10-10 480 3 8','OWNER',f.env,f.later),/記録しました/);
  assert.match(await handleManagerCommand(`受注枠 ${order.id} 2026-10-10 60 0 1`,'OWNER',f.env,f.later),/枠を確保/);
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

test('manager can ask for history, while repeat-customer facts stay out of customer messages',async()=>{
  const f=fixture();f.env.ADMIN_API_TOKEN='test';
  const insert=f.db.prepare("INSERT INTO manager_imports(id,source_hash,source_file,source_heading,source_line,raw_text,review_status,linked_customer_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  insert.run('legacy_'+'a'.repeat(32),'hash','CUSTOMER_ORDER_CARDS_PRIVATE.md','山田さん','1','本人の過去文字：HISTORY-PRIVATE 800円','verified','CUSTOMER',f.now);
  insert.run('legacy_'+'b'.repeat(32),'hash','CUSTOMER_ORDER_CARDS_PRIVATE.md','山田さん同姓','2','OTHER-PRIVATE','verified','OTHER',f.now);
  const answer=await handleManagerCommand('山田さんの過去の注文を確認したい','OWNER',f.env,f.later);assert.match(answer,/検索候補/);assert.match(answer,/本人はまだ断定/);
  assert.equal(await handleManagerCommand('山田さんの過去の注文を確認したい','OTHER',f.env,f.later),null);
  await f.receive('こんにちは、ブーケをお願いします');
  const order=f.get('SELECT id FROM manager_orders');
  const note=await handleManagerCommand(`過去情報 ${order.id}`,'OWNER',f.env,f.later);assert.match(note,/HISTORY-PRIVATE/);assert.doesNotMatch(note,/OTHER-PRIVATE/);
  assert.match(f.get("SELECT text FROM manager_outbox WHERE channel='owner'").text,/HISTORY-PRIVATE/);
  assert.doesNotMatch(f.get('SELECT message FROM manager_drafts').message,/HISTORY-PRIVATE|OTHER-PRIVATE/);
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_fields WHERE value_text LIKE '%HISTORY-PRIVATE%'").n,0);
  const req=token=>new Request('https://shop.example/api/manager/history?q='+encodeURIComponent('山田'),{headers:{Authorization:'Bearer '+token}});
  assert.equal((await managerApi(req('wrong'),f.env)).status,401);
  assert.equal((await (await managerApi(req('test'),f.env)).json()).records.length,2);
});

test('test sends require explicit recipients and never release old queued messages',async()=>{
  const f=fixture();f.env.MANAGER_TEST_MODE='true';f.env.MANAGER_TEST_CUSTOMER_IDS='CUSTOMER';f.env.MANAGER_SEND_NOT_BEFORE=f.now;
  await receiveManagerEvents([f.event('ブーケ','OUTSIDE','OTHER')],f.env,f.now);assert.equal(f.get('SELECT COUNT(*) n FROM manager_events').n,0);
  await f.receive('ブーケ');const d=f.get('SELECT id FROM manager_drafts');await handleManagerCommand(`承認送信 ${d.id}`,'OWNER',f.env,f.later);
  f.db.prepare("INSERT INTO manager_outbox(id,recipient,channel,text,retry_key,next_attempt_at,created_at) VALUES ('OLD','CUSTOMER','customer','old','retry-old',?,?)").run(f.now,'2026-09-01T00:00:00Z');
  f.db.prepare("INSERT INTO manager_outbox(id,recipient,channel,text,retry_key,next_attempt_at,created_at) VALUES ('OTHER','OTHER','customer','other','retry-other',?,?)").run(f.now,f.now);
  const recipients=[];await flushManagerOutbox(f.env,f.later,async(_url,options)=>{recipients.push(JSON.parse(options.body).to);return new Response('{}')});
  assert.equal(f.get("SELECT last_error FROM manager_outbox WHERE id='OLD'").last_error,'before_test_cutover');
  assert.equal(f.get("SELECT last_error FROM manager_outbox WHERE id='OTHER'").last_error,'outside_test_allowlist');
  assert.deepEqual(recipients.sort(),['CUSTOMER','OWNER']);
  const g=fixture();g.env.MANAGER_TEST_MODE='true';await g.receive('ブーケ');assert.equal(g.get('SELECT COUNT(*) n FROM manager_events').n,0);
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
