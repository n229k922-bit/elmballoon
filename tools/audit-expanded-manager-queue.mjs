import assert from 'node:assert/strict';
import {createManagerFixture} from './helpers/manager-fixture.mjs';
import {receiveManagerEvents,drainManagerInbox} from '../workers/admin-line-secretary/src/manager-runtime.js';
const {db,env}=createManagerFixture();
// Memory-only fixture, no fetch or deployed service. Permit all synthetic IDs.
env.MANAGER_RELEASE_STAGE='live';
try{
 const anchor='2026-10-19T01:00:00Z',processed='2026-10-19T01:01:00Z';
 const event=(i,text)=>({type:'message',webhookEventId:`QUEUE-${i}`,timestamp:Date.parse(anchor),source:{userId:`QUEUE-C-${i}`},message:{type:'text',id:`QUEUE-${i}`,text}});
 const events=Array.from({length:24},(_,i)=>event(i,'11月7日にブーケ1つ、合計3000円で店頭受取希望です'));
 events.push(event(24,'子供が風船を飲み込んだかもしれません。至急担当者へお願いします'));
 await receiveManagerEvents(events,env,anchor);
 await drainManagerInbox(env,processed);
 const pending=db.prepare('SELECT customer_id,text FROM manager_events WHERE processed_at IS NULL ORDER BY rowid').all();
 const emergencyPending=pending.some(e=>e.customer_id==='QUEUE-C-24');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM manager_events').get().n,25);
 const report={synthetic:true,activation_allowed:false,notLiveLine:true,scope:'in_memory_burst_queue_priority_diagnostic',customers:25,ownerCount:1,expected:'安全性の緊急相談を通常20件境界の後方へ放置しない',passed:!emergencyPending,emergencyPendingAfterFirstDrain:emergencyPending,pendingAfterFirstDrain:pending.length,limits:'単一バッチの処理順診断。実時間の遅延秒数・実LINE送達・医療応答は検証しない'};
 console.log(JSON.stringify(report,null,2));
 if(emergencyPending)process.exitCode=1;
}finally{db.close();}
