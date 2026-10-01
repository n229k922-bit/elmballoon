import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { createManualOrder as createManualManagerOrder, isManualCustomer } from '../workers/admin-line-secretary/src/manager-intake.js';
import { managerApi } from '../workers/admin-line-secretary/src/manager-console.js';

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  const root = new URL('../workers/admin-line-secretary/migrations/', import.meta.url);
  for (const file of fs.readdirSync(root).filter(x=>x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(file,root),'utf8'));
  class Statement {
    constructor(sql) { this.sql=sql;this.args=[]; }
    bind(...args) { this.args=args;return this; }
    async first() { return db.prepare(this.sql).get(...this.args)||null; }
    async all() { return {results:db.prepare(this.sql).all(...this.args)}; }
    async run() { return {meta:{changes:db.prepare(this.sql).run(...this.args).changes}}; }
  }
  const env={DB:{prepare:sql=>new Statement(sql),async batch(statements){db.exec('BEGIN');try{const rows=[];for(const s of statements)rows.push(await s.run());db.exec('COMMIT');return rows;}catch(e){db.exec('ROLLBACK');throw e;}}}};
  return {db,env,get:(sql,...args)=>db.prepare(sql).get(...args)};
}
const input={requestId:'32e74fa9-50fb-41ef-9e05-97e4badab515',channel:'phone',title:'架空・電話受付テスト',name:'架空のお客様',phone:'090-0000-0000',memo:'相談のみ。注文確定ではない。'};
const now='2026-10-01T01:00:00.000Z';

test('manual intake persists a separate, non-LINE card and never queues a message',async()=>{
  const f=fixture();const result=await createManualManagerOrder(input,'OWNER',f.env,now);
  assert.equal(result.created,true);assert.match(result.orderId,/^M[A-F0-9]{16}$/);
  const order=f.get('SELECT * FROM manager_orders');assert.equal(isManualCustomer(order.customer_id),true);assert.equal(order.status,'open');
  assert.equal(f.get("SELECT value_text FROM manager_fields WHERE field_key='customer_name'").value_text,input.name);
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_outbox').n,0);assert.equal(f.get('SELECT COUNT(*) n FROM manager_drafts').n,0);
  assert.equal(f.get('SELECT processed_at FROM manager_events').processed_at,now);assert.equal(f.get('SELECT actor FROM manager_audit').actor,'OWNER');
});
test('authenticated API registers and retrieves uppercase IDs and rejects invalid requests',async()=>{
  const f=fixture();Object.assign(f.env,{ORDER_ENGINE:'v2',ADMIN_API_TOKEN:'local-only-test-key'});
  const request=value=>new Request('https://example.test/api/manager/intake',{method:'POST',headers:{Authorization:'Bearer local-only-test-key','Content-Type':'application/json'},body:JSON.stringify(value)});
  const response=await managerApi(request(input),f.env);assert.equal(response.status,200);
  const result=await response.json();assert.match(result.orderId,/^M[A-F0-9]{16}$/);
  const detail=await managerApi(new Request(`https://example.test/api/manager/order?id=${result.orderId}`,{headers:{Authorization:'Bearer local-only-test-key'}}),f.env);
  assert.equal(detail.status,200);assert.equal((await detail.json()).order.customer_id,`manual:${input.requestId}`);
  const invalid=await managerApi(request({...input,requestId:'bad'}),f.env);assert.equal(invalid.status,400);
});
test('repeated requests are idempotent and changing a repeated payload is rejected',async()=>{
  const f=fixture();const a=await createManualManagerOrder(input,'OWNER',f.env,now);const b=await createManualManagerOrder(input,'OWNER',f.env,now);
  assert.deepEqual(b,{orderId:a.orderId,created:false});assert.equal(f.get('SELECT COUNT(*) n FROM manager_audit').n,1);
  await assert.rejects(createManualManagerOrder({...input,title:'変更'},'OWNER',f.env,now),e=>e.status===409);
});
test('invalid inputs leave no partial card',async()=>{
  const f=fixture();for(const value of [{...input,requestId:'bad'},{...input,channel:'line'},{...input,title:''},{...input,memo:'x'.repeat(4001)},{...input,phone:'hello'},{...input,name:42}])await assert.rejects(createManualManagerOrder(value,'OWNER',f.env,now),e=>e.status===400);
  await assert.rejects(createManualManagerOrder(input,'',f.env,now),e=>e.status===401);
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_orders').n,0);
});
test('database failure rolls back the entire intake',async()=>{
  const f=fixture();f.db.exec("CREATE TRIGGER fail_intake BEFORE INSERT ON manager_events BEGIN SELECT RAISE(ABORT,'test failure'); END");
  await assert.rejects(createManualManagerOrder(input,'OWNER',f.env,now));
  for(const table of ['manager_orders','manager_fields','manager_audit','manager_events'])assert.equal(f.get(`SELECT COUNT(*) n FROM ${table}`).n,0);
});
test('walk-in cards retain memo verbatim without activating AI replies',async()=>{
  const f=fixture();await createManualManagerOrder({...input,channel:'walkin',name:'',phone:'',memo:'名前入れ「A & B」\n住所は後で確認'},'OWNER',f.env,now);
  assert.equal(f.get("SELECT value_text FROM manager_fields WHERE field_key='intake_channel'").value_text,'来店');
  assert.equal(JSON.parse(f.get('SELECT text FROM manager_events').text).memo,'名前入れ「A & B」\n住所は後で確認');
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_tasks').n,0);
});
