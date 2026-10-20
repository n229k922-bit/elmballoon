import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Read-only CLI capture. Wrangler handles listing pagination. No key/value is printed.
try {
  const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const relative=path.relative(fileURLToPath(new URL('..',import.meta.url)),path.resolve(config.output));
  if(!relative.startsWith('..'+path.sep))throw new Error('Private output required');
  if(config.namespaceId!=='f14e95ea09e64e069cebcf8531832306')throw new Error('Only the approved test namespace is supported');
  const invoke=args=>execFileSync(process.execPath,[config.wranglerPath,'kv','key',...args,'--namespace-id',config.namespaceId,'--remote','--config',config.wranglerConfig],{maxBuffer:128*1024*1024,stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  const first=JSON.parse(invoke(['list']).toString());
  if(!Array.isArray(first))throw new Error('Unexpected list response');
  const entries=first.map(item=>({key:item.name,valueBase64:invoke(['get',item.name]).toString('base64'),...(item.metadata===undefined?{}:{metadata:item.metadata}),...(item.expiration===undefined?{}:{expiration:item.expiration})}));
  const second=JSON.parse(invoke(['list']).toString());
  const stable=items=>JSON.stringify(items.slice().sort((a,b)=>a.name.localeCompare(b.name)));
  if(stable(first)!==stable(second))throw new Error('Namespace changed during capture; retry while sending is paused');
  fs.writeFileSync(config.output,JSON.stringify(entries),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({captured:entries.length,listingStable:true,pointInTimeGuaranteed:false}));
}catch {console.error('Read-only KV snapshot failed. Private output was not printed.');process.exitCode=1;}
