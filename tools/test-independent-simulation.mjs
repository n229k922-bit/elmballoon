import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagerFixture} from './helpers/manager-fixture.mjs';
import {receiveManagerEvents,drainManagerInbox} from '../workers/admin-line-secretary/src/manager-runtime.js';

// Independent review: memory database only; outbox is inspected, never sent.
function setup(t){
 const f=createManagerFixture();t.after(()=>f.db.close());
 Object.assign(f.env,{MANAGER_RELEASE_STAGE:'live',MANAGER_AUTO_INTAKE_ENABLED:'true',AI_DISCLOSURE_ENABLED:'true'});
 let tick=0;const anchor=Date.parse('2026-10-19T01:00:00Z');
 const send=async text=>{const at=anchor+tick++*60000,id=`INDEPENDENT-${tick}`;await receiveManagerEvents([{type:'message',webhookEventId:id,timestamp:at,source:{userId:'INDEPENDENT'},message:{id,type:'text',text}}],f.env,new Date(at).toISOString());await drainManagerInbox(f.env,new Date(at+30000).toISOString());};
 const draft=()=>f.db.prepare('SELECT * FROM manager_drafts ORDER BY rowid DESC LIMIT 1').get();
 const fields=()=>f.db.prepare('SELECT order_id,field_key,value_text FROM manager_fields ORDER BY order_id,field_key').all();
 return {...f,send,draft,fields};
}

test('independent: complaint -> thanks -> numeric details stays held',async t=>{
 const f=setup(t);await f.send('11月7日にブーケ3個、3000円で店頭受取');
 await f.send('昨日のバルーンがしぼみました。交換してください');const before=f.fields();
 await f.send('ありがとうございます');await f.send('明日10時、2個、5000円です');
 assert.deepEqual(f.fields(),before);
 assert.doesNotMatch(f.draft().message,/😊|ご予算|どのような|いつ頃/u);
 assert.notEqual(f.draft().approved_by,'system:intake');
});

test('independent: bereavement context survives plain followup with auto intake enabled',async t=>{
 const f=setup(t);await f.send('葬儀のお供え用の相談です');
 assert.notEqual(f.draft().approved_by,'system:intake','first sensitive consultation must require human review');
 await f.send('白で控えめにお願いします');
 assert.doesNotMatch(f.draft().message,/😊|🎉|お祝い|おめでとう/u,'bereavement context must persist');
 assert.notEqual(f.draft().approved_by,'system:intake','sensitive followup must remain human-reviewed');
});

test('independent: explicit old order id with another order cannot mix facts',async t=>{
 const f=setup(t);await f.send('11月7日にブーケ3個、3000円で店頭受取');
 const order=f.db.prepare('SELECT id FROM manager_orders').get();const before=f.fields();
 await f.send(`${order.id} は変更なしです。別件でスタンド1台、15000円、11月14日に配達希望です`);
 assert.deepEqual(f.fields(),before);
});

test('independent: ambiguous two-order followup holds; explicit selection changes only target',async t=>{
 const f=setup(t);await f.send('11月7日にブーケ3個、3000円で店頭受取');
 await f.send('別件で11月14日にスタンド1台、15000円で配達希望です');
 const orders=f.db.prepare('SELECT id FROM manager_orders ORDER BY rowid').all();assert.equal(orders.length,2);
 const before=f.fields();await f.send('数量を2個に変更してください');assert.deepEqual(f.fields(),before);
 await f.send(`${orders[0].id} の数量を2個に変更してください`);
 assert.equal(f.db.prepare("SELECT value_text FROM manager_fields WHERE order_id=? AND field_key='quantity'").get(orders[0].id).value_text,'2');
 assert.deepEqual(f.fields().filter(r=>r.order_id===orders[1].id),before.filter(r=>r.order_id===orders[1].id));
});
