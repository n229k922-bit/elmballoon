import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { validateCapacityRequirements, reserveOrderCapacity, getCapacitySummary } from '../workers/admin-line-secretary/src/capacity-safety.js';

function fixture() {
 const db = new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 const root = new URL('../workers/admin-line-secretary/migrations/',import.meta.url);
 for (const file of fs.readdirSync(root).filter(f=>f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(file,root),'utf8'));
 class S { constructor(sql){this.sql=sql;this.args=[];} bind(...args){this.args=args;return this;} async first(){return db.prepare(this.sql).get(...this.args)||null;} async run(){return db.prepare(this.sql).run(...this.args);} }
 const env={DB:{prepare:sql=>new S(sql),async batch(items){db.exec('BEGIN');try{for(const s of items)await s.run();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}}};
 for(const id of ['A','B']) db.prepare("INSERT INTO manager_orders(id,customer_id,created_at,updated_at) VALUES (?,?,'now','now')").run(id,id);
 const limits=(date,p=60,d=1,o=2)=>db.prepare("INSERT INTO manager_capacity_limits VALUES (?,?,?,?,'OWNER','now')").run(date,p,d,o);
 return {db,env,limits};
}
const req=(date='2026-10-09',p=30,d=0,o=1)=>[{date,production_minutes:p,delivery_count:d,order_count:o}];

test('missing, negative, fractional, string estimates and malformed real dates fail closed',()=>{
 for(const x of [[],null,[{date:'2026-10-09'}],req('2026-02-30'),req('2026-1-01'),req('2026-10-09',-1),req('2026-10-09',1.5),req('2026-10-09','30'),req('2026-10-09',0,0,0),[...req(),...req()]]) assert.ok(validateCapacityRequirements(x));
 assert.equal(validateCapacityRequirements(req()),null);
});
test('unknown limits, stale revision and missing order fail closed',async()=>{
 const f=fixture(); assert.equal((await reserveOrderCapacity(f.env,'A',0,req())).reason,'capacity_unknown_limits');
 f.limits('2026-10-09'); assert.equal((await reserveOrderCapacity(f.env,'A',1,req())).reason,'capacity_stale_order');
 assert.equal((await reserveOrderCapacity(f.env,'UNKNOWN',0,req())).ok,false);
});
test('totals enforce production, delivery and count with idempotent replacement',async()=>{
 for(const [p,d,o,next] of [[30,0,1,req('2026-10-09',31)],[0,1,1,req('2026-10-09',0,1)],[0,0,2,req('2026-10-09',0,0,1)]]){
 const f=fixture();f.limits('2026-10-09');
 assert.equal((await reserveOrderCapacity(f.env,'A',0,req('2026-10-09',p,d,o))).ok,true);
 assert.equal((await reserveOrderCapacity(f.env,'A',0,req('2026-10-09',p,d,o))).ok,true);
 assert.equal((await reserveOrderCapacity(f.env,'B',0,next)).reason,'capacity_exceeded');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_capacity_reservations').get().n,1);
 }
});
test('failed multi-date amendment rolls back old reservation, cancellation frees capacity',async()=>{
 const f=fixture();f.limits('2026-10-09');f.limits('2026-10-10',0,0,0);
 await reserveOrderCapacity(f.env,'A',0,req());
 assert.equal((await reserveOrderCapacity(f.env,'A',0,[...req('2026-10-09',20),...req('2026-10-10')])).ok,false);
 assert.equal((await getCapacitySummary(f.env,'2026-10-09')).used_production_minutes,30);
 f.db.exec("UPDATE manager_orders SET status='cancelled' WHERE id='A'");
 assert.equal((await getCapacitySummary(f.env,'2026-10-09')).used_order_count,0);
 assert.equal((await reserveOrderCapacity(f.env,'A',0,req())).reason,'capacity_stale_order');
 assert.equal((await reserveOrderCapacity(f.env,'B',0,req('2026-10-09',60))).ok,true);
});
test('raw SQL writes cannot bypass total guard and stale replacements preserve existing rows',async()=>{
 const f=fixture();f.limits('2026-10-09');await reserveOrderCapacity(f.env,'A',0,req('2026-10-09',60));
 assert.throws(()=>f.db.exec("INSERT INTO manager_capacity_reservations VALUES ('B','2026-10-09',0,1,0,1,'now')"),/capacity_exceeded/);
 assert.throws(()=>f.db.exec("UPDATE manager_capacity_reservations SET production_minutes=100"),/capacity_replace_required/);
 assert.throws(()=>f.db.exec("UPDATE manager_capacity_limits SET production_minutes=1 WHERE date='2026-10-09'"),/capacity_existing_commitments/);
 f.db.exec("UPDATE manager_orders SET revision=1 WHERE id='A'");
 assert.equal((await reserveOrderCapacity(f.env,'A',0,req())).reason,'capacity_stale_order');
 assert.equal((await getCapacitySummary(f.env,'2026-10-09')).used_production_minutes,60);
});
test('legacy commitments missing workload block relevant date; unknown dates report uncertainty',async()=>{
 const f=fixture();f.limits('2026-10-09');f.limits('2026-10-10');
 f.db.exec("UPDATE manager_orders SET production_status='production' WHERE id='B'");
 assert.equal((await getCapacitySummary(f.env,'2026-10-09')).reason,'capacity_uncertain_existing_load');
 assert.equal((await reserveOrderCapacity(f.env,'A',0,req())).reason,'capacity_uncertain_existing_load');
 f.db.exec("INSERT INTO manager_fields(order_id,field_key,value_text,source_occurred_at) VALUES ('B','receive_date','2026-10-10','now')");
 assert.equal((await reserveOrderCapacity(f.env,'A',0,req())).ok,true);
 assert.equal((await getCapacitySummary(f.env,'2026-10-09')).ok,true);
 assert.equal((await getCapacitySummary(f.env,'2026-10-10')).reason,'capacity_unaccounted_existing_load');
 assert.equal((await reserveOrderCapacity(f.env,'A',0,req('2026-10-10'))).reason,'capacity_unaccounted_existing_load');
 assert.equal((await reserveOrderCapacity(f.env,'B',0,req('2026-10-10'))).ok,true);
 assert.equal((await reserveOrderCapacity(f.env,'A',0,req('2026-10-10'))).ok,true);
 f.db.exec("UPDATE manager_orders SET revision=1 WHERE id='B'");
 assert.equal((await getCapacitySummary(f.env,'2026-10-10')).reason,'capacity_unaccounted_existing_load');
 assert.equal((await reserveOrderCapacity(f.env,'A',0,req('2026-10-10'))).reason,'capacity_unaccounted_existing_load');
 f.db.exec("UPDATE manager_orders SET status='cancelled' WHERE id='B'");
 assert.equal((await reserveOrderCapacity(f.env,'A',0,req('2026-10-10'))).ok,true);
});
