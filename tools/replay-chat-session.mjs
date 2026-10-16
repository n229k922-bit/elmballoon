import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createManagerFixture} from './helpers/manager-fixture.mjs';
import {receiveManagerEvents,drainManagerInbox,handleManagerCommand,flushManagerOutbox} from '../workers/admin-line-secretary/src/manager-runtime.js';

// This runner executes supplied human/role messages; it never invents a shop decision.
const inputPath=process.argv[2];
assert.ok(inputPath,'Usage: node tools/replay-chat-session.mjs <synthetic-session.json>');
const session=JSON.parse(fs.readFileSync(inputPath,'utf8').replace(/^\uFEFF/u,''));
assert.equal(session.synthetic,true,'Only explicitly synthetic sessions are allowed');
assert.ok(Array.isArray(session.steps));
assert.ok(Number.isFinite(Date.parse(session.anchorTime)),'anchorTime is required');
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('External communication is disabled in chat replay');};
const f=createManagerFixture();
Object.assign(f.env,{MANAGER_TEST_MODE:'true',MANAGER_TEST_CUSTOMER_IDS:'SYNTH-CHAT',ADMIN_LINE_USER_IDS:'SYNTH-OWNER',MANAGER_AUTO_INTAKE_ENABLED:'true',AI_DISCLOSURE_ENABLED:'true'});
const deliveries=[],records=[];
const mock=async(url,init)=>{
  assert.equal(url,'https://api.line.me/v2/bot/message/push');
  const body=JSON.parse(init.body);assert.ok(['SYNTH-CHAT','SYNTH-OWNER'].includes(body.to));
  deliveries.push({role:body.to==='SYNTH-CHAT'?'customer':'manager',messages:body.messages});
  return new Response('{}',{status:200});
};
const all=(sql,...args)=>f.db.prepare(sql).all(...args);
function snapshot(){
  return {
    orders:all('SELECT * FROM manager_orders ORDER BY rowid').map((o,i)=>({...o,alias:`@order:${i+1}`,fields:Object.fromEntries(all('SELECT field_key,value_text,status FROM manager_fields WHERE order_id=?',o.id).map(r=>[r.field_key,{value:r.value_text,status:r.status}]))})),
    drafts:all('SELECT * FROM manager_drafts ORDER BY rowid'),
    changes:all('SELECT * FROM manager_changes ORDER BY rowid'),
  };
}
function resolveAliases(text){
  const orders=all('SELECT id FROM manager_orders ORDER BY rowid');
  return text.replace(/@order:(\d+)/gu,(_,n)=>{assert.ok(orders[Number(n)-1],'Unknown order alias');return orders[Number(n)-1].id;})
    .replace(/@draft:latest\b/gu,()=>{const draft=f.db.prepare("SELECT id FROM manager_drafts WHERE status IN ('pending','held') ORDER BY rowid DESC LIMIT 1").get();assert.ok(draft,'No pending reply to select');return draft.id;});
}
try{
  for(const [index,step] of session.steps.entries()){
    assert.ok(['customer','manager'].includes(step.role));assert.equal(typeof step.text,'string');
    const at=new Date(Date.parse(session.anchorTime)+index*60000).toISOString();
    const drained=new Date(Date.parse(at)+30000).toISOString(),start=deliveries.length;
    let response=null;
    if(step.role==='customer'){
      const id=`CHAT-REPLAY-${index+1}`;
      await receiveManagerEvents([{type:'message',webhookEventId:id,timestamp:Date.parse(at),source:{userId:'SYNTH-CHAT'},message:{type:'text',id,text:step.text}}],f.env,at);
      await drainManagerInbox(f.env,drained);
    }else response=await handleManagerCommand(resolveAliases(step.text),'SYNTH-OWNER',f.env,at);
    await flushManagerOutbox(f.env,drained,mock);
    records.push({step:index+1,input:step,managerResponse:response,deliveries:deliveries.slice(start),state:snapshot()});
  }
  console.log(JSON.stringify({synthetic:true,externalCommunication:false,automaticManagerDecisions:false,scope:'actual runtime; isolated memory DB; recorded mock delivery',records,final:snapshot()},null,2));
}finally{f.db.close();globalThis.fetch=originalFetch;}
