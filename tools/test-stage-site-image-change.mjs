import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {stageSiteImageChange} from './stage-site-image-change.mjs';
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc]);}
function png(width=300,height=200){const h=Buffer.alloc(13);h.writeUInt32BE(width);h.writeUInt32BE(height,4);h[8]=8;h[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.alloc((width*4+1)*height))),chunk('IEND',Buffer.alloc(0))]);}
async function fixture(html='<h1>商品</h1><img src="assets/photo.png" width="300" height="200" alt="以前の写真">'){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'elm-image-review-')),dist=path.join(root,'dist'),privateDir=path.join(root,'private');
  await fs.mkdir(path.join(dist,'assets'),{recursive:true});await fs.mkdir(privateDir);
  await fs.writeFile(path.join(dist,'index.html'),html);await fs.writeFile(path.join(dist,'assets','photo.png'),png());await fs.writeFile(path.join(privateDir,'new.png'),png(400,250));
  return{root,dist,source:path.join(privateDir,'new.png'),stage:path.join(privateDir,'proposal'),options:{distDir:dist,page:'index.html',targetSrc:'assets/photo.png',sourceImage:path.join(privateDir,'new.png'),alt:'新しい写真',stagingDir:path.join(privateDir,'proposal')},async cleanup(){await fs.rm(root,{recursive:true,force:true});}};
}
test('isolated proposal has old/new hash, true PNG dimensions, alt and exact rollback; original dist stays unchanged',async()=>{
  const f=await fixture();try{
    const original=await fs.readFile(path.join(f.dist,'index.html')),oldImage=await fs.readFile(path.join(f.dist,'assets','photo.png'));
    const result=await stageSiteImageChange({...f.options,alt:'新しい $& "写真" <参考>'});
    assert.equal(result.published,false);assert.equal(result.status,'review_required');assert.equal(result.before.width,300);assert.equal(result.after.width,400);assert.equal(result.after.height,250);assert.notEqual(result.before.imageSha256,result.after.imageSha256);
    assert.deepEqual(await fs.readFile(path.join(f.dist,'index.html')),original);assert.deepEqual(await fs.readFile(path.join(f.dist,'assets','photo.png')),oldImage);
    const staged=await fs.readFile(path.join(f.stage,'site','index.html'),'utf8');assert.match(staged,/\.review-[a-f0-9-]+\.png/);assert.match(staged,/width="400" height="250"/);assert.ok(staged.includes('新しい $&amp; &quot;写真&quot; &lt;参考&gt;'));
    assert.deepEqual(await fs.readFile(path.join(f.stage,'rollback','index.html')),original);assert.equal(result.rollback.originalImageUntouched,true);
    assert.deepEqual(await fs.readFile(path.join(f.stage,'site',result.after.imagePath)),await fs.readFile(f.source));
    await assert.rejects(stageSiteImageChange(f.options),/already_exists/);
  }finally{await f.cleanup();}
});
for(const [name,override] of Object.entries({missing_alt:{alt:''},path_traversal:{page:'../outside.html'},absolute_target:{targetSrc:'/assets/photo.png'},target_query:{targetSrc:'assets/photo.png?x=1'},svg_source:{sourceImage:'private.svg'}})){
  test(`${name} cannot create a proposal`,async()=>{const f=await fixture();try{await assert.rejects(stageSiteImageChange({...f.options,...override}));await assert.rejects(fs.access(f.stage));}finally{await f.cleanup();}});
}
for(const [name,html] of Object.entries({duplicate:'<img src="assets/photo.png"><img src="assets/photo.png">',srcset:'<img src="assets/photo.png" srcset="small.png 300w">',lazy:'<img src="assets/photo.png" data-src="lazy.png">',picture:'<picture><source srcset="alternative.webp"><img src="assets/photo.png"></picture>',unquoted_alt:'<img src="assets/photo.png" alt=old>',commented:'<!-- <img src="assets/photo.png"> -->',script:'<script>const value=\'<img src="assets/photo.png">\';</script>',template:'<template><img src="assets/photo.png"></template>'})){
  test(`${name} requires explicit multi-asset/attribute review`,async()=>{const f=await fixture(html);try{await assert.rejects(stageSiteImageChange(f.options));await assert.rejects(fs.access(f.stage));}finally{await f.cleanup();}});
}
test('SVG disguised as PNG and corrupt source pixels cannot stage',async()=>{const f=await fixture();try{await fs.writeFile(f.source,'<svg><script>alert(1)</script></svg>');await assert.rejects(stageSiteImageChange(f.options),/invalid_image/);await assert.rejects(fs.access(f.stage));}finally{await f.cleanup();}});
test('stage inside dist and symlink/junction sources are rejected',async()=>{const f=await fixture();try{
  await assert.rejects(stageSiteImageChange({...f.options,stagingDir:path.join(f.dist,'proposal')}),/unsafe_staging/);
  const linked=path.join(f.root,'linked-private');await fs.symlink(path.dirname(f.source),linked,process.platform==='win32'?'junction':'dir');
  await assert.rejects(stageSiteImageChange({...f.options,sourceImage:path.join(linked,'new.png')}),/symlink_not_allowed/);await assert.rejects(fs.access(f.stage));
}finally{await f.cleanup();}});
