// Fixed isolated test environment. Creates/cleans only its own short-lived QA
// login, never changes an order, sends a message or enables a queue.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const base='https://elm-balloon-admin-line-secretary-test.n229k922.workers.dev';
const cwd=fileURLToPath(new URL('../workers/admin-line-secretary/',import.meta.url));
const expected=process.argv[2];if(!/^[a-f0-9]{40}$/u.test(expected||''))throw Error('Provide the candidate commit SHA');
if(process.platform!=='win32')throw Error('Local operator script requires Windows');
const sql=command=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`npx --yes wrangler@4.147.0 d1 execute elm-balloon-schedule-test --remote --config wrangler.test.toml --command '${command.replaceAll("'","''")}' --json`],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const hash=value=>createHash('sha256').update(value).digest('hex');
const token=randomBytes(32).toString('hex'),tokenHash=hash(token),actor='mobile-owner';
let cookie=null,sessionHash=null,inserted=false,step='start',failure=false;
try{
 step='public_access';assert.equal((await fetch(base+'/manager')).status,200);assert.equal((await fetch(base+'/api/manager/setup')).status,401);assert.equal((await fetch(base+'/api/manager/order-card?id=M1111111111111111')).status,401);
 step='qa_login';sql(`INSERT INTO manager_login_links(token_hash,actor,expires_at) VALUES ('${tokenHash}','${actor}','${new Date(Date.now()+5*60000).toISOString()}')`);inserted=true;
 const login=await fetch(base+'/api/manager/session',{method:'POST',headers:{Origin:base,'X-Manager-Request':'1','Content-Type':'application/json'},body:JSON.stringify({token})});assert.equal(login.status,200);
 cookie=login.headers.get('set-cookie')?.split(';')[0];const raw=cookie?.slice(cookie.indexOf('=')+1);assert.match(raw||'',/^[a-f0-9]{64}$/u);sessionHash=hash(raw);
 const get=path=>fetch(base+path,{headers:{Cookie:cookie}});
 step='candidate_identity';const readiness=await(await get('/api/manager/readiness')).json();assert.equal(readiness.buildCommit,expected);assert.equal(readiness.queueTransmissionEnabled,false);assert.equal(readiness.acceptance.productionApproved,false);
 step='manager_application';const orderResponse=await get('/api/manager/orders');assert.equal(orderResponse.status,200);const data=await orderResponse.json();assert.equal(data.sendPaused,true);
 const setupPage=await get('/manager/setup');assert.equal(setupPage.status,200);assert.match(await setupPage.text(),/受付上限|営業予定/);
 const setupResponse=await get('/api/manager/setup');assert.equal(setupResponse.status,200);const setup=await setupResponse.json();assert.equal(setup.days.length,14);assert.equal(setup.storeProfile.opens,'10:00');assert.equal(setup.storeProfile.closes,'16:00');
 step='card_and_history';
 // A fresh test session can hide retained older cards in the active list.
 // Inspect those exact existing records instead of silently testing zero cards
 // or seeding another customer/order into the shared final-test environment.
 const examples=data.orders.length?data.orders.slice(0,3):JSON.parse(sql('SELECT id FROM manager_orders ORDER BY created_at DESC LIMIT 2'))[0].results;
 assert.ok(examples.length>0,'A card must actually be inspected');
 let cards=0;for(const order of examples){const card=await get('/api/manager/order-card?id='+encodeURIComponent(order.id));assert.equal(card.status,200);assert.match(card.headers.get('cache-control'),/no-store/);assert.match(await card.text(),/注文数量|数量/);const events=await get('/api/manager/order-events?id='+encodeURIComponent(order.id));assert.equal(events.status,200);assert.ok(Array.isArray((await events.json()).events));cards++;}
 step='unconfigured_image_status';assert.ok(setup.readiness.gates.some(gate=>gate.id==='schedule_image_config'));
 step='monitoring';const health=await get('/api/manager/health');assert.ok([200,503].includes(health.status));assert.ok(Array.isArray((await health.json()).checks));
 console.log(JSON.stringify({scope:'isolated_test_no_messages_sent',candidate:expected,authenticatedSetup:true,cardsChecked:cards,sendPaused:true,operationalGates:setup.readiness.gates.map(({id,status})=>({id,status})),realImageAcceptance:false,mobileAcceptance:false},null,2));
}catch{failure=true;console.error('Test deployment QA failed at '+step+'. Sensitive responses were not logged.');process.exitCode=1;}
finally{
 try{if(cookie){const r=await fetch(base+'/api/manager/logout',{method:'POST',headers:{Cookie:cookie,Origin:base,'X-Manager-Request':'1'},body:'{}'});assert.equal(r.status,200);assert.equal((await fetch(base+'/api/manager/orders',{headers:{Cookie:cookie}})).status,401);}}catch{failure=true;console.error('QA logout needs inspection.');process.exitCode=1;}
 try{if(sessionHash)sql(`DELETE FROM manager_sessions WHERE token_hash='${sessionHash}' AND actor='${actor}'`);if(inserted)sql(`DELETE FROM manager_login_links WHERE token_hash='${tokenHash}' AND actor='${actor}'`);}catch{failure=true;console.error('Own QA records could not be cleaned; existing owner records were not touched.');process.exitCode=1;}
 if(!failure)console.log('Dedicated QA logout and cleanup verified.');
}
