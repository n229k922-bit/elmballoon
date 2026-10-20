import {authorizeManagerRequest} from './manager-auth.js';
import {handleManagerCommand,managerV2Enabled} from './manager-runtime.js';
import {getOperationalReadiness} from './manager-readiness.js';
import {STORE_PROFILE} from './store-profile.js';

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const validDate=value=>/^\d{4}-\d{2}-\d{2}$/u.test(value||'')&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const rows=async(env,sql,...values)=>(await env.DB.prepare(sql).bind(...values).all()).results||[];

export async function managerSetupApi(request,env,now=new Date().toISOString()) {
 const auth=await authorizeManagerRequest(request,env,now);if(auth.denied)return auth.denied;
 if(!managerV2Enabled(env))return json({error:'new_manager_not_enabled'},409);
 if(new URL(request.url).pathname!=='/api/manager/setup')return json({error:'not_found'},404);
 if(request.method==='GET') {
  const readiness=await getOperationalReadiness(env,{now:new Date(now)});
  const limits=await rows(env,'SELECT date,production_minutes,delivery_count,order_count,updated_at FROM manager_capacity_limits WHERE date>=? AND date<=? ORDER BY date',readiness.from,readiness.through);
  const schedule=await rows(env,'SELECT date,status,open_time,close_time FROM business_schedule WHERE date>=? AND date<=? ORDER BY date',readiness.from,readiness.through);
  const days=Array.from({length:14},(_,i)=>new Date(Date.parse(readiness.from+'T00:00:00Z')+i*86400000).toISOString().slice(0,10)).map(date=>({date,capacity:limits.find(row=>row.date===date)||null,schedule:schedule.find(row=>row.date===date)||null}));
  const review=(await rows(env,"SELECT actor,detail,created_at FROM manager_audit WHERE action='schedule.review' ORDER BY id DESC LIMIT 1"))[0]||null;
  let calendarReview=null;try {if(review)calendarReview={...JSON.parse(review.detail),actor:review.actor==='api:admin'?'管理担当':'ログイン中の店長',recordedAt:review.created_at};}catch{}
  return json({readiness,days,calendarReview,storeProfile:STORE_PROFILE});
 }
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 // Bearer admin authentication also requires explicit browser request provenance.
 if(request.headers.get('Origin')!==new URL(request.url).origin||request.headers.get('X-Manager-Request')!=='1')return json({error:'invalid_origin'},403);
 const raw=await request.text();if(raw.length>4000)return json({error:'入力が長すぎます。'},413);
 let body;try {body=JSON.parse(raw);}catch{return json({error:'入力を読み取れません。'},400);}
 if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'入力を読み取れません。'},400);
 if(body.action==='capacity') {
  const keys=['productionMinutes','deliveryCount','orderCount'];
  if(!validDate(body.date)||keys.some(key=>typeof body[key]!=='number'||!Number.isSafeInteger(body[key])||body[key]<0)||body.productionMinutes>1440||body.deliveryCount>10000||body.orderCount>10000)return json({error:'日付と、制作分数・配達件数・注文件数をすべて入力してください。空欄は0件にはしません。'},400);
  const readiness=await getOperationalReadiness(env,{now:new Date(now)});
  if(body.date<readiness.from||body.date>readiness.through)return json({error:'一覧にある今後14日間の日付を選んでください。'},400);
  const summary=`${body.date}：制作${body.productionMinutes}分・配達${body.deliveryCount}件・注文${body.orderCount}件`;
  if(body.confirmed!==true)return json({confirmationRequired:true,summary,message:'この日だけに保存します。休業で全件0の場合も、内容を確認して保存してください。'});
  const message=await handleManagerCommand(`受付上限 ${body.date} ${body.productionMinutes} ${body.deliveryCount} ${body.orderCount}`,auth.actor,env,now);
  if(!message?.includes('の受付上限を記録しました。'))return json({error:message||'受付上限を保存できませんでした。'},409);
  return json({saved:true,message});
 }
 if(body.action==='calendar_review') {
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  if(!validDate(body.reviewedOn)||!validDate(body.through)||body.reviewedOn>today||body.reviewedOn<new Date(Date.parse(today+'T00:00:00Z')-31*86400000).toISOString().slice(0,10)||body.through<today||body.through>new Date(Date.parse(today+'T00:00:00Z')+366*86400000).toISOString().slice(0,10)||typeof body.note!=='string'||body.note.trim().length<5||body.note.length>1000)return json({error:'実際に照合した日、確認済みの対象最終日、照合した資料や内容を入力してください。'},400);
  if(body.confirmed!==true)return json({confirmationRequired:true,summary:`営業予定：${body.through}まで／実確認日：${body.reviewedOn}`,message:'実店舗の定休日・臨時営業時間との照合を行った事実を記録します。ホームページや営業予定自体は変更しません。'});
  const evidence={reviewedOn:body.reviewedOn,through:body.through,note:body.note.trim(),kind:'human_review_record'};
  await env.DB.prepare("INSERT INTO manager_audit(order_id,actor,action,detail,created_at) VALUES(NULL,?,'schedule.review',?,?)").bind(auth.actor,JSON.stringify(evidence),now).run();
  return json({saved:true,message:'営業予定を実店舗の予定と照合した記録を保存しました。'});
 }
 return json({error:'対応していない操作です。'},400);
}

export async function managerSetupPage(request,env) {
 const auth=await authorizeManagerRequest(request,env);if(auth.denied)return auth.denied;
 if(request.method!=='GET')return json({error:'method_not_allowed'},405);
 if(!managerV2Enabled(env))return json({error:'new_manager_not_enabled'},409);
 const page=HTML.replace('<h1>お店の運用準備</h1>','<h1>お店の運用準備</h1><p>'+STORE_PROFILE.notice+'</p><p>制作・配達・注文件数の上限は未定です。店長が案件ごとに確認し、確約前に必要な枠を確認します。</p>');
 return new Response(page,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}});
}

const HTML=`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>お店の運用準備</title><style>body{font:16px/1.6 system-ui;margin:0;background:#f4f7f5;color:#233c31}main{max-width:960px;margin:auto;padding:18px}section{background:white;padding:18px;margin:14px 0;border-radius:12px}h1{font-size:24px}h2{font-size:20px}label{display:block;margin:12px 0}input,select,textarea,button{font:inherit;box-sizing:border-box;padding:12px;border:1px solid #7d9486;border-radius:7px;max-width:100%}input,select,textarea{width:100%}button{background:#245940;color:white;cursor:pointer;min-height:46px}table{width:100%;border-collapse:collapse}td,th{padding:10px;text-align:left;border-bottom:1px solid #d4dfd8}small{display:block;color:#526358}.scroll{overflow:auto}.notice{background:#fff2d7;padding:12px}#message{white-space:pre-wrap}a{color:#245940}</style><main><a href="/manager">注文一覧へ戻る</a><h1>お店の運用準備</h1><p>入力した日だけに反映します。未入力の受付上限や営業予定を、自動で埋めることはありません。</p><p id="message" role="status" aria-live="polite">確認しています…</p><section><h2>準備の状況</h2><div id="gates"></div></section><section><h2>今後14日間</h2><div class="scroll"><table><thead><tr><th>日付</th><th>制作</th><th>配達</th><th>注文</th><th>営業予定の登録</th></tr></thead><tbody id="days"></tbody></table></div><small>営業予定の未登録は休業を意味しません。実店舗の予定と照合してください。</small></section><section><h2>1日分の受付上限を入力</h2><form id="capacity"><label>日付<select id="date" required></select></label><label>制作に使える合計時間（分）<input id="productionMinutes" type="number" min="0" max="1440" step="1" required inputmode="numeric"></label><label>配達できる件数<input id="deliveryCount" type="number" min="0" max="10000" step="1" required inputmode="numeric"></label><label>受けられる注文件数<input id="orderCount" type="number" min="0" max="10000" step="1" required inputmode="numeric"></label><p>休業日にはすべて0を入力してください。空欄は未確認のままです。予約済みの量より小さくすることはできません。</p><button>内容を確認して保存</button></form></section><section><h2>営業予定を照合した記録</h2><p>実店舗の定休日・臨時営業時間を確認してから記録します。営業日の変更は統括への変更依頼で行ってください。</p><form id="review"><label>実際に照合した日<input id="reviewedOn" type="date" required></label><label>何日までの予定を照合しましたか<input id="through" type="date" required></label><label>照合した資料・確認内容<textarea id="note" rows="3" minlength="5" maxlength="1000" required></textarea></label><button>照合した事実を確認して記録</button></form><p id="lastReview"></p></section><section><h2>実物の確認が必要なもの</h2><p class="notice">画像の写り方、別端末でのバックアップ読戻し、スマホでの注文操作は、実際の確認記録が必要です。この画面だけでは合格になりません。</p></section></main><script>
const el=id=>document.getElementById(id);const text=(tag,value)=>{const node=document.createElement(tag);node.textContent=value;return node;};let current;
async function api(body){const response=await fetch('/api/manager/setup',{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Manager-Request':'1'}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw Error(data.error||'確認できませんでした。');return data;}
async function load(){current=await api();el('gates').replaceChildren();const states={ready:'確認済み',configured:'設定あり・実確認待ち',missing:'対応が必要',unknown:'未確認'};for(const gate of current.readiness.gates)el('gates').append(text('p',(states[gate.status]||'未確認')+'：'+gate.message));el('days').replaceChildren();el('date').replaceChildren();for(const day of current.days){const row=document.createElement('tr');for(const value of [day.date,day.capacity?day.capacity.production_minutes+'分':'未確認',day.capacity?day.capacity.delivery_count+'件':'未確認',day.capacity?day.capacity.order_count+'件':'未確認',day.schedule?({open:'営業',closed:'休業',special_hours:'臨時営業時間'}[day.schedule.status]||'要確認'):'未登録'])row.append(text('td',value));el('days').append(row);const option=text('option',day.date);option.value=day.date;el('date').append(option);}const review=current.calendarReview;el('lastReview').textContent=review?'前回の実確認：'+review.reviewedOn+'／対象：'+review.through+'まで／記録者：'+review.actor+'／'+review.note:'照合した記録はまだありません。';fill();}
function fill(){const saved=current.days.find(day=>day.date===el('date').value)?.capacity;for(const [id,key] of [['productionMinutes','production_minutes'],['deliveryCount','delivery_count'],['orderCount','order_count']])el(id).value=saved?saved[key]:'';}
el('date').addEventListener('change',fill);
async function save(body,button){button.disabled=true;try{const preview=await api(body);if(!confirm(preview.summary+'\\n\\n'+preview.message))return;const result=await api({...body,confirmed:true});el('message').textContent=result.message;await load();}catch(error){el('message').textContent=error.message;}finally{button.disabled=false;}}
el('capacity').addEventListener('submit',event=>{event.preventDefault();const keys=['productionMinutes','deliveryCount','orderCount'];if(keys.some(key=>el(key).value.trim()==='')){el('message').textContent='3項目をすべて入力してください。空欄は0にはしません。';return;}save({action:'capacity',date:el('date').value,...Object.fromEntries(keys.map(key=>[key,Number(el(key).value)]))},event.submitter);});
el('review').addEventListener('submit',event=>{event.preventDefault();save({action:'calendar_review',reviewedOn:el('reviewedOn').value,through:el('through').value,note:el('note').value},event.submitter);});
load().then(()=>{el('message').textContent='現在の記録を表示しています。';}).catch(error=>{el('message').textContent=error.message+' 店長アプリにログインしてから開いてください。';});
</script></html>`;
