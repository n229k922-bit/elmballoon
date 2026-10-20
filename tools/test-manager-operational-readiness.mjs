import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagerFixture} from './helpers/manager-fixture.mjs';
import {getOperationalReadiness} from '../workers/admin-line-secretary/src/manager-readiness.js';

test('operational readiness distinguishes unknown evidence, sparse capacity and unreviewed history',async()=>{
 const f=createManagerFixture();try {
  let report=await getOperationalReadiness(f.env,{now:new Date('2026-10-20T16:00:00Z')});
  assert.equal(report.from,'2026-10-21');assert.equal(report.ready,false);
  assert.equal(report.gates.find(g=>g.id==='capacity_coverage').missingDates.length,14);
  assert.equal(report.gates.find(g=>g.id==='verified_history').status,'unknown');
  for(let i=0;i<14;i++) {
   const date=new Date(Date.parse('2026-10-21')+i*86400000).toISOString().slice(0,10);
   f.db.prepare('INSERT INTO manager_capacity_limits VALUES(?,0,0,0,?,?)').run(date,'OWNER','2026-10-20');
  }
  Object.assign(f.env,{MANAGER_SCHEDULE_REVIEWED_AT:'2026-10-20T01:00:00Z',MANAGER_SCHEDULE_REVIEWED_THROUGH:'2026-11-03',SCHEDULE_PROOF_PAGE_URL:'https://example.test',BROWSER_RENDERING_TOKEN:'not-real',CLOUDFLARE_ACCOUNT_ID:'not-real'});
  report=await getOperationalReadiness(f.env,{now:new Date('2026-10-20T16:00:00Z')});
  assert.equal(report.gates.find(g=>g.id==='capacity_coverage').status,'ready');
  assert.equal(report.gates.find(g=>g.id==='schedule_review').status,'ready');
  assert.equal(report.gates.find(g=>g.id==='schedule_image_config').status,'configured');
  assert.equal(report.gates.find(g=>g.id==='schedule_image_acceptance').status,'unknown');
  assert.doesNotMatch(JSON.stringify(report),/not-real/);assert.equal(report.ready,false);
 }finally {f.db.close();}
});
