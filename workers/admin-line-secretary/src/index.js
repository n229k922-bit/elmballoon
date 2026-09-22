const encoder = new TextEncoder();
const CUSTOMER_SESSION_TTL = 60 * 60 * 24 * 14;

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/business-schedule') return publicSchedule(request, env);
  if (request.method === 'POST' && url.pathname === '/webhook/line') return lineWebhook(request, env);
  return new Response('Not found', { status: 404 });
} };

async function lineWebhook(request, env) {
  const body = await request.text();
  const signature = request.headers.get('x-line-signature') || '';
  if (!(await signatureIsValid(body, signature, env.LINE_CHANNEL_SECRET))) return new Response('Invalid signature', { status: 401 });
  const payload = JSON.parse(body);
  for (const event of payload.events || []) if (event.type === 'message') await handleEvent(event, env);
  return new Response('OK');
}

async function handleEvent(event, env) {
  const userId = event.source?.userId;
  if (!userId || !event.replyToken) return;
  const admins = new Set((env.ADMIN_LINE_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
  return admins.has(userId) ? handleAdmin(event, env) : handleCustomer(event, env);
}

async function handleAdmin(event, env) {
  if (event.message?.type !== 'text') return reply(event.replyToken, '営業時間の変更は文字でお送りください。', env);
  const userId = event.source.userId, text = event.message.text.trim(), pendingKey = 'pending:' + userId;
  if (/^(はい|確定|承認)$/u.test(text)) {
    const pending = await env.SECRETARY_KV.get(pendingKey, 'json');
    if (!pending) return reply(event.replyToken, '確認待ちの変更はありません。', env);
    await applyChange(pending, userId, env); await env.SECRETARY_KV.delete(pendingKey);
    return reply(event.replyToken, pending.summary + ' を反映しました。', env);
  }
  if (/^(取消|キャンセル)$/u.test(text)) { await env.SECRETARY_KV.delete(pendingKey); return reply(event.replyToken, '確認待ちの変更を取り消しました。', env); }
  const change = parseCommand(text);
  if (!change) return reply(event.replyToken, '例:「休業 2026-09-22」または「営業時間 2026-09-23 10:00-18:00」。内容を確認後に「確定」と返信してください。', env);
  await env.SECRETARY_KV.put(pendingKey, JSON.stringify(change), { expirationTtl: 600 });
  return reply(event.replyToken, change.summary + '。よろしければ10分以内に「確定」と返信してください。', env);
}

async function handleCustomer(event, env) {
  if (!['text', 'image'].includes(event.message?.type)) return;
  const key = 'customer-session:' + event.source.userId;
  const session = (await env.SECRETARY_KV.get(key, 'json')) || { stage: 'new', fields: {} };
  const result = event.message?.type === 'image' ? receiveReferenceImage(session) : buildCustomerReply(event.message?.text?.trim() || '', session);
  await env.SECRETARY_KV.put(key, JSON.stringify(result.session), { expirationTtl: CUSTOMER_SESSION_TTL });
  return reply(event.replyToken, result.message, env);
}

function receiveReferenceImage(session) {
  session.fields.referenceImage = true; session.stage = 'collecting';
  return { session, message: 'お写真ありがとうございます☺︎ イメージ、確認いたしました。\nご希望に近い形でご案内するため、①ご用途 ②ご希望日 ③ご予算 ④お受け取り・配達のどちらか を教えていただけますか？' };
}

function buildCustomerReply(text, session) {
  if (/^(こんにちは|こんばんは|はじめまして|お世話になります)[！!。]*$/u.test(text)) return { session, message: 'こんにちは☺︎ ご連絡ありがとうございます。気になるお写真やご希望の内容がありましたら、そのままお送りください。ご用途・ご希望日・ご予算が分かるとスムーズにご案内できます🎈' };
  if (/(今日|本日|明日|あした|急ぎ|至急)/u.test(text)) return urgentReply(session);
  if (/(ヘリウム|浮[かき]|ガス)/u.test(text)) return heliumReply(session);
  if (/(配送|配達|送[っり]て|郵送)/u.test(text)) return deliveryReply(session);
  if (/(しぼ|どのくらい持|日持ち|持ちます)/u.test(text)) return longevityReply(session);
  if (/(注文|お願い|作れ|作って|欲しい|ほしい|祝い|誕生日|開店|結婚|出産|発表会|卒業|退職)/u.test(text)) return orderReply(text, session);
  if (session.stage === 'collecting') return collectOrderDetail(text, session);
  return { session, message: 'ご連絡ありがとうございます☺︎ 内容を確認して、できるだけご希望に沿えるようご案内します。差し支えなければ、①ご用途 ②ご希望日 ③ご予算 ④お受け取り・配達のどちらか を教えてください。参考のお写真があれば一緒に送っていただいて大丈夫です🎈' };
}

function urgentReply(session) { session.stage = 'urgent'; session.fields.urgent = true; return { session, message: 'お急ぎですね。ご相談ありがとうございます☺︎ 当日・翌日のご注文は、制作状況と商品の内容を確認してからのご案内になります。\nご希望日と、①ご用途 ②ご予算 ③お受け取り・配達のどちらか ④参考のお写真または商品番号 をお送りいただけますか？確認でき次第、可能な範囲をお返事します。' }; }
function heliumReply(session) { session.stage = 'helium'; return { session, message: 'ヘリウムバルーンのご相談ですね☺︎ バルーンの大きさ・種類・個数で必要量が変わるため、商品パッケージのお写真か、サイズと個数をお送りください。持ち込みの場合も確認してご案内します。\n※在庫状況や対応可能な時間は日によって変わるため、希望日も一緒にお願いします。' }; }
function deliveryReply(session) { session.stage = 'delivery'; return { session, message: '配達のご相談ありがとうございます☺︎ お届け地域・ご希望日・ご希望時間・ご予算を確認してご案内します。夏場は高温による破損を防ぐため、発送を控える場合があります。近隣への配達や店頭受け取りも含めて、いちばん良い方法をご提案しますね。' }; }
function longevityReply(session) { session.stage = 'faq'; return { session, message: 'ご質問ありがとうございます☺︎ バルーンは種類や飾る環境によって異なります。直射日光・高温・尖った物を避けて室内に飾ると、より長く楽しんでいただけます。お写真を送っていただければ、その商品に合わせた目安と保管方法をご案内します🎈' }; }
function orderReply(text, session) { session.stage = 'collecting'; session.fields.purpose = ['開店','結婚','出産','誕生日','発表会','卒業','退職'].find((purpose) => text.includes(purpose)) || 'other'; return { session, message: 'ご注文のご相談ありがとうございます☺︎ できるだけイメージに近づけたいので、①ご用途 ②ご希望日・お渡し希望時間 ③ご予算 ④お受け取り／配達 ⑤ご希望の色味・雰囲気 ⑥文字入れ・メッセージカードの有無 を、分かる範囲で教えてください。ホームページの商品番号、または参考画像だけでも大丈夫です🎈' }; }
function collectOrderDetail(text, session) { const f = session.fields; f.lastCustomerMessage = redactContactDetails(text); if (/\d{4}[/-]\d{1,2}[/-]\d{1,2}|今日|明日|あした/u.test(text)) f.hasDate = true; if (/円/u.test(text)) f.hasBudget = true; if (/(受取|受け取|来店|配達|配送)/u.test(text)) f.hasMethod = true; const missing = [!f.hasDate && 'ご希望日', !f.hasBudget && 'ご予算', !f.hasMethod && 'お受け取り・配達'].filter(Boolean); if (missing.length) return { session, message: 'ありがとうございます☺︎ 内容、確認しました。あと「' + missing.join('・') + '」を教えていただければ、作成可否とご提案を具体的にご案内できます。文字入れやカードをご希望でしたら、その内容も一緒にお願いします🎈' }; session.stage = 'review'; return { session, message: 'ありがとうございます☺︎ ご希望内容を確認しました。制作・在庫・配達の状況を確認して、対応可否とお見積りをご案内します。文字入れをご希望の場合は、お入れするお名前・メッセージをそのままお送りください。カードは50文字以内が目安です。' }; }
function redactContactDetails(text) { return text.replace(/\b\d{2,4}[- ]?\d{2,4}[- ]?\d{3,4}\b/g, '[連絡先]').slice(0, 500); }

function parseCommand(text) { let match = text.match(/^(?:休業|休み)\s*(\d{4}-\d{2}-\d{2})$/u); if (match) return { date: match[1], status: 'closed', openTime: null, closeTime: null, summary: match[1] + ' を終日休業' }; match = text.match(/^営業(?:時間)?\s*(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2})-(\d{2}:\d{2})$/u); if (match) return { date: match[1], status: 'special_hours', openTime: match[2], closeTime: match[3], summary: match[1] + ' を ' + match[2] + '〜' + match[3] + ' 営業' }; match = text.match(/^休業解除\s*(\d{4}-\d{2}-\d{2})$/u); if (match) return { date: match[1], status: 'open', openTime: null, closeTime: null, summary: match[1] + ' の休業を解除' }; return null; }
async function applyChange(change, userId, env) { const before = await env.DB.prepare('SELECT * FROM business_schedule WHERE date = ?').bind(change.date).first(); await env.DB.prepare(`INSERT INTO business_schedule (date, status, open_time, close_time, updated_at, updated_by) VALUES (?, ?, ?, ?, datetime('now'), ?) ON CONFLICT(date) DO UPDATE SET status = excluded.status, open_time = excluded.open_time, close_time = excluded.close_time, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(change.date, change.status, change.openTime, change.closeTime, userId).run(); await env.DB.prepare(`INSERT INTO audit_log (timestamp, actor_line_user_id, action, before_json, after_json, result) VALUES (datetime('now'), ?, 'schedule.update', ?, ?, 'success')`).bind(userId, JSON.stringify(before || null), JSON.stringify(change)).run(); }
async function publicSchedule(request, env) { const origin = request.headers.get('Origin'); const allowed = new Set((env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)); if (origin && !allowed.has(origin)) return new Response('Forbidden origin', { status: 403 }); const { results } = await env.DB.prepare('SELECT date, status, open_time, close_time, note, updated_at FROM business_schedule ORDER BY date').all(); return Response.json({ updatedAt: new Date().toISOString(), schedule: results }, { headers: { 'Access-Control-Allow-Origin': origin || 'null', 'Cache-Control': 'public, max-age=60' } }); }
async function signatureIsValid(body, signature, secret) { if (!secret || !signature) return false; const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(body)); return timingSafeEqual(btoa(String.fromCharCode(...new Uint8Array(digest))), signature); }
function timingSafeEqual(left, right) { if (left.length !== right.length) return false; let result = 0; for (let i = 0; i < left.length; i += 1) result |= left.charCodeAt(i) ^ right.charCodeAt(i); return result === 0; }
async function reply(replyToken, message, env) { return fetch('https://api.line.me/v2/bot/message/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN }, body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: message.slice(0, 4900) }] }) }); }
