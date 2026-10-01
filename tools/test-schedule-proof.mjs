import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleProofMessages,scheduleProofAsset} from '../workers/admin-line-secretary/src/schedule-proof.js';
const change={date:'2026-10-10',status:'special_hours',openTime:'13:00',closeTime:'16:00',summary:'10月10日を13:00〜16:00営業'};
function fixture(){const values=new Map();return {SCHEDULE_PROOF_PAGE_URL:'https://test.example/',BROWSER_RENDERING_TOKEN:'mock',CLOUDFLARE_ACCOUNT_ID:'mock',MANAGER_APP_ORIGIN:'https://worker.example',SECRETARY_KV:{async put(k,v){values.set(k,v)},async get(k){return values.get(k)}}}}
function scraper(label='営業時間 13:00〜16:00'){return new Response(JSON.stringify({result:[{selector:'.elm-calendar [data-date="2026-10-10"]',results:[{attributes:[{name:'data-date',value:'2026-10-10'},{name:'data-label',value:label},{name:'class',value:'has-special-hours'}]}]},{selector:'.elm-calendar',results:[{left:20,top:200,width:700,height:500,attributes:[{name:'data-schedule-source',value:'https://worker.example/api/business-schedule'}]}]}]}));}
test('verified real page crop yields LINE image and expiring PNG asset',async()=>{
 const env=fixture(),calls=[];const messages=await scheduleProofMessages(change,env,async(url,options)=>{calls.push(JSON.parse(options.body));return calls.length===1?scraper():new Response(new Uint8Array([137,80,78,71,13,10,26,10,0]));});
 assert.equal(messages[1].type,'image');assert.deepEqual(calls[1].screenshotOptions.clip,{x:20,y:200,width:700,height:500});
 assert.equal((await scheduleProofAsset(new URL(messages[1].originalContentUrl).pathname,env)).headers.get('Content-Type'),'image/png');
});
test('missing configuration or mismatched page never claims completed screenshot',async()=>{
 const empty=await scheduleProofMessages(change,{});assert.match(empty[0].text,/未完了/);assert.equal(empty.length,1);
 const mismatch=await scheduleProofMessages(change,fixture(),async()=>scraper('営業時間 10:00〜12:00'));assert.match(mismatch[0].text,/未完了/);assert.equal(mismatch.length,1);
});
