// Private KV only. No public links; every read still resolves the order/event.
export const IMAGE_RETENTION_SECONDS=365*86400;
const MAX_BYTES=8*1024*1024,MAX_ATTEMPTS=3;
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value)),b=>b.toString(16).padStart(2,'0')).join('');
export async function imageArchiveKey(event){return 'manager:image:v1:'+await digest(['customer',event.order_id,event.customer_id,event.id,event.media_message_id].join('\0'));}
const dimensions=(w,h)=>w>0&&h>0&&w<=8192&&h<=8192&&w*h<=40000000;
const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;};
export function imageSignatureMatches(bytes,type){
  const b=new Uint8Array(bytes),view=new DataView(b.buffer,b.byteOffset,b.byteLength),s=(start,text)=>start+text.length<=b.length&&text.split('').every((c,i)=>b[start+i]===c.charCodeAt(0));
  try{
    if(type==='image/png'){
      if(b.length<57||![137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v))return false;
      let at=8,first=true,idat=false,ended=false;
      while(at+12<=b.length){const len=view.getUint32(at),end=at+12+len;if(end>b.length)return false;const kind=String.fromCharCode(...b.slice(at+4,at+8));if(crc32(b.slice(at+4,at+8+len))!==view.getUint32(at+8+len))return false;
        if(first){if(kind!=='IHDR'||len!==13||!dimensions(view.getUint32(at+8),view.getUint32(at+12))||b[at+18]!==0||b[at+19]!==0||b[at+20]>1)return false;first=false;}else if(kind==='IHDR')return false;
        if(kind==='IDAT'){if(!len)return false;idat=true;}
        if(kind==='IEND'){if(len!==0||end!==b.length)return false;ended=true;break;}at=end;
      }return idat&&ended;
    }
    if(type==='image/jpeg'){
      if(b.length<25||b[0]!==255||b[1]!==216||b.at(-2)!==255||b.at(-1)!==217)return false;
      let at=2,frame=false,scan=false;
      while(at<b.length-2){if(b[at++]!==255)return false;while(b[at]===255)at++;const marker=b[at++];if(marker===217)return false;if(marker===0||marker===216)return false;if(marker>=208&&marker<=215)continue;
        const len=view.getUint16(at);if(len<2||at+len>b.length-2)return false;
        if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(len<8||!dimensions(view.getUint16(at+5),view.getUint16(at+3)))return false;frame=true;}
        at+=len;if(marker===218){scan=true;break;}
      }return frame&&scan&&at<b.length-2;
    }
    if(type==='image/webp'){
      if(b.length<30||!s(0,'RIFF')||!s(8,'WEBP')||view.getUint32(4,true)+8!==b.length)return false;
      let at=12,frame=false;
      while(at+8<=b.length){const len=view.getUint32(at+4,true),end=at+8+len;if(end>b.length)return false;const p=at+8;
        if(s(at,'VP8 ')){if(len<10||!s(p+3,'\x9d\x01\x2a')||!dimensions(view.getUint16(p+6,true)&16383,view.getUint16(p+8,true)&16383))return false;frame=true;}
        if(s(at,'VP8L')){if(len<5||b[p]!==47)return false;const bits=view.getUint32(p+1,true);if(!dimensions((bits&16383)+1,((bits>>>14)&16383)+1))return false;frame=true;}
        if(s(at,'VP8X')){if(len!==10)return false;const w=1+b[p+4]+(b[p+5]<<8)+(b[p+6]<<16),h=1+b[p+7]+(b[p+8]<<8)+(b[p+9]<<16);if(!dimensions(w,h))return false;}
        at=end+(len%2);
      }return frame&&at===b.length;
    }
    if(type==='image/gif'){
      if(b.length<14||!s(0,'GIF87a')&&!s(0,'GIF89a')||!dimensions(view.getUint16(6,true),view.getUint16(8,true)))return false;
      let at=13+((b[10]&128)?3*2**((b[10]&7)+1):0),frames=0;
      function blocks(){while(at<b.length){const len=b[at++];if(!len)return true;at+=len;if(at>b.length)return false;}return false;}
      while(at<b.length){const tag=b[at++];if(tag===59)return frames>0&&at===b.length;if(tag===33){at++;if(!blocks())return false;}else if(tag===44){if(at+9>b.length||!dimensions(view.getUint16(at+4,true),view.getUint16(at+6,true)))return false;const flags=b[at+8];at+=9;if(flags&128)at+=3*2**((flags&7)+1);if(at>=b.length||b[at]<2||b[at]>8)return false;at++;if(!blocks())return false;frames++;}else return false;}return false;
    }
  }catch{return false;}return false;
}
const usableKV=env=>env.SECRETARY_KV&&typeof env.SECRETARY_KV.get==='function'&&typeof env.SECRETARY_KV.put==='function';
export async function validateManagerImageContent(bytes,type){
  if(!imageSignatureMatches(bytes,type))return false;
  if(type!=='image/png')return true;
  // Validate the actual zlib stream as well as chunk CRCs. Bound decoded bytes
  // before reading so a valid-looking compressed bomb cannot exhaust memory.
  const b=new Uint8Array(bytes),view=new DataView(b.buffer,b.byteOffset,b.byteLength);
  const width=view.getUint32(16),height=view.getUint32(20),depth=b[24],color=b[25],channels={0:1,2:3,3:1,4:2,6:4}[color];
  const depths=color===0?[1,2,4,8,16]:color===3?[1,2,4,8]:[8,16];
  if(!channels||!depths.includes(depth)||b[28]!==0)return false;
  const rowBytes=1+Math.ceil(width*channels*depth/8),expected=rowBytes*height;
  if(expected>32*1024*1024)return false;
  const chunks=[];let at=8,palette=false,seenData=false,endedData=false;
  while(at+12<=b.length){const len=view.getUint32(at),kind=String.fromCharCode(...b.slice(at+4,at+8));
    if(kind==='PLTE'){if(seenData||len<3||len>768||len%3)return false;palette=true;}
    if(kind==='IDAT'){if(endedData)return false;seenData=true;chunks.push(b.slice(at+8,at+8+len));}else if(seenData)endedData=true;
    at+=len+12;
  }
  if(color===3&&!palette)return false;
  let reader;try{reader=new Blob(chunks).stream().pipeThrough(new DecompressionStream('deflate')).getReader();let count=0;while(true){const chunk=await reader.read();if(chunk.done)break;if(count+chunk.value.length>expected){await reader.cancel();return false;}for(let i=0;i<chunk.value.length;i++)if((count+i)%rowBytes===0&&chunk.value[i]>4){await reader.cancel();return false;}count+=chunk.value.length;}return count===expected;}catch{try{await reader?.cancel();}catch{}return false;}
}
export async function retrieveManagerImage(event,env,{fetcher=fetch,now=Date.now(),maintenance=false}={}){
  if(!/^\d{1,40}$/.test(event.media_message_id||''))return {error:'image_not_found',status:404};
  const key=await imageArchiveKey(event),stateKey=key.replace(':image:',':image-state:');let state=null;
  if(usableKV(env)){
    try{
      state=await env.SECRETARY_KV.get(stateKey,'json');
      const bytes=await env.SECRETARY_KV.get(key,'arrayBuffer');
      if(bytes&&state?.status==='saved'&&state.channel==='customer'&&state.key===key&&bytes.byteLength<=MAX_BYTES&&await validateManagerImageContent(bytes,state.type)&&await digest(bytes)===state.sha256)return {bytes,type:state.type,archive:'saved',cached:true};
      if(maintenance&&state){if(state.status==='expired')return {skipped:'previously_expired'};if(state.status==='unsupported')return {skipped:'previously_unsupported'};if(state.attempts>=MAX_ATTEMPTS)return {skipped:'retry_exhausted'};if(Number(state.retryAfter)>now)return {skipped:'retry_wait'};}
    }catch{if(maintenance)return {skipped:'archive_storage_unavailable'};}
  }else if(maintenance)return {skipped:'archive_not_configured'};
  if(!env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN)return {error:'image_channel_unavailable',status:503};
  const attempts=(state?.attempts||0)+1;
  async function failure(code,status,terminal=false){if(usableKV(env)){try{await env.SECRETARY_KV.put(stateKey,JSON.stringify({key,channel:'customer',status:terminal?(code==='image_expired'?'expired':'unsupported'):'failed',error:code,attempts,retryAfter:now+60000*2**Math.min(attempts,4)}),{expirationTtl:IMAGE_RETENTION_SECONDS});}catch{}}return {error:code,status};}
  let response;try{response=await fetcher('https://api-data.line.me/v2/bot/message/'+event.media_message_id+'/content',{headers:{Authorization:'Bearer '+env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN},redirect:'error',signal:AbortSignal.timeout(5000)});}catch{return failure('image_unavailable',502);}
  if(!response.ok)return failure(response.status===404||response.status===410?'image_expired':'image_unavailable',response.status===404||response.status===410?410:502,response.status===404||response.status===410);
  const type=(response.headers.get('Content-Type')||'').split(';')[0].toLowerCase();
  if(!['image/png','image/jpeg','image/gif','image/webp'].includes(type))return failure('unsupported_image',415,true);
  if(Number(response.headers.get('Content-Length'))>MAX_BYTES)return failure('image_too_large',413,true);
  const reader=response.body?.getReader();if(!reader)return failure('image_unavailable',502);
  const chunks=[];let size=0;try{while(true){const value=await reader.read();if(value.done)break;size+=value.value.length;if(size>MAX_BYTES){await reader.cancel();return failure('image_too_large',413,true);}chunks.push(value.value);}}catch{return failure('image_unavailable',502);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  if(!await validateManagerImageContent(bytes,type))return failure('invalid_image_content',415,true);
  let archive='not_configured';
  if(usableKV(env)){try{await env.SECRETARY_KV.put(key,bytes.buffer,{expirationTtl:IMAGE_RETENTION_SECONDS});await env.SECRETARY_KV.put(stateKey,JSON.stringify({key,channel:'customer',status:'saved',type,sha256:await digest(bytes),savedAt:new Date(now).toISOString(),expiresAt:new Date(now+IMAGE_RETENTION_SECONDS*1000).toISOString(),attempts}),{expirationTtl:IMAGE_RETENTION_SECONDS});archive='saved';}catch{archive='failed';}}
  return {bytes,type,archive};
}
export async function archivePendingManagerImages(env,{limit=5,fetcher=fetch,now=Date.now()}={}){
  if(!usableKV(env))return {skipped:'archive_not_configured',saved:0};
  if(!env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN)return {skipped:'image_channel_unavailable',saved:0};
  const cap=Math.max(1,Math.min(5,Math.floor(Number(limit)||5))),cursorKey='manager:image-scan:v1';let cursor=null;
  try{cursor=await env.SECRETARY_KV.get(cursorKey,'json');}catch{return {skipped:'archive_storage_unavailable',saved:0};}
  if(!Array.isArray(cursor)||cursor.length!==2||!cursor.every(v=>typeof v==='string'))cursor=null;
  const page=(await env.DB.prepare(`SELECT e.id,e.order_id,e.customer_id,e.media_message_id,e.occurred_at FROM manager_events e JOIN manager_orders o ON o.id=e.order_id AND o.customer_id=e.customer_id WHERE e.direction='customer' AND e.processed_at IS NOT NULL AND e.media_message_id IS NOT NULL ${cursor?'AND (e.occurred_at<? OR (e.occurred_at=? AND e.id<?))':''} ORDER BY e.occurred_at DESC,e.id DESC LIMIT 10`).bind(...(cursor?[cursor[0],cursor[0],cursor[1]]:[])).all()).results||[];
  const result={saved:0,failed:0,expired:0,skipped:0,attempted:0,reasons:{}};let last=null;
  for(const event of page){last=event;const image=await retrieveManagerImage(event,env,{fetcher,now,maintenance:true});if(image.skipped||image.cached){result.skipped++;const reason=image.cached?'already_saved':image.skipped;result.reasons[reason]=(result.reasons[reason]||0)+1;continue;}if(image.bytes&&image.archive==='saved'){
      result.saved++;
    }else if(image.error==='image_expired'){result.expired++;result.reasons.image_expired=(result.reasons.image_expired||0)+1;}else{result.failed++;const reason=image.archive==='failed'?'archive_save_failed':image.error||'unknown_error';result.reasons[reason]=(result.reasons[reason]||0)+1;}
    result.attempted++;if(result.attempted>=cap)break;
  }
  // Small pages bound KV subrequests; keyset rotation still covers >100 records.
  try{await env.SECRETARY_KV.put(cursorKey,JSON.stringify(last&&(result.attempted>=cap||page.length===10)?[last.occurred_at,last.id]:null));}catch{result.storageError=true;result.reasons.archive_cursor_write_failed=1;}
  return result;
}
