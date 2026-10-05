import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
import worker from '../workers/admin-line-secretary/src/index.js';

function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');const root=new URL('../workers/admin-line-secretary/migrations/',import.meta.url);
 for(const f of fs.readdirSync(root).filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync(new URL(f,root),'utf8'));
 class Statement{constructor(sql){this.sql=sql;this.args=[]}bind(...args){this.args=args;return this}async all(){return{results:db.prepare(this.sql).all(...this.args)}}async first(){return db.prepare(this.sql).get(...this.args)||null}async run(){return{meta:{changes:db.prepare(this.sql).run(...this.args).changes}}}}
 const env={ORDER_ENGINE:'v2',MANAGER_TEST_MODE:'true',MANAGER_TEST_CUSTOMER_IDS:'CUSTOMER',ADMIN_LINE_USER_IDS:'OWNER',CUSTOMER_LINE_CHANNEL_SECRET:'customer-test-secret',CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN:'customer-test-token',LINE_CHANNEL_SECRET:'owner-test-secret',LINE_CHANNEL_ACCESS_TOKEN:'owner-test-token',DB:{prepare:sql=>new Statement(sql),async batch(statements){db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}}}};
 const req=(path,user,text,id,secret)=>{const body=JSON.stringify({events:[{type:'message',webhookEventId:id,replyToken:'test-reply-token',timestamp:Date.now(),source:{userId:user},message:{type:'text',id,text}}]});return new Request('https://test.example'+path,{method:'POST',headers:{'Content-Type':'application/json','x-line-signature':createHmac('sha256',secret).update(body).digest('base64')},body})};
 return{db,env,req};
}
test('signed customer receipt leads to owner notice, manager approval and one customer reply',async()=>{
 const f=fixture(),sent=[],original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{assert.match(String(url),/^https:\/\/api\.line\.me\/v2\/bot\/message\/(push|reply)$/);sent.push({url:String(url),body:JSON.parse(options.body)});return new Response('{}',{status:200})};
 try{
  const received=await worker.fetch(f.req('/webhook/customer-line','CUSTOMER','至急、10月10日にブーケ3個、合計3000円で店頭受取を相談したいです','C-EVENT',f.env.CUSTOMER_LINE_CHANNEL_SECRET),f.env);
  assert.equal(received.status,200);assert.equal(sent.filter(s=>s.body.to==='OWNER').length,1);assert.equal(sent.filter(s=>s.body.to==='CUSTOMER').length,0);
  const draft=f.db.prepare('SELECT id FROM manager_drafts').get();assert.match(sent[0].body.messages[0].text,/1：この内容で送信/);
  assert.ok(!sent[0].body.messages[0].text.includes(draft.id));
  await worker.fetch(f.req('/webhook/line','OWNER','1','O-LIST',f.env.LINE_CHANNEL_SECRET),f.env);
  assert.equal(sent.filter(s=>s.body.to==='CUSTOMER').length,0);
  await worker.fetch(f.req('/webhook/line','OWNER','1','O-SELECT',f.env.LINE_CHANNEL_SECRET),f.env);
  assert.equal(sent.filter(s=>s.body.to==='CUSTOMER').length,0);
  const approved=await worker.fetch(f.req('/webhook/line','OWNER','1','O-EVENT',f.env.LINE_CHANNEL_SECRET),f.env);
  assert.equal(approved.status,200);assert.equal(sent.filter(s=>s.body.to==='CUSTOMER').length,1);assert.equal(f.db.prepare('SELECT status FROM manager_drafts').get().status,'sent');
  await worker.fetch(f.req('/webhook/line','OWNER','1','O-EVENT',f.env.LINE_CHANNEL_SECRET),f.env);
  assert.equal(sent.filter(s=>s.body.to==='CUSTOMER').length,1);
 }finally{globalThis.fetch=original}
});
test('business day request updates only store hours after explicit confirmation',async()=>{
 const f=fixture(),original=globalThis.fetch,cache=new Map(),sent=[];
 f.env.SECRETARY_KV={async put(k,v){cache.set(k,v)},async get(k,type){const v=cache.get(k);return v ? type==='json'?JSON.parse(v):v : null},async delete(k){cache.delete(k)}};
 globalThis.fetch=async(url,options)=>{sent.push(JSON.parse(options.body));return new Response('{}',{status:200})};
 const send=(text,id)=>worker.fetch(f.req('/webhook/line','OWNER',text,id,f.env.LINE_CHANNEL_SECRET),f.env);
 try{
  await send('日付変更依頼','H1');assert.match(sent.at(-1).messages[0].text,/店休日・営業時間/);
  await send('営業時間 2026-10-10 13:00-18:00','H2');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_schedule WHERE date='2026-10-10'").get().n,0);
  await send('確定','H3');const hours=f.db.prepare("SELECT * FROM business_schedule WHERE date='2026-10-10'").get();
  assert.equal(hours.open_time,'13:00');assert.equal(hours.close_time,'18:00');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_orders').get().n,0);
  assert.equal(sent.filter(x=>x.to).length,0);
  await send('休業 2026-10-11','H4');await send('取消','H5');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_schedule WHERE date='2026-10-11'").get().n,0);
 }finally{globalThis.fetch=original}
});

test('unknown manager, invalid signatures and missing manager credentials cannot cause a send',async()=>{
 const f=fixture(),original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('No send allowed')};
 try{
  assert.equal((await worker.fetch(f.req('/webhook/line','OTHER','案件一覧','BAD-OWNER',f.env.LINE_CHANNEL_SECRET),f.env)).status,200);
  assert.equal((await worker.fetch(f.req('/webhook/customer-line','CUSTOMER','至急','BAD-SIGN','wrong'),f.env)).status,401);
  delete f.env.LINE_CHANNEL_ACCESS_TOKEN;assert.equal((await worker.fetch(f.req('/webhook/line','OWNER','案件一覧','MISSING',f.env.LINE_CHANNEL_SECRET),f.env)).status,503);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_events').get().n,0);
 }finally{globalThis.fetch=original}
});
