import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {deflateSync} from 'node:zlib';

function miniflare() {
  const explicit=process.env.MINIFLARE_PACKAGE_JSON;
  const cache=path.join(process.env.LOCALAPPDATA || '', 'npm-cache','_npx');
  const candidates=explicit?[explicit]:fs.existsSync(cache)?fs.readdirSync(cache).map(name=>path.join(cache,name,'node_modules','miniflare','package.json')):[];
  for (const candidate of candidates) if(fs.existsSync(candidate)) return createRequire(candidate)('miniflare');
  return null;
}
function crc32(bytes) {let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function chunk(type,data) {const length=Buffer.alloc(4),crc=Buffer.alloc(4),name=Buffer.from(type);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc]);}
function image(width,height,pixelLength=(width*4+1)*height) {const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(pixelLength))),chunk('IEND',Buffer.alloc(0))]);}

const runtime=miniflare();
if(process.env.CI&&!runtime)throw new Error('CI requires the pinned Worker runtime; image acceptance must not silently skip');
test('workerd native deflate validates maximum PNG and rejects expansion bomb without publishing an image',{skip:!runtime?'Install Miniflare or set MINIFLARE_PACKAGE_JSON to run actual Worker runtime acceptance':false,timeout:30000},async()=>{
  const proof=fs.readFileSync(new URL('../workers/admin-line-secretary/src/schedule-proof.js',import.meta.url),'utf8');
  const large=JSON.stringify([...image(2000,2000)]),bomb=JSON.stringify([...image(200,100,64*1024*1024)]);
  const script=`import {scheduleProofMessages,scheduleProofAsset} from './schedule-proof.js';
    export default {async fetch(request,env) {
      const path=new URL(request.url).pathname;
      const bytes=new Uint8Array(path==='/bomb'?${bomb}:${large});
      const change={date:'2026-10-10',status:'special_hours',openTime:'13:00',closeTime:'16:00'};
      const fake=async url=>url.includes('/scrape?')?Response.json({success:true,result:[{selector:'.elm-calendar [data-date="2026-10-10"]',results:[{attributes:[{name:'data-date',value:'2026-10-10'},{name:'data-label',value:'営業時間 13:00〜16:00'},{name:'class',value:'has-special-hours'}]}]},{selector:'.elm-calendar',results:[{attributes:[{name:'data-schedule-source',value:'https://worker.example/api/business-schedule'}]}]}]}):new Response(bytes,{headers:{'Content-Type':'image/png'}});
      const messages=await scheduleProofMessages(change,{...env,SCHEDULE_PROOF_PAGE_URL:'https://public.example/',MANAGER_APP_ORIGIN:'https://worker.example',BROWSER_RENDERING_TOKEN:'mock',CLOUDFLARE_ACCOUNT_ID:'mock'},fake);
      const status=messages[1]? (await scheduleProofAsset(new URL(messages[1].originalContentUrl).pathname,env)).status:null;
      return Response.json({decompression:typeof DecompressionStream,messages,status});
    }};`;
  const options={compatibilityDate:'2026-09-21',modules:[{type:'ESModule',path:'worker.js',contents:script},{type:'ESModule',path:'schedule-proof.js',contents:proof}],kvNamespaces:['SECRETARY_KV']};
  const mf=new runtime.Miniflare(runtime.convertV4MiniflareOptions?runtime.convertV4MiniflareOptions(options):options);
  try {
    const started=performance.now(),good=await(await mf.dispatchFetch('https://local.example/good')).json();
    assert.equal(good.decompression,'function');assert.equal(good.messages[1].type,'image');assert.equal(good.status,200);
    const firstMs=Math.round(performance.now()-started),bombStart=performance.now();
    for(let iteration=0;iteration<5;iteration++) {
      const bad=await(await mf.dispatchFetch('https://local.example/bomb')).json();
      assert.equal(bad.messages.length,1);assert.match(bad.messages[0].text,/未完了/);assert.equal(bad.status,null);
    }
    const bombMs=Math.round(performance.now()-bombStart);
    assert.ok(bombMs<10000,`Five bounded expansion rejections took ${bombMs} ms`);
    console.log(JSON.stringify({runtime:'workerd',maximumPngAndReadbackMs:firstMs,fiveExpansionBombRejectionsMs:bombMs}));
  } finally {await mf.dispose();}
});
