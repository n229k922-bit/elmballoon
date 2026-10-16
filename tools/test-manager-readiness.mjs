import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { getManagerReadiness } from '../workers/admin-line-secretary/src/manager-readiness.js';
import { managerApi } from '../workers/admin-line-secretary/src/manager-console.js';
beforeEach(t=>t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-15T01:00:00.000Z')}));

function fixture(options) {
  const f=createManagerFixture(options);
  Object.assign(f.env,{ORDER_ENGINE:'v2',MANAGER_TEST_MODE:'false',MANAGER_RELEASE_STAGE:'pilot',
    MANAGER_APP_ORIGIN:'https://qa.example',MANAGER_AUTO_INTAKE_ENABLED:'true',AI_DISCLOSURE_ENABLED:'true',
    MANAGER_CONTEXT_BUTTONS_ENABLED:'true',MANAGER_EXPECTED_OWNER_BASIC_ID:'@owner',
    MANAGER_EXPECTED_CUSTOMER_BASIC_ID:'@customer',MANAGER_BUILD_COMMIT:'a'.repeat(40),
    MANAGER_SEND_NOT_BEFORE:'2026-10-01T00:00:00.000Z',ADMIN_API_TOKEN:'readiness-test-only'});
  return f;
}
const verified=async(_,init)=>{
  assert.equal(init.method,'GET');
  return Response.json(init.headers.Authorization.includes('owner')?{userId:'BOT-OWNER',basicId:'@owner'}:{userId:'BOT-CUSTOMER',basicId:'@customer'});
};

test('readiness is private, read-only and does not equate configuration with real LINE acceptance',async()=>{
 const f=fixture();
 assert.equal((await managerApi(new Request('https://qa.example/api/manager/readiness'),f.env)).status,401);
 const before=f.db.prepare('SELECT total_changes() AS n').get().n;
 const report=await getManagerReadiness(f.env,{origin:'https://qa.example',verifyLine:true,fetcher:verified});
 assert.equal(report.configurationReady,true,JSON.stringify(report.checks.filter(c=>!c.ok)));
 assert.equal(report.acceptance.productionApproved,false);
 assert.match(report.pauseScope,/旧システムは対象外/);
 assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
 const json=JSON.stringify(report);assert.ok(!json.includes(f.env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN));
 const res=await managerApi(new Request('https://qa.example/api/manager/readiness',{headers:{Authorization:'Bearer readiness-test-only'}}),f.env);
 assert.equal(res.status,200);assert.match(res.headers.get('cache-control'),/no-store/);
 assert.equal((await res.json()).configurationReady,false,'without actual LINE bot identity check this is not ready');
 f.db.close();
});

test('legacy schemas, missing triggers and missing columns never report ready',async()=>{
 for(const scenario of ['legacy','trigger','column','unavailable']){
  const f=fixture({legacy:scenario==='legacy'});
  if(scenario==='legacy')f.env.ORDER_ENGINE='legacy';
  if(scenario==='trigger')f.db.exec('DROP TRIGGER manager_capacity_reservation_guard');
  if(scenario==='column')f.db.exec('ALTER TABLE manager_outbox DROP COLUMN message_json');
  if(scenario==='unavailable')f.env.DB={prepare(){throw new Error('sensitive detail must not escape')}};
  const report=await getManagerReadiness(f.env,{origin:'https://qa.example',verifyLine:true,fetcher:verified});
  assert.equal(report.configurationReady,false,scenario);
  assert.ok(report.checks.some(c=>c.blocking&&!c.ok));assert.doesNotMatch(JSON.stringify(report),/sensitive detail/);
  f.db.close();
 }
});

test('wrong bots, swapped tokens, absent identity, wrong app and test settings block production',async()=>{
 for(const scenario of ['swapped','same_bot','unavailable','missing_expected','wrong_origin','test_session','unknown_stage','no_cutover','whitespace']){
  const f=fixture();let fetcher=verified,origin='https://qa.example';
  if(scenario==='swapped')fetcher=async()=>Response.json({userId:'OTHER',basicId:'@unexpected'});
  if(scenario==='same_bot')fetcher=async(_,init)=>Response.json({userId:'SAME',basicId:init.headers.Authorization.includes('owner')?'@owner':'@customer'});
  if(scenario==='unavailable')fetcher=async()=>new Response('{}',{status:401});
  if(scenario==='missing_expected')delete f.env.MANAGER_EXPECTED_CUSTOMER_BASIC_ID;
  if(scenario==='wrong_origin')origin='https://other.example';
  if(scenario==='test_session')f.env.MANAGER_TEST_SESSION_STARTED_AT='2026-10-01T00:00:00.000Z';
  if(scenario==='unknown_stage')f.env.MANAGER_RELEASE_STAGE='pilto';
  if(scenario==='no_cutover')delete f.env.MANAGER_SEND_NOT_BEFORE;
  if(scenario==='whitespace')f.env.LINE_CHANNEL_SECRET='   ';
  const report=await getManagerReadiness(f.env,{origin,verifyLine:true,fetcher});
  assert.equal(report.configurationReady,false,scenario);f.db.close();
 }
});

test('queue uncertainty blocks release; paused-but-verified setup remains distinguishable',async()=>{
 const f=fixture();f.env.MANAGER_SEND_PAUSED='true';
 let report=await getManagerReadiness(f.env,{verifyLine:true,fetcher:verified});
 assert.equal(report.configurationReady,true);assert.equal(report.queueTransmissionEnabled,false);
 f.db.prepare("INSERT INTO manager_outbox(id,recipient,channel,text,retry_key,status,next_attempt_at,created_at) VALUES ('UNKNOWN','CUSTOMER','customer','test','key','uncertain','2026-10-01','2026-10-01')").run();
 report=await getManagerReadiness(f.env,{verifyLine:true,fetcher:verified});
 assert.equal(report.configurationReady,false);assert.equal(report.queues.find(q=>q.status==='uncertain').count,1);f.db.close();
});
