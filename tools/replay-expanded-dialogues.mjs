import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createManagerFixture} from './helpers/manager-fixture.mjs';
import {receiveManagerEvents, drainManagerInbox, flushManagerOutbox} from '../workers/admin-line-secretary/src/manager-runtime.js';

const input = JSON.parse(fs.readFileSync(new URL('../docs/simulations/2026-10-16-expanded/customer-scenarios.json', import.meta.url), 'utf8'));
assert.equal(input.synthetic, true);
assert.equal(input.activation_allowed, false);
const withFeedback = process.argv.includes('--customer-followup');
assert(process.argv.slice(2).every(arg=>arg==='--customer-followup'), 'Unknown option');
const feedback = withFeedback ? JSON.parse(fs.readFileSync(new URL('../docs/simulations/2026-10-16-expanded/customer-runtime-review.json',import.meta.url),'utf8')) : null;
if(feedback){assert.equal(feedback.synthetic,true);assert.equal(feedback.synthetic_agent_review,true);}
const cases = input.scenarios.map(c=>{
  const next=feedback?.reviews.find(r=>r.caseId===c.caseId)?.nextCustomerText;
  if(withFeedback)assert.equal(typeof next,'string');
  return {...c,turns:next?[...c.turns,next]:c.turns};
});
assert.equal(cases.length, 24);
assert.equal(new Set(cases.map(c => c.caseId)).size, cases.length);
const customerId = c => `EXP-CUSTOMER-${c.caseId}`;
const fixture = createManagerFixture();
const {db, env} = fixture;
const deliveries = [];
Object.assign(env, {MANAGER_TEST_MODE:'true', MANAGER_TEST_CUSTOMER_IDS:cases.map(customerId).join(','), ADMIN_LINE_USER_IDS:'EXP-OWNER', MANAGER_AUTO_INTAKE_ENABLED:'true', AI_DISCLOSURE_ENABLED:'true'});
const fakeFetch = async (url, init) => {
  assert.equal(url, 'https://api.line.me/v2/bot/message/push');
  const payload = JSON.parse(init.body);
  assert(['EXP-OWNER', ...cases.map(customerId)].includes(payload.to));
  deliveries.push({to:payload.to, messages:payload.messages});
  return new Response('{}', {status:200});
};
const records = [];
try {
  const maxTurns = Math.max(...cases.map(c => c.turns.length));
  for (let round=0; round<maxTurns; round++) {
    // Shared database, interleaved customers and a single owner. No external API.
    for (const [index, scenario] of cases.entries()) {
      const raw = scenario.turns[round];
      if (!raw) continue;
      const text = typeof raw === 'string' ? raw : raw.text;
      assert.equal(typeof text, 'string');
      const eventId = `${scenario.caseId}-T${round+1}`;
      const timestamp = new Date(Date.parse('2026-10-19T01:00:00Z') + round*120000 + index*2000).toISOString();
      await receiveManagerEvents([{type:'message', webhookEventId:eventId, timestamp:Date.parse(timestamp), source:{userId:customerId(scenario)}, message:{type:'text', id:eventId, text}}], env, timestamp);
      const processed = new Date(Date.parse(timestamp)+15000).toISOString();
      await drainManagerInbox(env, processed);
      await flushManagerOutbox(env, processed, fakeFetch);
      const orders = db.prepare('SELECT id,title,status,revision FROM manager_orders WHERE customer_id=? ORDER BY rowid').all(customerId(scenario));
      const draft = db.prepare('SELECT message,status,reasons_json,order_id FROM manager_drafts WHERE source_event_id=?').get(eventId);
      records.push({caseId:scenario.caseId, turn:round+1, customerText:text, actualReply:draft?.message??null, draftStatus:draft?.status??null, requiresRouting:Boolean(draft&&!draft.order_id), reasons:JSON.parse(draft?.reasons_json??'[]'), orders:orders.map((order,i)=>({orderLabel:`${scenario.caseId}-ORDER-${i+1}`, title:order.title, status:order.status, revision:order.revision, fields:Object.fromEntries(db.prepare('SELECT field_key,value_text FROM manager_fields WHERE order_id=?').all(order.id).map(f=>[f.field_key,f.value_text]))}))});
    }
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM manager_imports').get().n, 0);
  console.log(JSON.stringify({synthetic:true, activation_allowed:false, scope:'interleaved_customer_utterance_replay', adaptiveCustomerFollowup:withFeedback, notLiveLine:true, managerRoleDecisionsApplied:false, sharedDatabase:true, ownerCount:1, customers:cases.length, utterances:records.length, realKnowledgeImports:0, deliveries:deliveries.length, records}, null, 2));
} finally {db.close();}
