import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagerFixture} from './helpers/manager-fixture.mjs';
import {handleManagerCommand,receiveManagerEvents,drainManagerInbox,flushManagerOutbox} from '../workers/admin-line-secretary/src/manager-runtime.js';
const oid='M1122334455667788';
const anchor=Date.parse('2026-10-16T07:00:00Z');
const payload={items:[{type:'浮くミッキー（ピンク）',quantity:1,size:'45cm'}],total_yen:5000,tax_included:true,personalization_fee_yen:500,feasible:true,receive_date:'2026-10-17',receive_time:'16:00',use_date:'2026-10-18',fulfillment_method:'店頭受取',balloon_message:'NANO'};
function setup(t){
 const f=createManagerFixture();t.after(()=>f.db.close());f.env.MANAGER_PILOT_CUSTOMER_IDS='YAMADA';
 const now=new Date(anchor).toISOString();f.db.prepare('INSERT INTO manager_orders(id,customer_id,created_at,updated_at) VALUES (?,?,?,?)').run(oid,'YAMADA',now,now);
 for(const [k,v] of Object.entries({customer_name:'山田',purpose:'娘の誕生日',budget:'5000円程度',receive_date:'2026-10-18',receive_time:'11:00',use_date:'2026-10-18',color_vibe:'ピンク',balloon_message:'NANO'}))f.db.prepare('INSERT INTO manager_fields(order_id,field_key,value_text,source_occurred_at) VALUES (?,?,?,?)').run(oid,k,v,now);
 let tick=0;const time=()=>new Date(anchor+(++tick)*60000).toISOString();
 const cmd=text=>handleManagerCommand(text,'OWNER',f.env,time());
 const fields=()=>Object.fromEntries(f.db.prepare('SELECT field_key,value_text FROM manager_fields WHERE order_id=?').all(oid).map(f=>[f.field_key,f.value_text]));
 const send=async text=>{const at=time(),id=`YAMADA-${tick}`;await receiveManagerEvents([{type:'message',webhookEventId:id,timestamp:Date.parse(at),source:{userId:'YAMADA'},message:{id,type:'text',text}}],f.env,at);await drainManagerInbox(f.env,new Date(Date.parse(at)+15000).toISOString());};
 const offer=async(p=payload)=>{const result=await cmd(`提案作成 ${oid} ${JSON.stringify(p)}`);const draft=f.db.prepare('SELECT * FROM manager_drafts ORDER BY rowid DESC LIMIT 1').get();return {result,draft};};
 const deliver=async draft=>{assert.match(await cmd(`承認送信 ${draft.id}`),/送信待ち/);await flushManagerOutbox(f.env,time(),async()=>new Response('{}',{status:200}));assert.equal(f.db.prepare('SELECT status FROM manager_drafts WHERE id=?').get(draft.id).status,'sent');};
 return {...f,cmd,fields,send,offer,deliver};
}
test('runtime: complete reviewed offer is sent, naturally accepted and atomically applied; budget and use date remain independent',async t=>{
 const f=setup(t);await f.send('受け取りを17日に変更したいです');await f.send('17時でお願いします');assert.equal(f.fields().receive_date,'2026-10-18');assert.equal(f.fields().receive_time,'11:00');
 const {result,draft}=await f.offer();assert.match(result,/使用日：2026-10-18のまま/);assert.equal(f.fields().receive_date,'2026-10-18');await f.deliver(draft);await f.send('はい、その内容で');
 const fields=f.fields();assert.equal(fields.receive_date,'2026-10-17');assert.equal(fields.receive_time,'16:00');assert.equal(fields.use_date,'2026-10-18');assert.equal(fields.quoted_total,'5000');assert.equal(fields.personalization_fee,'500');assert.equal(fields.budget,'5000円程度');assert.equal(fields.balloon_message,'NANO');assert.match(fields.customer_agreement,/^C/);
 const order=f.db.prepare('SELECT * FROM manager_orders WHERE id=?').get(oid);assert.equal(order.production_status,'consulting');assert.notEqual(order.payment_status,'paid');assert.match(await f.cmd(`制作開始 ${oid}`),/枠が未確認/);
});
test('runtime: incomplete terms, unsent OK, changed offer version and commercial free-text promises never confirm order',async t=>{
 const f=setup(t);assert.match((await f.offer({...payload,items:[{type:'ミッキー',quantity:1}]})).result,/サイズ/);assert.match((await f.offer({...payload,personalization_fee_yen:undefined})).result,/名入れ料金/);
 assert.match(await f.cmd(`制作開始 ${oid}`),/税込総額|同じ版/);await f.offer();await f.send('OK');assert.equal(f.fields().customer_agreement,undefined);
 const {draft}=await f.offer();await f.deliver(draft);await f.send('文字はNANAに変更したいです');await f.send('はい、その内容で');assert.equal(f.fields().customer_agreement,undefined);
 await f.cmd(`返信作成 ${oid} 5000円でご用意できます。名入れ無料です。ご予約承りました。`);const promise=f.db.prepare('SELECT id FROM manager_drafts ORDER BY rowid DESC LIMIT 1').get();assert.doesNotMatch(await f.cmd(`承認送信 ${promise.id}`),/送信待ちに登録/);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM manager_outbox WHERE draft_id=?").get(promise.id).n,0);
});
test('runtime: owner field command parses colon inside receive_time without treating time as part of key',async t=>{const f=setup(t);assert.match(await f.cmd(`項目確定 ${oid} receive_time：15:00`),/保存しました/);assert.equal(f.fields().receive_time,'15:00');});
for(const reply of ['OKです','はいお願いします','大丈夫です'])test(`runtime: latest sent complete offer accepts natural reply ${reply}`,async t=>{const f=setup(t);const {draft}=await f.offer();await f.deliver(draft);await f.send(reply);assert.match(f.fields().customer_agreement,/^C/);assert.equal(f.fields().receive_time,'16:00');assert.equal(f.fields().use_date,'2026-10-18');assert.equal(f.db.prepare('SELECT production_status FROM manager_orders WHERE id=?').get(oid).production_status,'consulting');});
