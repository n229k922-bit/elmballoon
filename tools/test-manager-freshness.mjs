import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { receiveManagerEvents, drainManagerInbox, handleManagerCommand, flushManagerOutbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

function fixture() {
  const db=new DatabaseSync(':memory:');
  const root=new URL('../workers/admin-line-secretary/migrations/',import.meta.url);
  for(const file of fs.readdirSync(root).filter(x=>x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(file,root),'utf8'));
  class Statement {
    constructor(sql){this.sql=sql;this.args=[];}
    bind(...args){this.args=args;return this;}
    async all(){return {results:db.prepare(this.sql).all(...this.args)};}
    async first(){return db.prepare(this.sql).get(...this.args)||null;}
    async run(){return {meta:{changes:db.prepare(this.sql).run(...this.args).changes}};}
  }
  const env={ORDER_ENGINE:'v2',ADMIN_LINE_USER_IDS:'OWNER',LINE_CHANNEL_ACCESS_TOKEN:'owner',CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN:'customer',DB:{prepare:sql=>new Statement(sql),async batch(ss){db.exec('BEGIN');try{const result=[];for(const s of ss)result.push(await s.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}}};
  const now='2026-10-02T01:00:00.000Z';
  const get=(sql,...args)=>db.prepare(sql).get(...args);
  const event=(id,text)=>({type:'message',webhookEventId:id,timestamp:Date.parse(now)-60000,source:{userId:'CUSTOMER'},message:{type:'text',id,text}});
  return {db,env,now,get,event};
}

test('manual update invalidates queued approval without mutating confirmed order facts',async()=>{
  const f=fixture();
  await receiveManagerEvents([f.event('E1','10月10日にブーケ3個、3000円で店頭受取')],f.env,f.now);
  await drainManagerInbox(f.env,'2026-10-02T01:01:00.000Z');
  const draft=f.get('SELECT * FROM manager_drafts'),order=f.get('SELECT * FROM manager_orders');
  await handleManagerCommand(`承認送信 ${draft.id}`,'OWNER',f.env,f.now);
  assert.equal(JSON.parse(f.get("SELECT detail FROM manager_audit WHERE action='reply.approved'").detail).scope,'reply_only');
  const result=await handleManagerCommand(`店頭メモ ${order.id} 電話で受取日変更の相談あり。まだ確定していない`,'OWNER',f.env,f.now);
  assert.match(result,/以前の返信案/);
  assert.equal(f.get('SELECT revision FROM manager_orders').revision,order.revision+1);
  assert.equal(f.get('SELECT status FROM manager_drafts').status,'stale');
  assert.equal(f.get("SELECT status FROM manager_outbox WHERE channel='customer'").status,'cancelled');
  assert.equal(f.get("SELECT value_text FROM manager_fields WHERE field_key='receive_date'").value_text,'2026-10-10');
  let calls=0;await flushManagerOutbox(f.env,f.now,async(_,init)=>{if(JSON.parse(init.body).to==='CUSTOMER')calls++;return new Response('{}');});
  assert.equal(calls,0);
  assert.match(await handleManagerCommand(`承認送信 ${draft.id}`,'OWNER',f.env,f.now),/処理済み/);
  await handleManagerCommand(`返信作成 ${order.id} 日付確認のご連絡です。`,'OWNER',f.env,f.now);
  const fresh=f.get("SELECT * FROM manager_drafts WHERE status='pending'");
  assert.match(await handleManagerCommand(`承認送信 ${fresh.id}`,'OWNER',f.env,f.now),/電話・店頭での対応後の確認/);
  assert.match(await handleManagerCommand(`制作開始 ${order.id}`,'OWNER',f.env,f.now),/最新内容を確認するまで制作開始できません/);
  assert.match(await handleManagerCommand(`対応確認 ${order.id}`,'OWNER',f.env,f.now),/最新内容を確認済み/);
  assert.match(await handleManagerCommand(`対応確認 ${order.id}`,'OWNER',f.env,f.now),/すでに記録済み/);
  assert.match(await handleManagerCommand(`承認送信 ${fresh.id}`,'OWNER',f.env,f.now),/送信待ち/);
});

test('incoming unprocessed customer change blocks approval and bare OK never approves',async()=>{
  const f=fixture();await receiveManagerEvents([f.event('E1','ブーケ希望')],f.env,f.now);await drainManagerInbox(f.env,'2026-10-02T01:01:00.000Z');
  const draft=f.get('SELECT * FROM manager_drafts');
  await receiveManagerEvents([f.event('E2','やっぱり日付変更したい')],f.env,f.now);
  assert.match(await handleManagerCommand(`承認送信 ${draft.id}`,'OWNER',f.env,f.now),/整理中/);
  await handleManagerCommand('OK','OWNER',f.env,f.now);
  assert.equal(f.get("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").n,0);
});

test('manual memo preserves already attempted ambiguous retry payload and retry key',async()=>{
  const f=fixture();await receiveManagerEvents([f.event('E1','ブーケ希望')],f.env,f.now);await drainManagerInbox(f.env,'2026-10-02T01:01:00.000Z');
  const draft=f.get('SELECT * FROM manager_drafts');await handleManagerCommand(`承認送信 ${draft.id}`,'OWNER',f.env,f.now);
  const before=f.get("SELECT * FROM manager_outbox WHERE channel='customer'");
  f.db.prepare("UPDATE manager_outbox SET first_attempt_at=?,status='pending' WHERE id=?").run(f.now,before.id);
  await handleManagerCommand(`電話メモ ${draft.order_id} 店頭で相談中`,'OWNER',f.env,f.now);
  const after=f.get('SELECT * FROM manager_outbox WHERE id=?',before.id);
  assert.equal(after.status,'pending');assert.equal(after.retry_key,before.retry_key);assert.equal(after.text,before.text);
});

test('capacity commands reject unauthorized configuration, zero-day accepts closure, changed specifications require re-review',async()=>{
  const f=fixture();await receiveManagerEvents([f.event('E1','ブーケ希望')],f.env,f.now);await drainManagerInbox(f.env,'2026-10-02T01:01:00.000Z');
  const order=f.get('SELECT * FROM manager_orders');
  assert.equal(await handleManagerCommand('受付上限 2026-10-10 480 3 8','STRANGER',f.env,f.now),null);
  assert.match(await handleManagerCommand('受付上限 2026-10-10 0 0 0','OWNER',f.env,f.now),/記録しました/);
  assert.match(await handleManagerCommand(`受注枠 ${order.id} 2026-10-10 60 0 1`,'OWNER',f.env,f.now),/上限を超え/);
  for(const [key,value] of Object.entries({product_type:'ブーケ',quantity:'3',budget:'3000円',receive_date:'2026-10-10',fulfillment_method:'配達'}))await handleManagerCommand(`項目確定 ${order.id} ${key}：${value}`,'OWNER',f.env,f.now);
  await handleManagerCommand('受付上限 2026-10-10 480 3 8','OWNER',f.env,f.now);
  await handleManagerCommand(`受注枠 ${order.id} 2026-10-10 60 0 1`,'OWNER',f.env,f.now);
  assert.match(await handleManagerCommand(`制作開始 ${order.id}`,'OWNER',f.env,f.now),/配達日の配達枠が未確認/);
  await handleManagerCommand(`受注枠 ${order.id} 2026-10-10 60 1 1`,'OWNER',f.env,f.now);
  assert.match(await handleManagerCommand('受付上限 2026-10-10 10 1 1','OWNER',f.env,f.now),/予約済み/);
  await handleManagerCommand(`項目確定 ${order.id} quantity：4`,'OWNER',f.env,f.now);
  assert.match(await handleManagerCommand(`制作開始 ${order.id}`,'OWNER',f.env,f.now),/確認し直し/);
  await handleManagerCommand(`受注枠 ${order.id} 2026-10-10 80 1 1`,'OWNER',f.env,f.now);
  assert.match(await handleManagerCommand(`制作開始 ${order.id}`,'OWNER',f.env,f.now),/店長確認として記録/);
});

test('multiday booking reserves production before receipt and rejects bad JSON without partial updates',async()=>{
  const f=fixture();await receiveManagerEvents([f.event('E1','ブーケ希望')],f.env,f.now);await drainManagerInbox(f.env,'2026-10-02T01:01:00.000Z');const order=f.get('SELECT * FROM manager_orders');
  for(const [key,value] of Object.entries({product_type:'ブーケ',quantity:'3',budget:'3000円',receive_date:'2026-10-10',fulfillment_method:'店頭受取'}))await handleManagerCommand(`項目確定 ${order.id} ${key}：${value}`,'OWNER',f.env,f.now);
  for(const date of ['2026-10-09','2026-10-10'])await handleManagerCommand(`受付上限 ${date} 480 3 8`,'OWNER',f.env,f.now);
  const requirements=[{date:'2026-10-09',production_minutes:60,delivery_count:0,order_count:0},{date:'2026-10-10',production_minutes:0,delivery_count:0,order_count:1}];
  assert.match(await handleManagerCommand(`受注枠 ${order.id} ${JSON.stringify(requirements)}`,'OWNER',f.env,f.now),/全日程/);
  assert.match(await handleManagerCommand('負荷確認 2026-10-09','OWNER',f.env,f.now),/60／480分/);
  assert.match(await handleManagerCommand(`受注枠 ${order.id} [{wrong}]`,'OWNER',f.env,f.now),/入力形式/);
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_capacity_reservations').n,2);
  assert.match(await handleManagerCommand(`制作開始 ${order.id}`,'OWNER',f.env,f.now),/店長確認として記録/);
});

test('operational report remains read-only and reports unmeasured fields honestly',async()=>{
  const f=fixture();const result=await handleManagerCommand('運用確認','OWNER',f.env,f.now);
  assert.match(result,/未計測/);
  assert.equal(f.get('SELECT COUNT(*) n FROM manager_outbox').n,0);
});

test('lifecycle transitions rebase current booked work and do not block another same-day production',async()=>{
  const f=fixture();await receiveManagerEvents([f.event('E1','ブーケ希望')],f.env,f.now);await drainManagerInbox(f.env,'2026-10-02T01:01:00.000Z');const first=f.get('SELECT * FROM manager_orders');
  const second='M0123456789ABCDEF';
  f.db.prepare('INSERT INTO manager_orders(id,customer_id,created_at,updated_at) VALUES (?,?,?,?)').run(second,first.customer_id,f.now,f.now);
  await handleManagerCommand('受付上限 2026-10-10 480 3 8','OWNER',f.env,f.now);
  for(const orderId of [first.id,second]) {
    for(const [key,value] of Object.entries({product_type:'ブーケ',quantity:'3',budget:'3000円',receive_date:'2026-10-10',fulfillment_method:'店頭受取'}))await handleManagerCommand(`項目確定 ${orderId} ${key}：${value}`,'OWNER',f.env,f.now);
    assert.match(await handleManagerCommand(`受注枠 ${orderId} 2026-10-10 60 0 1`,'OWNER',f.env,f.now),/枠を確保/);
    assert.match(await handleManagerCommand(`制作開始 ${orderId}`,'OWNER',f.env,f.now),/店長確認として記録/);
    assert.equal(f.get('SELECT revision FROM manager_capacity_reservations WHERE order_id=?',orderId).revision,f.get('SELECT revision FROM manager_orders WHERE id=?',orderId).revision);
  }
  assert.equal(f.get('SELECT SUM(production_minutes) n FROM manager_capacity_reservations').n,120);
  await handleManagerCommand(`完成 ${first.id}`,'OWNER',f.env,f.now);
  assert.equal(f.get('SELECT revision FROM manager_capacity_reservations WHERE order_id=?',first.id).revision,f.get('SELECT revision FROM manager_orders WHERE id=?',first.id).revision);
});
