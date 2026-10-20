import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagerFixture} from './helpers/manager-fixture.mjs';
import {managerHealthApi,recordMaintenanceHealth} from '../workers/admin-line-secretary/src/manager-health.js';
test('health is private and absent or stale heartbeat is not healthy',async t=>{
 const f=createManagerFixture();t.after(()=>f.db.close());const now='2026-10-20T01:00:00Z',kv=new Map();f.env.ADMIN_API_TOKEN='fixture';f.env.SECRETARY_KV={get:async key=>kv.get(key),put:async(key,value)=>kv.set(key,value)};
 const req=auth=>new Request('https://shop.test/api/manager/health',{headers:auth?{Authorization:'Bearer fixture'}:{}});
 assert.equal((await managerHealthApi(req(false),f.env,now)).status,401);
 assert.equal((await managerHealthApi(req(true),f.env,now)).status,503);
 await recordMaintenanceHealth(f.env,{now,ok:true});assert.equal((await managerHealthApi(req(true),f.env,now)).status,200);
 assert.equal((await managerHealthApi(req(true),f.env,'2026-10-20T01:21:00Z')).status,503);
 await recordMaintenanceHealth(f.env,{now,ok:false});assert.equal((await managerHealthApi(req(true),f.env,now)).status,503);
});
test('inbox delay is visible without returning customer information',async t=>{
 const f=createManagerFixture();t.after(()=>f.db.close());f.env.ADMIN_API_TOKEN='fixture';f.env.SECRETARY_KV={get:async()=>JSON.stringify({at:'2026-10-20T01:00:00Z',ok:true})};
 f.db.prepare("INSERT INTO manager_events(id,customer_id,direction,text,occurred_at,received_at) VALUES ('private-event','private-person','customer','private-content','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z')").run();
 const result=await managerHealthApi(new Request('https://shop.test/api/manager/health',{headers:{Authorization:'Bearer fixture'}}),f.env,'2026-10-20T01:00:00Z');assert.equal(result.status,503);
 const body=await result.text();assert.doesNotMatch(body,/private-person|private-content|private-event/);assert.match(body,/'|inbox_delay/);
});
test('repeated pending delivery failure and image archival failure cannot report healthy',async t=>{
 const f=createManagerFixture();t.after(()=>f.db.close());const now='2026-10-20T01:00:00Z',kv=new Map();f.env.ADMIN_API_TOKEN='fixture';f.env.SECRETARY_KV={get:async key=>kv.get(key),put:async(key,value)=>kv.set(key,value)};
 f.db.prepare("INSERT INTO manager_outbox(id,recipient,channel,text,retry_key,created_at,next_attempt_at) VALUES ('test','fixture-person','customer','fixture-body','retry','2026-10-20T00:00:00Z','2026-10-20T01:00:00Z')").run();
 const req=()=>new Request('https://shop.test/api/manager/health',{headers:{Authorization:'Bearer fixture'}});
 await recordMaintenanceHealth(f.env,{now,ok:true});assert.equal((await managerHealthApi(req(),f.env,now)).status,503);
 f.env.MANAGER_SEND_PAUSED='true';assert.equal((await managerHealthApi(req(),f.env,now)).status,200);
 await recordMaintenanceHealth(f.env,{now,ok:true,imageArchive:{saved:0,failed:1,reasons:{retry_exhausted:1}}});assert.equal((await managerHealthApi(req(),f.env,now)).status,503);
 const body=await(await managerHealthApi(req(),f.env,now)).text();assert.doesNotMatch(body,/fixture-person|fixture-body/);
});
