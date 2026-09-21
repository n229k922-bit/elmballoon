const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/business-schedule') {
      return publicSchedule(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/webhook/line') {
      return lineWebhook(request, env);
    }
    return new Response('Not found', { status: 404 });
  },
};

async function lineWebhook(request, env) {
  const body = await request.text();
  const signature = request.headers.get('x-line-signature') || '';
  if (!(await signatureIsValid(body, signature, env.LINE_CHANNEL_SECRET))) {
    return new Response('Invalid signature', { status: 401 });
  }

  const payload = JSON.parse(body);
  for (const event of payload.events || []) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue;
    await handleMessage(event, env);
  }
  return new Response('OK');
}

async function handleMessage(event, env) {
  const userId = event.source?.userId;
  const admins = new Set((env.ADMIN_LINE_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
  if (!admins.has(userId)) {
    return reply(event.replyToken, 'この操作は店主専用です。管理者登録を確認してください。', env);
  }

  const text = event.message.text.trim();
  const pendingKey = 'pending:' + userId;
  if (/^(はい|確定|承認)$/u.test(text)) {
    const pending = await env.SECRETARY_KV.get(pendingKey, 'json');
    if (!pending) return reply(event.replyToken, '確認待ちの変更はありません。', env);
    await applyChange(pending, userId, env);
    await env.SECRETARY_KV.delete(pendingKey);
    return reply(event.replyToken, pending.summary + ' を反映しました。', env);
  }
  if (/^(取消|キャンセル)$/u.test(text)) {
    await env.SECRETARY_KV.delete(pendingKey);
    return reply(event.replyToken, '確認待ちの変更を取り消しました。', env);
  }

  const change = parseCommand(text);
  if (!change) {
    return reply(event.replyToken, '例: 「休業 2026-09-22」または「営業時間 2026-09-23 10:00-18:00」。内容を確認後に「確定」と返信してください。', env);
  }
  await env.SECRETARY_KV.put(pendingKey, JSON.stringify(change), { expirationTtl: 600 });
  return reply(event.replyToken, change.summary + '。よろしければ10分以内に「確定」と返信してください。', env);
}

function parseCommand(text) {
  let match = text.match(/^(?:休業|休み)\s*(\d{4}-\d{2}-\d{2})$/u);
  if (match) return { date: match[1], status: 'closed', openTime: null, closeTime: null, summary: match[1] + ' を終日休業' };
  match = text.match(/^営業(?:時間)?\s*(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2})-(\d{2}:\d{2})$/u);
  if (match) return { date: match[1], status: 'special_hours', openTime: match[2], closeTime: match[3], summary: match[1] + ' を ' + match[2] + '〜' + match[3] + ' 営業' };
  match = text.match(/^休業解除\s*(\d{4}-\d{2}-\d{2})$/u);
  if (match) return { date: match[1], status: 'open', openTime: null, closeTime: null, summary: match[1] + ' の休業を解除' };
  return null;
}

async function applyChange(change, userId, env) {
  const before = await env.DB.prepare('SELECT * FROM business_schedule WHERE date = ?').bind(change.date).first();
  await env.DB.prepare(`INSERT INTO business_schedule (date, status, open_time, close_time, updated_at, updated_by)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(date) DO UPDATE SET status = excluded.status, open_time = excluded.open_time,
      close_time = excluded.close_time, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(change.date, change.status, change.openTime, change.closeTime, userId).run();
  await env.DB.prepare(`INSERT INTO audit_log (timestamp, actor_line_user_id, action, before_json, after_json, result)
    VALUES (datetime('now'), ?, 'schedule.update', ?, ?, 'success')`)
    .bind(userId, JSON.stringify(before || null), JSON.stringify(change)).run();
}

async function publicSchedule(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = new Set((env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean));
  if (origin && !allowed.has(origin)) return new Response('Forbidden origin', { status: 403 });
  const { results } = await env.DB.prepare('SELECT date, status, open_time, close_time, note, updated_at FROM business_schedule ORDER BY date').all();
  return Response.json({ updatedAt: new Date().toISOString(), schedule: results }, {
    headers: { 'Access-Control-Allow-Origin': origin || 'null', 'Cache-Control': 'public, max-age=60' },
  });
}

async function signatureIsValid(body, signature, secret) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i += 1) result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return result === 0;
}

async function reply(replyToken, message, env) {
  return fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: message }] }),
  });
}
