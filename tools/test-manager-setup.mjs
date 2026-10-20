import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagerFixture} from './helpers/manager-fixture.mjs';
import {managerSetupApi,managerSetupPage} from '../workers/admin-line-secretary/src/manager-setup.js';

const now='2026-10-20T01:00:00.000Z';
function fixture(t){const f=createManagerFixture();f.env.ADMIN_API_TOKEN='setup-test-only';t.after(()=>f.db.close());return f;}
function request(body,headers={}){return new Request('https://qa.example/api/manager/setup',{method:body?'POST':'GET',headers:{Authorization:'Bearer setup-test-only',...(body?{Origin:'https://qa.example','X-Manager-Request':'1','Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});}

test('setup is authenticated, no-store, read-only until explicitly confirmed and keeps blanks unknown',async t=>{
 const f=fixture(t);const before=f.db.prepare('SELECT total_changes() n').get().n;
 assert.equal((await managerSetupPage(new Request('https://qa.example/manager/setup'),f.env)).status,401);
 assert.equal((await managerSetupApi(new Request('https://qa.example/api/manager/setup'),f.env,now)).status,401);
 const response=await managerSetupApi(request(),f.env,now);assert.equal(response.status,200);assert.match(response.headers.get('Cache-Control'),/no-store/);
 const data=await response.json();assert.equal(data.days.length,14);assert.ok(data.days.every(day=>day.capacity===null));
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 const body={action:'capacity',date:'2026-10-20',productionMinutes:120,deliveryCount:1,orderCount:2};
 const preview=await managerSetupApi(request(body),f.env,now);assert.equal((await preview.json()).confirmationRequired,true);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_capacity_limits').get().n,0);
 const saved=await managerSetupApi(request({...body,confirmed:true}),f.env,now);assert.equal(saved.status,200);
 assert.deepEqual({...f.db.prepare('SELECT production_minutes,delivery_count,order_count FROM manager_capacity_limits').get()},{production_minutes:120,delivery_count:1,order_count:2});
});

test('admin requests also require origin and request marker; invalid input never becomes a zero limit',async t=>{
 const f=fixture(t);const body={action:'capacity',date:'2026-10-20',productionMinutes:120,deliveryCount:1,orderCount:2,confirmed:true};
 for(const headers of [{Origin:'https://bad.example'},{'X-Manager-Request':''}])assert.equal((await managerSetupApi(request(body,headers),f.env,now)).status,403);
 for(const changed of [{productionMinutes:''},{productionMinutes:null},{deliveryCount:undefined},{orderCount:-1},{orderCount:1.5},{date:'2026-02-30'},{date:'2026-12-01'}])assert.equal((await managerSetupApi(request({...body,...changed}),f.env,now)).status,400);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_capacity_limits').get().n,0);
 const closed=await managerSetupApi(request({...body,productionMinutes:0,deliveryCount:0,orderCount:0}),f.env,now);assert.equal(closed.status,200);
 const nullBody=new Request('https://qa.example/api/manager/setup',{method:'POST',headers:{Authorization:'Bearer setup-test-only',Origin:'https://qa.example','X-Manager-Request':'1'},body:'null'});
 assert.equal((await managerSetupApi(nullBody,f.env,now)).status,400);
});

test('existing reservation protection is preserved and no other day is written',async t=>{
 const f=fixture(t);
 f.db.exec("INSERT INTO manager_orders(id,customer_id,title,status,revision,production_status,fulfillment_status,payment_status,created_at,updated_at) VALUES('M0000000000000001','CUSTOMER','sample','open',1,'consulting','pending','unconfirmed','2026-10-20','2026-10-20'); INSERT INTO manager_capacity_limits VALUES('2026-10-20',120,2,2,'OWNER','2026-10-20'); INSERT INTO manager_capacity_reservations VALUES('M0000000000000001','2026-10-20',1,60,1,1,'2026-10-20');");
 const response=await managerSetupApi(request({action:'capacity',date:'2026-10-20',productionMinutes:30,deliveryCount:0,orderCount:0,confirmed:true}),f.env,now);
 assert.equal(response.status,409);assert.match((await response.json()).error,/予約済み/);
 assert.equal(f.db.prepare('SELECT production_minutes FROM manager_capacity_limits').get().production_minutes,120);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_capacity_limits').get().n,1);
});

test('calendar review records actor, real date and notes without certifying mobile, backup or image acceptance',async t=>{
 const f=fixture(t);const body={action:'calendar_review',reviewedOn:'2026-10-20',through:'2026-11-05',note:'店舗の営業予定表と臨時休業の申請を照合しました。'};
 assert.equal((await (await managerSetupApi(request(body),f.env,now)).json()).confirmationRequired,true);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_audit').get().n,0);
 assert.equal((await managerSetupApi(request({...body,confirmed:true}),f.env,now)).status,200);
 const audit=f.db.prepare('SELECT actor,action,detail FROM manager_audit').get();assert.equal(audit.actor,'api:admin');assert.equal(audit.action,'schedule.review');assert.equal(JSON.parse(audit.detail).reviewedOn,body.reviewedOn);
 const data=await (await managerSetupApi(request(),f.env,now)).json();assert.equal(data.readiness.gates.find(g=>g.id==='schedule_review').status,'ready');
 for(const id of ['mobile_acceptance','backup_recovery_acceptance','schedule_image_acceptance'])assert.equal(data.readiness.gates.find(g=>g.id===id).status,'unknown');
 for(const changed of [{reviewedOn:'2026-10-21'},{reviewedOn:'2026-08-01'},{through:'2026-10-19'},{note:''}])assert.equal((await managerSetupApi(request({...body,...changed,confirmed:true}),f.env,now)).status,400);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_imports').get().n,0);
});
