// Reviewed offers are explicit owner evidence, never generated from a budget.
const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const one = (env, sql, ...args) => stmt(env, sql, ...args).first();
const all = async (env, sql, ...args) => (await stmt(env, sql, ...args).all()).results || [];
const uid = prefix => prefix + crypto.randomUUID().replaceAll('-', '').slice(0,16).toUpperCase();
const date = value => /^\d{4}-\d{2}-\d{2}$/u.test(value || '') && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const time = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value || '');
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
export const AGREEMENT_FIELDS = ['item_specification','quoted_total','personalization_fee','feasibility','customer_agreement'];

export async function reviewedAgreementError(order,env) {
  const fields=Object.fromEntries((await all(env,'SELECT field_key,value_text,status FROM manager_fields WHERE order_id=?',order.id)).map(f=>[f.field_key,f]));
  const agreement=fields.customer_agreement;
  const c=agreement && await one(env,"SELECT * FROM manager_changes WHERE id=? AND order_id=? AND field_key='reviewed_proposal' AND status='approved'",agreement.value_text,order.id);
  if(!c)return '店長確認済みの商品構成・税込総額・名入れ料金・可否と、同じ版へのお客様の承諾が必要です。予算や「OK」だけでは制作を開始できません。「提案作成」で最新条件を確認してください。';
  let p;try{p=JSON.parse(c.new_value);}catch{return '承諾済み提案を確認できません。';}
  if(validateProposal(p))return '承諾済み提案の必須条件が不足しています。';
  const expected={item_specification:JSON.stringify(p.items),quoted_total:String(p.total_yen),personalization_fee:String(p.personalization_fee_yen),feasibility:'店長確認済み',customer_agreement:c.id,product_type:p.items.map(i=>i.type).join('／'),quantity:String(p.items.reduce((n,i)=>n+i.quantity,0)),balloon_message:p.balloon_message,receive_date:p.receive_date,receive_time:p.receive_time,use_date:p.use_date,fulfillment_method:p.fulfillment_method};
  if(Object.entries(expected).some(([k,v])=>fields[k]?.status!=='confirmed'||fields[k].value_text!==v))return '現在のカルテと承諾済み提案が一致しません。変更条件を店長とお客様に確認してください。';
  let original;try{original=JSON.parse(c.old_value);}catch{return '提案前の条件を確認できません。';}
  const agreed={...original,...expected};
  if(Object.entries(fields).some(([k,f])=>!Object.hasOwn(agreed,k)||f.value_text!==agreed[k]))return 'ご承諾のあとに条件が変わっています。最新のご提案を確認してください。';
  return null;
}

export async function commercialReplyError(draft,env) {
  const proposal=await one(env,"SELECT c.*,e.text AS original_message,o.revision FROM manager_changes c JOIN manager_events e ON e.id=c.source_event_id JOIN manager_orders o ON o.id=c.order_id WHERE c.source_event_id=? AND c.field_key='reviewed_proposal'",draft.source_event_id);
  if(proposal){
    if(proposal.status!=='pending'||proposal.revision!==proposal.base_revision||proposal.original_message!==draft.message)return '店長提案の文面・版が変わっています。提案作成から条件を再確認してください。';
    try{return validateProposal(JSON.parse(proposal.new_value));}catch{return '提案内容を確認できません。';}
  }
  // Commercial promises use the structured offer route, including manually
  // edited replies. A normal acknowledgement/question remains available.
  const clauses=draft.message.split(/[。\n！？!?、]/u).map(s=>s.trim());
  if(clauses.some(clause=>{
    const qualified=/確認|未確定|未確認|確約でき|できません|出来ません|無料では|無料じゃ|かどうか|可能か|できるか|出来るか|お見積り|見積もり/u.test(clause);
    return !qualified && /(?:ご予約|ご注文|予約|注文).{0,5}(?:承り|確定|お受け)|(?:ご用意|制作|製作|名入れ|対応|お届け).{0,8}(?:できます|出来ます|可能です|いたします|します)|(?:無料|料金は?\s*\d|税込(?:総額)?[：:\s]*\d|合計[：:\s]*\d)|\d[\d,]*円(?:で|にて)(?:ご用意|承り|対応|制作)|必ず(?:間に合|お届け)/u.test(clause);
  }))return '価格・制作可否・名入れ料金・受注の確約は「提案作成」で具体条件を確認してください。通常の質問や確認中のご案内は送れます。';
  return null;
}

export function validateProposal(p) {
  if (!p || !Array.isArray(p.items) || !p.items.length || p.items.length > 20 || p.items.some(i => !nonempty(i.type) || !nonempty(i.size) || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 999)) return '商品構成の種類・個数・サイズを明記してください。';
  if (!Number.isInteger(p.total_yen) || p.total_yen < 0 || p.total_yen > 10000000 || p.tax_included !== true) return '税込総額を整数の円で確定してください。予算は価格として扱いません。';
  if (!Number.isInteger(p.personalization_fee_yen) || p.personalization_fee_yen < 0 || p.personalization_fee_yen > p.total_yen) return '名入れ料金を明記してください（なし・無料なら0円）。';
  if (p.feasible !== true) return '制作・商品・名入れの可否を店長が確認してください。';
  if (!date(p.receive_date) || !date(p.use_date) || !time(p.receive_time) || p.receive_date > p.use_date || !nonempty(p.fulfillment_method)) return '実在する受取日・時刻・使用日・受取方法を確認してください。';
  if (!nonempty(p.balloon_message)) return '名入れの文字列を明記してください（不要なら「なし」）。';
  return null;
}

export async function createReviewedProposal(orderId, json, actor, env, now) {
  let p; try { p = JSON.parse(json); } catch { return '提案のJSON形式を確認してください。'; }
  const error = validateProposal(p); if (error) return error;
  const order = await one(env, "SELECT * FROM manager_orders WHERE id=? AND status='open'", orderId);
  if (!order) return '進行中のカルテがありません。';
  const incoming = await one(env, "SELECT id FROM manager_events WHERE customer_id=? AND processed_at IS NULL AND direction='customer' LIMIT 1", order.customer_id);
  if (incoming) return '新しいお客様の発言を整理してから最新条件で提案してください。';
  const fields = await all(env, 'SELECT field_key,value_text FROM manager_fields WHERE order_id=?',orderId);
  const previous = Object.fromEntries(fields.map(f=>[f.field_key,f.value_text]));
  // Changing receipt is never permission to change the event date.
  if (previous.use_date && previous.use_date !== p.use_date) return '使用日がカルテと異なります。使用日変更を別途確認してください。';
  const changeId=uid('C'), eventId=uid('O'), draftId=uid('D');
  const message = `店長からのご提案です。\n${p.items.map(i=>`${i.type} ${i.quantity}個（${i.size}）`).join('\n')}\n名入れ：${p.balloon_message}／名入れ料金${p.personalization_fee_yen}円（税込総額に含む）\n税込総額：${p.total_yen}円\n受取：${p.receive_date} ${p.receive_time}／${p.fulfillment_method}\n使用日：${p.use_date}のままです。\n以上の構成・金額・受取変更・使用日でよろしければ「はい、その内容で」とお返事ください。変更があればお知らせください。`;
  await env.DB.batch([
    stmt(env,"UPDATE manager_changes SET status='superseded',reviewed_by=?,reviewed_at=? WHERE order_id=? AND field_key='reviewed_proposal' AND status='pending'",actor,now,orderId),
    stmt(env,"UPDATE manager_drafts SET status='stale' WHERE order_id=? AND status IN ('pending','held','approved')",orderId),
    stmt(env,"INSERT INTO manager_events(id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at) VALUES (?,?,?,'owner',?,?,?,?)",eventId,order.customer_id,orderId,message,now,now,now),
    stmt(env,"INSERT INTO manager_changes(id,order_id,field_key,old_value,new_value,source_event_id,base_revision) VALUES (?,?,'reviewed_proposal',?,?,?,?)",changeId,orderId,JSON.stringify(previous),JSON.stringify(p),eventId,order.revision),
    stmt(env,'INSERT INTO manager_drafts(id,order_id,customer_id,source_event_id,base_revision,message,created_at) VALUES (?,?,?,?,?,?,?)',draftId,orderId,order.customer_id,eventId,order.revision,message,now),
    stmt(env,"INSERT INTO manager_tasks(id,order_id,kind,detail,due_at,created_at) VALUES (?,?,'reply',?,?,?)",`reply:${draftId}`,orderId,`店長提案 ${changeId}`,now,now),
    stmt(env,"INSERT INTO manager_audit(order_id,actor,action,detail,created_at) VALUES (?,?,'proposal.created',?,?)",orderId,actor,JSON.stringify({changeId,draftId,revision:order.revision,proposal:p}),now),
  ]);
  return `${message}\n\n提案 ${changeId} を返信案に保存しました。まだ送っていません。「返信待ち」で承認してください。承諾前のカルテは維持します。`;
}

export async function acceptReviewedProposal(events, env, now) {
  const text=events.map(e=>e.text).join('\n').normalize('NFKC').trim();
  const explicit=text.match(/^提案承諾\s+(C[A-F0-9]{16})(?:\s+使用日\d{4}-\d{2}-\d{2}のまま)?[。!！]?$/iu);
  const natural=/^(?:(?:はい|OK(?:です)?|オーケー|大丈夫です|お願いします)[、,。!！\s]*)?(?:(?:その|この|ご提案の|提案の)内容で(?:お願いします|大丈夫です|OKです)?|それでお願いします|承諾します|はい|OK(?:です)?|オーケー|大丈夫です|お願いします)[。!！\s]*$/iu.test(text);
  if (!explicit && !natural) return false;
  const customer=events[0].customer_id;
  const candidates=await all(env,`SELECT c.*,o.customer_id,o.revision,o.status AS order_status,d.id AS draft_id,d.status AS draft_status,d.message AS proposal_message FROM manager_changes c JOIN manager_orders o ON o.id=c.order_id JOIN manager_drafts d ON d.source_event_id=c.source_event_id WHERE o.customer_id=? AND c.field_key='reviewed_proposal' AND c.status='pending'`,customer);
  // No offer exists: leave ordinary thanks/OK to the normal conversation engine.
  if (!candidates.length && !explicit) return false;
  const active=await all(env,"SELECT id FROM manager_orders WHERE customer_id=? AND status='open'",customer);
  const c=explicit ? candidates.find(c=>c.id===explicit[1].toUpperCase()) : candidates.length===1&&active.length===1 ? candidates[0] : null;
  let error=!c ? 'どのご提案へのお返事か確認します。ご注文の内容はまだ変更していません。' : c.order_status!=='open'||c.revision!==c.base_revision ? 'ご提案のあとに条件が変わっています。最新の内容を担当者が確認します。' : c.draft_status!=='sent' ? 'ご提案の送信確認ができないため、内容を担当者が確認します。' : null;
  let p; if(c){try{p=JSON.parse(c.new_value);}catch{error='提案内容を確認できないため、担当者が確認します。';}if(p)error ||= validateProposal(p);}
  const event=events.at(-1),replyId=uid('D');
  if (!error) {
    const sent=await one(env,"SELECT id,sent_at FROM manager_outbox WHERE draft_id=? AND channel='customer' AND status='sent' LIMIT 1",c.draft_id);
    if(!sent)error='ご提案の送信確認ができないため、内容を担当者が確認します。';
    else if(!sent.sent_at || events.some(e=>!Number.isFinite(Date.parse(e.occurred_at))||Date.parse(e.occurred_at)<Date.parse(sent.sent_at)))error='ご提案より前のお返事のため、最新の内容へのご承諾を確認します。';
  }
  const batch=[];
  if (!error) {
    const reviewer=`customer:${event.id}`;
    batch.push(stmt(env,"UPDATE manager_changes SET status='approved',reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM manager_orders WHERE id=? AND revision=? AND status='open')",reviewer,now,c.id,c.order_id,c.base_revision));
    batch.push(stmt(env,"UPDATE manager_orders SET revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM manager_changes WHERE id=? AND status='approved' AND reviewed_by=? AND reviewed_at=?)",now,c.order_id,c.base_revision,c.id,reviewer,now));
    const values={item_specification:JSON.stringify(p.items),quoted_total:String(p.total_yen),personalization_fee:String(p.personalization_fee_yen),feasibility:'店長確認済み',customer_agreement:c.id,product_type:p.items.map(i=>i.type).join('／'),quantity:String(p.items.reduce((n,i)=>n+i.quantity,0)),balloon_message:p.balloon_message,receive_date:p.receive_date,receive_time:p.receive_time,use_date:p.use_date,fulfillment_method:p.fulfillment_method};
    for(const [key,value] of Object.entries(values))batch.push(stmt(env,`INSERT INTO manager_fields(order_id,field_key,value_text,status,source_event_id,source_occurred_at,confirmed_by,confirmed_at) SELECT ?,?,?,'confirmed',?,?,?,? WHERE EXISTS(SELECT 1 FROM manager_changes c JOIN manager_orders o ON o.id=c.order_id WHERE c.id=? AND c.status='approved' AND c.reviewed_by=? AND o.revision=?) ON CONFLICT(order_id,field_key) DO UPDATE SET value_text=excluded.value_text,status=excluded.status,source_event_id=excluded.source_event_id,source_occurred_at=excluded.source_occurred_at,confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at`,c.order_id,key,value,event.id,event.occurred_at,reviewer,now,c.id,reviewer,c.base_revision+1));
    batch.push(stmt(env,"UPDATE manager_changes SET status='superseded',reviewed_by=?,reviewed_at=? WHERE order_id=? AND status='pending' AND field_key<>'reviewed_proposal' AND EXISTS(SELECT 1 FROM manager_changes agreed JOIN manager_orders o ON o.id=agreed.order_id WHERE agreed.id=? AND agreed.status='approved' AND agreed.reviewed_by=? AND o.revision=?)",reviewer,now,c.order_id,c.id,reviewer,c.base_revision+1));
    batch.push(stmt(env,"UPDATE manager_drafts SET status='stale' WHERE order_id=? AND status IN ('pending','held','approved') AND EXISTS(SELECT 1 FROM manager_changes agreed JOIN manager_orders o ON o.id=agreed.order_id WHERE agreed.id=? AND agreed.status='approved' AND agreed.reviewed_by=? AND o.revision=?)",c.order_id,c.id,reviewer,c.base_revision+1));
    batch.push(stmt(env,"INSERT INTO manager_audit(order_id,actor,action,detail,created_at) SELECT ?,?,'proposal.accepted',?,? WHERE EXISTS(SELECT 1 FROM manager_changes WHERE id=? AND reviewed_by=? AND status='approved')",c.order_id,reviewer,JSON.stringify({proposalId:c.id,sourceEventId:event.id,revision:c.base_revision+1}),now,c.id,reviewer));
  }
  const reply=error || `ご提案の内容へのご承諾を記録しました。受取は${p.receive_date} ${p.receive_time}、使用日は${p.use_date}のままです。制作・お支払いの状況は担当者が別途確認します。`;
  if(!error)batch.push(stmt(env,`INSERT INTO manager_drafts(id,order_id,customer_id,source_event_id,base_revision,message,created_at) SELECT ?,?,?,?,revision,CASE WHEN EXISTS(SELECT 1 FROM manager_changes WHERE id=? AND status='approved' AND reviewed_by=?) AND revision=? THEN ? ELSE '注文内容が同時に更新されました。最新の条件を担当者が確認します。' END,? FROM manager_orders WHERE id=?`,replyId,c.order_id,customer,event.id,c.id,`customer:${event.id}`,c.base_revision+1,reply,now,c.order_id));
  else batch.push(stmt(env,'INSERT INTO manager_drafts(id,order_id,customer_id,source_event_id,base_revision,message,created_at) VALUES (?,?,?,?,?,?,?)',replyId,c?.order_id||null,customer,event.id,c?.revision??null,reply,now));
  batch.push(stmt(env,"INSERT INTO manager_tasks(id,order_id,kind,detail,due_at,created_at) VALUES (?,?,'reply',?,?,?)",`reply:${replyId}`,c?.order_id||null,'提案承諾の確認返信',now,now));
  for(const e of events)batch.push(stmt(env,'UPDATE manager_events SET order_id=COALESCE(?,order_id),processed_at=?,processing_error=NULL WHERE id=?',c?.order_id||null,now,e.id));
  await env.DB.batch(batch);return true;
}
