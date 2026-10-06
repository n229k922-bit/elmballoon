import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { handleManagerCommand, receiveManagerEvents, drainManagerInbox, flushManagerOutbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

const root = new URL('../workers/admin-line-secretary/migrations/', import.meta.url);
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  for (const f of fs.readdirSync(root).filter(x => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, root), 'utf8'));
  class S { constructor(sql){this.sql=sql;this.args=[]} bind(...a){this.args=a;return this} async all(){return {results:db.prepare(this.sql).all(...this.args)}} async first(){return db.prepare(this.sql).get(...this.args)||null} async run(){return {meta:{changes:db.prepare(this.sql).run(...this.args).changes}}} }
  const env={ORDER_ENGINE:'v2',MANAGER_TEST_MODE:'true',MANAGER_TEST_CUSTOMER_IDS:'TEST-USER',ADMIN_LINE_USER_IDS:'TEST-USER',LINE_CHANNEL_ACCESS_TOKEN:'owner-test',CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN:'customer-test',DB:{prepare:s=>new S(s),async batch(ss){db.exec('BEGIN');try{const r=[];for(const s of ss)r.push(await s.run());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}}};
  const event=(text,id='E1',customer='TEST-USER')=>({type:'message',webhookEventId:id,timestamp:Date.parse('2026-10-06T01:00:00Z'),source:{userId:customer},message:{type:'text',id,text}});
  return {db,env,event};
}

// Local four-role simulation, not a live LINE test. Role is the channel even
// when the customer and owner are the same person. Signed routes are covered
// separately by test-line-e2e.mjs. No external network or real records are used.
const f=fixture(), owner='TEST-USER', customer='TEST-USER', rows=[], deliveries=[];
const deliver=async(_,options)=>{
  const payload=JSON.parse(options.body);
  const role=options.headers.Authorization==='Bearer owner-test'?'統括→店長':'注文担当→お客様';
  deliveries.push({role,payload});rows.push([role,payload.messages[0].text]);
  return new Response('{}',{status:200});
};
async function customerSays(text,id){await receiveManagerEvents([f.event(text,id,customer)],f.env,'2026-10-06T01:00:00Z');await drainManagerInbox(f.env,'2026-10-06T01:01:00Z');rows.push(['お客様',text]);await flushManagerOutbox(f.env,'2026-10-06T01:02:00Z',deliver);}
async function managerSays(text){const answer=await handleManagerCommand(text,owner,f.env,'2026-10-06T01:02:00Z');rows.push(['店長',text,answer]);await flushManagerOutbox(f.env,'2026-10-06T01:02:00Z',deliver);return answer;}
const field=(order,key)=>f.db.prepare('SELECT value_text FROM manager_fields WHERE order_id=? AND field_key=?').get(order,key)?.value_text;

await customerSays('10月10日に卒業祝いのブーケを3個、予算3000円、店頭受取でお願いします','ORDER-1');
await managerSays('返信待ち'); await managerSays('1'); await managerSays('1');
assert.equal(deliveries.filter(d=>d.role==='注文担当→お客様').length,1);
const bouquet=f.db.prepare('SELECT id FROM manager_orders').get().id;
await customerSays('色はおまかせで大丈夫です','ORDER-2');
assert.equal(field(bouquet,'color_vibe'),'おまかせ');
await managerSays('返信待ち'); await managerSays('1'); await managerSays('2 ご希望のお色を確認して制作します😊'); await managerSays('1');
assert.equal(deliveries.filter(d=>d.role==='注文担当→お客様').length,2);
await managerSays('1');
assert.equal(deliveries.filter(d=>d.role==='注文担当→お客様').length,2,'repeated approval never sends another reply');
await customerSays('受取日を10月11日に変更できますか？','ORDER-3');
await managerSays('案件一覧'); await managerSays('1'); await managerSays('3');
await customerSays('別件でスタンド花を1台、納品希望です','ORDER-4');
const stand=f.db.prepare('SELECT id FROM manager_orders WHERE id<>?').get(bouquet).id;
assert.equal(field(stand,'quantity'),'1');
assert.equal(field(stand,'receive_date'),undefined);
assert.equal(field(stand,'budget'),undefined);
assert.equal(field(bouquet,'quantity'),'3');
const previousBudget=field(bouquet,'budget');
await customerSays('予算は15000円です','ORDER-5');
assert.equal(field(bouquet,'budget'),previousBudget,'ambiguous reply does not modify the other order');
assert.equal(field(stand,'budget'),undefined,'ambiguous reply requires explicit routing');
assert.equal(f.db.prepare("SELECT COUNT(*) n FROM manager_tasks WHERE kind='routing'").get().n,1);
await managerSays('返信待ち'); await managerSays('1');

const summary={
  scope:'local simulation with mocked LINE delivery; not live acceptance',
  assertionsPassed:true,
  customerTurns:rows.filter(r=>r[0]==='お客様').length,
  managerActionCount:rows.filter(r=>r[0]==='店長').length,
  drafts:f.db.prepare('SELECT COUNT(*) n FROM manager_drafts').get().n,
  sent:f.db.prepare("SELECT COUNT(*) n FROM manager_drafts WHERE status='sent'").get().n,
  held:f.db.prepare("SELECT COUNT(*) n FROM manager_drafts WHERE status='held'").get().n,
  schedules:f.db.prepare('SELECT COUNT(*) n FROM business_schedule').get().n,
  events:f.db.prepare('SELECT direction,processed_at,text FROM manager_events').all(),
  deliveries,
  transcripts:rows
};
console.log(JSON.stringify(summary,null,2));
f.db.close();
