// Synthetic customer utterance replay, not live LINE and not a replay of the
// roleplaying clerk's promises. The real local runtime generates its own replies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createManagerFixture} from './helpers/manager-fixture.mjs';
import {receiveManagerEvents,drainManagerInbox,flushManagerOutbox} from '../workers/admin-line-secretary/src/manager-runtime.js';

const folder=new URL('../docs/simulations/2026-10-16/',import.meta.url);
const files=fs.readdirSync(folder).filter(name=>/^customer-round[1-9]\d*\.json$/u.test(name))
  .sort((a,b)=>Number(a.match(/\d+/u)[0])-Number(b.match(/\d+/u)[0]));
assert.ok(files.length>=2,'At least two customer rounds are needed');
const cases=Array.from({length:6},(_,i)=>`SIM${String(i+1).padStart(2,'0')}`);
const customerFor=id=>`SIM-C${id.slice(-2)}`;
const f=createManagerFixture(),deliveries=[],snapshots=[];
Object.assign(f.env,{MANAGER_TEST_MODE:'true',MANAGER_TEST_CUSTOMER_IDS:cases.map(customerFor).join(','),
  ADMIN_LINE_USER_IDS:'SIM-OWNER',MANAGER_AUTO_INTAKE_ENABLED:'true',AI_DISCLOSURE_ENABLED:'true'});
const fakeFetch=async(url,init)=>{
  assert.equal(url,'https://api.line.me/v2/bot/message/push');
  const payload=JSON.parse(init.body);
  const channel=init.headers.Authorization===`Bearer ${f.env.LINE_CHANNEL_ACCESS_TOKEN}`?'owner':'customer';
  assert.ok(channel==='owner'?payload.to==='SIM-OWNER':cases.map(customerFor).includes(payload.to));
  deliveries.push({channel,recipient:payload.to,text:payload.messages[0].text});
  return new Response('{}',{status:200});
};
try {
 for(const [roundIndex,file] of files.entries()){
  const round=JSON.parse(fs.readFileSync(new URL(file,folder),'utf8'));
  assert.equal(round.synthetic,true);assert.equal(round.turns.length,6);
  assert.deepEqual([...new Set(round.turns.map(t=>t.caseId))].sort(),cases);
  for(const turn of round.turns){
   assert.equal(turn.role,'customer');assert.equal(turn.customerId,customerFor(turn.caseId));
   assert.ok(typeof turn.text==='string'&&turn.text.length>0&&turn.text.length<20000);
   const timestamp=new Date(Date.parse(round.anchorTime||'2026-10-16T01:00:00.000Z')+roundIndex*120000).toISOString();
   const eventId=`${turn.caseId}-ROUND-${roundIndex+1}`;
   await receiveManagerEvents([{type:'message',webhookEventId:eventId,timestamp:Date.parse(timestamp),source:{userId:turn.customerId},message:{type:'text',id:eventId,text:turn.text}}],f.env,timestamp);
   const processedAt=new Date(Date.parse(timestamp)+15000).toISOString();
   await drainManagerInbox(f.env,processedAt);await flushManagerOutbox(f.env,processedAt,fakeFetch);
   const orders=f.db.prepare('SELECT id,title,revision,status FROM manager_orders WHERE customer_id=? ORDER BY rowid').all(turn.customerId)
    .map((o,index)=>({orderLabel:`${turn.caseId}-ORDER-${index+1}`,title:o.title,revision:o.revision,status:o.status,
      fields:Object.fromEntries(f.db.prepare('SELECT field_key,value_text FROM manager_fields WHERE order_id=?').all(o.id).map(x=>[x.field_key,x.value_text]))}));
   const draft=f.db.prepare('SELECT message,status,reasons_json,order_id FROM manager_drafts WHERE source_event_id=?').get(eventId);
   snapshots.push({round:roundIndex+1,caseId:turn.caseId,source:`${file}#${turn.caseId}`,customerText:turn.text,orders,
    actualReply:draft?.message||null,status:draft?.status||null,reasons:JSON.parse(draft?.reasons_json||'[]'),
    requiresRouting:Boolean(draft&&!draft.order_id)});
  }
 }
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM manager_imports').get().n,0,'synthetic dialogue must not become real verified history');
 const records=cases.map(caseId=>({caseId,customerId:customerFor(caseId),snapshots:snapshots.filter(s=>s.caseId===caseId)}));
 const findings=[];
 const finalSchool=records.find(r=>r.caseId==='SIM02').snapshots.at(-1);
 const standRequested=finalSchool&&records.find(r=>r.caseId==='SIM02').snapshots.some(s=>/別件/u.test(s.customerText)&&/スタンド/u.test(s.customerText));
 if(standRequested&&finalSchool.orders.length<2)findings.push({id:'SIM-F01',severity:'high',caseId:'SIM02',status:'reproduced_in_memory',
   message:'自然な「別件なんですが」を別注文として分離できず、同じ顧客の注文が混ざる。',evidence:records.find(r=>r.caseId==='SIM02').snapshots.filter(s=>/別件/u.test(s.customerText)).map(s=>s.source)});
 const withdrawal=records.find(r=>r.caseId==='SIM03').snapshots.find(s=>/今回は見送/u.test(s.customerText));
 if(withdrawal&&withdrawal.orders.some(o=>o.status==='open')&&/どのような|いつ頃|ご希望/u.test(withdrawal.actualReply||''))findings.push({
   id:'SIM-F02',severity:'high',caseId:'SIM03',status:'reproduced_in_memory',
   message:'「今回は見送ります」を相談の終了として扱えず、注文の聞き取りを続ける。',evidence:[withdrawal.source]});
 for(const snapshot of snapshots){
  if(snapshot.requiresRouting)findings.push({id:`ROUTE-${snapshot.caseId}-${snapshot.round}`,severity:'review',caseId:snapshot.caseId,status:'observed_in_memory',message:'対象が不明な回答を推測更新せず、振分待ちにした。',evidence:[snapshot.source]});
 }
 console.log(JSON.stringify({synthetic:true,scope:'customer_utterance_replay_in_memory',
  notLiveLine:true,roleplayRepliesAreNotSystemOutputs:true,managerRoleDecisionsApplied:false,
  rounds:files.length,customers:cases.length,customerTurns:snapshots.length,
  deliveries:{customer:deliveries.filter(d=>d.channel==='customer').length,owner:deliveries.filter(d=>d.channel==='owner').length},
  realKnowledgeImports:0,findings,records},null,2));
} finally {f.db.close();}
