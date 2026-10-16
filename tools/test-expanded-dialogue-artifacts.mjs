import assert from 'node:assert/strict';
import fs from 'node:fs';
const root=new URL('../docs/simulations/2026-10-16-expanded/',import.meta.url);
const read=name=>JSON.parse(fs.readFileSync(new URL(name,root),'utf8'));
const cases=read('customer-scenarios.json');
assert.equal(cases.synthetic,true);assert.equal(cases.activation_allowed,false);
assert.equal(cases.scenarios.length,24);assert.equal(new Set(cases.scenarios.map(c=>c.caseId)).size,24);
for(const c of cases.scenarios){
 assert(c.turns.length>=4);assert(c.expectedSafety.length>0);assert(c.persona.ageGroup);assert(c.persona.gender);
 for(const p of c.sourcePatterns)assert(cases.sourcePatterns[p],`${c.caseId}: unknown source ${p}`);
}
const replay=read('runtime-replay.json');
assert.equal(replay.notLiveLine,true);assert.equal(replay.ownerCount,1);assert.equal(replay.realKnowledgeImports,0);
assert.equal(replay.managerRoleDecisionsApplied,false);assert.equal(replay.utterances,96);
for(const c of cases.scenarios){const rows=replay.records.filter(r=>r.caseId===c.caseId);assert.equal(rows.length,c.turns.length);rows.forEach((r,i)=>assert.equal(r.customerText,c.turns[i]));}
const diagnostic=read('intent-diagnostic.json');assert.equal(diagnostic.failed,6);
const feedback=read('customer-runtime-review.json');assert.equal(feedback.synthetic_agent_review,true);assert.equal(feedback.reviews.length,24);
const followup=read('runtime-followup-replay.json');assert.equal(followup.adaptiveCustomerFollowup,true);assert.equal(followup.utterances,120);assert.equal(followup.notLiveLine,true);assert.equal(followup.realKnowledgeImports,0);
for(const c of cases.scenarios){const row=followup.records.find(r=>r.caseId===c.caseId&&r.turn===5);assert.equal(row.customerText,feedback.reviews.find(r=>r.caseId===c.caseId).nextCustomerText);}
const knowledge=read('knowledge-candidates.json');assert.equal(knowledge.activation_allowed,false);assert.equal(knowledge.candidates.length,20);
for(const k of knowledge.candidates){assert.equal(k.activation_allowed,false);assert(cases.scenarios.some(c=>c.caseId===k.caseId));}
const clerk=read('clerk-responses.json');assert.equal(clerk.actualSystemOutput,false);assert.equal(clerk.activation_allowed,false);assert.equal(clerk.cases.length,24);assert.equal(clerk.cases.reduce((n,c)=>n+c.turns.length,0),96);
const manager=read('manager-role-decisions.json');assert.equal(manager.actualSystemOutput,false);assert.equal(manager.activation_allowed,false);assert.equal(manager.managerCount,1);assert.equal(manager.decisions.length,23);
assert.deepEqual(manager.decisions.map(d=>d.requestId).sort(),clerk.managerRequests.map(d=>d.id).sort());
for(const d of manager.decisions){assert.equal(d.orderKey,clerk.managerRequestProvenance.find(r=>r.requestId===d.requestId).orderKey);assert.equal(d.promiseAllowed,false);}
const queue=read('manager-queue-diagnostic.json');assert.equal(queue.notLiveLine,true);assert.equal(queue.passed,false);assert.equal(queue.emergencyPendingAfterFirstDrain,true);
const after=read('clerk-after-manager.json');assert.equal(after.actualSystemOutput,false);assert.equal(after.activation_allowed,false);assert.equal(after.responses.length,24);assert.equal(new Set(after.responses.map(r=>r.caseId)).size,24);for(const response of after.responses)assert.equal(response.bookingConfirmed,false);
console.log(JSON.stringify({artifactValidation:'passed',customers:24,initialUtterances:96,withAdaptiveFollowup:120,knowledgeCandidates:20,intentBusinessFailures:diagnostic.failed,notLiveLine:true,businessAcceptance:'not_passed'}));
