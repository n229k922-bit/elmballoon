// Phone and walk-in cards are deliberately NOT linked to a LINE recipient.
export class ManagerIntakeError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ManagerIntakeError'; this.status = status; this.code = 'invalid_intake'; }
}

export function isManualCustomer(customerId) { return String(customerId || '').startsWith('manual:'); }

function clean(value, key, max, required = false) {
  if (value != null && typeof value !== 'string') throw new ManagerIntakeError(`${key}は文字で入力してください。`);
  const text = (value || '').trim();
  if ((required && !text) || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new ManagerIntakeError(`${key}の入力を確認してください（最大${max}文字）。`);
  return text;
}

export async function createManualOrder(input, actor, env, now = new Date().toISOString()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ManagerIntakeError('注文内容を確認してください。');
  if (!actor || typeof actor !== 'string') throw new ManagerIntakeError('ログインが必要です。', 401);
  const requestId = clean(input.requestId, '受付番号', 36, true).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) throw new ManagerIntakeError('受付番号が無効です。');
  const channel = input.channel;
  if (!['phone', 'walkin'].includes(channel)) throw new ManagerIntakeError('受付方法を選んでください。');
  const title = clean(input.title, '注文名', 120, true);
  const name = clean(input.name, 'お名前', 120);
  const phone = clean(input.phone, '電話番号', 40);
  const memo = clean(input.memo, 'メモ', 4000);
  if (phone && !/^[+\d\s()\-ー−]+$/u.test(phone)) throw new ManagerIntakeError('電話番号は数字・ハイフンで入力してください。');
  if (!Number.isFinite(Date.parse(now))) throw new ManagerIntakeError('受付日時が無効です。');
  const payload = JSON.stringify({ title, channel, name, phone, memo });
  const eventId = `manual-intake:${requestId}`;
  const customerId = `manual:${requestId}`;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestId));
  const orderId = 'M' + [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 16).toUpperCase();
  const existing = await env.DB.prepare('SELECT order_id,text FROM manager_events WHERE id=?').bind(eventId).first();
  if (existing) {
    if (existing.text !== payload) throw new ManagerIntakeError('同じ受付番号で内容が変わっています。新しく登録し直してください。', 409);
    return { orderId: existing.order_id, created: false };
  }
  // D1 batch is atomic. The final event acts as the request receipt; every write
  // is gated by it, including a concurrent retry that passed the read above.
  const absent = 'NOT EXISTS(SELECT 1 FROM manager_events WHERE id=?)';
  const statements = [env.DB.prepare(`INSERT INTO manager_orders(id,customer_id,title,created_at,updated_at) SELECT ?,?,?,?,? WHERE ${absent}`).bind(orderId,customerId,title,now,now,eventId)];
  for (const [key, value] of [['customer_name',name],['phone',phone],['intake_channel',channel === 'phone' ? '電話' : '来店']]) {
    if (value) statements.push(env.DB.prepare(`INSERT INTO manager_fields(order_id,field_key,value_text,status,source_occurred_at,confirmed_by,confirmed_at) SELECT ?,?,?,'confirmed',?,?,? WHERE ${absent}`).bind(orderId,key,value,now,actor,now,eventId));
  }
  statements.push(env.DB.prepare(`INSERT INTO manager_audit(order_id,actor,action,detail,created_at) SELECT ?,?,'manual_intake',?,? WHERE ${absent}`).bind(orderId,actor,JSON.stringify({channel,requestId}),now,eventId));
  statements.push(env.DB.prepare(`INSERT INTO manager_events(id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at) SELECT ?,?,?,'owner',?,?,?,? WHERE ${absent}`).bind(eventId,customerId,orderId,payload,now,now,now,eventId));
  const result = await env.DB.batch(statements);
  const receipt = await env.DB.prepare('SELECT order_id,text FROM manager_events WHERE id=?').bind(eventId).first();
  if (!receipt || receipt.text !== payload) throw new ManagerIntakeError('受付番号が重複しています。内容を確認してください。', 409);
  return { orderId: receipt.order_id, created: (result[0]?.meta?.changes || 0) > 0 };
}
