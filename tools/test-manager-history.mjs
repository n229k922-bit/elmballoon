import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {parseHistoryRequest,searchHistory,getHistoryDetail,formatCustomerHistory} from '../workers/admin-line-secretary/src/manager-history.js';
function fixture(){
 const db=new DatabaseSync(':memory:');
 const root=new URL('../workers/admin-line-secretary/migrations/',import.meta.url);
 for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync(new URL(file,root),'utf8'));
 const env={DB:{prepare(sql){let args=[];return{bind(...a){args=a;return this;},async all(){return{results:db.prepare(sql).all(...args)};},async first(){return db.prepare(sql).get(...args)||null;}};}}};
 const imp=(n,name,raw,status='needs_review',customer=null)=>db.prepare('INSERT INTO manager_imports(id,source_hash,source_file,source_heading,source_line,raw_text,review_status,linked_customer_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(`legacy_${String(n).padStart(32,'0')}`,'hash','private.md',name,1,raw,status,customer,'2026-09-01');
 const order=(n,customer,status='closed')=>db.prepare('INSERT INTO manager_orders(id,customer_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(`M${String(n).padStart(16,'0')}`,customer,'卒部ブーケ',status,'2026-09-01','2026-09-02');
 return{db,env,imp,order};
}
test('polite manager history requests parse without consuming unrelated conversations',()=>{
 assert.deepEqual(parseHistoryRequest('山田さんの過去の注文を確認したい'),{query:'山田'});
 assert.deepEqual(parseHistoryRequest('山田さんの過去の注文を教えてください'),{query:'山田'});
 assert.deepEqual(parseHistoryRequest('統括、田中様の注文履歴を見せて。'),{query:'田中'});
 assert.deepEqual(parseHistoryRequest('過去注文 08012345678'),{query:'08012345678'});
 assert.deepEqual(parseHistoryRequest('履歴詳細 legacy_'+'a'.repeat(32)),{query:'',detailId:'legacy_'+'a'.repeat(32)});
 assert.deepEqual(parseHistoryRequest('過去情報 M'+'1'.repeat(16)),{query:'',orderId:'M'+'1'.repeat(16)});
 assert.equal(parseHistoryRequest('今日の注文を承認して'),null);
});
test('search includes private staging and closed cards but excludes active orders, wildcard and SQL expansion',async()=>{
 const f=fixture();f.imp(1,'山田','08012345678 赤ハート');f.order(1,'C');f.order(2,'C','open');
 f.db.prepare('INSERT INTO manager_fields(order_id,field_key,value_text,source_occurred_at) VALUES(?,?,?,?)').run('M'+'0'.repeat(15)+'1','customer_name','山田','2026-09-01');
 f.db.prepare('INSERT INTO manager_fields(order_id,field_key,value_text,source_occurred_at) VALUES(?,?,?,?)').run('M'+'0'.repeat(15)+'2','customer_name','山田','2026-09-01');
 assert.equal((await searchHistory('山田',f.env)).records.length,2);
 assert.equal((await searchHistory('08012345678',f.env)).records.length,1);
 assert.equal((await searchHistory('%',f.env)).records.length,0);
 assert.equal((await searchHistory("' OR 1=1 --",f.env)).records.length,0);
 assert.equal((await searchHistory('',f.env)).records.length,0);
 assert.equal((await searchHistory('',f.env,{allowEmpty:true})).records.length,2);
 const page=await searchHistory('山田',f.env,{limit:1});assert.equal(page.hasMore,true);assert.equal(page.records.length,1);
 assert.equal((await searchHistory('山田',f.env,{limit:1,offset:1})).hasMore,false);
 assert.equal(f.db.prepare('SELECT linked_customer_id FROM manager_imports').get().linked_customer_id,null);
});
test('details preserve source uncertainty and closed item data without accepting open cards',async()=>{
 const f=fixture();f.imp(1,'山田','赤ハート、当時800円');f.order(1,'C');f.order(2,'C','open');
 f.db.prepare('INSERT INTO manager_order_items(id,order_id,label,specification,updated_at) VALUES(?,?,?,?,?)').run('I1','M'+'0'.repeat(15)+'1','1人目','RINO 背番号1','2026-09-01');
 assert.match(await getHistoryDetail('legacy_'+'0'.repeat(31)+'1',f.env),/未確認.*本人/);
 assert.match(await getHistoryDetail('M'+'0'.repeat(15)+'1',f.env),/RINO 背番号1/);
 assert.match(await getHistoryDetail('M'+'0'.repeat(15)+'2',f.env),/見つかりません/);
 f.imp(2,'長文','長'.repeat(10000));assert.ok((await getHistoryDetail('legacy_'+'0'.repeat(31)+'2',f.env)).length<=4500);
});
test('repeat-customer summary is identity-scoped and verified-only with historical warnings',async()=>{
 const f=fixture();f.imp(1,'本人確認済み','赤ハート','verified','C');f.imp(2,'未確認','秘密未確認','needs_review','C');f.imp(3,'別のお客様','別人秘密','verified','OTHER');f.order(1,'C');f.order(2,'OTHER');
 const result=await formatCustomerHistory('C',f.env);assert.match(result,/赤ハート/);assert.match(result,/当時の価格/);assert.doesNotMatch(result,/秘密/);assert.ok(result.length<=1800);
 assert.equal(await formatCustomerHistory('UNKNOWN',f.env),'');assert.equal(await formatCustomerHistory('',f.env),'');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_audit').get().n,0);
});
test('relevant history projection avoids unstructured personal carryover and labels source age',async()=>{
 const f=fixture();f.imp(1,'本人','過去の秘密電話番号','verified','C');f.order(1,'C');
 for(const [key,value] of [['phone','過去電話'],['color_vibe','赤ハート']])f.db.prepare('INSERT INTO manager_fields(order_id,field_key,value_text,source_occurred_at) VALUES(?,?,?,?)').run('M'+'0'.repeat(15)+'1',key,value,'2026-09-01');
 const result=await formatCustomerHistory('C',f.env,null,{relevantKeys:['color_vibe']});
 assert.match(result,/赤ハート/);assert.doesNotMatch(result,/過去電話|秘密電話/);assert.match(result,/注文日とは限りません/);assert.match(result,/未記録項目は不明/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_changes').get().n,0);
});
