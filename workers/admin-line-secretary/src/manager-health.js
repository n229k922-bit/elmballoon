import {authorizeManagerRequest} from './manager-auth.js';
const HEARTBEAT='manager:maintenance-health';
export async function recordMaintenanceHealth(env,{now=new Date().toISOString(),ok=true,imageArchive=null}={}) {
  if(!env.SECRETARY_KV?.put)return;
  // No customer identifiers, message contents or provider errors in telemetry.
  const counts=imageArchive?Object.fromEntries(['saved','failed','expired'].map(key=>[key,Math.max(0,Number(imageArchive[key])||0)])):null;
  const requiresReview=Boolean(imageArchive&&(imageArchive.failed>0||imageArchive.expired>0||imageArchive.storageError||imageArchive.skipped||['previously_expired','previously_unsupported','retry_exhausted'].some(key=>imageArchive.reasons?.[key]>0)));
  await env.SECRETARY_KV.put(HEARTBEAT,JSON.stringify({at:now,ok,...(counts?{imageArchive:{...counts,requiresReview}}:{})}),{expirationTtl:7*86400});
}
export async function managerHealthApi(request,env,now=new Date().toISOString()) {
  const auth=await authorizeManagerRequest(request,env);if(auth.denied)return auth.denied;
  const headers={'Content-Type':'application/json','Cache-Control':'no-store'};
  if(request.method!=='GET')return new Response(JSON.stringify({error:'method_not_allowed'}),{status:405,headers});
  let heartbeat=null;
  try{heartbeat=JSON.parse(await env.SECRETARY_KV?.get(HEARTBEAT)||'null');}catch{}
  const age=heartbeat?Date.parse(now)-Date.parse(heartbeat.at):NaN;
  const checks=[{id:'maintenance',ok:heartbeat?.ok===true&&Number.isFinite(age)&&age>=-300000&&age<=20*60000,message:'定期処理が20分以内に成功している'}];
  let queues=[];
  try{
    queues=(await env.DB.prepare('SELECT status,COUNT(*) AS count,MIN(created_at) AS oldest FROM manager_outbox GROUP BY status').all()).results||[];
    const pending=(await env.DB.prepare('SELECT COUNT(*) AS count FROM manager_events WHERE processed_at IS NULL AND received_at < ?').bind(new Date(Date.parse(now)-20*60000).toISOString()).first())?.count;
    checks.push({id:'database',ok:true,message:'記録先に接続できる'},{id:'inbox_delay',ok:Number(pending)===0,message:'20分以上未処理の受信がない',count:Number(pending)||0},{id:'delivery_attention',ok:!queues.some(row=>['failed','uncertain','sending'].includes(row.status)&&Number(row.count)>0),message:'失敗・結果不明・処理中の送信を確認する'});
    checks.push({id:'outbox_delay',ok:env.MANAGER_SEND_PAUSED==='true'||!queues.some(row=>row.status==='pending'&&Number(row.count)>0&&(!Number.isFinite(Date.parse(row.oldest))||Date.parse(now)-Date.parse(row.oldest)>20*60000)),message:env.MANAGER_SEND_PAUSED==='true'?'送信停止中。再開前に待機中の内容を確認する':'20分以上滞留している送信待ちがない'});
  }catch{checks.push({id:'database',ok:false,message:'記録先の状態を確認できない'});}
  if(heartbeat?.imageArchive)checks.push({id:'image_archive',ok:!heartbeat.imageArchive.requiresReview,message:'参考画像の保存失敗・期限切れ・設定不足を確認する',counts:heartbeat.imageArchive});
  const healthy=checks.every(check=>check.ok);
  return new Response(JSON.stringify({checkedAt:now,healthy,heartbeat,sendPaused:env.MANAGER_SEND_PAUSED==='true',checks,queues,notice:'外部の死活監視はこの認証付きURLを定期確認し、503または応答なしで担当者へ通知する設定が必要です。'}),{status:healthy?200:503,headers});
}
