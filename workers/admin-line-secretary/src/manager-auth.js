import { authorizeCalendarAdmin } from './calendar.js';

const COOKIE='__Host-manager-session';
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const allowed=(env,actor)=>[env.ADMIN_LINE_USER_IDS,env.MANAGER_APP_USER_IDS].filter(Boolean).join(',').split(',').map(x=>x.trim()).includes(actor);
const cookie=request=>(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);

export async function createManagerLoginLink(actor,env,now=new Date().toISOString()) {
  if(!allowed(env,actor))return null;
  let origin;try{origin=new URL(env.MANAGER_APP_ORIGIN);}catch{return null;}
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)return null;
  const token=random();
  await env.DB.prepare(`INSERT INTO manager_login_links(token_hash,actor,expires_at) VALUES (?,?,?)`)
    .bind(await hash(token),actor,new Date(Date.parse(now)+10*60_000).toISOString()).run();
  return `${origin.origin}/manager#login=${token}`;
}

export async function managerSessionEndpoint(request,env,now=new Date().toISOString()) {
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  const origin=new URL(request.url).origin;
  if(request.headers.get('Origin')!==origin||request.headers.get('X-Manager-Request')!=='1')return json({error:'invalid_origin'},403);
  if(new URL(request.url).pathname.endsWith('/logout')) {
    const token=cookie(request);
    if(token)await env.DB.prepare('DELETE FROM manager_sessions WHERE token_hash=?').bind(await hash(token)).run();
    return json({ok:true},200,{'Set-Cookie':`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`});
  }
  const raw=await request.text();if(raw.length>500)return json({error:'invalid_link'},400);
  let body;try{body=JSON.parse(raw);}catch{return json({error:'invalid_link'},400);}
  if(!/^[a-f0-9]{64}$/.test(body.token||''))return json({error:'invalid_link'},400);
  const tokenHash=await hash(body.token);
  const link=await env.DB.prepare('SELECT actor,expires_at,consumed_at FROM manager_login_links WHERE token_hash=?').bind(tokenHash).first();
  if(!link||link.consumed_at||link.expires_at<=now||!allowed(env,link.actor))return json({error:'expired_or_used_link'},401);
  const session=random(),sessionHash=await hash(session),expires=new Date(Date.parse(now)+14*86400_000).toISOString();
  // Conditional insert then consume in a single transaction: a link can create one session only.
  const result=await env.DB.batch([
    env.DB.prepare(`INSERT INTO manager_sessions(token_hash,actor,expires_at,created_at)
      SELECT ?,actor,?,? FROM manager_login_links WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?`)
      .bind(sessionHash,expires,now,tokenHash,now),
    env.DB.prepare('UPDATE manager_login_links SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').bind(now,tokenHash),
  ]);
  if(!result[0].meta.changes)return json({error:'expired_or_used_link'},401);
  return json({ok:true,expiresAt:expires},200,{'Set-Cookie':`${COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${14*86400}`});
}

export async function authorizeManagerRequest(request,env,now=new Date().toISOString()) {
  if(request.headers.has('Authorization')) {
    const denied=await authorizeCalendarAdmin(request,env);
    return denied?{denied}:{actor:'api:admin'};
  }
  const token=cookie(request);
  if(!/^[a-f0-9]{64}$/.test(token||''))return {denied:json({error:'unauthorized'},401)};
  const session=await env.DB.prepare('SELECT actor,expires_at FROM manager_sessions WHERE token_hash=?').bind(await hash(token)).first();
  if(!session||session.expires_at<=now||!allowed(env,session.actor))return {denied:json({error:'unauthorized'},401)};
  if(request.method!=='GET' && (request.headers.get('Origin')!==new URL(request.url).origin||request.headers.get('X-Manager-Request')!=='1'))return {denied:json({error:'invalid_origin'},403)};
  return {actor:session.actor};
}
