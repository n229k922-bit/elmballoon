import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { receiveManagerEvents, drainManagerInbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

// Actual runtime + local in-memory fixture only. Never uses LINE or remote D1.
const anchor=Date.parse('2026-10-19T01:00:00.000Z');
function fixture(){
 const f=createManagerFixture();f.env.MANAGER_RELEASE_STAGE='live';let tick=0;
 const get=(sql,...args)=>f.db.prepare(sql).get(...args);
 const all=(sql,...args)=>f.db.prepare(sql).all(...args);
 const event=(text,id,user='SYNTH-SENSITIVE',at=anchor+tick*60000)=>({type:'message',webhookEventId:id,timestamp:at,source:{userId:user},message:{id,type:'text',text}});
 const send=async text=>{const at=anchor+tick++*60000;await receiveManagerEvents([event(text,`SYNTH-E${tick}`,'SYNTH-SENSITIVE',at)],f.env,new Date(at).toISOString());await drainManagerInbox(f.env,new Date(at+30000).toISOString());};
 const latest=()=>get('SELECT * FROM manager_drafts ORDER BY rowid DESC LIMIT 1');
 const fields=id=>Object.fromEntries(all('SELECT field_key,value_text FROM manager_fields WHERE order_id=?',id).map(r=>[r.field_key,r.value_text]));
 return {...f,get,all,event,send,latest,fields};
}
const ordinaryQuestion=/いつ頃|いつごろ|ご希望日|希望日は|どのような|どんな|いくつ|ご予算|ご希望のお色|ご希望の色|受け取り方法.*[？?]/u;

test('withdrawal stops routine intake questions, including a later thanks',async()=>{
 const f=fixture();await f.send('誕生日のブーケを相談したいです');await f.send('まだ注文前なので、今回は見送ります。');
 const afterWithdrawal=f.latest();if(afterWithdrawal)assert.doesNotMatch(afterWithdrawal.message,ordinaryQuestion);
 await f.send('ありがとうございます。また必要な時に連絡します');
 const latest=f.latest();if(latest)assert.doesNotMatch(latest.message,ordinaryQuestion);
 assert.equal(f.get("SELECT COUNT(*) n FROM manager_orders WHERE production_status='confirmed'").n,0);f.db.close();
});
test('complaint remains human-review pending after thanks, without restarting intake',async()=>{
 const f=fixture();await f.send('昨日受け取ったバルーンがしぼみました。明日使うので交換してください');
 let draft=f.latest();assert.ok(draft);assert.doesNotMatch(draft.message,ordinaryQuestion);
 await f.send('ありがとうございます。確認のお返事を待ちます');draft=f.latest();if(draft)assert.doesNotMatch(draft.message,ordinaryQuestion);f.db.close();
});
test('casual 今日 does not overwrite a previously requested pickup date',async()=>{
 const f=fixture();await f.send('11月7日にブーケ1つ、店頭受取希望です');const order=f.get('SELECT id FROM manager_orders');
 await f.send('今日もお忙しいところありがとうございます。');assert.equal(f.fields(order.id).receive_date,'2026-11-07');f.db.close();
});
test('old bouquet plus a new stand inside one message cannot contaminate old fields',async()=>{
 const f=fixture();await f.send('11月7日10時にブーケ3個、合計3000円で店頭受取');const order=f.get('SELECT id FROM manager_orders');const before=f.fields(order.id);
 await f.send('前のブーケはそのままでお願いします。別件でスタンド1台、11月14日17時に配達希望、予算15000円です');
 const after=f.fields(order.id);for(const key of ['quantity','budget','receive_date','receive_time','fulfillment_method','product_type'])assert.equal(after[key],before[key],`old ${key} changed`);
 // Splitting or safely holding ambiguity are both acceptable; overwriting is not.
 assert.ok(f.get('SELECT COUNT(*) n FROM manager_orders').n>=1);f.db.close();
});
test('30日18時 change never combines new time with old31日 as a fabricated commitment',async()=>{
 const f=fixture();await f.send('受取日：10月31日。受取時間：12時。使用日：11月1日。置き型1つ、店頭受取、予算5000円');const order=f.get('SELECT id FROM manager_orders');
 assert.equal(f.fields(order.id).receive_date,'2026-10-31','fixture must establish old pickup date');
 assert.equal(f.fields(order.id).receive_time,'12:00','fixture must establish old pickup time');
 assert.equal(f.fields(order.id).use_date,'2026-11-01','fixture must establish separate use date');
 await f.send('受け取りだけ30日の18時に変更できますか？使用は11月1日のままです');const fields=f.fields(order.id);
 assert.ok(!(fields.receive_date==='2026-10-31'&&fields.receive_time==='18:00'),'fabricated old date plus new time');
 if(fields.receive_time==='18:00')assert.equal(fields.receive_date,'2026-10-30','new time must belong to resolved new date');
 assert.equal(fields.use_date,'2026-11-01');f.db.close();
});
test('possible accidental ingestion is not hidden behind20 ordinary inbox events',async()=>{
 const f=fixture();const events=Array.from({length:24},(_,i)=>f.event('ブーケについて相談です',`LOAD-${i}`,`SYNTH-LOAD-${i}`,anchor));
 const urgent=f.event('子どもが割れたバルーンを誤飲したかもしれません。どうすればいいですか','SAFETY-INGESTION','SYNTH-SAFETY',anchor);
 await receiveManagerEvents([...events,urgent],f.env,new Date(anchor).toISOString());await drainManagerInbox(f.env,new Date(anchor+30000).toISOString());
 const stored=f.get("SELECT processed_at FROM manager_events WHERE id='SAFETY-INGESTION'");assert.ok(stored?.processed_at,'urgent evidence left behind normal LIMIT20');
 const draft=f.get("SELECT message FROM manager_drafts WHERE customer_id='SYNTH-SAFETY' ORDER BY rowid DESC LIMIT 1");assert.ok(draft);assert.doesNotMatch(draft.message,ordinaryQuestion);assert.doesNotMatch(draft.message,/😊|お祝い/u);f.db.close();
});
test('funeral consultation uses respectful wording without smile or celebration',async()=>{
 const f=fixture();await f.send('葬儀のお供え用に、白のバルーンを相談したいです');const draft=f.latest();assert.ok(draft);assert.doesNotMatch(draft.message,/😊|お祝い/u);f.db.close();
});
