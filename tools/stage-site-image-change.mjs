import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {validateScheduleProofPng} from '../workers/admin-line-secretary/src/schedule-proof.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,target)=>target===root || (!path.relative(root,target).startsWith('..'+path.sep) && !path.isAbsolute(path.relative(root,target)) && path.relative(root,target)!=='..');
async function noLinks(target) {
  let cursor=path.resolve(target);
  for (;;) {
    const info=await fs.lstat(cursor);
    if(info.isSymbolicLink())throw new Error('symlink_not_allowed');
    const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;
  }
}
function relativePath(value) {
  if(!value || path.isAbsolute(value) || /[\\?#%\u0000-\u001f]/u.test(value) || value.split('/').some(part=>!part || part==='.' || part==='..'))throw new Error('unsafe_relative_path');
  return value;
}
function escapeAttr(value) {return value.replace(/&/gu,'&amp;').replace(/"/gu,'&quot;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;');}
function dimensions(bytes) {return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};}

// Produces a review bundle. It never overwrites source/dist or publishes files.
// PNG-only intentionally: every accepted image is fully decoded and checked.
export async function stageSiteImageChange({distDir,page,targetSrc,sourceImage,alt,stagingDir}) {
  if(!distDir || !page || !targetSrc || !sourceImage || !stagingDir || typeof alt!=='string' || !alt.trim() || alt.length>300 || /[\u0000-\u001f]/u.test(alt))throw new Error('explicit_target_source_alt_and_staging_required');
  const root=path.resolve(distDir),pageRelative=relativePath(page),pagePath=path.resolve(root,pageRelative),stage=path.resolve(stagingDir),source=path.resolve(sourceImage);
  if(!pageRelative.endsWith('.html') || inside(root,stage) || inside(stage,root) || inside(root,source))throw new Error('unsafe_staging_or_source_location');
  if(/^[a-z]+:|^\/|[?#%\\\u0000-\u001f]/iu.test(targetSrc) || !targetSrc.toLowerCase().endsWith('.png') || !source.toLowerCase().endsWith('.png'))throw new Error('only_local_png_target_and_source_supported');
  const target=path.resolve(path.dirname(pagePath),targetSrc);
  if(!inside(root,pagePath) || !inside(root,target))throw new Error('path_traversal');
  await noLinks(root);await noLinks(pagePath);await noLinks(target);await noLinks(source);await noLinks(path.dirname(stage));
  try {await fs.lstat(stage);throw new Error('staging_directory_already_exists');} catch(error) {if(error.code!=='ENOENT')throw error;}
  const [htmlBytes,oldImage,newImage]=await Promise.all([fs.readFile(pagePath),fs.readFile(target),fs.readFile(source)]);
  await validateScheduleProofPng(new Uint8Array(oldImage));await validateScheduleProofPng(new Uint8Array(newImage));
  const html=htmlBytes.toString('utf8');
  if(!Buffer.from(html,'utf8').equals(htmlBytes))throw new Error('html_must_be_utf8');
  const searchable=html.replace(/<!--[\s\S]*?-->|<(?:script|style|template|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|template|noscript)\s*>/giu,block=>' '.repeat(block.length));
  const matches=[...searchable.matchAll(/<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu)].filter(match=>{
    const src=match[0].match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/iu);return (src?.[1]??src?.[2])===targetSrc;
  });
  if(matches.length!==1)throw new Error('target_img_must_match_exactly_once');
  const selected=matches[0],tag=selected[0];
  if((tag.match(/\bsrc\s*=/giu)||[]).length!==1 || (tag.match(/\balt\s*=/giu)||[]).length>1 || (/\balt\s*=/iu.test(tag) && !/\balt\s*=\s*(?:"[^"]*"|'[^']*')/iu.test(tag)))throw new Error('ambiguous_image_attributes');
  if(/\b(?:srcset|data-[\w-]*src[\w-]*)\s*=/iu.test(tag) || html.toLowerCase().lastIndexOf('<picture',selected.index)>html.toLowerCase().lastIndexOf('</picture',selected.index))throw new Error('responsive_or_lazy_image_requires_explicit_multi_asset_review');
  const requestId=randomUUID(),assetRelative=path.relative(root,target).split(path.sep).join('/').replace(/\.png$/iu,`.review-${requestId}.png`);
  const newSrc=path.posix.relative(path.posix.dirname(pageRelative),assetRelative);
  let changedTag=tag.replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*')/iu,()=>`src="${escapeAttr(newSrc)}"`);
  if(/\balt\s*=/iu.test(changedTag))changedTag=changedTag.replace(/\balt\s*=\s*(?:"[^"]*"|'[^']*')/iu,()=>`alt="${escapeAttr(alt)}"`);
  else changedTag=changedTag.replace(/\/?\s*>$/u,()=>` alt="${escapeAttr(alt)}">`);
  const newSize=dimensions(newImage);
  for(const key of ['width','height'])changedTag=changedTag.replace(new RegExp(`\\b${key}\\s*=\\s*(?:"[^"]*"|'[^']*'|[0-9]+)`,'iu'),()=>`${key}="${newSize[key]}"`);
  const proposed=Buffer.from(html.slice(0,selected.index)+changedTag+html.slice(selected.index+tag.length),'utf8');
  const oldRelative=path.relative(root,target).split(path.sep).join('/');
  const manifest={version:1,requestId,status:'review_required',published:false,createdAt:new Date().toISOString(),page:pageRelative,
    before:{src:targetSrc,imagePath:oldRelative,imageSha256:hash(oldImage),pageSha256:hash(htmlBytes),...dimensions(oldImage)},
    after:{src:newSrc,imagePath:assetRelative,imageSha256:hash(newImage),pageSha256:hash(proposed),alt,...dimensions(newImage)},
    rollback:{restorePageFrom:`rollback/${pageRelative}`,expectedCurrentPageSha256:hash(proposed),removeNewAssetOnly:assetRelative,originalImageUntouched:true},
    checks:{singleExactTarget:true,decodedPng:true,noSourceMutation:true,alternativeSourcesRejected:true}};
  const files=[[`site/${pageRelative}`,proposed],[`site/${assetRelative}`,newImage],[`rollback/${pageRelative}`,htmlBytes],[`rollback/${oldRelative}`,oldImage]];
  await fs.mkdir(stage);
  for(const [relative,bytes] of files) {const destination=path.join(stage,...relative.split('/'));await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,bytes,{flag:'wx'});}
  await fs.writeFile(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const args=process.argv.slice(2),values={};
  for(let i=0;i<args.length;i+=2)values[args[i]]=args[i+1];
  try {const result=await stageSiteImageChange({distDir:values['--dist'],page:values['--page'],targetSrc:values['--target-src'],sourceImage:values['--source'],alt:values['--alt'],stagingDir:values['--staging-dir']});console.log(JSON.stringify(result,null,2));}
  catch(error) {console.error(JSON.stringify({staged:false,error:error.message}));process.exitCode=1;}
}
