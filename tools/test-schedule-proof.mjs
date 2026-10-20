import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {deflateSync} from 'node:zlib';
import {captureScheduleProof,scheduleProofMessages,scheduleProofAsset,scheduleProofReadiness} from '../workers/admin-line-secretary/src/schedule-proof.js';

const change = {date:'2026-10-10',status:'special_hours',openTime:'13:00',closeTime:'16:00',summary:'10月10日を13:00〜16:00営業'};
function fixture() {
  const values = new Map(), writes = [];
  return {values,writes,SCHEDULE_PROOF_PAGE_URL:'https://test.example/elmballoon/?schedule=test',BROWSER_RENDERING_TOKEN:'mock-secret',CLOUDFLARE_ACCOUNT_ID:'mock',MANAGER_APP_ORIGIN:'https://worker.example',
    SECRETARY_KV:{async put(k,v,options) {values.set(k,v);writes.push({k,options});},async get(k) {return values.get(k);}}};
}
function crc32(bytes) {let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function chunk(type,data) {const size=Buffer.alloc(4),crc=Buffer.alloc(4),name=Buffer.from(type);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([size,name,data,crc]);}
function png({width=700,height=500,pixels,compressed}={}) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',compressed||deflateSync(pixels||Buffer.alloc((width*4+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}
function scraper(options={}) {
  const {label='営業時間 13:00〜16:00',date='2026-10-10',className='has-special-hours',source='https://worker.example/api/business-schedule',duplicate=false}=options;
  const entry={attributes:[{name:'data-date',value:date},{name:'data-label',value:label},{name:'class',value:className}]};
  return new Response(JSON.stringify({success:true,result:[{selector:'.elm-calendar [data-date="2026-10-10"]',results:duplicate?[entry,entry]:[entry]},{selector:'.elm-calendar',results:[{attributes:[{name:'data-schedule-source',value:source}]}]}]}));
}
function provider({scrape={},image=png(),screenshotStatus=200,contentType='image/png'}={}) {
  const calls=[];
  return {calls,async fetch(url,options) {calls.push({endpoint:url,...JSON.parse(options.body)});return url.includes('/scrape?')?scraper(scrape):new Response(image,{status:screenshotStatus,headers:{'Content-Type':contentType}});}};
}
async function incomplete(env,fetcher) {
  const result=await scheduleProofMessages(change,env,fetcher);
  assert.equal(result.length,1);assert.equal(result[0].type,'text');assert.match(result[0].text,/未完了/);assert.doesNotMatch(result[0].text,/表示も確認できました/);
}

test('verified selector screenshot has identical original/preview, readable bytes, seven-day TTL and no credentials in URLs',async()=>{
  const env=fixture(),mock=provider(),messages=await scheduleProofMessages(change,env,mock.fetch);
  assert.equal(messages[1].type,'image');assert.equal(messages[1].originalContentUrl,messages[1].previewImageUrl);
  const capture=mock.calls[1];assert.equal(capture.selector,capture.waitForSelector.selector);assert.match(capture.selector,/^#schedule-proof-/);
  assert.equal(capture.screenshotOptions.clip,undefined);assert.match(capture.addScriptTag[0].content,/cloneNode/);
  assert.ok(mock.calls.every(call=>call.endpoint.endsWith('cacheTTL=0')));assert.ok(mock.calls.every(call=>!call.url.includes('mock-secret')));
  assert.equal(env.writes[0].options.expirationTtl,604800);
  const asset=await scheduleProofAsset(new URL(messages[1].originalContentUrl).pathname,env);
  assert.equal(asset.status,200);assert.equal(asset.headers.get('Content-Type'),'image/png');assert.equal(asset.headers.get('Cache-Control'),'no-store');
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()),png());
});

for(const [name,scrape] of Object.entries({wrong_date:{date:'2026-10-11'},wrong_hours:{label:'営業時間 10:00〜12:00'},swapped_hours:{label:'営業時間 16:00〜13:00'},partial_hours:{label:'営業時間 113:00〜16:00'},wrong_source:{source:'https://production.example/api/business-schedule'},closed_instead:{className:'is-closed'},missing_special_class:{className:''},duplicate_day:{duplicate:true}})) {
  test(`${name}: page mismatch never generates image or completion`,async()=>{const env=fixture(),mock=provider({scrape});await incomplete(env,mock.fetch);assert.equal(env.writes.length,0);assert.equal(mock.calls.length,1);});
}

test('closed and ordinary open require the exact status, and invalid statuses/dates/times never contact provider',async()=>{
  for(const [status,scrape] of [['closed',{className:'is-closed',label:'店休日'}],['open',{className:'',label:'通常営業'}]]) {
    const mock=provider({scrape});assert.ok((await captureScheduleProof({...change,status},fixture(),mock.fetch)).imageUrl);
  }
  for(const invalid of [{status:'anything'},{date:'2026-02-30'},{openTime:'25:00'},{closeTime:'12:00'},{date:'2026-10-10" onclick="x'}]) {
    await assert.rejects(captureScheduleProof({...change,...invalid},fixture(),()=>{throw new Error('must_not_fetch');}),/invalid_change/);
  }
});

test('preflight names missing prerequisites and rejects private pages/query secrets/non-HTTPS without leaking token',async()=>{
  assert.equal(scheduleProofReadiness({}).ready,false);assert.ok(scheduleProofReadiness({}).missing.includes('BROWSER_RENDERING_TOKEN'));
  for(const url of ['https://test.example/manager','https://test.example/manager/','https://test.example/api/','https://test.example/?token=secret','http://test.example/','https://user:pass@test.example/','https://test.example/#private']) {
    const env={...fixture(),SCHEDULE_PROOF_PAGE_URL:url};assert.equal(scheduleProofReadiness(env).ready,false);await incomplete(env,()=>{throw new Error('must_not_fetch');});
  }
  assert.equal(scheduleProofReadiness({...fixture(),MANAGER_APP_ORIGIN:'https://worker.example/manager'}).ready,false);
  assert.equal(JSON.stringify(scheduleProofReadiness(fixture())).includes('mock-secret'),false);
});

for(const [name,image] of Object.entries({signature_only:Buffer.from([137,80,78,71,13,10,26,10]),truncated:png().subarray(0,-3),bad_crc:Buffer.from(png()).fill(255,29,30),tiny:png({width:1,height:1}),bad_pixels:png({compressed:Buffer.from('not zlib')}),wrong_pixel_length:png({pixels:Buffer.alloc(3)}),invalid_filter:png({pixels:Buffer.alloc((700*4+1)*500,255)}),oversized:Buffer.alloc(900001)})) {
  test(`${name}: invalid PNG never stored or attached`,async()=>{const env=fixture(),mock=provider({image});await incomplete(env,mock.fetch);assert.equal(env.writes.length,0);});
}

test('provider HTTP/error JSON, timeout and KV write/read failures never claim screenshot completion',async()=>{
  await incomplete(fixture(),async()=>new Response(JSON.stringify({success:false}),{status:200}));
  await incomplete(fixture(),async()=>{throw new Error('timeout');});
  for(const setup of [{screenshotStatus:500},{contentType:'application/json'}]) {const mock=provider(setup);await incomplete(fixture(),mock.fetch);}
  for(const method of ['put','get']) {const env=fixture(),mock=provider();env.SECRETARY_KV[method]=async()=>{throw new Error('KV unavailable');};await incomplete(env,mock.fetch);}
  const env=fixture(),mock=provider();env.SECRETARY_KV.get=async()=>null;await incomplete(env,mock.fetch);
});

test('expired/malformed/corrupt assets return 404/null/503 and never an image',async()=>{
  const env=fixture(),path='/schedule-proof/4a5c30ac-e019-49e6-92ee-f232bb9593b4.png';
  assert.equal((await scheduleProofAsset(path,env)).status,404);assert.equal(await scheduleProofAsset('/schedule-proof/../../private.png',env),null);
  env.values.set('schedule-proof:4a5c30ac-e019-49e6-92ee-f232bb9593b4',new Uint8Array([1,2]).buffer);
  assert.equal((await scheduleProofAsset(path,env)).status,503);
});

test('same-navigation script refuses redirects and changed source/date/status/hours; freezes only calendar after verification',async()=>{
  const mock=provider();await captureScheduleProof(change,fixture(),mock.fetch);const script=mock.calls[1].addScriptTag[0].content;
  const pageUrl=mock.calls[1].url;
  function run(overrides={}) {
    let copied=null,disconnected=false;
    const attrs={'data-label':'営業時間 13:00〜16:00',class:'has-special-hours',...overrides.attrs};
    const copy={style:{},querySelectorAll:()=>[]};
    const calendar={getAttribute:()=>overrides.source||'https://worker.example/api/business-schedule',querySelectorAll:()=>overrides.noDay?[]:[{getAttribute:name=>attrs[name]}],cloneNode:()=>copy,getBoundingClientRect:()=>({width:700,height:500,...overrides.size})};
    const document={documentElement:{},querySelectorAll:()=>[calendar],body:{style:{},replaceChildren(value){copied=value;}}};
    runInNewContext(script,{location:{href:overrides.pageUrl||pageUrl},document,MutationObserver:class{observe(){}disconnect(){disconnected=true;}}});
    return {copied,disconnected};
  }
  assert.ok(run().copied);assert.equal(run().disconnected,true);
  for(const args of [{pageUrl:'https://other.example/'},{source:'https://production.example/api/business-schedule'},{noDay:true},{attrs:{class:'is-closed'}},{attrs:{'data-label':'営業時間 10:00〜12:00'}},{size:{height:0}}]) assert.equal(run(args).copied,null);
});
