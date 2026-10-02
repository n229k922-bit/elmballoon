import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {getOperationalMetrics,formatOperationalMetrics} from '../workers/admin-line-secretary/src/operational-metrics.js';
import {managerApi} from '../workers/admin-line-secretary/src/manager-console.js';
function fixture(){
 const db=new DatabaseSync(':memory:');const root=new URL('../workers/admin-line-secretary/migrations/',import.meta.url);
 for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync(new URL(file,root),'utf8'));
 return{db,env:{DB:{prepare(sql){let args=[];return{bind(...a){args=a;return this;},async first(){return db.prepare(sql).get(...args)||null;}};}}}};
}
const period={since:'2026-10-01T00:00:00Z',until:'2026-10-02T00:00:00Z'};

test('metrics API is authenticated, private, read-only and rejects invalid periods',async()=>{
 const {env,db}=fixture();env.ORDER_ENGINE='v2';env.ADMIN_API_TOKEN='test';
 const url='https://example.test/api/manager/metrics';
 assert.equal((await managerApi(new Request(url),env)).status,401);
 const headers={Authorization:'Bearer test'};
 const response=await managerApi(new Request(url,{headers}),env);
 assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.match((await response.json()).message,/未計測/);
 assert.equal((await managerApi(new Request(url+'?since=bad',{headers}),env)).status,400);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM manager_outbox').get().n,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM manager_audit').get().n,0);
});
test('empty measurements retain unknown outcomes and average instead of false zero success',async()=>{
 const {env}=fixture();const m=await getOperationalMetrics(env,period);
 assert.equal(m.customerMessages,0);assert.equal(m.responseSeconds.value,null);assert.equal(m.orderConversion,null);
 assert.equal(m.customerEffort,null);assert.equal(m.lostOrders,null);
 assert.match(formatOperationalMetrics(m),/日本時間/);assert.match(formatOperationalMetrics(m),/未計測/);
 await assert.rejects(getOperationalMetrics(env,{since:'bad',until:period.until}));
 await assert.rejects(getOperationalMetrics(env,{since:period.until,until:period.since}));
});
test('measurements use received source, exclude unsent, owner notice and malformed negative duration',async()=>{
 const {env,db}=fixture();
 db.prepare('INSERT INTO manager_events(id,customer_id,direction,text,occurred_at,received_at) VALUES(?,?,?,?,?,?)').run('E','C','customer','問合せ',period.since,period.since);
 db.prepare('INSERT INTO manager_drafts(id,customer_id,source_event_id,message,created_at) VALUES(?,?,?,?,?)').run('D','C','E','返信',period.since);
 for(const [id,channel,status,sent] of [['X','customer','sent','2026-10-01T00:02:00Z'],['Y','owner','sent','2026-10-01T00:01:00Z'],['Z','customer','pending',null],['N','customer','sent','2026-09-30T23:59:00Z']])db.prepare('INSERT INTO manager_outbox(id,recipient,channel,text,draft_id,retry_key,status,next_attempt_at,sent_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'C',channel,'本文','D',id,status,period.since,sent,period.since);
 const m=await getOperationalMetrics(env,period);assert.equal(m.customerMessages,1);assert.equal(m.responseSeconds.samples,1);assert.ok(Math.abs(m.responseSeconds.value-120)<0.1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM manager_audit').get().n,0);
});
