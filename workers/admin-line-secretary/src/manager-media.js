// Only callers authenticated by managerApi may invoke these helpers.
import { retrieveManagerImage } from './manager-image-archive.js';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const error=(message,status)=>new Response(JSON.stringify({error:message}),{status,headers:{...headers,'Content-Type':'application/json'}});
export async function orderEventPage(env,orderId,cursor='') {
  let before=null;
  if(cursor){try{before=JSON.parse(decodeURIComponent(cursor));}catch{throw new Error('invalid_cursor');}
    if(!Array.isArray(before)||before.length!==2||!before.every(x=>typeof x==='string'&&x.length<180))throw new Error('invalid_cursor');}
  const result=await env.DB.prepare(`SELECT * FROM manager_events WHERE order_id=? ${before?'AND (occurred_at<? OR (occurred_at=? AND id<?))':''} ORDER BY occurred_at DESC,id DESC LIMIT 51`).bind(...(before?[orderId,before[0],before[0],before[1]]:[orderId])).all();
  const events=(result.results||[]).slice(0,50),last=events.at(-1);
  return {events,hasMore:(result.results||[]).length>50,nextCursor:(result.results||[]).length>50?encodeURIComponent(JSON.stringify([last.occurred_at,last.id])):null};
}
export async function orderImage(request,env,orderId,eventId) {
  // No URL or LINE message ID comes from the browser. Resolve both ownership and
  // channel from the recorded customer event before contacting the fixed host.
  const event=await env.DB.prepare(`SELECT e.id,e.order_id,e.customer_id,e.media_message_id FROM manager_events e JOIN manager_orders o ON o.id=e.order_id AND o.customer_id=e.customer_id WHERE e.order_id=? AND e.id=? AND e.direction='customer'`).bind(orderId,eventId).first();
  if(!event||!/^\d{1,40}$/.test(event.media_message_id||''))return error('image_not_found',404);
  const image=await retrieveManagerImage(event,env);
  if(image.error)return error(image.error,image.status);
  return new Response(image.bytes,{headers:{...headers,'Content-Type':image.type,'Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':'inline','X-Image-Archive-Status':image.archive}});
}
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={customer_name:'お名前',phone:'電話番号',delivery_address:'お届け先',product_type:'商品',quantity:'注文数量',receive_date:'受取希望日',use_date:'使用日',receive_time:'受取時間',budget:'予算',budget_scope:'予算の単位',fulfillment_method:'受取方法',color_vibe:'色・雰囲気',purpose:'用途',balloon_message:'文字入れ',card_message:'カード'};
export function orderCardDocument(order,fields,items,changes=[]) {
  const historical=order.status==='closed';
  const lines=fields.filter(f=>labels[f.field_key]).map(f=>[labels[f.field_key],f.value_text,f.status==='confirmed'?'確認済み':'未確定']);
  if(!fields.some(f=>f.field_key==='quantity'))lines.unshift(['注文数量','未確認','未確定']);
  const pending=changes.map(change=>`<tr><th>変更確認待ち：${escape(labels[change.field_key]||'確認内容')}</th><td>${escape(change.old_value||'未記録')} → ${escape(change.new_value)}（変更未承認・制作前に確認）</td></tr>`).join('');
  const body=pending+lines.map(([label,value,status])=>`<tr><th>${escape(label)}</th><td>${escape(value)} <small>（${status}）</small></td></tr>`).join('');
  return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>注文カルテ</title><style>body{font:16px/1.7 system-ui;margin:24px;color:#20372c}main{max-width:850px;margin:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #ccc;padding:10px;white-space:pre-wrap;overflow-wrap:anywhere}th{width:28%}.notice{background:#fff2d7;padding:12px}small{color:#555}p{white-space:pre-wrap}@media print{body{margin:12mm}.tools{display:none}}button{font:inherit;padding:12px}</style><main><h1>${escape(order.title||'注文カルテ')}</h1><p class="notice">${historical?'過去の注文記録です。今回の数量・価格・日時・届け先は改めて確認してください。':'今回の注文内容です。未確定の内容は注文確定ではありません。'} 写真から数量を推測していません。</p><table>${body}</table><h2>商品ごとの仕様</h2>${items.length?items.map(i=>`<p>${escape(i.label)}：${escape(i.specification)}</p>`).join(''):'<p>個別仕様の記録はありません。注文数量は上の「注文数量」を確認してください。</p>'}<p>記録更新：${escape(order.updated_at)}（注文日時とは限りません）</p><p class="tools">ブラウザの印刷・共有操作から、印刷またはPDF保存できます。個人情報を含むため保管先を確認してください。</p></main></html>`,{headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}});
}
