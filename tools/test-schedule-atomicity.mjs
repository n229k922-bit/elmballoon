import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
import worker from '../workers/admin-line-secretary/src/index.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../workers/admin-line-secretary/migrations/',import.meta.url);
  for (const name of fs.readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(name,migrations),'utf8'));
  class Statement {
    constructor(sql) {this.sql=sql;this.args=[];}
    bind(...args) {this.args=args;return this;}
    async first() {return db.prepare(this.sql).get(...this.args) || null;}
    async all() {return {results:db.prepare(this.sql).all(...this.args)};}
    async run() {return {meta:{changes:db.prepare(this.sql).run(...this.args).changes}};}
  }
  const cache = new Map(), sent = [], batches = [];
  const env = {
    ORDER_ENGINE:'v2',MANAGER_TEST_MODE:'true',ADMIN_LINE_USER_IDS:'OWNER',LINE_CHANNEL_SECRET:'test-owner-secret',LINE_CHANNEL_ACCESS_TOKEN:'mock-only',
    SECRETARY_KV:{async get(key,type) {const value=cache.get(key);return value?(type==='json'?JSON.parse(value):value):null;},async put(key,value) {cache.set(key,value);},async delete(key) {cache.delete(key);}},
    DB:{prepare:sql=>new Statement(sql),async batch(statements) {
      batches.push(statements.map(statement=>statement.sql));
      db.exec('BEGIN');
      try {const result=[];for (const statement of statements) result.push(await statement.run());db.exec('COMMIT');return result;}
      catch (error) {db.exec('ROLLBACK');throw error;}
    }}
  };
  let sequence=0;
  async function send(text,{actor='OWNER',secret=env.LINE_CHANNEL_SECRET}={}) {
    const body=JSON.stringify({events:[{type:'message',webhookEventId:'atomic-'+(++sequence),replyToken:'mock-reply',timestamp:Date.now(),source:{userId:actor},message:{type:'text',id:String(sequence),text}}]});
    const original=globalThis.fetch;
    globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://api.line.me/v2/bot/message/reply');sent.push(JSON.parse(options.body));return new Response('{}');};
    try {return await worker.fetch(new Request('https://test.example/webhook/line',{method:'POST',headers:{'x-line-signature':createHmac('sha256',secret).update(body).digest('base64')},body}),env);}
    finally {globalThis.fetch=original;}
  }
  async function prepare() {await send('店休日変更依頼');await send('1');await send('明日');return JSON.parse(cache.get('site-dialogue:OWNER')).change;}
  return {db,env,cache,sent,batches,send,prepare};
}

for (const existing of [false,true]) {
  test(`signed schedule confirmation: audit failure rolls back ${existing?'existing date update':'new date insert'} and cannot produce completion/image`,async()=>{
    const f=fixture();
    try {
      const change=await f.prepare();
      if (existing) f.db.prepare("INSERT INTO business_schedule(date,status,open_time,close_time,updated_by,updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").run(change.date,'special_hours','10:00','12:00','ORIGINAL');
      const before=f.db.prepare('SELECT * FROM business_schedule WHERE date=?').get(change.date);
      f.db.exec("CREATE TRIGGER reject_schedule_audit BEFORE INSERT ON audit_log WHEN NEW.action='schedule.update' BEGIN SELECT RAISE(ABORT,'injected audit write failure'); END");
      const response=await f.send('1');assert.equal(response.status,200);
      assert.deepEqual(f.db.prepare('SELECT * FROM business_schedule WHERE date=?').get(change.date),before);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM audit_log WHERE action='schedule.update'").get().n,0);
      assert.equal(f.batches.length,1);assert.equal(f.batches[0].length,2);
      const messages=f.sent.at(-1).messages;
      assert.ok(messages.every(message=>message.type==='text'));assert.match(messages[0].text,/変更結果を確認できません/);
      assert.doesNotMatch(messages[0].text,/保存しました|表示も確認できました/);
      await f.send('1');assert.equal(f.batches.length,1);assert.match(f.sent.at(-1).messages[0].text,/終了/);
    } finally {f.db.close();}
  });
}

test('signed successful schedule confirmation commits calendar and audit together exactly once',async()=>{
  const f=fixture();
  try {
    const change=await f.prepare();await f.send('1');
    const saved=f.db.prepare('SELECT * FROM business_schedule WHERE date=?').get(change.date);assert.equal(saved.status,'closed');assert.equal(saved.updated_by,'OWNER');
    const audit=f.db.prepare("SELECT * FROM audit_log WHERE action='schedule.update'").all();assert.equal(audit.length,1);assert.equal(JSON.parse(audit[0].after_json).date,change.date);
    assert.match(f.sent.at(-1).messages[0].text,/保存しました/);assert.match(f.sent.at(-1).messages[0].text,/画像の確認は未完了/);
    await f.send('1');assert.equal(f.batches.length,1);assert.equal(f.db.prepare("SELECT count(*) AS n FROM audit_log WHERE action='schedule.update'").get().n,1);
  } finally {f.db.close();}
});

test('invalid signature or non-owner cannot save a prepared schedule',async()=>{
  const f=fixture();
  try {
    await f.prepare();assert.equal((await f.send('1',{secret:'wrong-secret'})).status,401);await f.send('1',{actor:'NOT_OWNER'});
    assert.equal(f.batches.length,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM business_schedule').get().n,0);
  } finally {f.db.close();}
});
