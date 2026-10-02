// Read-only historical information. Caller must authenticate the manager.
const WARNING = '【過去情報】当時の価格・在庫・納期・対応条件です。今回の条件や注文確定には使わず、改めて確認してください。保存できた範囲の記録であり、会話の全履歴ではありません。';
const LABELS = { customer_name:'お名前', phone:'電話番号', delivery_address:'住所', product_type:'商品', quantity:'数量', budget:'予算', receive_date:'受取日', receive_time:'受取時間', fulfillment_method:'受取方法', color_vibe:'色・雰囲気', balloon_message:'文字入れ', card_message:'カード', purpose:'用途' };
const cut = (value, length) => String(value || '').slice(0, length);
const rows = async statement => (await statement.all()).results || [];

export function parseHistoryRequest(text) {
  const value = String(text || '').trim();
  let match = value.match(/^履歴詳細\s+(legacy_[a-f0-9]{32}|M[a-f0-9]{16})$/i);
  if (match) return { query:'', detailId:match[1].startsWith('M')||match[1].startsWith('m')?match[1].toUpperCase():match[1].toLowerCase() };
  match = value.match(/^過去情報\s+(M[a-f0-9]{16})$/i);
  if (match) return { query:'', orderId:match[1].toUpperCase() };
  match = value.match(/^(?:過去注文|過去カルテ|履歴検索|注文履歴)\s+(.+)$/);
  if (match) return { query:cut(match[1].trim(),120) };
  match = value.match(/^(?:統括[、,\s]*)?(.+?)(?:さん|様)?の(?:過去の注文|過去注文|注文履歴|過去カルテ|履歴)(?:を|が)?(?:確認したい|確認して|見せて|見たい|教えて|知りたい|確認できますか|お願いします)?(?:ください|下さい|です)?[。？！!?]*$/);
  if (match) return { query:cut(match[1].trim(),120) };
  return null;
}

export async function searchHistory(query, env, {limit=8,offset=0,allowEmpty=false}={}) {
  const needle = cut(String(query || '').trim(),120);
  if (!needle&&!allowEmpty) return {records:[],hasMore:false};
  const size = Math.max(1,Math.min(30,Math.floor(Number(limit)||8)));
  const start = Math.max(0,Math.floor(Number(offset)||0));
  const found = await rows(env.DB.prepare(`
    SELECT id,'import' kind,source_heading label,review_status reviewStatus,raw_text summary,created_at sort_at
    FROM manager_imports WHERE instr(lower(source_heading),lower(?))>0 OR instr(lower(raw_text),lower(?))>0
    UNION ALL
    SELECT o.id,'order' kind,o.title label,'verified' reviewStatus,
      COALESCE((SELECT group_concat(field_key || '：' || value_text,' / ') FROM manager_fields WHERE order_id=o.id),'') summary,o.updated_at sort_at
    FROM manager_orders o WHERE o.status='closed' AND (instr(lower(o.title),lower(?))>0 OR EXISTS
      (SELECT 1 FROM manager_fields f WHERE f.order_id=o.id AND instr(lower(f.value_text),lower(?))>0)
      OR EXISTS (SELECT 1 FROM manager_order_items i WHERE i.order_id=o.id AND instr(lower(i.label || ' ' || i.specification),lower(?))>0))
    ORDER BY sort_at DESC,id LIMIT ? OFFSET ?`).bind(needle,needle,needle,needle,needle,size+1,start));
  return { records:found.slice(0,size).map(({sort_at,...record})=>({...record,label:cut(record.label,120),summary:cut(record.summary,220)})),hasMore:found.length>size };
}

async function orderDetail(order,env) {
  const fields=await rows(env.DB.prepare('SELECT field_key,value_text,status,source_occurred_at,confirmed_at,confirmed_by FROM manager_fields WHERE order_id=? ORDER BY field_key').bind(order.id));
  const items=await rows(env.DB.prepare('SELECT label,specification FROM manager_order_items WHERE order_id=? ORDER BY id').bind(order.id));
  return [`${order.id} ${order.title}`,`記録更新日：${order.updated_at}（注文日とは限りません）`,...fields.map(f=>`${LABELS[f.field_key]||f.field_key}：${f.value_text}${f.status==='confirmed'?'（当時の確認済み）':'（当時の回答・未確定）'}／出典日時：${f.source_occurred_at||'不明'}`),...items.map(i=>`明細 ${i.label}：${i.specification}`)].join('\n');
}

export async function getHistoryDetail(id,env) {
  if (/^legacy_[a-f0-9]{32}$/i.test(String(id))) {
    const record=await env.DB.prepare('SELECT * FROM manager_imports WHERE id=?').bind(id).first();
    if (!record) return '該当する過去カルテは見つかりませんでした。';
    const status=record.review_status==='verified'?'確認済み':'未確認・本人との紐付けは未確定';
    const header=`${WARNING}\n\n${record.source_heading}\n記録状態：${status}\n出典：${record.source_file} ${record.source_line}行\n\n`;
    return cut(header+record.raw_text,4450)+(header.length+record.raw_text.length>4450?'\n（長い記録のため一部省略）':'');
  }
  if (/^M[a-f0-9]{16}$/i.test(String(id))) {
    const order=await env.DB.prepare("SELECT * FROM manager_orders WHERE id=? AND status='closed'").bind(id).first();
    if (order) return cut(`${WARNING}\n\n${await orderDetail(order,env)}`,4500);
  }
  return '該当する終了済みの過去カルテは見つかりませんでした。';
}

export async function formatCustomerHistory(customerId,env,excludeOrderId=null,{relevantKeys=null}={}) {
  if (!customerId) return '';
  // Only trusted structured field names are eligible for a limited summary.
  if(relevantKeys!==null) relevantKeys=Array.isArray(relevantKeys)?relevantKeys.filter(key=>Object.hasOwn(LABELS,key)):[];
  const imports=await rows(env.DB.prepare("SELECT source_heading,raw_text,source_file,source_line,created_at FROM manager_imports WHERE linked_customer_id=? AND review_status='verified' ORDER BY created_at DESC,id LIMIT 3").bind(customerId));
  const orders=await rows(env.DB.prepare("SELECT * FROM manager_orders WHERE customer_id=? AND status='closed' AND id<>? ORDER BY updated_at DESC,id LIMIT 3").bind(customerId,excludeOrderId||''));
  if (!imports.length&&!orders.length) return '';
  const sections=imports.map(r=>`${r.source_heading}\n出典：${r.source_file}:${r.source_line}／保存日：${r.created_at}（注文日とは限りません）\n${relevantKeys?'未構造化の過去記録です。必要な情報は過去カルテで確認してください。':cut(r.raw_text,350)}`);
  for(const order of orders) {
    if(relevantKeys) {
      const fields=await rows(env.DB.prepare('SELECT field_key,value_text,status,source_occurred_at FROM manager_fields WHERE order_id=? ORDER BY field_key').bind(order.id));
      const selected=fields.filter(f=>relevantKeys.includes(f.field_key)&&LABELS[f.field_key]);
      sections.push(`${order.title}／更新日：${order.updated_at}\n${selected.map(f=>`${LABELS[f.field_key]}：${cut(f.value_text,100)}（当時${f.status==='confirmed'?'確認済み':'未確定'}・出典 ${f.source_occurred_at||'不明'}）`).join('\n')||'関連項目の記録なし'}`);
    } else sections.push(cut(await orderDetail(order,env),450));
  }
  const body=`${WARNING}\n本人確認・紐付け済みの過去記録のみ。今回の希望とは区別してください。未記録項目は不明です。「前回と同じ」の希望も今回の確認が必要です。\n\n${sections.join('\n\n')}`;
  return cut(body,1750)+(body.length>1750?'\n（表示上限のため一部省略。過去カルテで詳細確認）':'');
}
