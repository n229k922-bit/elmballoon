import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {AI_DISCLOSURE,discloseAssistant} from '../workers/admin-line-secretary/src/ai-disclosure.js';
test('production and disabled test do not inspect or change messages',async()=>{
 const DB={prepare(){throw new Error('must not read');}};
 assert.equal(await discloseAssistant('本文','C',{AI_DISCLOSURE_ENABLED:'true',DB}),'本文');
 assert.equal(await discloseAssistant('本文','C',{MANAGER_TEST_MODE:'true',DB}),'本文');
});
test('disclosure is customer scoped, retryable after stale draft and never sends',async()=>{
 const db=new DatabaseSync(':memory:');const root=new URL('../workers/admin-line-secretary/migrations/',import.meta.url);
 for(const f of fs.readdirSync(root).filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync(new URL(f,root),'utf8'));
 const env={MANAGER_TEST_MODE:'true',AI_DISCLOSURE_ENABLED:'true',DB:{prepare(sql){let args;return{bind(...values){args=values;return this;},async first(){return db.prepare(sql).get(...args);}};}}};
 assert.equal(await discloseAssistant('ご用途は？','C',env),AI_DISCLOSURE+'\n\nご用途は？');
 db.exec("INSERT INTO manager_events(id,customer_id,direction,text,occurred_at,received_at) VALUES ('E','C','customer','問合せ','2026-10-05','2026-10-05')");
 db.prepare(`INSERT INTO manager_drafts(id,customer_id,source_event_id,message,created_at) VALUES ('D','C','E',?,'2026-10-05')`).run(AI_DISCLOSURE);
 assert.equal(await discloseAssistant('数量は？','C',env),'数量は？');
 assert.match(await discloseAssistant('数量は？','OTHER',env),/AIアシスタント/);
 db.exec("UPDATE manager_drafts SET status='stale'");assert.match(await discloseAssistant('数量は？','C',env),/AIアシスタント/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM manager_outbox').get().n,0);
});
