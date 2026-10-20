// Consume a dedicated QA entrance, never a link issued to the user.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const link=JSON.parse(await readFile(process.argv[2],'utf8'));
const url=new URL(link.url);
assert.equal(url.origin,'https://elm-balloon-admin-line-secretary-test.n229k922.workers.dev');
const token=new URLSearchParams(url.hash.slice(1)).get('login');
const page=await fetch(url.origin+'/manager');assert.equal(page.status,200);
const html=await page.text();assert.match(html,/今日やること/);assert.match(html,/電話・来店の新しい注文を登録/);
assert.equal((await fetch(url.origin+'/api/manager/orders')).status,401);
const login=await fetch(url.origin+'/api/manager/session',{method:'POST',headers:{Origin:url.origin,'X-Manager-Request':'1','Content-Type':'application/json'},body:JSON.stringify({token})});
assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
const get=path=>fetch(url.origin+'/api/manager/'+path,{headers:{Cookie:cookie}});
const response=await get('orders');assert.equal(response.status,200);const data=await response.json();
assert.equal(data.sendPaused,true);assert.ok(data.today?.date);assert.ok(data.orders.length>=1);
// Search against an order that actually exists in the isolated QA database;
// never depend on a synthetic ID or title that may not be present after a
// safe reset of test data.
const sample=data.orders[0];assert.ok(sample?.id);
const search=await (await get('orders?q='+encodeURIComponent(sample.title))).json();assert.ok(search.orders.some(o=>o.id===sample.id));
assert.equal((await (await get('orders?q=NO-MATCH-6af703')).json()).orders.length,0);
const logout=await fetch(url.origin+'/api/manager/logout',{method:'POST',headers:{Cookie:cookie,Origin:url.origin,'X-Manager-Request':'1'},body:'{}'});assert.equal(logout.status,200);
assert.equal((await get('orders')).status,401);
console.log('Test deployment: login, access denial, dashboard, search, send-paused mode and logout passed. No customer messages sent.');
