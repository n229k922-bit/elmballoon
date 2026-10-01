// Operator-only: upload private cards to isolated test storage for review.
// Use a dedicated QA entrance, not a link issued to a human.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const link=JSON.parse(await readFile(process.argv[2],'utf8'));
const bundle=JSON.parse(await readFile(process.argv[3],'utf8'));
const url=new URL(link.url);
assert.equal(url.origin,'https://elm-balloon-admin-line-secretary-test.n229k922.workers.dev');
const headers={Origin:url.origin,'X-Manager-Request':'1','Content-Type':'application/json'};
const login=await fetch(url.origin+'/api/manager/session',{method:'POST',headers,body:JSON.stringify({token:new URLSearchParams(url.hash.slice(1)).get('login')})});
assert.equal(login.status,200);headers.Cookie=login.headers.get('set-cookie').split(';')[0];
try {
  const mode=await (await fetch(url.origin+'/api/manager/orders',{headers})).json();assert.equal(mode.sendPaused,true);
  const response=await fetch(url.origin+'/api/manager/import',{method:'POST',headers,body:JSON.stringify(bundle)});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.activated,0);
  const records=await (await fetch(url.origin+'/api/manager/imports',{headers})).json();
  assert.ok(bundle.records.every(row=>records.imports.some(r=>r.id===row.id)));
  const history=await (await fetch(url.origin+'/api/manager/history',{headers})).json();assert.ok(history.records.length>0);
  const detail=await fetch(url.origin+'/api/manager/history-detail?id='+bundle.records[0].id,{headers});assert.equal(detail.status,200);
  const asked=await fetch(url.origin+'/api/manager/command',{method:'POST',headers,body:JSON.stringify({command:'過去注文 '+bundle.records[0].source_heading.split(' ')[0]})});assert.equal(asked.status,200);
  assert.match((await asked.json()).message,/過去情報|検索候補/);
  console.log(JSON.stringify({staged:result.staged,activated:0,historySearch:true,historyDetail:true,managerConversation:true,noCustomerMessages:true}));
} finally {await fetch(url.origin+'/api/manager/logout',{method:'POST',headers,body:'{}'});}
