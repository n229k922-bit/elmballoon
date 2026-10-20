import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagerFixture} from './helpers/manager-fixture.mjs';
import {receiveManagerEvents,drainManagerInbox} from '../workers/admin-line-secretary/src/manager-runtime.js';
import {extractConversationFacts} from '../workers/admin-line-secretary/src/conversation.js';

const anchor='2026-10-20T01:00:00.000Z';
function scenario(t){
  const f=createManagerFixture();t.after(()=>f.db.close());
  Object.assign(f.env,{MANAGER_RELEASE_STAGE:'live',MANAGER_AUTO_INTAKE_ENABLED:'true',AI_DISCLOSURE_ENABLED:'true'});
  let n=0;
  const send=async(text,eventId)=>{const at=new Date(Date.parse(anchor)+n++*60000).toISOString(),id=eventId||`COUNT-${n}`;await receiveManagerEvents([{type:'message',webhookEventId:id,timestamp:Date.parse(at),source:{userId:'CUSTOMER'},message:{id,type:'text',text}}],f.env,at);await drainManagerInbox(f.env,new Date(Date.parse(at)+30000).toISOString());};
  const fields=()=>f.db.prepare('SELECT order_id,field_key,value_text FROM manager_fields ORDER BY order_id,field_key').all();
  return {...f,send,fields};
}
for(const [text,expected] of [['1個でお願いします','1'],['2個でお願いします','2'],['２個です','2'],['一個です','1'],['二個です','2'],['ひとつお願いします','1'],['ふたつお願いします','2'],['1個から2個に変更してください','2'],['2個→1個に訂正してください','1'],['2個ではなく1個です','1'],['1個じゃなく2個です','2']])test(`quantity meaning: ${text}`,()=>{
  const result=extractConversationFacts({text,sourceTimestamp:anchor});
  assert.equal(result.updates.find(update=>update.key==='quantity')?.value,expected);
});
for(const text of ['1個か2個で迷っています','2個と3個それぞれお願いします','数量は0個です','数量は-1個です','数量は1.5個です','数量：-1','数量：1.5','1.5点です','1.5人分です','各2個を3人分','2個×3人分','2個ずつ3人分でお願いします','文字入れは「2個の幸せ」','名前は「2個の幸せ」','名入れに「2個の幸せ」と入れてください','1個から2個に変更しません','2個から1個へ変更、1個から2個へも変更','商品番号12、フォント2番でお願いします'])test(`do not invent total quantity: ${text}`,()=>{
  const result=extractConversationFacts({text,sourceTimestamp:anchor});
  assert.equal(result.updates.find(update=>update.key==='quantity'),undefined);
});
for(const text of ['数量を2個に変更してください','数量を1個に訂正してください','1個ではなく2個です','2個です','ブーケを2個お願いします','1個にしてください','注文をキャンセルしてください','赤に変更してください','受取日を11月14日に変更してください','11月14日の受取へ変更','受取日を11月14日の分に変更してください'])test(`two jobs stay intact until scoped: ${text}`,async t=>{
  const f=scenario(t);await f.send('11月7日にブーケ1個、3000円で店頭受取');await f.send('別件で11月14日にスタンド2台、15000円で配達希望です');
  const before=f.fields();await f.send(text);assert.deepEqual(f.fields(),before);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM manager_tasks WHERE kind='routing' AND status='open'").get().n,1);
});
for(const [from,to] of [[1,2],[2,1]])test(`explicit target ${from} -> ${to}; other job and duplicate delivery stay intact`,async t=>{
  const f=scenario(t);await f.send(`11月7日にブーケ${from}個、3000円で店頭受取`);await f.send('別件で11月14日にスタンド1台、15000円で配達希望です');
  const orders=f.db.prepare('SELECT id FROM manager_orders ORDER BY rowid').all(),other=f.fields().filter(row=>row.order_id===orders[1].id);
  const text=`${orders[0].id} の数量を${to}個に変更してください`;
  await f.send(text,'EXACT-CHANGE');await f.send(text,'EXACT-CHANGE');
  assert.equal(f.db.prepare("SELECT value_text FROM manager_fields WHERE order_id=? AND field_key='quantity'").get(orders[0].id).value_text,String(to));
  assert.deepEqual(f.fields().filter(row=>row.order_id===orders[1].id),other);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM manager_events WHERE id='EXACT-CHANGE'").get().n,1);
});
test('confirmed quantity remains unchanged until a reviewed change is applied',async t=>{
  const f=scenario(t);await f.send('11月7日にブーケ1個、3000円で店頭受取');
  f.db.prepare("UPDATE manager_fields SET status='confirmed' WHERE field_key='quantity'").run();
  await f.send('数量を2個に変更してください');
  assert.equal(f.db.prepare("SELECT value_text FROM manager_fields WHERE field_key='quantity'").get().value_text,'1');
  const change=f.db.prepare("SELECT * FROM manager_changes WHERE field_key='quantity' AND status='pending'").get();assert.ok(change);
});
