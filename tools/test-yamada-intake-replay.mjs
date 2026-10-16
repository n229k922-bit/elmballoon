import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagerFixture} from './helpers/manager-fixture.mjs';
import {receiveManagerEvents, drainManagerInbox, flushManagerOutbox, handleManagerCommand} from '../workers/admin-line-secretary/src/manager-runtime.js';

// The customer's chat replay: a fresh isolated customer, real runtime, no network.
function setup(t) {
  const f=createManagerFixture(); t.after(()=>f.db.close());
  Object.assign(f.env,{MANAGER_TEST_MODE:'true',MANAGER_TEST_CUSTOMER_IDS:'SYNTH-YAMADA',MANAGER_AUTO_INTAKE_ENABLED:'true',AI_DISCLOSURE_ENABLED:'true'});
  const deliveries=[]; let tick=0;
  const now=()=>new Date(Date.parse('2026-10-16T01:00:00Z')+tick*60000).toISOString();
  const mock=async(url,init)=>{assert.equal(url,'https://api.line.me/v2/bot/message/push');const body=JSON.parse(init.body);assert.ok(['OWNER','SYNTH-YAMADA'].includes(body.to));deliveries.push(body);return new Response('{}',{status:200});};
  const send=async text=>{const at=now(),eventId=`YAMADA-${++tick}`;await receiveManagerEvents([{type:'message',webhookEventId:eventId,timestamp:Date.parse(at),source:{userId:'SYNTH-YAMADA'},message:{type:'text',id:eventId,text}}],f.env,at);await drainManagerInbox(f.env,now());await flushManagerOutbox(f.env,now(),mock);};
  const owner=async text=>handleManagerCommand(text,'OWNER',f.env,now());
  const fields=()=>Object.fromEntries(f.db.prepare('SELECT field_key,value_text FROM manager_fields').all().map(r=>[r.field_key,r.value_text]));
  const latest=()=>f.db.prepare('SELECT * FROM manager_drafts ORDER BY rowid DESC LIMIT 1').get();
  return {...f,send,owner,fields,latest,deliveries,now};
}

test('Yamada: original conversation records use date separately and never invents a quotation',async t=>{
  const f=setup(t);
  await f.send('こんにちは初めての注文です');
  await f.send('娘の誕生日に浮くタイプのバルーンを考えています。');
  const questions=f.db.prepare('SELECT field_key FROM manager_questions WHERE draft_id=?').all(f.latest().id);
  assert.ok(questions.some(q=>q.field_key==='use_date'),'the real conversation must ask when it will be used');
  await f.send('明後日なんですけど間に合いますか？');
  assert.equal(f.fields().use_date,'2026-10-18','the answer to use date must not become pickup date');
  await f.send('お店に伺います');
  assert.equal(f.fields().fulfillment_method,'店頭受取');
  await f.send('何時から受け取り出来ますか？');
  assert.equal(f.fields().receive_time,undefined,'opening-hours question is not a requested time');
  await f.send('11時ごろ希望です');
  await f.send('5000円程度でどのようなものができますか？');
  await f.send('ミッキーです');
  await f.send('ピンクです');
  await f.send('OK');
  assert.equal(f.fields().receive_time,'11:00');
  assert.match(f.fields().budget,/5,000/);
  assert.equal(f.fields().quoted_total,undefined,'a customer budget is not a shop quotation');
  assert.equal(f.db.prepare('SELECT production_status FROM manager_orders').get().production_status,'consulting');
  for(const d of f.deliveries.filter(d=>d.to==='SYNTH-YAMADA'))assert.doesNotMatch(d.messages[0].text,/ご用意できます|無料です|ご予約を承りました|ご注文を承りました/);
});

test('Yamada: a new pickup request cannot overwrite confirmed pickup or use date',async t=>{
  const f=setup(t);await f.send('使用日：2026-10-18\n受取希望日：2026-10-18\n受取方法：店頭受取\n浮くバルーン');
  const order=f.db.prepare('SELECT id FROM manager_orders').get();
  await f.owner(`項目確定 ${order.id} use_date：2026-10-18`);
  await f.owner(`項目確定 ${order.id} receive_date：2026-10-18`);
  await f.owner(`項目確定 ${order.id} receive_time：11:00`);
  await f.send('やっぱり受取明日でもいいですか？');
  await f.send('１７時希望です');
  assert.equal(f.fields().use_date,'2026-10-18');
  assert.equal(f.fields().receive_date,'2026-10-18','old pickup remains until a reviewed replacement is accepted');
  assert.equal(f.fields().receive_time,'11:00','new time is only a proposed change');
  assert.ok(f.db.prepare("SELECT COUNT(*) n FROM manager_changes WHERE status='pending'").get().n>0);
  assert.match(f.latest().message,/使用日|ご使用日/,'pickup-change conversation must confirm whether the use date stays the same');
});

test('Yamada: colon in a confirmed time must not corrupt its field name',async t=>{
  const f=setup(t);await f.send('浮くバルーンを相談したいです');
  const order=f.db.prepare('SELECT id FROM manager_orders').get();
  const result=await f.owner(`項目確定 ${order.id} receive_time：16:00`);
  assert.match(result,/保存/);assert.equal(f.fields().receive_time,'16:00');
});
