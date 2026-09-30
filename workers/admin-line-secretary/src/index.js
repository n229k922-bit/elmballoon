const encoder = new TextEncoder();
const CUSTOMER_SESSION_TTL = 60 * 60 * 24 * 14;
const CUSTOMER_MESSAGE_BUNDLE_WAIT_MS = 12_000;
const STORE_SERVICE_HOURS_NOTICE = '店舗対応時間は10:00〜16:00です。夜間の配達は、地域・内容・当日の予定を確認して個別にご案内します。';
const DATE_INPUT_PATTERN = '(?:令和\\s*\\d{1,2}年?\\s*\\d{1,2}[月/-]\\s*\\d{1,2}日?|R\\s*\\d{1,2}[年/月/-]\\s*\\d{1,2}[月/-]\\s*\\d{1,2}日?|\\d{4}年?\\s*\\d{1,2}[月/-]\\s*\\d{1,2}日?|\\d{1,2}月\\s*\\d{1,2}日?|\\d{4}[/-]\\d{1,2}[/-]\\d{1,2})';
const CUSTOMER_REPLY_TIMINGS = {
  initial_intake: { minDelayMs: 3000, maxDelayMs: 5000, loadingSeconds: 5 },
  missing_details: { minDelayMs: 4000, maxDelayMs: 7000, loadingSeconds: 10 },
  faq_answer: { minDelayMs: 5000, maxDelayMs: 9000, loadingSeconds: 10 },
  details_confirmation: { minDelayMs: 7000, maxDelayMs: 11000, loadingSeconds: 15 },
  bundled_reply: { minDelayMs: 1500, maxDelayMs: 3000, loadingSeconds: 5 },
};
const ORDER_FEASIBILITY_FIELDS = [
  { key: 'product_source', label: 'HPの商品番号 または参考画像' },
  { key: 'product_type', label: 'バルーンのタイプ' },
  { key: 'budget', label: 'ご予算' },
  { key: 'color_vibe', label: '全体的なお色味と雰囲気' },
  { key: 'use_date', label: 'プレゼント・使用予定日' },
  { key: 'receive_date', label: '受取希望日' },
  { key: 'receive_time', label: '受取希望時間' },
  { key: 'fulfillment_method', label: '受取方法' },
];
const ORDER_FIELD_LABELS = Object.fromEntries([
  ...ORDER_FEASIBILITY_FIELDS.map((field) => [field.key, field.label]),
  ['balloon_message', 'バルーンへの文字入れ'],
  ['card_message', 'メッセージカード'],
  ['customer_name', 'お名前'],
  ['phone', 'ご連絡先'],
  ['delivery_address', 'お届け先'],
  ['payment_method', '支払方法'],
  ['payment_status', '支払い'],
  ['fulfillment_completed', '受渡し・納品'],
  ['receipt', '領収書'],
  ['sns_permission', 'HP・SNS掲載'],
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/oauth/google/start') return googleOAuthStart(env);
    if (request.method === 'GET' && url.pathname === '/oauth/google/callback') return googleOAuthCallback(url, env);
    if (request.method === 'GET' && url.pathname === '/api/business-schedule') {
      return publicSchedule(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/calendar/availability') {
      return calendarAvailability(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/webhook/line') {
      return lineWebhook(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/webhook/customer-line') {
      return customerLineWebhook(request, env, ctx);
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(retryPendingOwnerNotifications(env));
  },
};

const GOOGLE_REDIRECT_URI = 'https://elm-balloon-admin-line-secretary.n229k922.workers.dev/oauth/google/callback';

// Secret名は旧環境と現行環境の両方を許容する。
function googleClientId(env) {
  return env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_CLIENT_ID || '';
}

function googleClientSecret(env) {
  return env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '';
}

async function publicSchedule(request, env) {
  const rows = await readBusinessSchedule(env);
  const exceptions = (rows.results || []).map((row) => {
    if (row.status === 'special_hours') {
      return { date: row.date, status: row.status, start: row.open_time, end: row.close_time, delivery_window: row.delivery_window || null, label: row.note || '営業時間変更' };
    }
    return { date: row.date, status: row.status, label: row.note || (row.status === 'closed' ? '臨時休業' : '営業予定') };
  });
  const updatedAt = (rows.results || []).reduce((latest, row) => !latest || row.updated_at > latest ? row.updated_at : latest, null);
  const body = { timezone: 'Asia/Tokyo', exceptions, updated_at: updatedAt };
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = (env.ALLOWED_ORIGINS || 'https://n229k922-bit.github.io,https://elmballoon.com,https://www.elmballoon.com')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const headers = { 'Cache-Control': 'no-store' };
  if (allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return json(body, 200, headers);
}

// Older production databases may not yet have delivery_window. Keep the
// public schedule API available while the schema is being upgraded.
async function readBusinessSchedule(env, date = null) {
  const where = date ? ' WHERE date = ?' : '';
  const query = `SELECT date, status, open_time, close_time, delivery_window, note, updated_at
      FROM business_schedule${where}${date ? '' : ' ORDER BY date ASC'}`;
  try {
    const statement = env.DB.prepare(query);
    return date ? await statement.bind(date).first() : await statement.all();
  } catch (error) {
    console.warn('business schedule schema compatibility fallback', error?.message || error);
    const fallbackQuery = `SELECT date, status, open_time, close_time, note, updated_at
      FROM business_schedule${where}${date ? '' : ' ORDER BY date ASC'}`;
    const statement = env.DB.prepare(fallbackQuery);
    return date ? await statement.bind(date).first() : await statement.all();
  }
}

function googleOAuthStart(env) {
  const clientId = googleClientId(env);
  if (!clientId) return new Response('Google OAuth client is not configured', { status: 503 });
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
  });
  return Response.redirect(auth.toString(), 302);
}

async function googleOAuthCallback(url, env) {
  const code = url.searchParams.get('code');
  if (!code) return new Response('Google OAuth was cancelled or failed.', { status: 400 });
  const clientId = googleClientId(env);
  const clientSecret = googleClientSecret(env);
  if (!clientId || !clientSecret) return new Response('Google OAuth client is not configured', { status: 503 });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code' }),
  });
  const token = await response.json();
  if (!response.ok || !token.refresh_token) return new Response('Google OAuth token exchange failed.', { status: 502 });
  await env.SECRETARY_KV.put('google-calendar-refresh-token', token.refresh_token);
  return new Response('Googleカレンダーの読み取り接続が完了しました。この画面は閉じて大丈夫です。', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function calendarAvailability(request, env) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  const startTime = url.searchParams.get('start') || '00:00';
  const endTime = url.searchParams.get('end') || '23:59';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return json({ error: 'date must be YYYY-MM-DD' }, 400);
  const refreshToken = await env.SECRETARY_KV.get('google-calendar-refresh-token');
  if (!refreshToken) return json({ error: 'calendar_not_connected' }, 503);
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: googleClientId(env), client_secret: googleClientSecret(env), refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const token = await tokenRes.json();
  if (!tokenRes.ok || !token.access_token) return json({ error: 'calendar_token_refresh_failed' }, 502);
  const timeMin = `${date}T${startTime}:00+09:00`, timeMax = `${date}T${endTime}:00+09:00`;
  const eventsUrl = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  eventsUrl.search = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
  const eventsRes = await fetch(eventsUrl, { headers: { Authorization: `Bearer ${token.access_token}` } });
  const events = await eventsRes.json();
  if (!eventsRes.ok) return json({ error: 'calendar_events_failed', detail: events.error || null }, 502);
  const busy = (events.items || []).filter((event) => event.status !== 'cancelled').map((event) => ({ id: event.id, summary: event.summary || '(予定名なし)', start: event.start?.dateTime || event.start?.date, end: event.end?.dateTime || event.end?.date }));
  return json({ date, timeMin, timeMax, busy, report: formatCalendarReport(date, startTime, endTime, busy) });
}

function formatCalendarReport(date, startTime, endTime, busy) {
  const lines = busy.length
    ? busy.map((event) => `・${event.start?.slice(11, 16) || '終日'}〜${event.end?.slice(11, 16) || '終日'}：${event.summary}`).join('\n')
    : '・重複する予定はありません。';
  return `【カレンダー確認結果】\n\n対象日時：${formatJapanDate(date)} ${startTime}〜${endTime}\n${STORE_SERVICE_HOURS_NOTICE}\n\n【既存予定】\n${lines}`;
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders } });
}

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

function normalizeManagerCommand(text) {
  const match = text.match(/^([1-9])\s+(受ける|難しい|確認|制作開始|完成|受渡完了|支払案内済み|支払確認待ち|支払完了|日付変更|お客様へ|顧客送信|指定メッセージ|店長指定メッセージ|電話メモ|紙注文補足)(?:\s+([\s\S]+))?$/u);
  if (!match) return text;
  return `${match[2]} ${match[1]}${match[3] ? ` ${match[3]}` : ''}`;
}

async function handleAdmin(event, env) {
  if (event.message?.type === 'image') return registerManualOrderFormImage(event, env);
  if (event.message?.type !== 'text') return reply(event.replyToken, '注文書画像または文字でお送りください。', env);
  const userId = event.source.userId, text = normalizeManagerCommand(event.message.text.trim()), pendingKey = 'pending:' + userId;
  const pendingStatusKey = 'pending-status:' + userId;
  const sendReply = text.match(/^送信\s+(review:[^\s]+)(?:\s+([\s\S]+))?$/u);
  if (sendReply) return prepareCustomerReplySend(event.replyToken, userId, sendReply[1], sendReply[2]?.trim() || null, false, env);
  if (text === '送信') {
    const latestReview = await env.DB.prepare(`SELECT id FROM customer_reply_reviews
        WHERE status = 'needs_review'
        ORDER BY created_at DESC LIMIT 1`).first();
    if (!latestReview) return reply(event.replyToken, '送信できる確認待ちの返信案はありません。', env);
    return prepareCustomerReplySend(event.replyToken, userId, latestReview.id, null, false, env);
  }
  if (/^送信(?:\s|$)/u.test(text)) {
    return reply(event.replyToken, '「送信」だけで最新の確認待ち返信案を送れます。営業日・休業日の変更はこの操作では行いません。', env);
  }
  const confirmReply = text.match(/^送信確認\s+(review:[^\s]+)$/u);
  if (confirmReply) return prepareCustomerReplySend(event.replyToken, userId, confirmReply[1], null, true, env);
  const holdReply = text.match(/^保留\s+(review:[^\s]+)(?:\s+([\s\S]+))?$/u);
  if (holdReply) {
    const result = await env.DB.prepare(`UPDATE customer_reply_reviews
        SET status = 'held', proposed_message = ? WHERE id = ? AND status IN ('needs_review', 'needs_change_confirmation')`)
      .bind(holdReply[2]?.trim().slice(0, 500) || '店長確認待ち', holdReply[1]).run();
    return reply(event.replyToken, result.meta.changes ? '返信を保留として記録しました。' : '確認待ちの返信案が見つからないか、すでに処理済みです。', env);
  }
  const approveOrderChange = text.match(/^変更OK(?:\s+(change:[^\s]+))?$/u);
  if (approveOrderChange) {
    return reviewLatestOrderFieldChange(event.replyToken, userId, approveOrderChange[1] || null, true, env);
  }
  const rejectOrderChange = text.match(/^変更しない(?:\s+(change:[^\s]+))?$/u);
  if (rejectOrderChange) {
    return reviewLatestOrderFieldChange(event.replyToken, userId, rejectOrderChange[1] || null, false, env);
  }
  if (/^(?:カルテ|最新カルテ)$/u.test(text)) {
    return replyLatestOrderRecord(event.replyToken, env);
  }
  const richMenuCommand = text.match(/^(確認待ち一覧|受注判断|日付変更依頼|お客様への返信依頼|制作進捗更新|システム変更依頼)$/u);
  if (richMenuCommand) {
    return handleRichMenuCommand(event.replyToken, richMenuCommand[1], env);
  }
  if (text === '顧客送信確認') {
    return confirmPendingOwnerCustomerMessage(event.replyToken, userId, env);
  }
  // 自然文で届いた進捗報告も、対象カルテを推定して確認フローへ送ります。
  const implicitStatus = text.match(/^(?:(K[A-Z0-9]+|[1-9])\s*)?(制作が?完了|完成(?:しました)?|できあが(?:りました|った)|受け渡し(?:が)?完了|受渡完了|お渡し(?:しました|完了)|引き渡し完了)(?:[。！!].*)?$/iu);
  if (implicitStatus) {
    const action = /受け渡し|受渡|お渡し|引き渡し/u.test(implicitStatus[2]) ? '受渡完了' : '完成';
    return proposeOrderLifecycleTransition(event.replyToken, userId, action, implicitStatus[1]?.toUpperCase() || null, env);
  }
  const manualSupplement = text.match(/^紙注文補足(?:\s+((?:K[A-Z0-9]+|[1-9])))?\s+([\s\S]+)$/iu);
  if (manualSupplement) {
    return recordManualOrderSupplement(
      event.replyToken,
      userId,
      manualSupplement[1]?.toUpperCase() || null,
      manualSupplement[2].trim(),
      env,
    );
  }
  const dateChange = text.match(/^日付変更\s+((?:K[A-Z0-9]+|[1-9]))\s+([\s\S]+)$/iu);
  if (dateChange) {
    return recordOrderDateChange(event.replyToken, userId, dateChange[1].toUpperCase(), dateChange[2].trim(), env);
  }
  const ownerCustomerMessage = text.match(/^(?:お客様へ|顧客送信|指定メッセージ|店長指定メッセージ)(?:\s+((?:K[A-Z0-9]+|[1-9])))?\s+([\s\S]+)$/iu);
  if (ownerCustomerMessage) {
    return prepareOwnerCustomerMessage(
      event.replyToken,
      userId,
      ownerCustomerMessage[1]?.toUpperCase() || null,
      ownerCustomerMessage[2].trim(),
      env,
    );
  }
  const phoneMemo = text.match(/^電話メモ(?:\s+((?:K[A-Z0-9]+|[1-9])))?\s+([\s\S]+)$/iu);
  if (phoneMemo) {
    return recordOwnerPhoneMemo(
      event.replyToken,
      userId,
      phoneMemo[1]?.toUpperCase() || null,
      phoneMemo[2].trim(),
      env,
    );
  }
  const shortOwnerDecision = text.match(/^(受ける|難しい|確認)(?:\s+((?:K[A-Z0-9]+|[1-9])))?(?:\s+([\s\S]+))?$/iu);
  if (shortOwnerDecision) {
    return handleOwnerShortDecision(
      event.replyToken,
      userId,
      shortOwnerDecision[1],
      shortOwnerDecision[2]?.toUpperCase() || null,
      shortOwnerDecision[3]?.trim() || null,
      env,
    );
  }
  const lifecycleCommand = text.match(/^(制作開始|完成|受渡完了|支払案内済み|支払確認待ち|支払完了)(?:\s+((?:K[A-Z0-9]+|[1-9])))?$/iu);
  if (lifecycleCommand) {
    return handleOrderLifecycleCommand(
      event.replyToken,
      userId,
      lifecycleCommand[1],
      lifecycleCommand[2]?.toUpperCase() || null,
      env,
    );
  }
  const ownerDecision = text.match(/^店長確認\s+(decision:[^\s]+)\s+(.+)$/u);
  if (ownerDecision) {
    const result = await env.DB.prepare(`UPDATE owner_decision_requests
        SET status = 'recorded', owner_response = ?, decided_at = ?, decided_by = ?
        WHERE id = ? AND status = 'needs_owner_review'`)
      .bind(ownerDecision[2].slice(0, 1000), new Date().toISOString(), userId, ownerDecision[1]).run();
    return reply(event.replyToken, result.meta.changes
      ? '店長判断を記録しました。見積・在庫・配達・予定の確定処理は、この後に追加する確認手順で行います。'
      : '確認待ちのフォームが見つからないか、すでに記録済みです。', env);
  }
  if (/^(はい|確定|承認)$/u.test(text)) {
    const pendingStatus = await env.SECRETARY_KV.get(pendingStatusKey, 'json');
    if (pendingStatus) {
      await env.SECRETARY_KV.delete(pendingStatusKey);
      return applyPendingStatusTransition(event.replyToken, userId, pendingStatus, env);
    }
    const pending = await env.SECRETARY_KV.get(pendingKey, 'json');
    if (!pending) return reply(event.replyToken, '確認待ちの変更はありません。', env);
    await applyChange(pending, userId, env); await env.SECRETARY_KV.delete(pendingKey);
    return reply(event.replyToken, pending.summary + ' を反映しました。', env);
  }
  if (/^いいえ$/u.test(text)) {
    const pendingStatus = await env.SECRETARY_KV.get(pendingStatusKey, 'json');
    if (pendingStatus) {
      await env.SECRETARY_KV.delete(pendingStatusKey);
      return reply(event.replyToken, 'ステータスは変更せず、現在の状態を維持しました。', env);
    }
    return reply(event.replyToken, '確認待ちのステータス変更はありません。', env);
  }
  if (/^(取消|キャンセル)$/u.test(text)) {
    await env.SECRETARY_KV.delete(pendingKey);
    await env.SECRETARY_KV.delete(pendingStatusKey);
    await env.SECRETARY_KV.delete('pending-customer-send:' + userId);
    return reply(event.replyToken, '確認待ちの変更を取り消しました。', env);
  }

  if (/^(?:今週|来週|再来週)末(?:は)?(?:休業|休み)(?:にして)?$/u.test(text)) {
    return reply(event.replyToken, '「週末」は土曜・日曜のどちらか、または両日かを確認したいです。例: 「今週末の土曜休み」「来週末の日曜休み」', env);
  }

  const change = parseCommand(text);
  if (change) {
    await env.SECRETARY_KV.put(pendingKey, JSON.stringify(change), { expirationTtl: 600 });
    return reply(event.replyToken, change.summary + '。よろしければ10分以内に「確定」と返信してください。', env);
  }
  const route = routeManagerRequest(text);
  if (route) return reply(event.replyToken, route, env);
  return reply(event.replyToken, '例:「休業 2026-09-22」または「営業時間 2026-09-23 10:00-18:00」。内容を確認後に「確定」と返信してください。\n\n' + STORE_SERVICE_HOURS_NOTICE, env);
}

async function customerLineWebhook(request, env, ctx) {
  console.log('customer webhook received');
  const body = await request.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  // LINE's webhook verification sends {"events":[]} before credentials are
  // configured. It is safe to acknowledge this handshake; real events still
  // require both the channel secret and access token below.
  if (Array.isArray(payload.events) && payload.events.length === 0) {
    return new Response('OK');
  }
  if (!env.CUSTOMER_LINE_CHANNEL_SECRET || !env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN) {
    console.log('customer channel credentials missing');
    return new Response('Customer channel is not configured', { status: 503 });
  }
  const signature = request.headers.get('x-line-signature') || '';
  if (!(await signatureIsValid(body, signature, env.CUSTOMER_LINE_CHANNEL_SECRET))) {
    console.log('customer webhook signature invalid');
    return new Response('Invalid signature', { status: 401 });
  }

  console.log('customer webhook signature valid', { eventCount: (payload.events || []).length });
  for (const event of payload.events || []) {
    console.log('customer webhook event', { type: event.type, messageType: event.message?.type || null });
    if (event.type !== 'message' || !['text', 'image'].includes(event.message?.type)) continue;
    // LINEの再送やネットワーク再試行で同じイベントが届いても、
    // お客様への返信や店長通知を二重に発生させない。
    const eventId = event.webhookEventId || event.message?.id;
    if (eventId) {
      const alreadyRecorded = await env.DB.prepare(`SELECT 1 AS found FROM order_messages WHERE webhook_event_id = ? LIMIT 1`)
        .bind(eventId).first();
      if (alreadyRecorded) {
        console.log('customer webhook duplicate skipped', { eventId });
        continue;
      }
    }
    await recordCustomerMessage(event, env);
    if (shouldBypassCustomerMessageBundle(event)) {
      if (event.message?.type === 'text' && isOrderStartTrigger((event.message.text || '').trim())) {
        await env.DB.prepare(`DELETE FROM customer_reply_bundles WHERE customer_line_user_id = ?`)
          .bind(event.source?.userId).run();
      }
      await queueCustomerReplyReview(event, env, ctx);
    } else {
      await scheduleCustomerMessageBundle(event, env, ctx);
    }
  }
  return new Response('OK');
}

function shouldBypassCustomerMessageBundle(event) {
  if (event.message?.type !== 'text') return false;
  const text = (event.message.text || '').trim();
  if (isOrderStartTrigger(text)) return true;
  return /返品|交換|返金|不良|壊れ|破損|割れ|破裂|爆発|燃え|引火|けが|怪我|誤飲|ヘリウム.{0,12}(?:吸|安全)|至急|緊急/u.test(text);
}

async function scheduleCustomerMessageBundle(event, env, ctx) {
  const customerId = event.source?.userId;
  const sourceEventId = event.webhookEventId || event.message?.id;
  if (!customerId || !sourceEventId) return;
  const now = event.__recordedAt || new Date().toISOString();
  const staleBefore = new Date(Date.parse(now) - 60_000).toISOString();
  const generation = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.floor(randomUnit() * 1_000_000)}`;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM customer_reply_bundles
        WHERE customer_line_user_id = ? AND updated_at < ?`).bind(customerId, staleBefore),
    env.DB.prepare(`INSERT INTO customer_reply_bundles
        (customer_line_user_id, generation, window_started_at, last_received_at,
         latest_source_event_id, has_image, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(customer_line_user_id) DO UPDATE SET
          generation = excluded.generation,
          last_received_at = excluded.last_received_at,
          latest_source_event_id = excluded.latest_source_event_id,
          has_image = MAX(customer_reply_bundles.has_image, excluded.has_image),
          updated_at = excluded.updated_at`)
      .bind(customerId, generation, now, now, sourceEventId,
        event.message?.type === 'image' ? 1 : 0, now),
  ]);
  const loading = startCustomerLoading(customerId, 15, env);
  if (ctx?.waitUntil) ctx.waitUntil(loading.catch((error) => console.error('bundle loading failed', error)));
  else await loading;

  const processing = processCustomerMessageBundleAfterWait(customerId, generation, env);
  await continueCustomerDelivery(processing, ctx);
}

async function processCustomerMessageBundleAfterWait(customerId, generation, env, waitMs = CUSTOMER_MESSAGE_BUNDLE_WAIT_MS) {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const bundle = await env.DB.prepare(`SELECT * FROM customer_reply_bundles
      WHERE customer_line_user_id = ?`).bind(customerId).first();
  if (!bundle || bundle.generation !== generation) {
    console.log('customer bundle superseded', { customerId, generation });
    return false;
  }
  const deleted = await env.DB.prepare(`DELETE FROM customer_reply_bundles
      WHERE customer_line_user_id = ? AND generation = ?`).bind(customerId, generation).run();
  if (!deleted.meta.changes) return false;
  const messages = await env.DB.prepare(`SELECT webhook_event_id, message_text, occurred_at
      FROM order_messages
      WHERE order_thread_id = ? AND direction = 'customer_inbound'
        AND occurred_at >= ? AND occurred_at <= ?
      ORDER BY occurred_at ASC, id ASC`)
    .bind('customer:' + customerId, bundle.window_started_at, bundle.last_received_at).all();
  const bundledEvent = createBundledCustomerEvent(customerId, bundle, messages.results || []);
  if (!bundledEvent) return false;
  await queueCustomerReplyReview(bundledEvent, env, null);
  return true;
}

function createBundledCustomerEvent(customerId, bundle, rows) {
  const textParts = rows
    .map((row) => (row.message_text || '').trim())
    .filter((text) => text && text !== '[参考画像]' && !isOrderStartTrigger(text));
  const hasImage = Number(bundle.has_image) === 1 || rows.some((row) => row.message_text === '[参考画像]');
  if (!textParts.length && !hasImage) return null;
  return {
    type: 'message',
    source: { userId: customerId },
    webhookEventId: bundle.latest_source_event_id,
    message: textParts.length
      ? { id: bundle.latest_source_event_id, type: 'text', text: textParts.join('\n') }
      : { id: bundle.latest_source_event_id, type: 'image' },
    __bundled: true,
    __bundleHasImage: hasImage,
    __bundleMessageCount: rows.length,
  };
}

async function recordCustomerMessage(event, env) {
  const customerId = event.source?.userId;
  if (!customerId) return;
  const isImage = event.message?.type === 'image';
  const text = isImage ? '[参考画像]' : (event.message?.text || '').trim();
  const now = new Date().toISOString();
  event.__recordedAt = now;
  const threadId = 'customer:' + customerId;
  const displayName = await fetchCustomerDisplayName(customerId, env);
  const confirmedName = isImage ? null : extractConfirmedCustomerName(text);
  await env.DB.prepare(`INSERT INTO customer_profiles (customer_line_user_id, first_seen_at, last_seen_at)
      VALUES (?, ?, ?) ON CONFLICT(customer_line_user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
    .bind(customerId, now, now).run();
  await env.DB.prepare(`INSERT INTO customer_order_threads
      (id, customer_line_user_id, customer_display_name, customer_confirmed_name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'collecting', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        customer_display_name = COALESCE(excluded.customer_display_name, customer_order_threads.customer_display_name),
        customer_confirmed_name = COALESCE(excluded.customer_confirmed_name, customer_order_threads.customer_confirmed_name),
        updated_at = excluded.updated_at`)
    .bind(threadId, customerId, displayName, confirmedName, now, now).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO order_messages
      (webhook_event_id, order_thread_id, direction, message_text, occurred_at)
      VALUES (?, ?, 'customer_inbound', ?, ?)`)
    .bind(event.webhookEventId || event.message.id, threadId, text, now).run();

  const currentSession = await env.SECRETARY_KV.get('customer-session:' + customerId, 'json');
  const orderSessionActive = ['collecting', 'review', 'awaiting_contact', 'confirmed']
    .includes(currentSession?.stage);
  const orderRecordResult = await syncCustomerOrderRecord({
    customerId,
    threadId,
    event,
    text,
    now,
    env,
    allowCreate: (!isImage && isOrderStartTrigger(text)) || orderSessionActive,
  });
  if (orderRecordResult?.pendingChanges.length) {
    const customerNames = await getCustomerNames(threadId, env);
    await notifyOwners(formatPendingOrderChanges(
      formatCustomerLabel(customerNames.confirmedName || customerNames.displayName),
      orderRecordResult.pendingChanges,
    ), env);
  }

  const candidate = isImage ? null : extractScheduleCandidate(text);
  const scheduleConflict = candidate ? await findBusinessScheduleConflict(candidate, env) : null;
  const details = isImage ? extractOrderDetails('', null) : extractOrderDetails(text, candidate);
  const catalogProduct = details.productReference ? await findProductCatalogMatch(details.productReference, env) : null;
  await upsertOrderCard(threadId, text, candidate, now, env, details);

  const customerNames = await getCustomerNames(threadId, env);
  const customerName = customerNames.confirmedName || customerNames.displayName;
  const customerLabel = formatCustomerLabel(customerName);
  if (confirmedName) {
    // 名前の確認は受注判断を要する通知ではないため、統括へ即時通知せず
    // 注文カルテのイベントとして保存する。最終確認依頼に必要な場合だけ要約する。
    await recordInternalOrderEvent(threadId, 'customer.name_confirmed', {
      customerLabel,
      name: confirmedName,
    }, now, env);
  }

  if (details.productReference) {
    if (catalogProduct) {
      await recordProductCatalogMatch(threadId, details.productReference, catalogProduct, now, env);
      // 商品画像は基本項目が揃った時点の制作可否確認へまとめて添付する。
      // 聞き取り途中の別通知にすると、最終確認と画像が離れて見落とされやすい。
    } else {
      // 商品番号の未照合も、聞き取り途中の単独通知にはしない。
      // 最終的な受注判断通知にまとめ、店長が同じ案件を何度も開かなくて済むようにする。
      await recordInternalOrderEvent(threadId, 'product.reference_unmatched', {
        reference: details.productReference,
        customerLabel,
      }, now, env);
    }
  }

  if (!candidate) {
    console.log('customer message recorded without schedule candidate');
    return;
  }
  const candidateId = 'candidate:' + (event.webhookEventId || event.message.id);
  await env.DB.prepare(`INSERT OR IGNORE INTO schedule_candidates
      (id, order_thread_id, event_type, event_date, event_time, status, source_summary, created_at)
      VALUES (?, ?, ?, ?, ?, 'needs_owner_review', ?, ?)`)
    .bind(candidateId, threadId, candidate.type, candidate.date, candidate.time,
      scheduleConflict ? `【営業日注意】${scheduleConflict}\n${text}` : text, now).run();
  if (scheduleConflict) {
    // 営業日との競合は候補と一緒に記録し、基本項目が揃った受注確認へ集約する。
    await recordInternalOrderEvent(threadId, 'schedule.conflict', {
      requested: formatScheduleDate(candidate.date, candidate.time),
      type: candidate.typeLabel,
      detail: scheduleConflict,
    }, now, env);
  }
  console.log('schedule candidate created', { type: candidate.type, date: candidate.date });
}

async function findBusinessScheduleConflict(candidate, env) {
  const row = await readBusinessSchedule(env, candidate.date);
  if (!row) return null;
  if (row.status === 'closed') return row.note || 'この日は店休日です。';
  if (row.status === 'special_hours' && candidate.time && row.open_time && row.close_time
      && (candidate.time < row.open_time || candidate.time >= row.close_time)) {
    return `${row.open_time}〜${row.close_time}は店頭受取などの店舗対応時間です（希望時刻は営業時間外）。${row.delivery_window ? ` 夜間配達の目安：${row.delivery_window}。` : ' 夜間配達は地域・内容・当日の予定を確認して個別判断します。'}`;
  }
  if (row.status === 'special_hours' && !candidate.time) return `${row.open_time}〜${row.close_time}は店頭受取などの店舗対応時間です（希望時刻の確認が必要）。${row.delivery_window ? ` 夜間配達の目安：${row.delivery_window}。` : ' 夜間配達は地域・内容・当日の予定を確認して個別判断します。'}`;
  return null;
}

async function queueCustomerReplyReview(event, env, ctx) {
  const customerId = event.source?.userId;
  if (!customerId) return;
  const sourceEventId = event.webhookEventId || event.message?.id;
  if (!sourceEventId) return;
  const key = 'customer-session:' + customerId;
  const session = (await env.SECRETARY_KV.get(key, 'json')) || { stage: 'new', fields: {} };
  const wasCollecting = session.stage === 'collecting';
  if (!session.customerKind) session.customerKind = await getCustomerKind(customerId, event.message?.text || '', env);
  if (event.__bundleHasImage && event.message?.type !== 'image') receiveReferenceImage(session);
  const result = event.message?.type === 'image'
    ? receiveReferenceImage(session)
    : buildCustomerReply(event.message?.text?.trim() || '', session);
  await env.SECRETARY_KV.put(key, JSON.stringify(result.session), { expirationTtl: CUSTOMER_SESSION_TTL });

  // 店舗資料で回答が確定しているお手入れ・安全案内は、注文状態を変えずに自動回答する。
  if (result.autoReply) {
    const delivery = deliverCustomerMessagesAfterDelay(
      customerId,
      [result.message],
      event.__bundled ? 'bundled_reply' : 'faq_answer',
      env,
      async () => {
        await env.DB.prepare(`INSERT INTO order_messages (order_thread_id, direction, message_text, occurred_at) VALUES (?, 'assistant_outbound', ?, ?)`)
          .bind('customer:' + customerId, result.message.slice(0, 4900), new Date().toISOString()).run();
        if (result.notifyOwner) {
          const names = await getCustomerNames('customer:' + customerId, env);
          const incoming = event.message?.text || '破損・返品交換に関する連絡';
          await notifyOwners(`統括マネージャーです。\n\n【商品状態の確認が必要です】\n${formatCustomerLabel(names.confirmedName || names.displayName)}から次の連絡がありました。\n「${redactContactDetails(incoming).slice(0, 500)}」\n\n説明書に基づく一次案内を送信しました。破損状況や個別対応について確認をお願いします。`, env);
        }
      },
    );
    await continueCustomerDelivery(delivery, ctx);
    return;
  }

  // 注文フォームの入口（「注文担当を呼び出します」）では、
  // まず注文ルートの選択肢をお客様へ返す。ここを返信確認キューへ
  // 回すと、初回案内が店長側にだけ保存され、お客様には届かない。
  if (result.session.stage === 'awaiting_order_route') {
    const delivery = deliverCustomerMessagesAfterDelay(
      customerId,
      splitCustomerReply(result.message),
      event.__bundled ? 'bundled_reply' : 'initial_intake',
      env,
      async () => {
        const sentAt = new Date().toISOString();
        await env.DB.prepare(`INSERT INTO order_messages (order_thread_id, direction, message_text, occurred_at) VALUES (?, 'assistant_outbound', ?, ?)`)
          .bind('customer:' + customerId, result.message.slice(0, 4900), sentAt).run();
      },
    );
    await continueCustomerDelivery(delivery, ctx);
    return;
  }

  // 初回の注文相談だけは自動で基本ヒアリングを返し、統括への通知は行わない。
  // お客様の回答が届いた次の段階で、内容を確認待ちとして統括へ回す。
  const missingFields = missingIntakeFields(result.session.fields);
  if (result.session.stage === 'collecting' && missingFields.length > 0) {
    const timingProfile = event.__bundled ? 'bundled_reply' : (wasCollecting ? 'missing_details' : 'initial_intake');
    const questionsShown = wasCollecting ? missingFields.slice(0, 3) : missingFields;
    const delivery = deliverCustomerMessagesAfterDelay(
      customerId,
      splitCustomerReply(result.message),
      timingProfile,
      env,
      async () => {
        const sentAt = new Date().toISOString();
        await env.DB.prepare(`INSERT INTO order_messages (order_thread_id, direction, message_text, occurred_at) VALUES (?, 'assistant_outbound', ?, ?)`)
          .bind('customer:' + customerId, result.message.slice(0, 4900), sentAt).run();
        await recordOrderQuestions(customerId, questionsShown, result.message, sentAt, env);
      },
    );
    await continueCustomerDelivery(delivery, ctx);
    return;
  }

  // 基本8項目が揃った直後は、お客様へ復唱しながら統括へ制作可否確認を引き継ぐ。
  // 統括通知は顧客向けの自然な待ち時間に依存させず、先に確実に処理する。
  if (result.session.stage === 'review' && wasCollecting) {
    const confirmation = basicOrderConfirmation(event.message?.text?.trim() || '', result.session);
    const names = await getCustomerNames('customer:' + customerId, env);
    const customerLabel = formatCustomerLabel(names.confirmedName || names.displayName);
    const candidate = event.message?.type === 'text' ? extractScheduleCandidate(event.message?.text || '') : null;
    const ownerRequest = await createOwnerDecisionRequest({
      threadId: 'customer:' + customerId,
      sourceEventId,
      text: event.message?.text || '',
      candidate,
      customerLabel,
      now: new Date().toISOString(),
      env,
    });
    if (ownerRequest) {
      const notificationKey = `owner-decision:${ownerRequest.id}`;
      if (!(await ownerNotificationSucceeded(notificationKey, env))) {
        const productReference = result.session.fields.productReference || result.session.fields.productSourceValue;
        const catalogProduct = productReference ? await findProductCatalogMatch(productReference, env) : null;
        const productImages = catalogProduct?.image_url
          ? [{ type: 'image', originalContentUrl: catalogProduct.image_url, previewImageUrl: catalogProduct.image_url }]
          : [];
        await notifyOwners(
          formatOwnerDecisionRequest(ownerRequest, catalogProduct),
          env,
          productImages,
          notificationKey,
        );
      }
    }
    const delivery = deliverCustomerMessagesAfterDelay(
      customerId,
      [confirmation],
      event.__bundled ? 'bundled_reply' : 'details_confirmation',
      env,
      async () => {
        await env.DB.prepare(`INSERT INTO order_messages (order_thread_id, direction, message_text, occurred_at) VALUES (?, 'assistant_outbound', ?, ?)`)
          .bind('customer:' + customerId, confirmation.slice(0, 4900), new Date().toISOString()).run();
      },
    );
    await continueCustomerDelivery(delivery, ctx);
    return;
  }

  const threadId = 'customer:' + customerId;
  const reviewId = `review:${sourceEventId}`;
  const duplicate = await env.DB.prepare(`SELECT id FROM customer_reply_reviews
      WHERE order_thread_id = ? AND draft_message = ? AND status IN ('needs_review', 'needs_change_confirmation')
      ORDER BY created_at DESC LIMIT 1`).bind(threadId, result.message).first();
  if (duplicate) return;
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO customer_reply_reviews
      (id, source_event_id, order_thread_id, customer_line_user_id, draft_message, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'needs_review', ?)`)
    .bind(reviewId, sourceEventId, threadId, customerId, result.message, new Date().toISOString()).run();
  if (!inserted.meta.changes) return;

  const names = await getCustomerNames(threadId, env);
  const customerLabel = formatCustomerLabel(names.confirmedName || names.displayName);
  const incomingText = event.message?.type === 'image' ? '' : redactContactDetails(event.message?.text || '').slice(0, 450);
  const incoming = event.__bundleHasImage
    ? `参考画像あり${incomingText ? `\n${incomingText}` : ''}`
    : (incomingText || '参考画像が届きました。');
  await notifyOwners(`統括マネージャーです。\n\n【お客様への返信確認】\n${customerLabel}からの連絡：\n「${incoming}」\n\n【送信案】\n${result.message.slice(0, 2500)}\n\n内容を確認してから送信します。\n・このまま送る：送信 ${reviewId}\n・文章を修正して送る：送信 ${reviewId} 修正した文章\n・保留する：保留 ${reviewId} 理由`, env);
}

function splitCustomerReply(message) {
  const marker = '【ご注文内容】';
  const index = message.indexOf(marker);
  if (index <= 0) return [message];
  const closingMarkers = ['\n\n内容を確認し', '\n\nすべての項目を確認できましたら', '\n\n基本項目を確認できましたら'];
  const closingIndex = closingMarkers
    .map((closingMarker) => message.indexOf(closingMarker, index))
    .filter((markerIndex) => markerIndex >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
  if (closingIndex < 0) return [message.slice(0, index).trim(), message.slice(index).trim()];
  return [message.slice(0, index).trim(), message.slice(index, closingIndex).trim(), message.slice(closingIndex).trim()];
}

async function prepareCustomerReplySend(replyToken, userId, reviewId, replacement, confirmed, env) {
  const review = await env.DB.prepare(`SELECT * FROM customer_reply_reviews WHERE id = ?`).bind(reviewId).first();
  if (!review || !['needs_review', 'needs_change_confirmation'].includes(review.status)) {
    return reply(replyToken, '確認待ちの返信案が見つからないか、すでに処理済みです。', env);
  }
  const message = replacement || review.proposed_message || review.draft_message;
  if (!confirmed && replacement && hasCriticalReplyDifference(review.draft_message, replacement)) {
    await env.DB.prepare(`UPDATE customer_reply_reviews SET status = 'needs_change_confirmation', proposed_message = ? WHERE id = ?`)
      .bind(replacement.slice(0, 4900), reviewId).run();
    return reply(replyToken, `日付・時刻・金額・受取／配達に差分の可能性があります。内容を確認し、送信する場合は「送信確認 ${reviewId}」と返信してください。`, env);
  }
  const sent = await pushCustomerMessage(review.customer_line_user_id, message, env);
  if (!sent) return reply(replyToken, 'お客様への送信に失敗しました。内容は送信せず、確認待ちのままです。', env);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE customer_reply_reviews SET status = 'sent', proposed_message = ?, sent_at = ?, sent_by = ? WHERE id = ?`)
      .bind(message.slice(0, 4900), now, userId, reviewId),
    env.DB.prepare(`INSERT INTO order_messages (order_thread_id, direction, message_text, occurred_at) VALUES (?, 'assistant_outbound', ?, ?)`)
      .bind(review.order_thread_id, message.slice(0, 4900), now),
  ]);
  return reply(replyToken, 'お客様へ送信し、注文記録にも残しました。', env);
}

function hasCriticalReplyDifference(draft, replacement) {
  const tokens = (value) => value.match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}:\d{2}|[0-9０-９][0-9０-９,，]*円|受取|受け取り|配達|来店|発送/g) || [];
  return JSON.stringify(tokens(draft)) !== JSON.stringify(tokens(replacement));
}

async function syncCustomerOrderRecord({ customerId, threadId, event, text, now, env, allowCreate = false }) {
  const sourceMessageId = event.webhookEventId || event.message?.id || `message:${Date.now()}`;
  const orderRecord = await getOrCreateActiveOrderRecord(customerId, threadId, sourceMessageId, now, env, allowCreate);
  if (!orderRecord) return null;
  const candidate = event.message?.type === 'text' ? extractScheduleCandidate(text) : null;
  const updates = extractOrderRecordUpdates(text, event.message?.type === 'image', candidate);
  const pendingChanges = [];

  for (const update of updates) {
    const existing = await env.DB.prepare(`SELECT value_text, status, locked
        FROM order_record_fields WHERE order_record_id = ? AND field_key = ?`)
      .bind(orderRecord.id, update.key).first();
    if (!existing) {
      await env.DB.prepare(`INSERT INTO order_record_fields
          (order_record_id, field_key, phase, value_text, status, source_message_id,
           source_direction, source_occurred_at, confidence, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'customer_inbound', ?, ?, ?)`)
        .bind(orderRecord.id, update.key, update.phase, update.value, update.status,
          sourceMessageId, now, update.confidence, now).run();
      continue;
    }
    if (normalizeChartValue(existing.value_text) === normalizeChartValue(update.value)) {
      await env.DB.prepare(`UPDATE order_record_fields
          SET source_message_id = ?, source_occurred_at = ?, confidence = MAX(COALESCE(confidence, 0), ?), updated_at = ?
          WHERE order_record_id = ? AND field_key = ?`)
        .bind(sourceMessageId, now, update.confidence, now, orderRecord.id, update.key).run();
      continue;
    }
    if (Number(existing.locked) === 1 || existing.status === 'confirmed') {
      const changeId = `change:${orderRecord.id}:${update.key}:${sourceMessageId}`;
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO order_field_changes
          (id, order_record_id, field_key, old_value, new_value, requested_status,
           status, source_message_id, source_occurred_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending_owner', ?, ?, ?)`)
        .bind(changeId, orderRecord.id, update.key, existing.value_text, update.value,
          update.status, sourceMessageId, now, now).run();
      if (inserted.meta.changes) pendingChanges.push({
        id: changeId,
        fieldKey: update.key,
        oldValue: existing.value_text,
        newValue: update.value,
      });
      continue;
    }
    await env.DB.prepare(`UPDATE order_record_fields
        SET value_text = ?, status = ?, source_message_id = ?, source_direction = 'customer_inbound',
            source_occurred_at = ?, confidence = ?, updated_at = ?
        WHERE order_record_id = ? AND field_key = ?`)
      .bind(update.value, update.status, sourceMessageId, now, update.confidence, now,
        orderRecord.id, update.key).run();
  }

  await env.DB.prepare(`UPDATE customer_order_records SET updated_at = ? WHERE id = ?`)
    .bind(now, orderRecord.id).run();
  for (const update of updates) {
    await env.DB.prepare(`UPDATE order_question_history SET answered_at = ?
        WHERE id = (SELECT id FROM order_question_history
          WHERE order_record_id = ? AND field_key = ? AND answered_at IS NULL
          ORDER BY asked_at DESC LIMIT 1)`)
      .bind(now, orderRecord.id, update.key).run();
  }
  await syncCustomerProfileFromOrderUpdates(customerId, updates, now, env);
  await advanceOrderRecordAfterContact(orderRecord.id, now, env);
  return { orderRecord, pendingChanges };
}

async function advanceOrderRecordAfterContact(orderRecordId, now, env) {
  const record = await env.DB.prepare(`SELECT status FROM customer_order_records WHERE id = ?`)
    .bind(orderRecordId).first();
  if (!['detail_intake', 'awaiting_customer_confirmation'].includes(record?.status)) return;
  const rows = await env.DB.prepare(`SELECT field_key, status FROM order_record_fields
      WHERE order_record_id = ? AND field_key IN ('customer_name', 'phone')`).bind(orderRecordId).all();
  const states = Object.fromEntries((rows.results || []).map((row) => [row.field_key, row.status]));
  if (!['answered', 'confirmed'].includes(states.customer_name) || !['answered', 'confirmed'].includes(states.phone)) return;
  await env.DB.prepare(`UPDATE customer_order_records SET status = 'confirmed', updated_at = ? WHERE id = ?`)
    .bind(now, orderRecordId).run();
}

async function getOrCreateActiveOrderRecord(customerId, threadId, sourceMessageId, now, env, allowCreate) {
  const active = await env.DB.prepare(`SELECT * FROM customer_order_records
      WHERE customer_line_user_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1`)
    .bind(customerId).first();
  if (active) return active;
  if (!allowCreate) return null;
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM customer_order_records
      WHERE customer_line_user_id = ?`).bind(customerId).first();
  const sequenceNumber = Number(countRow?.total || 0) + 1;
  const safeSourceId = String(sourceMessageId).replace(/[^A-Za-z0-9_-]/g, '').slice(-60) || String(Date.now());
  const id = `order:${customerId}:${safeSourceId}`;
  const displayCode = createOrderDisplayCode();
  await env.DB.prepare(`INSERT INTO customer_order_records
      (id, customer_line_user_id, source_thread_id, sequence_number, display_code,
       status, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'feasibility_intake', 1, ?, ?)`)
    .bind(id, customerId, threadId, sequenceNumber, displayCode, now, now).run();
  return { id, customer_line_user_id: customerId, source_thread_id: threadId, sequence_number: sequenceNumber, display_code: displayCode, status: 'feasibility_intake', is_active: 1 };
}

function createOrderDisplayCode(now = Date.now(), randomValue = randomUnit()) {
  const timePart = now.toString(36).toUpperCase().slice(-5).padStart(5, '0');
  const randomPart = Math.floor(Math.max(0, Math.min(0.999999, randomValue)) * 1296)
    .toString(36).toUpperCase().padStart(2, '0');
  return `K${timePart}${randomPart}`;
}

function extractOrderRecordUpdates(text, isImage, candidate) {
  text = stripIntakeTemplateHints(text);
  const updates = [];
  const add = (key, value, confidence = 1, phase = 'feasibility') => {
    const normalized = value?.trim();
    if (!normalized) return;
    updates.push({ key, value: normalized.slice(0, 1000), status: orderFieldStatus(normalized, key), confidence, phase });
  };

  if (isImage) add('product_source', '参考画像あり', 1);
  const productReference = extractProductReference(text);
  const productSource = labeledAnswer(text, 'HPの商品番号\\s*または参考画像|参考画像|商品番号|品番');
  if (productReference) add('product_source', productReference, 1);
  else if (productSource) add('product_source', productSource, 1);

  const productType = detectProductType(text);
  const productTypeAnswer = labeledAnswer(text, 'バルーンのタイプ|商品タイプ');
  if (productType) add('product_type', productTypeLabel(productType), 0.95);
  else if (productTypeAnswer) add('product_type', productTypeAnswer, 1);

  const budgetAnswer = labeledAnswer(text, 'ご予算|予算');
  const budgetMatch = text.match(/(?:予算|ご予算)?\s*([0-9０-９][0-9０-９,，]*)\s*円/u);
  if (budgetAnswer) add('budget', budgetAnswer, 1);
  else if (budgetMatch) add('budget', `${parseJapaneseNumber(budgetMatch[1]).toLocaleString('ja-JP')}円`, 0.9);

  const color = labeledAnswer(text, '全体的なお色味と雰囲気|色味・雰囲気|色味|雰囲気');
  if (color) add('color_vibe', color, 1);

  const useDate = labeledAnswer(text, 'プレゼント・使用予定日|使用予定日|プレゼント予定日|利用日|使用日');
  if (useDate) add('use_date', useDate, 1);

  const receiveDate = labeledAnswer(text, '受取希望日|受け取り希望日|お届け希望日|ご希望日');
  if (receiveDate) add('receive_date', receiveDate, 1);
  else if (candidate?.date) add('receive_date', candidate.date, 0.85);

  const receiveTime = labeledAnswer(text, '受取希望時間|受け取り希望時間|お届け希望時間|ご希望時間|希望時間');
  if (receiveTime) add('receive_time', receiveTime, 1);
  else if (candidate?.time) add('receive_time', candidate.time, 0.85);

  const method = labeledAnswer(text, '受取方法|受け取り方法|お届け方法|方法');
  if (method) add('fulfillment_method', method, 1);
  else if (/店頭受取|店頭で受取|店頭で受け取/u.test(text)) add('fulfillment_method', '店頭受取', 0.95);
  else if (/配達|配送/u.test(text)) add('fulfillment_method', '配達', 0.95);
  else if (/発送|郵送/u.test(text)) add('fulfillment_method', '発送', 0.95);

  addLaterOrderField(updates, text, 'balloon_message', 'バルーンへのご希望の文字入れ|文字入れ', 'product_detail');
  addLaterOrderField(updates, text, 'card_message', 'メッセージカードの有無|メッセージカード|カードの内容', 'product_detail');
  addLaterOrderField(updates, text, 'customer_name', 'お名前|氏名|名前', 'customer_confirmation');
  addLaterOrderField(updates, text, 'phone', 'ご連絡先|電話番号|電話|TEL', 'customer_confirmation');
  addLaterOrderField(updates, text, 'delivery_address', 'お届け先|配送先|発送先|住所', 'fulfillment');
  addLaterOrderField(updates, text, 'payment_method', '支払方法|お支払い方法', 'payment');
  addLaterOrderField(updates, text, 'receipt', '領収書', 'payment');
  addLaterOrderField(updates, text, 'sns_permission', 'HP・SNS掲載|SNS掲載|掲載可否', 'completion');
  return updates;
}

function addLaterOrderField(updates, text, key, pattern, phase) {
  const value = labeledAnswer(text, pattern);
  if (!value) return;
  updates.push({ key, value: value.slice(0, 1000), status: orderFieldStatus(value, key), confidence: 1, phase });
}

function labeledAnswer(text, label) {
  const lines = stripIntakeTemplateHints(text).split(/\r?\n/u);
  const pattern = new RegExp(`(?:${label})[ \t\u3000]*(?:→|[：:])[ \t\u3000]*(.*)$`, 'u');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern);
    if (!match) continue;
    const sameLine = match[1]?.trim();
    if (sameLine) return sameLine;
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex].trim();
      if (!nextLine) continue;
      if (/^[・•●▪︎]\s*[^\n]{1,50}[：:]/u.test(nextLine)) return null;
      return nextLine;
    }
    return null;
  }
  return null;
}

function stripIntakeTemplateHints(text) {
  return String(text || '').split(/\r?\n/u).filter((line) => {
    const value = line.trim();
    if (!/^[（(].*[）)]$/u.test(value)) return true;
    return !/(?:^\s*[（(]\s*例[：:]|このトークに画像|いつプレゼント|いつ使う|画像添付済み|ブーケ.*置き型|店頭受取.*配達)/u.test(value);
  }).join('\n');
}

function orderFieldStatus(value, key) {
  if (/^(?:未定|まだ決まっていない|決まっていません|わからない|分からない)$/u.test(value)) return 'undecided';
  if (/^(?:なし|不要|該当なし)$/u.test(value) && !ORDER_FEASIBILITY_FIELDS.some((field) => field.key === key)) return 'not_applicable';
  return 'answered';
}

function normalizeChartValue(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function productTypeLabel(type) {
  return ({
    arrangement: '置き型アレンジメント',
    floating_balloon: 'ヘリウム（浮く）タイプ',
    venue_decoration: '会場装飾',
    balloon_stand: 'バルーンスタンド',
    balloon_bouquet: 'ブーケ',
    store_consultation: '来店相談',
    other: 'その他（自由記載）',
  })[type] || type;
}

async function syncCustomerProfileFromOrderUpdates(customerId, updates, now, env) {
  const values = Object.fromEntries(updates.map((update) => [update.key, update.value]));
  if (!values.customer_name && !values.phone && !values.delivery_address) return;
  await env.DB.prepare(`UPDATE customer_profiles SET
      confirmed_name = COALESCE(?, confirmed_name),
      phone = COALESCE(?, phone),
      address = COALESCE(?, address),
      last_seen_at = ?
      WHERE customer_line_user_id = ?`)
    .bind(values.customer_name || null, values.phone || null, values.delivery_address || null, now, customerId).run();
}

function formatPendingOrderChanges(customerLabel, changes) {
  const lines = changes.map((change) => [
    `・${ORDER_FIELD_LABELS[change.fieldKey] || change.fieldKey}`,
    `  変更前：${change.oldValue || '未入力'}`,
    `  変更後：${change.newValue || '未入力'}`,
  ].join('\n')).join('\n\n');
  return `統括マネージャーです。\n\n【注文カルテの変更確認】\n${customerLabel}から、確定済み内容の変更と思われる連絡がありました。\n\n${lines}\n\n反映する場合：変更OK\n元の内容を残す場合：変更しない`;
}

async function reviewLatestOrderFieldChange(replyToken, userId, requestedId, approve, env) {
  const seed = requestedId
    ? await env.DB.prepare(`SELECT * FROM order_field_changes WHERE id = ? AND status = 'pending_owner'`).bind(requestedId).first()
    : await env.DB.prepare(`SELECT * FROM order_field_changes WHERE status = 'pending_owner' ORDER BY created_at DESC LIMIT 1`).first();
  if (!seed) return reply(replyToken, '確認待ちの注文内容変更はありません。', env);
  const changes = requestedId
    ? [seed]
    : (await env.DB.prepare(`SELECT * FROM order_field_changes
        WHERE order_record_id = ? AND source_message_id = ? AND status = 'pending_owner'
        ORDER BY created_at ASC`).bind(seed.order_record_id, seed.source_message_id).all()).results || [];
  const now = new Date().toISOString();
  if (!approve) {
    await env.DB.batch(changes.map((change) => env.DB.prepare(`UPDATE order_field_changes
        SET status = 'rejected', reviewed_at = ?, reviewed_by = ? WHERE id = ?`)
      .bind(now, userId, change.id)));
    const labels = changes.map((change) => ORDER_FIELD_LABELS[change.field_key] || change.field_key).join('、');
    return reply(replyToken, `${labels}は変更せず、元の内容を残しました。`, env);
  }
  const statements = [];
  for (const change of changes) {
    const sourceDirection = String(change.source_message_id || '').startsWith('phone:') ? 'owner_recorded' : 'customer_inbound';
    statements.push(
      env.DB.prepare(`UPDATE order_record_fields SET value_text = ?, status = 'confirmed',
          source_message_id = ?, source_direction = ?, source_occurred_at = ?,
          confidence = 1, locked = 1, updated_at = ?, confirmed_at = ?, confirmed_by = ?
          WHERE order_record_id = ? AND field_key = ?`)
        .bind(change.new_value, change.source_message_id, sourceDirection, change.source_occurred_at,
          now, now, userId, change.order_record_id, change.field_key),
      env.DB.prepare(`UPDATE order_field_changes SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ?`)
        .bind(now, userId, change.id),
    );
  }
  await env.DB.batch(statements);
  const labels = changes.map((change) => ORDER_FIELD_LABELS[change.field_key] || change.field_key).join('、');
  return reply(replyToken, `${labels}を新しい内容へ更新しました。`, env);
}

async function recordOrderQuestions(customerId, labels, questionText, askedAt, env) {
  const orderRecord = await env.DB.prepare(`SELECT id FROM customer_order_records
      WHERE customer_line_user_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1`)
    .bind(customerId).first();
  if (!orderRecord) return;
  for (const label of labels) {
    const field = ORDER_FEASIBILITY_FIELDS.find((item) => item.label === label);
    if (!field) continue;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO order_question_history
          (order_record_id, field_key, question_text, asked_at)
          VALUES (?, ?, ?, ?)`)
        .bind(orderRecord.id, field.key, questionText.slice(0, 1500), askedAt),
      env.DB.prepare(`INSERT INTO order_record_fields
          (order_record_id, field_key, phase, status, question_count, updated_at)
          VALUES (?, ?, 'feasibility', 'asked', 1, ?)
          ON CONFLICT(order_record_id, field_key) DO UPDATE SET
            question_count = order_record_fields.question_count + 1,
            status = CASE WHEN order_record_fields.status = 'unasked' THEN 'asked' ELSE order_record_fields.status END,
            updated_at = excluded.updated_at`)
        .bind(orderRecord.id, field.key, askedAt),
    ]);
  }
}

async function replyLatestOrderRecord(replyToken, env) {
  const orderRecord = await env.DB.prepare(`SELECT r.*, t.customer_display_name, t.customer_confirmed_name
      FROM customer_order_records r
      JOIN customer_order_threads t ON t.id = r.source_thread_id
      WHERE r.is_active = 1
      ORDER BY r.updated_at DESC LIMIT 1`).first();
  if (!orderRecord) return reply(replyToken, '進行中の注文カルテはありません。', env);
  const fields = await loadOrderRecordFields(orderRecord.id, env);
  const pendingRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM order_field_changes
      WHERE order_record_id = ? AND status = 'pending_owner'`).bind(orderRecord.id).first();
  const message = formatOrderRecordCard(
    formatCustomerLabel(orderRecord.customer_confirmed_name || orderRecord.customer_display_name),
    orderRecord,
    fields,
    Number(pendingRow?.total || 0),
  );
  return reply(replyToken, message, env);
}

async function handleRichMenuCommand(replyToken, command, env) {
  if (command === '確認待ち一覧') {
    return replyPendingOwnerDecisions(replyToken, env, false, '【確認待ち一覧】\n\n受注判断・返信承認・変更確認など、店長の確認が必要な案件を表示します。');
  }
  if (command === '受注判断') {
    return replyPendingOwnerDecisions(replyToken, env, true, '【受注判断】\n\n制作可否の判断が必要な注文だけを表示します。');
  }
  return reply(replyToken, richMenuPrompt(command), env);
}

async function replyPendingOwnerDecisions(replyToken, env, decisionMode = false, heading = '【確認待ち一覧】') {
  const rows = await env.DB.prepare(`SELECT d.id, d.request_types, d.customer_summary,
      r.display_code, r.status AS order_status
      FROM owner_decision_requests d
      LEFT JOIN customer_order_records r ON r.source_thread_id = d.order_thread_id AND r.is_active = 1
      WHERE d.status = 'needs_owner_review'
      ORDER BY d.created_at ASC LIMIT 10`).all();
  return reply(replyToken, formatPendingOwnerDecisionList(rows.results || [], decisionMode, heading), env);
}

function formatPendingOwnerDecisionList(rows, decisionMode = false, heading = '【確認待ち一覧】') {
  if (!rows.length) return `${heading}\n\n該当する確認待ちはありません。`;
  const lines = rows.map((row, index) => {
    const code = row.display_code || row.id;
    const summary = String(row.customer_summary || '').split('\n').slice(0, 4).join('\n');
    return `【${index + 1}】${code}\n${summary}`;
  });
  const suffix = decisionMode
    ? '\n\n操作番号で返信できます（一覧を表示した時点の番号）。\n・1 受ける\n・1 難しい 理由\n・1 確認\n\n正式カルテ番号（Kから始まる番号）も利用できます。'
    : '\n\n受注判断を行う場合は「受注判断」を押してください。';
  return `${heading}\n\n${lines.join('\n\n')}${suffix}`;
}

function richMenuPrompt(command) {
  const prompts = {
    '日付変更依頼': '【日付変更依頼】\n\n注文の操作番号（確認待ち一覧の1〜9）または正式カルテ番号と、変更後の日付・時間を送ってください。\n\n例：1 日付変更 10月5日 14時頃\n\n変更内容を復唱し、カレンダーの重複を確認してから反映します。',
    'お客様への返信依頼': '【お客様への返信依頼】\n\n注文の操作番号または正式カルテ番号と、送りたい文章を送ってください。\n\n例：1 お客様へ ご希望の日時で対応可能か確認します。\n（店長指定文：1 指定メッセージ 本文）\n\n送信案を表示し、店長が「顧客送信確認」と返信した後に送信します。',
    '制作進捗更新': '【制作進捗更新】\n\n進捗は統括が注文内容を確認し、変更前に「はい／いいえ」で確認します。\n制作開始・完成・受渡し・支払い確認の内容が分かるメッセージを送ってください。\n\n例：KABC123の制作が完成しました。\n例：1 お渡ししました\n\n遠隔クレジット決済の発行・確認は店長が手動で行います。',
    'システム変更依頼': '【システム変更依頼】\n\n変更対象・変更内容・希望時期を送ってください。\n\n例：商品ページの画像を差し替えたい\n例：注文ヒアリング文を変更したい\n\n変更案と影響範囲を整理し、店長の承認後に反映します。',
  };
  return prompts[command] || `${command}を受け付けました。内容を確認して整理します。`;
}

async function registerManualOrderFormImage(event, env) {
  const now = new Date().toISOString();
  const sourceMessageId = event.webhookEventId || event.message?.id || `image:${Date.now()}`;
  const safeId = String(sourceMessageId).replace(/[^A-Za-z0-9_-]/g, '').slice(-60) || String(Date.now());
  const customerId = `manual:${safeId}`;
  const threadId = `manual-thread:${safeId}`;
  const orderRecordId = `order:${customerId}`;
  const orderCardId = `order-card:${threadId}`;
  const displayCode = createOrderDisplayCode();

  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO customer_profiles
      (customer_line_user_id, first_seen_at, last_seen_at, completed_order_count, relationship_override)
      VALUES (?, ?, ?, 0, 'new')`).bind(customerId, now, now),
    env.DB.prepare(`INSERT OR IGNORE INTO customer_order_threads
      (id, customer_line_user_id, status, summary, fulfillment_type, created_at, updated_at)
      VALUES (?, ?, 'collecting', ?, 'unknown', ?, ?)`).bind(threadId, customerId, '来店・電話受付の紙注文書画像', now, now),
    env.DB.prepare(`INSERT OR IGNORE INTO customer_order_records
      (id, customer_line_user_id, source_thread_id, sequence_number, display_code,
       status, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, 'detail_intake', 1, ?, ?)`).bind(orderRecordId, customerId, threadId, displayCode, now, now),
    env.DB.prepare(`INSERT OR IGNORE INTO order_cards
      (id, order_thread_id, status, fulfillment_type, owner_notes, created_at, updated_at)
      VALUES (?, ?, 'needs_details', 'unknown', ?, ?, ?)`).bind(orderCardId, threadId, `紙注文書画像受領（LINE message_id: ${sourceMessageId}）`, now, now),
    env.DB.prepare(`INSERT INTO order_card_events
      (order_card_id, event_type, actor, detail, occurred_at)
      VALUES (?, 'manual.order_form_image_received', 'owner', ?, ?)`).bind(orderCardId, `店長記入の注文書画像を受領しました。画像参照元：${sourceMessageId}`, now),
    env.DB.prepare(`INSERT INTO order_messages
      (webhook_event_id, order_thread_id, direction, message_text, occurred_at)
      VALUES (?, ?, 'owner_recorded', ?, ?)`).bind(`manual-image:${sourceMessageId}`, threadId, '[紙注文書画像を受領]', now),
    env.DB.prepare(`INSERT INTO order_record_fields
      (order_record_id, field_key, phase, value_text, status, source_message_id,
       source_direction, source_occurred_at, confidence, locked, updated_at)
      VALUES (?, 'order_form_image', 'product_detail', '紙注文書画像あり', 'answered', ?, 'owner_recorded', ?, 1, 0, ?)\n      ON CONFLICT(order_record_id, field_key) DO UPDATE SET
       value_text = excluded.value_text, status = 'answered', source_message_id = excluded.source_message_id,
       source_direction = 'owner_recorded', source_occurred_at = excluded.source_occurred_at,
       updated_at = excluded.updated_at`).bind(orderRecordId, sourceMessageId, now, now),
  ]);
  const persisted = await env.DB.prepare(`SELECT display_code FROM customer_order_records WHERE id = ?`)
    .bind(orderRecordId).first();
  const cardCode = persisted?.display_code || displayCode;

  return reply(event.replyToken,
    `紙の注文書画像を受領し、注文カルテへ登録しました。\n\n注文カルテ番号：${cardCode}\n\n画像だけでは読み取りにくい項目や不明点がある場合は、次の形式で補足してください。\n\n紙注文補足 ${cardCode} お名前：／ご連絡先：／商品：／予算：／配色・雰囲気：／希望日・時間：／受取方法：\n\n補足内容は店長記入としてカルテへ反映します。`, env);
}

async function recordManualOrderSupplement(replyToken, userId, displayCode, text, env) {
  if (!displayCode) return reply(replyToken, '紙注文書の補足には注文カルテ番号が必要です。例：紙注文補足 KABC123 お名前：山田／ご連絡先：090-0000-0000', env);
  displayCode = await resolveManagerDisplayCode(displayCode, env, { manualOnly: true });
  if (!displayCode) return reply(replyToken, 'その操作番号の紙注文書カルテが見つかりません。まず「確認待ち一覧」またはカルテ番号をご確認ください。', env);
  const orderRecord = await env.DB.prepare(`SELECT r.*, t.id AS thread_id
      FROM customer_order_records r JOIN customer_order_threads t ON t.id = r.source_thread_id
      WHERE r.display_code = ? AND r.is_active = 1 AND r.customer_line_user_id LIKE 'manual:%'`).bind(displayCode).first();
  if (!orderRecord) return reply(replyToken, `${displayCode}の紙注文書カルテが見つかりません。`, env);
  const now = new Date().toISOString();
  const sourceMessageId = `manual-supplement:${Date.now()}`;
  const updates = extractOrderRecordUpdates(text, false, extractScheduleCandidate(text));
  if (!updates.length) return reply(replyToken, '補足内容を読み取れませんでした。項目名を付けて入力してください（例：お名前：山田／予算：15000円）。', env);
  await applyOwnerOrderUpdates(orderRecord.id, updates, sourceMessageId, now, userId, env);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO order_messages
      (webhook_event_id, order_thread_id, direction, message_text, occurred_at)
      VALUES (?, ?, 'owner_recorded', ?, ?)`).bind(sourceMessageId, orderRecord.thread_id, text.slice(0, 4900), now),
    env.DB.prepare(`INSERT INTO order_card_events
      (order_card_id, event_type, actor, detail, occurred_at)
      VALUES (?, 'manual.order_form_supplement_recorded', 'owner', ?, ?)`).bind(`order-card:${orderRecord.thread_id}`, text.slice(0, 1500), now),
  ]);
  return reply(replyToken, `${displayCode}の補足内容を注文カルテへ反映しました。`, env);
}

async function recordOrderDateChange(replyToken, userId, reference, text, env) {
  const selection = await selectActiveOrderForManager(reference, env);
  if (!selection.candidates.length) return reply(replyToken, `${reference}の進行中カルテが見つかりません。`, env);
  if (!selection.orderRecord) return reply(replyToken, formatAmbiguousOrderChoices(selection.candidates, '日付変更 カルテ番号 日付 時間'), env);
  const candidate = extractScheduleCandidate(text);
  if (!candidate?.date) return reply(replyToken, '変更後の日付を確認できませんでした。例：1 日付変更 10月5日 14時頃', env);
  const now = new Date().toISOString();
  const sourceMessageId = `manual-date-change:${Date.now()}`;
  const updates = [
    { key: 'receive_date', value: candidate.date, status: 'answered', confidence: 1, phase: 'feasibility' },
    { key: 'receive_time', value: candidate.time || '未定', status: candidate.time ? 'answered' : 'undecided', confidence: 1, phase: 'feasibility' },
  ];
  await applyOwnerOrderUpdates(selection.orderRecord.id, updates, sourceMessageId, now, userId, env);
  const scheduleConflict = await findBusinessScheduleConflict(candidate, env);
  await env.DB.prepare(`INSERT INTO order_card_events
      (order_card_id, event_type, actor, detail, occurred_at)
      VALUES (?, 'owner.date_changed', 'owner', ?, ?)`)
    .bind(`order-card:${selection.orderRecord.source_thread_id}`, JSON.stringify({ text, date: candidate.date, time: candidate.time, scheduleConflict }), now).run();
  return reply(replyToken, `${selection.orderRecord.display_code}の受取希望を${formatScheduleDate(candidate.date, candidate.time)}へ更新しました。${scheduleConflict ? `\n\n【要確認】${scheduleConflict}` : ''}`, env);
}

async function selectActiveOrderForManager(displayCode, env) {
  const originalReference = displayCode;
  displayCode = await resolveManagerDisplayCode(displayCode, env);
  if (originalReference && !displayCode) return { orderRecord: null, candidates: [] };
  const filter = displayCode ? ' AND r.display_code = ?' : '';
  const statement = env.DB.prepare(`SELECT r.*, t.customer_display_name, t.customer_confirmed_name
      FROM customer_order_records r
      JOIN customer_order_threads t ON t.id = r.source_thread_id
      WHERE r.is_active = 1${filter}
      ORDER BY r.updated_at DESC LIMIT 2`);
  const rows = displayCode ? await statement.bind(displayCode).all() : await statement.all();
  const candidates = rows.results || [];
  return {
    orderRecord: candidates.length === 1 ? candidates[0] : null,
    candidates,
  };
}

async function resolveManagerDisplayCode(reference, env, options = {}) {
  if (!reference || !/^[1-9]$/u.test(reference)) return reference || null;
  const pendingClause = options.pendingOnly ? " AND d.status = 'needs_owner_review'" : '';
  const manualClause = options.manualOnly ? " AND r.customer_line_user_id LIKE 'manual:%'" : '';
  const query = options.pendingOnly
    ? `SELECT r.display_code FROM owner_decision_requests d
       JOIN customer_order_records r ON r.source_thread_id = d.order_thread_id AND r.is_active = 1
       WHERE 1 = 1${pendingClause}${manualClause}
       ORDER BY d.created_at ASC LIMIT 10`
    : `SELECT r.display_code FROM customer_order_records r
       WHERE r.is_active = 1${manualClause}
       ORDER BY r.updated_at DESC LIMIT 10`;
  const rows = await env.DB.prepare(query).all();
  return rows.results?.[Number(reference) - 1]?.display_code || null;
}

async function prepareOwnerCustomerMessage(replyToken, userId, displayCode, message, env) {
  if (!message) return reply(replyToken, '送信する文章を「お客様へ 本文」の形で入力してください。', env);
  const selection = await selectActiveOrderForManager(displayCode, env);
  if (!selection.candidates.length) return reply(replyToken, displayCode
    ? `${displayCode}の進行中カルテはありません。`
    : '進行中の注文カルテはありません。', env);
  if (!selection.orderRecord) {
    return reply(replyToken, formatAmbiguousOrderChoices(selection.candidates, 'お客様へ カルテ番号 本文'), env);
  }
  const orderRecord = selection.orderRecord;
  const updates = extractOrderRecordUpdates(message, false, extractScheduleCandidate(message));
  const conflicts = await findOrderUpdateConflicts(orderRecord.id, updates, env);
  const pending = {
      orderRecordId: orderRecord.id,
      displayCode: orderRecord.display_code,
      customerLineUserId: orderRecord.customer_line_user_id,
      sourceThreadId: orderRecord.source_thread_id,
      message: message.slice(0, 4900),
      updates,
      conflicts,
  };
  await env.SECRETARY_KV.put('pending-customer-send:' + userId, JSON.stringify(pending), { expirationTtl: 600 });
  const conflictNotice = conflicts.length
    ? `\n\n送信文に注文カルテの変更が含まれています。\n${formatOrderUpdateConflicts(conflicts)}`
    : '';
  return reply(replyToken, `【お客様への送信案】\n\n${pending.message}${conflictNotice}\n\n内容を確認し、このまま送信する場合は「顧客送信確認」と返信してください。\n修正する場合は「指定メッセージ ${pending.displayCode} 修正文」、取り消す場合は「取消」と返信してください。`, env);
}

async function confirmPendingOwnerCustomerMessage(replyToken, userId, env) {
  const key = 'pending-customer-send:' + userId;
  const pending = await env.SECRETARY_KV.get(key, 'json');
  if (!pending) return reply(replyToken, '確認待ちのお客様向けメッセージはありません。', env);
  const orderRecord = await env.DB.prepare(`SELECT id, is_active FROM customer_order_records WHERE id = ?`)
    .bind(pending.orderRecordId).first();
  if (!orderRecord?.is_active) {
    await env.SECRETARY_KV.delete(key);
    return reply(replyToken, '対象の注文カルテはすでに完了しています。送信しませんでした。', env);
  }
  const result = await sendOwnerCustomerMessage(replyToken, userId, pending, env);
  await env.SECRETARY_KV.delete(key);
  return result;
}

async function sendOwnerCustomerMessage(replyToken, userId, pending, env) {
  const sent = await pushCustomerMessage(pending.customerLineUserId, pending.message, env);
  if (!sent) return reply(replyToken, 'お客様への送信に失敗しました。カルテは更新していません。', env);
  const now = new Date().toISOString();
  const sourceMessageId = `owner-send:${Date.now()}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO order_messages
        (webhook_event_id, order_thread_id, direction, message_text, occurred_at)
        VALUES (?, ?, 'owner_recorded', ?, ?)`)
      .bind(sourceMessageId, pending.sourceThreadId, pending.message, now),
    env.DB.prepare(`INSERT INTO order_card_events
        (order_card_id, event_type, actor, detail, occurred_at)
        VALUES (?, 'owner.customer_message_sent', 'owner', ?, ?)`)
      .bind(`order-card:${pending.sourceThreadId}`, pending.message.slice(0, 1500), now),
  ]);
  await applyOwnerOrderUpdates(pending.orderRecordId, pending.updates || [], sourceMessageId, now, userId, env);
  return reply(replyToken, `${pending.displayCode}のお客様へ送信し、会話ログと注文カルテへ記録しました。`, env);
}

async function recordOwnerPhoneMemo(replyToken, userId, displayCode, memo, env) {
  if (!memo) return reply(replyToken, '「電話メモ 内容」の形で入力してください。', env);
  const selection = await selectActiveOrderForManager(displayCode, env);
  if (!selection.candidates.length) return reply(replyToken, displayCode
    ? `${displayCode}の進行中カルテはありません。`
    : '進行中の注文カルテはありません。', env);
  if (!selection.orderRecord) {
    return reply(replyToken, formatAmbiguousOrderChoices(selection.candidates, '電話メモ カルテ番号 内容'), env);
  }
  const orderRecord = selection.orderRecord;
  const now = new Date().toISOString();
  const sourceMessageId = `phone:${Date.now()}`;
  const updates = extractOrderRecordUpdates(memo, false, extractScheduleCandidate(memo));
  const conflicts = await findOrderUpdateConflicts(orderRecord.id, updates, env);
  const conflictKeys = new Set(conflicts.map((conflict) => conflict.fieldKey));
  const safeUpdates = updates.filter((update) => !conflictKeys.has(update.key));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO order_messages
        (webhook_event_id, order_thread_id, direction, message_text, occurred_at)
        VALUES (?, ?, 'owner_recorded', ?, ?)`)
      .bind(sourceMessageId, orderRecord.source_thread_id, `[電話メモ] ${memo}`.slice(0, 4900), now),
    env.DB.prepare(`INSERT INTO order_card_events
        (order_card_id, event_type, actor, detail, occurred_at)
        VALUES (?, 'owner.phone_memo_recorded', 'owner', ?, ?)`)
      .bind(`order-card:${orderRecord.source_thread_id}`, memo.slice(0, 1500), now),
  ]);
  await applyOwnerOrderUpdates(orderRecord.id, safeUpdates, sourceMessageId, now, userId, env);
  if (!conflicts.length) return reply(replyToken, `${orderRecord.display_code}へ電話メモを記録しました。`, env);

  for (const conflict of conflicts) {
    const changeId = `change:${orderRecord.id}:${conflict.fieldKey}:${sourceMessageId}`;
    await env.DB.prepare(`INSERT OR IGNORE INTO order_field_changes
        (id, order_record_id, field_key, old_value, new_value, requested_status,
         status, source_message_id, source_occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending_owner', ?, ?, ?)`)
      .bind(changeId, orderRecord.id, conflict.fieldKey, conflict.oldValue, conflict.newValue,
        conflict.requestedStatus, sourceMessageId, now, now).run();
  }
  return reply(replyToken, `電話メモを保存しました。注文カルテの変更候補があります。\n\n${formatOrderUpdateConflicts(conflicts)}\n\nすべて反映する場合：変更OK\n元の内容を残す場合：変更しない`, env);
}

async function findOrderUpdateConflicts(orderRecordId, updates, env) {
  const fields = await loadOrderRecordFields(orderRecordId, env);
  return updates
    .filter((update) => fields[update.key]?.value_text
      && normalizeChartValue(fields[update.key].value_text) !== normalizeChartValue(update.value))
    .map((update) => ({
      fieldKey: update.key,
      oldValue: fields[update.key].value_text,
      newValue: update.value,
      requestedStatus: update.status,
    }));
}

function formatOrderUpdateConflicts(conflicts) {
  return conflicts.map((conflict) => [
    `・${ORDER_FIELD_LABELS[conflict.fieldKey] || conflict.fieldKey}`,
    `  変更前：${conflict.oldValue}`,
    `  変更後：${conflict.newValue}`,
  ].join('\n')).join('\n\n');
}

async function applyOwnerOrderUpdates(orderRecordId, updates, sourceMessageId, now, userId, env) {
  for (const update of updates) {
    const existing = await env.DB.prepare(`SELECT value_text FROM order_record_fields
        WHERE order_record_id = ? AND field_key = ?`).bind(orderRecordId, update.key).first();
    if (existing?.value_text && normalizeChartValue(existing.value_text) !== normalizeChartValue(update.value)) {
      const changeId = `change:owner:${orderRecordId}:${update.key}:${sourceMessageId}`;
      await env.DB.prepare(`INSERT OR IGNORE INTO order_field_changes
          (id, order_record_id, field_key, old_value, new_value, requested_status,
           status, source_message_id, source_occurred_at, created_at, reviewed_at, reviewed_by)
          VALUES (?, ?, ?, ?, ?, 'confirmed', 'approved', ?, ?, ?, ?, ?)`)
        .bind(changeId, orderRecordId, update.key, existing.value_text, update.value,
          sourceMessageId, now, now, now, userId).run();
    }
    await env.DB.prepare(`INSERT INTO order_record_fields
        (order_record_id, field_key, phase, value_text, status, source_message_id,
         source_direction, source_occurred_at, confidence, locked, updated_at,
         confirmed_at, confirmed_by)
        VALUES (?, ?, ?, ?, 'confirmed', ?, 'owner_recorded', ?, 1, 1, ?, ?, ?)
        ON CONFLICT(order_record_id, field_key) DO UPDATE SET
          value_text = excluded.value_text, status = 'confirmed', source_message_id = excluded.source_message_id,
          source_direction = 'owner_recorded', source_occurred_at = excluded.source_occurred_at,
          confidence = 1, locked = 1, updated_at = excluded.updated_at,
          confirmed_at = excluded.confirmed_at, confirmed_by = excluded.confirmed_by`)
      .bind(orderRecordId, update.key, update.phase, update.value, sourceMessageId,
        now, now, now, userId).run();
  }
  await env.DB.prepare(`UPDATE customer_order_records SET updated_at = ? WHERE id = ?`)
    .bind(now, orderRecordId).run();
}

async function handleOwnerShortDecision(replyToken, userId, action, displayCode, note, env) {
  const originalReference = displayCode;
  displayCode = await resolveManagerDisplayCode(displayCode, env, { pendingOnly: true });
  if (originalReference && !displayCode) return reply(replyToken, 'その操作番号の確認待ち案件が見つかりません。最新の「確認待ち一覧」を表示してから、番号を入力してください。', env);
  let filter = '';
  if (displayCode) {
    filter = ' AND r.display_code = ?';
  }
  const statement = env.DB.prepare(`SELECT d.*, r.id AS order_record_id, r.display_code,
      r.status AS order_status, t.customer_display_name, t.customer_confirmed_name
      FROM owner_decision_requests d
      JOIN customer_order_records r ON r.source_thread_id = d.order_thread_id AND r.is_active = 1
      JOIN customer_order_threads t ON t.id = r.source_thread_id
      WHERE d.status = 'needs_owner_review'${filter}
      ORDER BY d.created_at DESC LIMIT 2`);
  const rows = displayCode ? await statement.bind(displayCode).all() : await statement.all();
  const candidates = rows.results || [];
  if (!candidates.length) return reply(replyToken, displayCode
    ? `${displayCode}に確認待ちの判断はありません。`
    : '確認待ちの制作可否判断はありません。', env);
  if (!displayCode && candidates.length > 1) {
    return reply(replyToken, formatAmbiguousOrderChoices(candidates, `${action} カルテ番号`), env);
  }
  const decision = candidates[0];
  if (action === '確認') {
    return reply(replyToken, `【判断待ち／${decision.display_code}】\n\n${decision.customer_summary}\n\n対応可能：受ける ${decision.display_code}\n対応困難：難しい ${decision.display_code} 理由`, env);
  }
  const now = new Date().toISOString();
  const accepted = action === '受ける';
  const ownerResponse = accepted ? (note || '制作対応可能') : `対応困難${note ? `：${note}` : '（理由未入力）'}`;
  await env.DB.batch([
    env.DB.prepare(`UPDATE owner_decision_requests
        SET status = 'recorded', owner_response = ?, decided_at = ?, decided_by = ?
        WHERE id = ? AND status = 'needs_owner_review'`)
      .bind(ownerResponse, now, userId, decision.id),
    env.DB.prepare(`UPDATE customer_order_records SET status = ?, updated_at = ? WHERE id = ?`)
      .bind(accepted ? 'detail_intake' : 'feasibility_review', now, decision.order_record_id),
    env.DB.prepare(`INSERT INTO order_card_events
        (order_card_id, event_type, actor, detail, occurred_at)
        VALUES (?, ?, 'owner', ?, ?)`)
      .bind(decision.order_card_id, accepted ? 'owner.feasibility_accepted' : 'owner.feasibility_declined', ownerResponse, now),
  ]);
  if (accepted) {
    await env.SECRETARY_KV.put('pending-status:' + userId, JSON.stringify({
      orderRecordId: decision.order_record_id,
      displayCode: decision.display_code,
      currentStatus: 'detail_intake',
      action: '制作開始',
      nextStatus: 'production',
      eventType: 'production.started',
      createdAt: now,
    }), { expirationTtl: 600 });
    return reply(replyToken, `${decision.display_code}を「対応可能」として記録しました。\n\n注文内容を受け付けたため、ステータスを「制作中」に変更してよいですか？\n「はい」または「いいえ」でお答えください。`, env);
  }
  return reply(replyToken, `${decision.display_code}を「対応困難」として記録しました。${note ? '' : '\nお客様へ案内する理由は、続けて確認してください。'}`, env);
}

async function handleOrderLifecycleCommand(replyToken, userId, action, displayCode, env) {
  const originalReference = displayCode;
  displayCode = await resolveManagerDisplayCode(displayCode, env);
  if (originalReference && !displayCode) return reply(replyToken, 'その操作番号の注文カルテが見つかりません。最新のカルテ一覧を確認してください。', env);
  let filter = '';
  if (displayCode) {
    filter = ' AND r.display_code = ?';
  }
  const statement = env.DB.prepare(`SELECT r.*, t.customer_display_name, t.customer_confirmed_name
      FROM customer_order_records r
      JOIN customer_order_threads t ON t.id = r.source_thread_id
      WHERE r.is_active = 1${filter}
      ORDER BY r.updated_at DESC LIMIT 2`);
  const rows = displayCode ? await statement.bind(displayCode).all() : await statement.all();
  const candidates = rows.results || [];
  if (!candidates.length) return reply(replyToken, displayCode
    ? `${displayCode}の進行中カルテはありません。`
    : '進行中の注文カルテはありません。', env);
  if (!displayCode && candidates.length > 1) {
    return reply(replyToken, formatAmbiguousOrderChoices(candidates, `${action} カルテ番号`), env);
  }
  const orderRecord = candidates[0];
  const allowedStatuses = {
    制作開始: ['confirmed'],
    完成: ['production'],
    受渡完了: ['ready'],
    支払案内済み: ['confirmed', 'production', 'ready', 'fulfilled'],
    支払確認待ち: ['confirmed', 'production', 'ready', 'fulfilled'],
    支払完了: ['confirmed', 'production', 'ready', 'fulfilled'],
  };
  if (!allowedStatuses[action].includes(orderRecord.status)) {
    return reply(replyToken, `${orderRecord.display_code}は現在「${orderRecordStatusLabel(orderRecord.status)}」です。\n「${action}」へ進める前の確認が完了していません。`, env);
  }
  return proposeOrderLifecycleTransition(replyToken, userId, action, orderRecord.display_code, env, orderRecord);
}

async function proposeOrderLifecycleTransition(replyToken, userId, action, displayCode, env, selectedOrder = null) {
  let orderRecord = selectedOrder;
  if (!orderRecord) {
    const resolved = await resolveManagerDisplayCode(displayCode, env);
    const filter = resolved ? ' AND r.display_code = ?' : '';
    const statement = env.DB.prepare(`SELECT r.*, t.customer_display_name, t.customer_confirmed_name
        FROM customer_order_records r JOIN customer_order_threads t ON t.id = r.source_thread_id
        WHERE r.is_active = 1${filter} ORDER BY r.updated_at DESC LIMIT 2`);
    const rows = resolved ? await statement.bind(resolved).all() : await statement.all();
    const candidates = rows.results || [];
    if (!candidates.length) return reply(replyToken, resolved ? `${resolved}の進行中カルテはありません。` : '進行中の注文カルテはありません。', env);
    if (!resolved && candidates.length > 1) return reply(replyToken, formatAmbiguousOrderChoices(candidates, `${action} カルテ番号`), env);
    orderRecord = candidates[0];
  }
  const transition = {
    制作開始: { nextStatus: 'production', eventType: 'production.started', label: '制作中' },
    完成: { nextStatus: 'ready', eventType: 'production.completed', label: 'お渡し準備完了' },
    受渡完了: { nextStatus: 'fulfilled', eventType: 'fulfillment.completed', label: '受渡完了・支払確認待ち' },
    支払案内済み: { fieldKey: 'payment_status', fieldValue: '決済案内済み', label: '決済案内済み' },
    支払確認待ち: { fieldKey: 'payment_status', fieldValue: '支払い確認待ち', label: '支払い確認待ち' },
    支払完了: { fieldKey: 'payment_status', fieldValue: '完了', label: '支払完了' },
  }[action];
  if (!transition) return reply(replyToken, '変更内容を確認できませんでした。', env);
  const currentLabel = orderRecordStatusLabel(orderRecord.status);
  await env.SECRETARY_KV.put('pending-status:' + userId, JSON.stringify({
    orderRecordId: orderRecord.id, displayCode: orderRecord.display_code,
    currentStatus: orderRecord.status, action, ...transition, createdAt: new Date().toISOString(),
  }), { expirationTtl: 600 });
  const caution = action === '支払完了' ? '\n※決済画面で店長が確認済みの場合のみ「はい」とお答えください。' : '';
  return reply(replyToken, `【ステータス変更確認】\nカルテ：${orderRecord.display_code}\n現在：${currentLabel}\n変更後：${transition.label}\n\nこの内容で変更してよいですか？\n「はい」または「いいえ」でお答えください。${caution}`, env);
}

async function applyPendingStatusTransition(replyToken, userId, pending, env) {
  const row = await env.DB.prepare(`SELECT r.*, t.customer_display_name, t.customer_confirmed_name
      FROM customer_order_records r JOIN customer_order_threads t ON t.id = r.source_thread_id
      WHERE r.id = ? AND r.is_active = 1`).bind(pending.orderRecordId).first();
  if (!row) return reply(replyToken, '対象カルテが見つからないか、すでに完了しています。', env);
  if (row.status !== pending.currentStatus) return reply(replyToken, `カルテ${row.display_code}はすでに「${orderRecordStatusLabel(row.status)}」へ更新されています。`, env);
  const now = new Date().toISOString();
  if (pending.nextStatus) {
    const statements = [
      env.DB.prepare(`UPDATE customer_order_records SET status = ?, updated_at = ? WHERE id = ?`).bind(pending.nextStatus, now, row.id),
      env.DB.prepare(`INSERT INTO order_card_events (order_card_id, event_type, actor, detail, occurred_at) VALUES (?, ?, 'owner', ?, ?)`).bind(`order-card:${row.source_thread_id}`, pending.eventType, pending.action, now),
    ];
    if (pending.action === '受渡完了') {
      statements.push(env.DB.prepare(`INSERT INTO order_record_fields
          (order_record_id, field_key, phase, value_text, status, source_direction, source_occurred_at, confidence, locked, updated_at, confirmed_at, confirmed_by)
          VALUES (?, 'fulfillment_completed', 'completion', '完了', 'confirmed', 'owner_recorded', ?, 1, 1, ?, ?, ?)
          ON CONFLICT(order_record_id, field_key) DO UPDATE SET value_text = '完了', status = 'confirmed', source_direction = 'owner_recorded', source_occurred_at = excluded.source_occurred_at, confidence = 1, locked = 1, updated_at = excluded.updated_at, confirmed_at = excluded.confirmed_at, confirmed_by = excluded.confirmed_by`)
        .bind(row.id, now, now, now, userId));
    }
    await env.DB.batch(statements);
    if (pending.action === '受渡完了') await closeOrderRecordWhenComplete({ ...row, status: pending.nextStatus }, now, env);
    return reply(replyToken, `${row.display_code}を「${pending.label}」へ更新しました。`, env);
  }
  const fieldKey = pending.fieldKey || (pending.action === '受渡完了' ? 'fulfillment_completed' : null);
  const phase = fieldKey === 'payment_status' ? 'payment' : 'completion';
  if (pending.action === '受渡完了') pending.fieldValue = '完了';
  await env.DB.prepare(`INSERT INTO order_record_fields
      (order_record_id, field_key, phase, value_text, status, source_direction, source_occurred_at, confidence, locked, updated_at, confirmed_at, confirmed_by)
      VALUES (?, ?, ?, ?, 'confirmed', 'owner_recorded', ?, 1, 1, ?, ?, ?)
      ON CONFLICT(order_record_id, field_key) DO UPDATE SET value_text = excluded.value_text, status = 'confirmed', source_direction = 'owner_recorded', source_occurred_at = excluded.source_occurred_at, confidence = 1, locked = 1, updated_at = excluded.updated_at, confirmed_at = excluded.confirmed_at, confirmed_by = excluded.confirmed_by`)
    .bind(row.id, fieldKey, phase, pending.fieldValue, now, now, now, userId).run();
  if (pending.action === '受渡完了') await env.DB.prepare(`UPDATE customer_order_records SET status = 'fulfilled', updated_at = ? WHERE id = ?`).bind(now, row.id).run();
  const closed = await closeOrderRecordWhenComplete(row, now, env);
  if (closed) return reply(replyToken, `${row.display_code}は受渡し・支払いともに完了し、注文カルテを完了しました。`, env);
  return reply(replyToken, `${row.display_code}へ「${pending.label}」を記録しました。`, env);
}

async function closeOrderRecordWhenComplete(orderRecord, now, env) {
  const rows = await env.DB.prepare(`SELECT field_key, status FROM order_record_fields
      WHERE order_record_id = ? AND field_key IN ('fulfillment_completed', 'payment_status')`)
    .bind(orderRecord.id).all();
  const fields = Object.fromEntries((rows.results || []).map((row) => [row.field_key, row.status]));
  if (fields.fulfillment_completed !== 'confirmed' || fields.payment_status !== 'confirmed') return false;
  await env.DB.batch([
    env.DB.prepare(`UPDATE customer_order_records
        SET status = 'closed', is_active = 0, updated_at = ?, closed_at = ? WHERE id = ?`)
      .bind(now, now, orderRecord.id),
    env.DB.prepare(`UPDATE customer_profiles SET completed_order_count = completed_order_count + 1
        WHERE customer_line_user_id = ?`).bind(orderRecord.customer_line_user_id),
  ]);
  return true;
}

function formatAmbiguousOrderChoices(records, commandExample) {
  const choices = records.map((record) => {
    const name = formatCustomerLabel(record.customer_confirmed_name || record.customer_display_name);
    return `【${records.indexOf(record) + 1}】${record.display_code}：${name}（${orderRecordStatusLabel(record.order_status || record.status)}）`;
  }).join('\n');
  const normalizedExample = commandExample.replace('カルテ番号', '1');
  return `対象の注文が複数あります。上の操作番号（1〜${records.length}）または正式カルテ番号を付けてください。\n\n${choices}\n\n例：${normalizedExample.replace(/^(\S+)\s+1/u, '1 $1')}`;
}

function orderRecordStatusLabel(status) {
  return ({
    feasibility_intake: '基本情報を聞き取り中',
    feasibility_review: '制作可否の判断待ち',
    detail_intake: '商品別の詳細確認中',
    awaiting_customer_confirmation: 'お客様の最終確認待ち',
    confirmed: '注文確定',
    production: '制作中',
    ready: 'お渡し準備完了',
    fulfilled: '受渡完了・支払確認待ち',
    closed: '完了',
    cancelled: 'キャンセル',
  })[status] || status;
}

function formatOrderRecordCard(customerLabel, orderRecord, fields, pendingChangeCount = 0) {
  const statusLabels = {
    feasibility_intake: '制作可否の基本情報を聞き取り中',
    feasibility_review: '制作可否の判断待ち',
    detail_intake: '商品別の詳細を聞き取り中',
    awaiting_customer_confirmation: 'お客様の最終確認待ち',
    confirmed: '注文確定',
    production: '制作中',
    ready: 'お渡し準備完了',
    fulfilled: 'お渡し・納品完了',
    closed: '完了',
    cancelled: 'キャンセル',
  };
  const confirmed = [], undecided = [], missing = [];
  for (const { key, label } of ORDER_FEASIBILITY_FIELDS) {
    const field = fields?.[key];
    if (!field || ['unasked', 'asked'].includes(field.status)) missing.push(`・${label}`);
    else if (field.status === 'undecided') undecided.push(`・${label}：未定`);
    else confirmed.push(`・${label}：${field.value_text}`);
  }
  const laterFields = Object.entries(fields || {})
    .filter(([key, field]) => !ORDER_FEASIBILITY_FIELDS.some((item) => item.key === key)
      && ['answered', 'confirmed', 'not_applicable'].includes(field.status))
    .map(([key, field]) => `・${ORDER_FIELD_LABELS[key] || key}：${field.value_text || '対象外'}`);
  const sections = [
    `【注文カルテ ${orderRecord.display_code || `No.${orderRecord.sequence_number}`}】`,
    `お客様：${customerLabel}`,
    `現在：${statusLabels[orderRecord.status] || orderRecord.status}`,
  ];
  if (confirmed.length) sections.push(`【確認済み】\n${confirmed.join('\n')}`);
  if (undecided.length) sections.push(`【未定】\n${undecided.join('\n')}`);
  if (laterFields.length) sections.push(`【追加確認済み】\n${laterFields.join('\n')}`);
  if (missing.length) sections.push(`【まだ確認できていない項目】\n${missing.join('\n')}`);
  if (pendingChangeCount) sections.push(`【店長の確認待ち】\n・内容変更 ${pendingChangeCount}件`);
  return sections.join('\n\n');
}

async function upsertOrderCard(threadId, text, candidate, now, env, providedDetails = null) {
  const details = providedDetails || extractOrderDetails(text, candidate);
  const cardId = `order-card:${threadId}`;
  await env.DB.prepare(`INSERT INTO order_cards
      (id, order_thread_id, status, purpose, recipient_profile, product_reference,
       requested_quantity, budget_yen, color_preference, size_preference,
       character_request, balloon_message, card_message, fulfillment_type,
       requested_date, requested_time, product_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_thread_id) DO UPDATE SET
        status = CASE WHEN order_cards.status IN ('intake', 'needs_details') THEN excluded.status ELSE order_cards.status END,
        purpose = COALESCE(NULLIF(excluded.purpose, ''), order_cards.purpose),
        recipient_profile = COALESCE(NULLIF(excluded.recipient_profile, ''), order_cards.recipient_profile),
        product_reference = COALESCE(NULLIF(excluded.product_reference, ''), order_cards.product_reference),
        requested_quantity = COALESCE(excluded.requested_quantity, order_cards.requested_quantity),
        budget_yen = COALESCE(excluded.budget_yen, order_cards.budget_yen),
        color_preference = COALESCE(NULLIF(excluded.color_preference, ''), order_cards.color_preference),
        size_preference = COALESCE(NULLIF(excluded.size_preference, ''), order_cards.size_preference),
        character_request = COALESCE(NULLIF(excluded.character_request, ''), order_cards.character_request),
        balloon_message = COALESCE(NULLIF(excluded.balloon_message, ''), order_cards.balloon_message),
        card_message = COALESCE(NULLIF(excluded.card_message, ''), order_cards.card_message),
        fulfillment_type = CASE WHEN excluded.fulfillment_type <> 'unknown' THEN excluded.fulfillment_type ELSE order_cards.fulfillment_type END,
        requested_date = COALESCE(excluded.requested_date, order_cards.requested_date),
        requested_time = COALESCE(excluded.requested_time, order_cards.requested_time),
        product_type = COALESCE(NULLIF(excluded.product_type, ''), order_cards.product_type),
        updated_at = excluded.updated_at`)
    .bind(
      cardId, threadId, details.status, details.purpose, details.recipientProfile, details.productReference,
      details.quantity, details.budgetYen, details.colorPreference, details.sizePreference,
      details.characterRequest, details.balloonMessage, details.cardMessage, details.fulfillmentType,
      details.requestedDate, details.requestedTime, details.productType, now, now,
    ).run();
  await env.DB.prepare(`INSERT INTO order_card_events
      (order_card_id, event_type, actor, detail, occurred_at) VALUES (?, 'customer.message_analyzed', 'assistant', ?, ?)`)
    .bind(cardId, summarizeOrderDetails(details), now).run();
}

function extractOrderDetails(text, candidate) {
  text = stripIntakeTemplateHints(text);
  const purpose = ['誕生日', 'バースデー', '開店', '周年', '退職', '卒業', '入学', '発表会', '結婚', '出産', 'お見舞い', '記念', 'お祝い']
    .find((value) => text.includes(value)) || null;
  const budgetMatch = text.match(/(?:予算|ご予算)?\s*([0-9０-９][0-9０-９,，]*)\s*円/u);
  const quantityMatch = text.match(/([0-9０-９]+)\s*(?:個|本|組|セット)/u);
  const fulfillmentType = candidate?.type || (/発送|郵送/u.test(text) ? 'shipping' : 'unknown');
  return {
    status: orderDetailsAreSufficient(text, candidate) ? 'owner_review' : 'needs_details',
    purpose,
    recipientProfile: extractLabeledText(text, /(?:贈る相手|お相手|年齢|性別)\s*(?:は|:|：)?\s*/u),
    productReference: extractProductReference(text),
    quantity: quantityMatch ? parseJapaneseNumber(quantityMatch[1]) : null,
    budgetYen: budgetMatch ? parseJapaneseNumber(budgetMatch[1]) : null,
    colorPreference: extractLabeledText(text, /(?:色味(?:・雰囲気)?|色|カラー)\s*(?:は|:|：)?\s*/u),
    sizePreference: extractLabeledText(text, /(?:大きさ|サイズ)\s*(?:は|:|：)?\s*/u),
    characterRequest: extractLabeledText(text, /(?:キャラクター)\s*(?:は|:|：)?\s*/u),
    balloonMessage: extractLabeledText(text, /(?:文字入れ|バルーン(?:の)?(?:文字|メッセージ))\s*(?:は|:|：)?\s*/u),
    cardMessage: extractLabeledText(text, /(?:メッセージカード|カード(?:の内容)?)\s*(?:は|:|：)?\s*/u),
    fulfillmentType,
    requestedDate: candidate?.date || null,
    requestedTime: candidate?.time || null,
    productType: detectProductType(text),
  };
}

function detectProductType(text) {
  text = stripIntakeTemplateHints(text);
  if (/(?:バルーンのタイプ|商品タイプ)\s*[：:]?\s*その他|その他\s*(?:のバルーン|の商品|を作りたい)/u.test(text)) return 'other';
  if (/(?:会場装飾|イベント装飾|フォトブース|装飾)/u.test(text)) return 'venue_decoration';
  if (/スタンド/u.test(text)) return 'balloon_stand';
  if (/(?:フロート|ヘリウム|浮[かき]|ガス)/u.test(text)) return 'floating_balloon';
  if (/(?:アレンジ|アレンジメント|卓上|置き型)/u.test(text)) return 'arrangement';
  if (/(?:ブーケ|花束|手渡し|ギフト)/u.test(text)) return 'balloon_bouquet';
  if (/(?:来店相談|相談したい|見に行|見て決め)/u.test(text)) return 'store_consultation';
  return null;
}

function extractLabeledText(text, labelPattern) {
  const match = text.match(new RegExp(labelPattern.source + '([^、。！!\\n]{1,80})', 'u'));
  return match ? match[1].trim() : null;
}

function extractProductReference(text) {
  text = stripIntakeTemplateHints(text);
  const circled = '[⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿]';
  const numberPattern = `(?:${circled}|[0-9０-９]{1,4})`;
  const labelled = text.match(new RegExp(`(?:商品番号|品番|商品No\\.?|No\\.?)\\s*(?:は|の|:|：)?\\s*[#＃]?(${numberPattern})\\s*(?:番|号)?`, 'iu'));
  if (labelled) return normalizeProductNumber(labelled[1]);
  const productName = text.match(new RegExp(`(?:バルーン|商品)?(?:アレンジ(?:メント)?|ブーケ|スタンド|ヘリウム|フロート)\\s*(?:の|No\\.?|番号)?\\s*[#＃]?(${numberPattern})\\s*(?:番|号)?`, 'iu'));
  if (productName) return normalizeProductNumber(productName[1]);
  const url = text.match(/https?:\/\/[^\s]+/u);
  return url ? url[0].slice(0, 300) : null;
}

function normalizeProductNumber(value) {
  if (!value) return null;
  const circled = '⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿';
  const normalized = String(value).replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0));
  if (normalized.length === 1) {
    const index = circled.indexOf(normalized);
    if (index >= 0) return String(index);
  }
  return /^\d{1,4}$/u.test(normalized) ? String(Number(normalized)) : normalized;
}

async function findProductCatalogMatch(reference, env) {
  if (!reference) return null;
  if (/^https?:\/\//u.test(reference)) {
    return env.DB.prepare(`SELECT id, product_number, name, category, product_url, image_url, image_alt
        FROM product_catalog WHERE status = 'published' AND product_url = ? LIMIT 1`).bind(reference).first();
  }
  const number = normalizeProductNumber(reference);
  if (!number) return null;
  return env.DB.prepare(`SELECT id, product_number, name, category, product_url, image_url, image_alt
      FROM product_catalog WHERE status = 'published' AND product_number = ? LIMIT 1`).bind(number).first();
}

async function recordProductCatalogMatch(threadId, reference, product, now, env) {
  await env.DB.prepare(`INSERT INTO order_card_events
      (order_card_id, event_type, actor, detail, occurred_at) VALUES (?, 'product.reference_matched', 'system', ?, ?)`)
    .bind(`order-card:${threadId}`, JSON.stringify({ reference, productId: product.id, productNumber: product.product_number, name: product.name }), now).run();
}

async function recordInternalOrderEvent(threadId, eventType, detail, occurredAt, env) {
  await env.DB.prepare(`INSERT INTO order_card_events
      (order_card_id, event_type, actor, detail, occurred_at) VALUES (?, ?, 'system', ?, ?)`)
    .bind(`order-card:${threadId}`, eventType, JSON.stringify(detail), occurredAt).run();
}

function formatProductCatalogMatch(customerLabel, reference, product) {
  return `統括マネージャーです。\n\n【HP商品番号を照合しました】\n${customerLabel}から指定された商品番号：${reference}\n\n・商品名：${product.name}\n・カテゴリー：${product.category || '未分類'}\n・商品番号：${product.product_number}\n・商品ページ：${product.product_url}\n\nHPに登録されている該当画像を添付します。\n価格・在庫・納期は店長確認後にご案内します。`;
}

function parseJapaneseNumber(value) {
  const normalized = value.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0)).replace(/[，,]/g, '');
  const number = Number.parseInt(normalized, 10);
  return Number.isFinite(number) ? number : null;
}

function orderDetailsAreSufficient(text, candidate) {
  return Boolean(candidate?.date && (/(?:予算|[0-9０-９][0-9０-９,，]*円)/u.test(text) || /(?:商品番号|品番|https?:\/\/)/iu.test(text)));
}

function summarizeOrderDetails(details) {
  return JSON.stringify({
    purpose: details.purpose,
    productReference: details.productReference,
    quantity: details.quantity,
    budgetYen: details.budgetYen,
    fulfillmentType: details.fulfillmentType,
    requestedDate: details.requestedDate,
    requestedTime: details.requestedTime,
  });
}

function detectOrderRiskFlags(text, candidate = null) {
  const flags = [];
  if (/(?:今日|本日|明日|あした|至急|急ぎ|すぐ|間に合)/u.test(text)) flags.push('直前・急ぎの依頼：制作時間と在庫を店長確認');
  if (/配達|配送|お届け/u.test(text)) flags.push('配達案件：住所・不在時対応・配達時間を確認');
  if (/(?:住所|建物|施設|会場|届け先)/u.test(text)) flags.push('配達先情報：住所・建物名・連絡先を復唱');
  if (/(?:画像|写真|イメージ|同じ|完全再現)/u.test(text)) flags.push('参考画像案件：仕上がりは在庫により近似となる可能性を説明');
  if (/(?:予算|安く|大きく|小さく|ボリューム)/u.test(text)) flags.push('予算・ボリューム調整：店長提案が必要');
  if (/(?:返金|返品|交換|クレーム|苦情|不満|怒)/u.test(text)) flags.push('苦情・返金相談：自動確約せず店長対応');
  if (/(?:破損|割れ|しぼ|浮かない|不良)/u.test(text)) flags.push('破損・不良：写真と発生状況を確認');
  if (/(?:支払|決済|領収書|請求)/u.test(text)) flags.push('支払・領収書：方法と宛名を確定');
  if (/(?:店頭|来店|電話|紙注文|注文書)/u.test(text)) flags.push('店頭・電話受付：注文書画像とカルテを照合');
  if (candidate?.time && candidate.time >= '16:00') flags.push('16時以降：店舗対応時間外。夜間配達は個別確認');
  return [...new Set(flags)];
}

async function createOwnerDecisionRequest({ threadId, sourceEventId, text, candidate, customerLabel, now, env }) {
  const card = await env.DB.prepare(`SELECT * FROM order_cards WHERE order_thread_id = ?`).bind(threadId).first();
  const orderRecord = await env.DB.prepare(`SELECT * FROM customer_order_records
      WHERE source_thread_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1`).bind(threadId).first();
  const recordFields = orderRecord ? await loadOrderRecordFields(orderRecord.id, env) : null;
  if (orderRecord && !orderRecordReadyForFeasibilityReview(recordFields)) return null;
  if (!orderRecord && !orderCardReadyForOwnerReview(card)) return null;
  const scopeMarker = orderRecord ? ownerDecisionScopeMarker(orderRecord) : '%聞き取り内容%';
  const existing = await env.DB.prepare(`SELECT id, request_types, customer_summary FROM owner_decision_requests
      WHERE order_card_id = ? AND status = 'needs_owner_review' AND customer_summary LIKE ? LIMIT 1`)
    .bind(`order-card:${threadId}`, scopeMarker).first();
  if (existing) {
    return {
      id: existing.id,
      requestTypes: JSON.parse(existing.request_types || '[]'),
      customerSummary: existing.customer_summary,
    };
  }
  const requestTypes = orderRecord ? detectOwnerDecisionTypesFromRecord(recordFields) : detectOwnerDecisionTypesFromCard(card);
  const requestId = `decision:${sourceEventId}`;
  const baseCustomerSummary = orderRecord
    ? summarizeOwnerReviewFromRecord(customerLabel, orderRecord, recordFields)
    : summarizeOwnerReviewFromCard(customerLabel, card);
  const reviewEvents = await loadOwnerReviewEvents(threadId, env);
  const riskFlags = detectOrderRiskFlags(text, candidate);
  const customerSummary = appendOwnerReviewEvents(baseCustomerSummary, reviewEvents)
    + (riskFlags.length ? `\n\n【要注意】\n${riskFlags.map((flag) => `・${flag}`).join('\n')}` : '');
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO owner_decision_requests
      (id, source_event_id, order_thread_id, order_card_id, request_types, status, customer_summary, created_at)
      VALUES (?, ?, ?, ?, ?, 'needs_owner_review', ?, ?)`)
    .bind(requestId, sourceEventId, threadId, `order-card:${threadId}`, JSON.stringify(requestTypes), customerSummary, now).run();
  if (result.meta.changes && orderRecord) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE customer_order_records SET status = 'feasibility_review', updated_at = ? WHERE id = ?`)
        .bind(now, orderRecord.id),
      env.DB.prepare(`UPDATE order_record_fields SET locked = 1, updated_at = ?
          WHERE order_record_id = ? AND phase = 'feasibility'`)
        .bind(now, orderRecord.id),
    ]);
  }
  return result.meta.changes ? { id: requestId, requestTypes, customerSummary } : null;
}

async function loadOwnerReviewEvents(threadId, env) {
  const rows = await env.DB.prepare(`SELECT event_type, detail FROM order_card_events
      WHERE order_card_id = ?
        AND event_type IN ('customer.name_confirmed', 'product.reference_unmatched', 'schedule.conflict')
      ORDER BY id ASC`)
    .bind(`order-card:${threadId}`).all();
  return rows.results || [];
}

function appendOwnerReviewEvents(summary, events) {
  const lines = [];
  const seen = new Set();
  for (const event of events || []) {
    let detail;
    try { detail = JSON.parse(event.detail || '{}'); } catch { detail = {}; }
    if (event.event_type === 'product.reference_unmatched') {
      const key = `product:${detail.reference || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`・商品番号「${detail.reference || '未入力'}」はHP商品マスターで照合できていません（商品ページURLまたは参考画像の確認が必要）`);
    } else if (event.event_type === 'schedule.conflict') {
      const key = `schedule:${detail.requested || ''}:${detail.detail || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`・${detail.requested || '希望日時'}：${detail.detail || '営業日・営業時間との確認が必要'}`);
    }
  }
  return lines.length ? `${summary}\n\n【追加確認事項】\n${lines.join('\n')}` : summary;
}

function ownerDecisionScopeMarker(orderRecord) {
  return `%注文カルテ ${orderRecord.display_code || `No.${orderRecord.sequence_number}`}%`;
}

async function loadOrderRecordFields(orderRecordId, env) {
  const rows = await env.DB.prepare(`SELECT * FROM order_record_fields WHERE order_record_id = ?`)
    .bind(orderRecordId).all();
  return Object.fromEntries((rows.results || []).map((row) => [row.field_key, row]));
}

function orderRecordReadyForFeasibilityReview(fields) {
  return ORDER_FEASIBILITY_FIELDS.every(({ key }) => {
    const status = fields?.[key]?.status;
    return ['answered', 'undecided', 'not_applicable', 'confirmed'].includes(status);
  });
}

function detectOwnerDecisionTypesFromRecord(fields) {
  const types = ['schedule', 'quote_and_production'];
  const method = fields?.fulfillment_method?.value_text || '';
  if (/配達/u.test(method)) types.push('delivery');
  if (/発送/u.test(method) || /ヘリウム|浮く/u.test(fields?.product_type?.value_text || '')) types.push('store_policy');
  return [...new Set(types)];
}

function summarizeOwnerReviewFromRecord(customerLabel, orderRecord, fields) {
  const value = (key) => fields?.[key]?.value_text || '未入力';
  const undecided = ORDER_FEASIBILITY_FIELDS
    .filter(({ key }) => fields?.[key]?.status === 'undecided')
    .map(({ label }) => `・${label}`);
  const lines = [
    `${customerLabel}からの聞き取り内容（注文カルテ ${orderRecord.display_code || `No.${orderRecord.sequence_number}`}）`,
    '',
    '【制作可否の確認項目】',
    `・商品番号・参考画像：${value('product_source')}`,
    `・バルーンタイプ：${value('product_type')}`,
    `・ご予算：${value('budget')}`,
    `・色味・雰囲気：${value('color_vibe')}`,
    `・プレゼント・使用予定日：${value('use_date')}`,
    `・受取希望日：${value('receive_date')}`,
    `・受取希望時間：${value('receive_time')}`,
    `・受取方法：${value('fulfillment_method')}`,
  ];
  if (undecided.length) lines.push('', '【未定として回答された項目】', ...undecided);
  lines.push('', '【現在の段階】', '制作可否・在庫・納期・受取方法の判断待ち');
  return lines.join('\n');
}

function orderCardReadyForOwnerReview(card) {
  return Boolean(card?.purpose && card?.product_type && card?.requested_date && card?.requested_time && card?.budget_yen && card?.fulfillment_type !== 'unknown' && card?.color_preference);
}

function detectOwnerDecisionTypesFromCard(card) {
  const types = [];
  types.push('schedule', 'quote_and_production');
  if (card.fulfillment_type === 'delivery') types.push('delivery');
  if (card.product_type === 'floating_balloon' || card.fulfillment_type === 'shipping') types.push('store_policy');
  return [...new Set(types)];
}

function summarizeOwnerReviewFromCard(customerLabel, card) {
  const lines = [
    `${customerLabel}からの聞き取り内容`,
  ];
  lines.push(`・商品タイプ：${{ arrangement: 'アレンジ', floating_balloon: '浮くタイプ', venue_decoration: '会場装飾', balloon_stand: 'バルーンスタンド', balloon_bouquet: 'バルーンブーケ', store_consultation: '来店相談', other: 'その他' }[card.product_type] || card.product_type}`);
  lines.push(`・用途：${card.purpose}`);
  lines.push(`・希望日時：${formatScheduleDate(card.requested_date, card.requested_time)}`);
  lines.push(`・方法：${{ pickup: '店頭受取', delivery: '配達', visit: '来店相談', shipping: '発送' }[card.fulfillment_type]}`);
  lines.push(`・予算：${Number(card.budget_yen).toLocaleString('ja-JP')}円`);
  lines.push(`・色味・雰囲気：${card.color_preference}`);
  if (card.product_reference) lines.push(`・商品番号・参照：${card.product_reference}`);
  if (card.requested_quantity) lines.push(`・個数：${card.requested_quantity}`);
  if (card.size_preference) lines.push(`・大きさ：${card.size_preference}`);
  if (card.balloon_message) lines.push(`・文字入れ：${card.balloon_message}`);
  if (card.card_message) lines.push(`・メッセージカード：${card.card_message}`);
  return lines.join('\n');
}

function formatOwnerDecisionRequest(request, catalogProduct = null) {
  const labels = {
    schedule: '予約・受取時間の可否',
    delivery: '配達エリア・配達料・対応可否',
    quote_and_production: '見積・制作可否・納期',
    store_policy: '在庫・休業・キャンセル等の個別判断',
  };
  const checks = request.requestTypes.map((type) => `・${labels[type]}`).join('\n');
  const productMatch = catalogProduct
    ? `\n\n【HP商品照合】\n・商品名：${catalogProduct.name}\n・商品番号：${catalogProduct.product_number}\n・商品ページ：${catalogProduct.product_url}\n※該当する商品画像をこの報告に添付しています。`
    : '';
  return `統括マネージャーです。\n\n注文担当から、店長の判断が必要な内容を受け取りました。\nAIは価格・在庫・納期・配達可否を確約しません。\n\n【確認内容】\n${request.customerSummary}${productMatch}\n\n【確認していただきたいこと】\n${checks}\n\n【返信方法】\n確認待ちが1件の場合は、操作番号を先頭にして返信してください。\n\n・1 受ける：この内容で対応可能\n・1 難しい 理由：対応が難しい\n・1 確認：内容を見直す\n\n正式カルテ番号を使う場合は「受ける KABC123」も利用できます。\n\n条件や理由を添える場合\n・1 受ける 配達料は別途、16時以降は不可\n・1 難しい 納期が合わないため`;
}

async function replyCustomerConversation(event, env) {
  if (!event.replyToken || !event.source?.userId) return;
  const key = 'customer-session:' + event.source.userId;
  const session = (await env.SECRETARY_KV.get(key, 'json')) || { stage: 'new', fields: {} };
  const result = event.message?.type === 'image'
    ? receiveReferenceImage(session)
    : buildCustomerReply(event.message?.text?.trim() || '', session);
  await env.SECRETARY_KV.put(key, JSON.stringify(result.session), { expirationTtl: CUSTOMER_SESSION_TTL });
  await replyCustomer(event.replyToken, result.message, env);
}

function receiveReferenceImage(session) {
  session.fields.referenceImage = true;
  session.fields.hasProductSource = true;
  session.fields.productSourceValue = '参考画像あり';
  session.stage = 'collecting';
  return {
    session,
    message: '参考画像をお送りいただき、ありがとうございます。\n\n送っていただいた画像をもとに、当店でご用意できる商品と照らし合わせながら、色味・大きさ・全体の雰囲気に近い形でご提案いたします。\n\n在庫状況により、まったく同じ仕上がりをお約束するものではありませんが、ご希望のイメージに合わせてお作りできるよう確認します。\n\nご希望の色、入れたいお名前やメッセージ、ご予算、必要な日または受取・配達のご希望を教えてください。確認後、改めてご連絡いたします。',
  };
}

async function fetchCustomerDisplayName(customerId, env) {
  if (!customerId) return null;
  try {
    const response = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(customerId)}`, {
      headers: { Authorization: 'Bearer ' + env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN },
    });
    if (!response.ok) return null;
    const profile = await response.json();
    return typeof profile.displayName === 'string' ? profile.displayName.trim().slice(0, 80) : null;
  } catch {
    return null;
  }
}

function extractConfirmedCustomerName(text) {
  const match = text.match(/(?:お名前|名前)\s*(?:は|：|:)\s*([^、。！!\n]{1,40})(?:です)?[。！!]?$/u);
  return match ? match[1].trim().replace(/です$/u, '').trim() : null;
}

async function getCustomerNames(threadId, env) {
  const row = await env.DB.prepare(`SELECT customer_confirmed_name, customer_display_name
      FROM customer_order_threads WHERE id = ?`).bind(threadId).first();
  return {
    confirmedName: row?.customer_confirmed_name || null,
    displayName: row?.customer_display_name || null,
  };
}

function formatCustomerLabel(name) {
  if (!name) return 'お名前確認中のお客様';
  return `${name.replace(/さん$/u, '')}さん`;
}

function extractScheduleCandidate(text) {
  text = stripIntakeTemplateHints(text);
  const methodAnswer = labeledAnswer(text, '受取方法|受け取り方法|お届け方法|方法') || '';
  const typeText = methodAnswer || text;
  const type = /配達|配送/u.test(typeText) ? 'delivery'
    : /発送|郵送/u.test(typeText) ? null
      : /店頭(?:受取)?|受取|受け取り|引取/u.test(typeText) ? 'pickup'
        : /来店/u.test(typeText) ? 'visit' : null;
  if (!type) return null;
  const dateAnswer = labeledAnswer(text, '受取希望日|受け取り希望日|お届け希望日|ご希望日|希望日');
  const dateSource = dateAnswer || text;
  const parsedDate = parseFlexibleCustomerDate(dateSource);
  let date = parsedDate?.date;
  let dateExpression = parsedDate?.expression || null;
  if (!date) {
    const relative = extractRelativeCustomerDate(dateSource);
    if (!relative) return null;
    date = relative.date;
    dateExpression = relative.expression;
  }
  const timeAnswer = labeledAnswer(text, '受取希望時間|受け取り希望時間|お届け希望時間|ご希望時間|希望時間');
  const time = parseFlexibleCustomerTime(timeAnswer || text);
  const typeLabel = { pickup: '受取', delivery: '配達', visit: '来店' }[type];
  return { type, typeLabel, date, time, dateExpression };
}

function parseFlexibleCustomerDate(value) {
  const normalized = String(value || '').normalize('NFKC').replace(/\s+/g, '');
  let match = normalized.match(/(?:令和|R)(\d{1,2})(?:年|[/-])(\d{1,2})(?:月|[/-])(\d{1,2})日?/iu);
  if (match) return { date: formatIsoDate(2018 + Number(match[1]), match[2], match[3]), expression: match[0] };
  match = normalized.match(/(\d{4})(?:年|[/-])(\d{1,2})(?:月|[/-])(\d{1,2})日?/u);
  if (match) return { date: formatIsoDate(match[1], match[2], match[3]), expression: match[0] };
  match = normalized.match(/(\d{1,2})(?:月|[/-])(\d{1,2})日?/u);
  if (match) return { date: formatIsoDate(japanDate(0).slice(0, 4), match[1], match[2]), expression: match[0] };
  return null;
}

function parseFlexibleCustomerTime(value) {
  const normalized = String(value || '').normalize('NFKC');
  let match = normalized.match(/(午前|午後)?\s*(\d{1,2})\s*時\s*半/u);
  if (match) match[3] = '30';
  else match = normalized.match(/(午前|午後)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/u);
  if (!match) match = normalized.match(/(午前|午後)?\s*(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分)?/u);
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = Number(match[3] || 0);
  if (match[1] === '午後' && hour < 12) hour += 12;
  if (match[1] === '午前' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatIsoDate(year, month, day) {
  const numericYear = Number(year), numericMonth = Number(month), numericDay = Number(day);
  if (numericYear < 2000 || numericMonth < 1 || numericMonth > 12 || numericDay < 1 || numericDay > 31) return null;
  return `${numericYear}-${String(numericMonth).padStart(2, '0')}-${String(numericDay).padStart(2, '0')}`;
}

function extractRelativeCustomerDate(text) {
  const simple = text.match(/(今日|明日|明後日)/u);
  if (simple) return { expression: simple[1], date: resolveJapanDate(simple[1]) };

  const weekday = text.match(/(今週|来週|再来週|今度|次|次の)\s*(?:の)?\s*([日月火水木金土])(?:曜(?:日)?)?/u);
  if (!weekday) return null;
  const expression = weekday[0];
  const target = '日月火水木金土'.indexOf(weekday[2]);
  const today = japanDate(0);
  const todayWeekday = new Date(today + 'T00:00:00Z').getUTCDay();
  let offset;
  if (weekday[1] === '今週') {
    offset = target - todayWeekday;
  } else if (weekday[1] === '来週') {
    offset = 7 - todayWeekday + target;
  } else if (weekday[1] === '再来週') {
    offset = 14 - todayWeekday + target;
  } else {
    offset = target - todayWeekday;
    if (offset <= 0) offset += 7;
  }
  return { expression, date: japanDate(offset) };
}

function formatJapanDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = '日月火水木金土'[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${year}年${month}月${day}日（${weekday}）`;
}

function formatScheduleDate(date, time) {
  return `${formatJapanDate(date)}${time ? ' ' + time : ''}`;
}

function extractDeliveryPlaceHint(text) {
  const labeled = text.match(/(?:配達先|お届け先|場所|会場)\s*(?:は|:|：)?\s*([^、。！!\n]{2,80})/u);
  if (labeled) return sanitizePlaceHint(labeled[1]);
  const directional = text.match(/([^、。！!\n]{2,60}?)(?:に|へ|まで)(?:配達|お届け)(?:を|は|お願いします|して)?/u);
  return directional ? sanitizePlaceHint(directional[1]) : null;
}

function sanitizePlaceHint(value) {
  const place = value.replace(/^(?:明日|今日|来週|今週|再来週|\d{4}[/-]\d{1,2}[/-]\d{1,2})\s*/u, '').trim();
  return place.length >= 2 ? place : null;
}

function formatDeliveryPlaceNote(place) {
  if (!place) return '\n・配達先：住所・建物名を確認中';
  const mapSearch = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
  return `\n・配達先候補：${place}\n・地図で確認：${mapSearch}\n※候補が正しいか店長確認後に、住所を確定します。`;
}

function routeManagerRequest(text) {
  const isScheduleCommand = /^(?:休業|休み|営業(?:時間)?|休業解除)\s*(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}-\d{2}:\d{2})$/u.test(text);
  if (!isScheduleCommand && /(?:営業日|営業(?:時間)?|休業日|休業|休み|休日|臨時休業|営業再開)/u.test(text)) {
    return `統括マネージャーです。営業日・休業日・営業時間の変更として受け取りました。システム担当へ引き継ぎます。\n\n変更内容を「休業 2026-09-22」「営業 2026-09-23 10:00-18:00」「休業解除 2026-09-22」の形式で送ってください。内容を確認後、反映前に改めて確認します。\n\n${STORE_SERVICE_HOURS_NOTICE}`;
  }
  if (/(?:配達|受取|引取|制作|納期|進捗|スケジュール|カレンダー)/u.test(text)) {
    return '統括マネージャーです。スケジュール担当への依頼として受け取りました。Googleカレンダーの予定を照会し、重複の有無と近い空き時間を整理して店長へ確認します。対象の注文名・受取または配達日・時間を教えてください。';
  }
  if (/(?:注文|見積|お客様|問い合わせ|問合せ|予約)/u.test(text)) {
    return '統括マネージャーです。注文担当への依頼として整理します。お客様向けLINEはまだこの店主窓口と接続していないため、お客様への送信や注文確定は行っていません。内容・希望日・予算を教えてください。';
  }
  if (/(?:ホームページ|サイト|掲載|ページ|文章|写真)/u.test(text)) {
    return '統括マネージャーです。HP更新依頼として受け取りました。対象ページ、変更したい文章または画像、希望する公開時期を教えてください。変更案とプレビューを作成し、店長の「公開確定」後にだけ公開する運用です。現在、自動反映が有効なのは営業日・営業時間です。その他の内容は下書きとして整理し、機能の実装段階に合わせて順次公開フローへ接続します。';
  }
  return null;
}

function parseCommand(text) {
  const relativeClose = text.match(/^(今日|明日|明後日|(?:今週|来週|再来週)(?:の)?[日月火水木金土](?:曜(?:日)?)?|(?:次|今度)の?[日月火水木金土](?:曜(?:日)?)?|(?:今週|来週|再来週)末(?:の)?[土日](?:曜(?:日)?)?)(?:は)?(?:休業|休み)(?:にして)?$/u);
  if (relativeClose) {
    const date = resolveJapanDate(relativeClose[1]);
    if (!date) return null;
    return { date, status: 'closed', openTime: null, closeTime: null, summary: date + ' を終日休業' };
  }
  let match = text.match(/^(?:休業|休み)\s*(\d{4}-\d{2}-\d{2})$/u);
  if (match) return { date: match[1], status: 'closed', openTime: null, closeTime: null, summary: match[1] + ' を終日休業' };
  match = text.match(/^営業(?:時間)?\s*(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2})-(\d{2}:\d{2})$/u);
  if (match) return { date: match[1], status: 'special_hours', openTime: match[2], closeTime: match[3], summary: match[1] + ' を ' + match[2] + '〜' + match[3] + ' 営業' };
  match = text.match(/^休業解除\s*(\d{4}-\d{2}-\d{2})$/u);
  if (match) return { date: match[1], status: 'open', openTime: null, closeTime: null, summary: match[1] + ' の休業を解除' };
  return null;
}

function japanDate(daysFromToday) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + daysFromToday));
  return date.toISOString().slice(0, 10);
}

function resolveJapanDate(expression) {
  if (expression === '今日') return japanDate(0);
  if (expression === '明日') return japanDate(1);
  if (expression === '明後日') return japanDate(2);

  const match = expression.match(/^(今週|来週|再来週|次|今度)(?:(?:の)?|末(?:の)?)?([日月火水木金土])/u);
  if (!match) return null;
  const targetWeekday = '日月火水木金土'.indexOf(match[2]);
  const today = japanDate(0);
  const todayWeekday = new Date(today + 'T00:00:00Z').getUTCDay();
  const kind = match[1];
  let offset;
  if (kind === '今週') offset = targetWeekday - todayWeekday;
  else if (kind === '来週') offset = 7 - todayWeekday + targetWeekday;
  else if (kind === '再来週') offset = 14 - todayWeekday + targetWeekday;
  else {
    offset = targetWeekday - todayWeekday;
    if (offset <= 0) offset += 7;
  }
  return japanDate(offset);
}

async function applyChange(change, userId, env) {
  const before = await env.DB.prepare('SELECT * FROM business_schedule WHERE date = ?').bind(change.date).first();
  await env.DB.prepare(`INSERT INTO business_schedule (date, status, open_time, close_time, updated_at, updated_by)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(date) DO UPDATE SET status = excluded.status, open_time = excluded.open_time,
      close_time = excluded.close_time, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(change.date, change.status, change.openTime, change.closeTime, userId).run();
  await env.DB.prepare(`INSERT INTO audit_log
      (timestamp, actor_line_user_id, action, before_json, after_json, result, error_code)
    VALUES (datetime('now'), ?, 'schedule.update', ?, ?, 'success', NULL)`)
    .bind(userId, JSON.stringify(before || null), JSON.stringify({ ...change, date: change.date })).run();
}

async function getCustomerKind(customerId, text, env) {
  const profile = await env.DB.prepare(`SELECT completed_order_count, relationship_override
      FROM customer_profiles WHERE customer_line_user_id = ?`).bind(customerId).first();
  if (profile?.relationship_override === 'returning' || Number(profile?.completed_order_count || 0) > 0) return 'returning';
  if (/(?:前回|以前|またお願い|いつも|リピート)/u.test(text)) return 'returning';
  return 'new';
}

function buildCustomerReply(text, session) {
  if (/^(こんにちは|こんばんは|はじめまして|お世話になります)[！!。]*$/u.test(text)) return { session, message: 'こんにちは😊 ご連絡ありがとうございます。気になるお写真やご希望の内容がありましたら、そのままお送りください。ご用途・ご希望日・ご予算が分かるとスムーズにご案内できます🎈' };
  if (/^(?:戻る|やり直す|選び直す|最初から)$/u.test(text.trim())) {
    session.fields = { questionCounts: {} };
    session.stage = 'awaiting_order_route';
    return { session, message: orderRoutePrompt() };
  }
  if (isOrderStartTrigger(text)) return orderReply(text, session);
  const careReply = balloonCareKnowledgeReply(text, session);
  if (careReply) return careReply;
  if (session.stage === 'review' && /(?:注文お願いします|注文をお願いします|この内容で注文|お願いします)/u.test(text)) return requestCustomerContact(session);
  if (session.stage === 'awaiting_contact') return recordCustomerContact(text, session);
  // 初回分岐直後でまだ回答内容がない場合は、番号だけで選択をやり直せる。
  // お客様に「注文担当を呼び出します」から再入力していただかないための救済処理。
  if (session.stage === 'collecting' && isBareOrderRouteNumber(text) && !hasCollectedIntakeAnswer(session)) {
    session.stage = 'awaiting_order_route';
    return selectOrderRoute(text, session);
  }
  if (session.stage === 'awaiting_order_route') return selectOrderRoute(text, session);
  if (session.stage === 'consulting') return collectConsultationDetail(text, session);
  if (session.stage === 'schedule_consulting') return collectScheduleDetail(text, session);
  if (session.stage === 'collecting') return collectOrderDetail(text, session);
  if (/(今日|本日|明日|あした|急ぎ|至急)/u.test(text)) return urgentReply(session);
  if (/(ヘリウム|浮[かき]|ガス)/u.test(text)) return heliumReply(session);
  if (/(配送|配達|送[っり]て|郵送)/u.test(text)) return deliveryReply(session);
  if (/(しぼ|どのくらい持|日持ち|持ちます)/u.test(text)) return longevityReply(session);
  if (/(注文|お願い|作れ|作って|欲しい|ほしい|祝い|誕生日|開店|結婚|出産|発表会|卒業|退職)/u.test(text)) return unstructuredOrderInquiry(session);
  return { session, message: 'ご連絡ありがとうございます😊 内容を確認して、できるだけご希望に沿えるようご案内します。差し支えなければ、①ご用途 ②ご希望日 ③ご予算 ④お受け取り・配達のどちらか を教えてください。参考のお写真があれば一緒に送っていただいて大丈夫です🎈' };
}

function isBareOrderRouteNumber(text) {
  return /^(?:1|2|3|4|①|②|③|④)$/u.test(text.trim());
}

function hasCollectedIntakeAnswer(session) {
  const fields = session?.fields || {};
  return Object.entries(fields).some(([key, value]) => {
    if (key === 'questionCounts') return false;
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && value !== '' && value !== false;
  });
}

function isOrderStartTrigger(text) {
  return /^(?:注文したい|注文担当を呼び出します)[。！!？?]*$/u.test(text.trim());
}

function balloonCareKnowledgeReply(text, session) {
  const reply = (message, notifyOwner = false) => ({ session, message, autoReply: true, notifyOwner });
  const isHelium = /ヘリウム|浮[くき]|フロート|ガス/u.test(text) || session.fields?.productType === 'floating_balloon';

  if (/返品|交換|返金|不良|壊れて|破損して|割れて(?:い|しま)/u.test(text)) {
    return reply('ご心配をおかけして申し訳ございません。\n\n当店では、お渡しする数時間前にヘリウムや空気を入れて状態を確認しているため、ご購入後の返品・交換は原則として承っておりません。\n\nただし、お渡し時から気になる状態がある場合や、破損の状況を確認する必要がある場合は個別に確認いたします。破損した箇所のお写真と、いつ・どのような状況で気付かれたかをお送りください。確認後、改めてご案内いたします。', true);
  }

  if (isHelium && /割れ|破裂|爆発|燃え|引火|換気|吸(?:う|って|引)/u.test(text)) {
    return reply('ヘリウムは不活性ガスに分類され、引火したり燃焼・爆発したりするものではありません。\n\n室内でヘリウム入りのバルーンが割れた場合は、念のため窓を開けるなど換気をお願いします。風船に充填しているヘリウムを意図的に吸い込むことはお控えください。\n\nバルーンや周囲に破損がある場合は、お写真をお送りいただけましたら状態を確認いたします。', /割れ|破裂/u.test(text));
  }

  if (/次亜塩素酸|消毒|除菌|除光液|有機溶剤|灯油|ライター|鉱物(?:製)?油|オイル|リモネン|レモン|オレンジ|柑橘|洗剤/u.test(text)) {
    return reply('バルーンには、消毒液に使われる次亜塩素酸ナトリウム、除光液などの有機溶剤、灯油・ライターオイルなどの鉱物製油を付けないようにしてください。素材が傷み、破損や破裂につながる場合があります。\n\nまた、レモンやオレンジの皮に含まれる「リモネン」や、リモネンを含む洗剤もゴムを溶かすことがあります。柑橘類やオレンジ・レモン表示のある洗剤の近くでは、特にご注意ください。');
  }

  if (/火|暖房|ヒーター|ストーブ|吹出口/u.test(text)) {
    return reply('火や暖房器具には近づけないでください。暖房の吹出口付近でも、熱で中の空気やヘリウムが膨張して破裂したり、一部の素材が溶けたりするおそれがあります。\n\n暖房の風が直接当たらない、温度変化の少ない場所に飾ってください。');
  }

  if (isHelium && /ひも|ヒモ|紐|引っ張|振り回|とがった|尖った|扱い|持ち運/u.test(text)) {
    return reply('ヘリウムバルーンはとてもデリケートです。ヒモを強く引っ張ったり、振り回したりしないよう、やさしく扱ってください。\n\n結び目の強度が落ちたり、固い物やとがった物に触れて破損・破裂したりすることがあります。移動するときも、周囲に引っ掛からないようご注意ください。');
  }

  if (/高温|多湿|湿気|紫外線|直射日光|日光|窓|車内|車の中|夏場|寒|低温|温度|しぼ/u.test(text)) {
    return reply('バルーンは高温多湿や紫外線、急な温度変化が苦手です。窓の近くや夏場の車内など高温になる場所では、中の空気やヘリウムが膨張して破裂する可能性があります。\n\n反対に、気温が下がると一時的にしぼんで見えることがあります。直射日光や暖房の風を避け、温度変化の少ない室内でお楽しみください。');
  }

  if (/長持ち|日持ち|どのくらい持|長く楽し|保管|飾る場所|お手入れ/u.test(text)) {
    const handling = isHelium ? '\n\nヘリウムバルーンは、ヒモを強く引っ張ったり振り回したりせず、固い物やとがった物に触れないよう、やさしく扱ってください。' : '';
    return reply(`長く楽しんでいただくため、直射日光・高温多湿・急な温度変化を避け、火や暖房器具から離れた室内に飾ってください。消毒液、除光液、油類、柑橘類やリモネンを含む洗剤が触れないようご注意ください。${handling}\n\n楽しめる期間はバルーンの種類や飾る環境によって異なるため、商品番号やお写真をお送りいただけましたら、その商品に合わせてご案内します🎈`);
  }

  return null;
}

function urgentReply(session) { session.stage = 'urgent'; session.fields.urgent = true; return { session, message: 'お急ぎですね。ご相談ありがとうございます☺︎ 当日・翌日のご注文は、制作状況と商品の内容を確認してからのご案内になります。\nご希望日と、①ご用途 ②ご予算 ③お受け取り・配達のどちらか ④参考のお写真または商品番号 をお送りいただけますか？確認でき次第、可能な範囲をお返事します。' }; }
function heliumReply(session) { session.stage = 'helium'; return { session, message: 'ヘリウムバルーンのご相談ですね😊 バルーンの大きさ・種類・個数で必要量が変わるため、商品パッケージのお写真か、サイズと個数をお送りください。持ち込みの場合も確認してご案内します。\n※在庫状況や対応可能な時間は日によって変わるため、希望日も一緒にお願いします。' }; }
function deliveryReply(session) { session.stage = 'delivery'; return { session, message: `配達のご相談ありがとうございます😊 お届け地域・ご希望日・ご希望時間・ご予算を確認してご案内します。${STORE_SERVICE_HOURS_NOTICE} 夏場は高温による破損を防ぐため、発送を控える場合があります。近隣への配達や店頭受け取りも含めて、いちばん良い方法をご提案しますね。` }; }
function longevityReply(session) { session.stage = 'faq'; return { session, message: 'ご質問ありがとうございます😊 バルーンは種類や飾る環境によって異なります。直射日光・高温・尖った物を避けて室内に飾ると、より長く楽しんでいただけます。お写真を送っていただければ、その商品に合わせた目安と保管方法をご案内します🎈' }; }
function orderReply(text, session) {
  if (isOrderStartTrigger(text)) {
    session.fields = { questionCounts: {} };
    session.stage = 'awaiting_order_route';
    return { session, message: orderRoutePrompt() };
  }
  session.stage = 'collecting';
  session.fields.purpose = ['開店','結婚','出産','誕生日','発表会','卒業','退職'].find((purpose) => text.includes(purpose)) || null;
  session.fields.productType = detectProductType(text);
  mergeIntakeAnswers(session.fields, text);
  const missing = missingIntakeFields(session.fields);
  if (!missing.length) {
    session.stage = 'review';
    return { session, message: orderDetailsReceivedReply() };
  }
  markSessionFieldsAsked(session, missing);
  return { session, message: intakePrompt(missing, session.fields.productType, session.customerKind, Boolean(session.fields.productType || session.fields.purpose)) };
}
function orderRoutePrompt() {
  return 'ご相談ありがとうございます🎈\n\nまだ商品が決まっていなくても大丈夫です。近いものを1つお選びください。\n\n1：商品番号・参考画像がある\n2：商品は未定で、店頭で相談したい\n3：商品・ご予算がある程度決まっている\n4：日程・受け取り方法を先に相談したい\n\n1〜4の番号だけで返信いただけます。\n※「①」のような丸数字でも受け付けています。';
}
function selectOrderRoute(text, session) {
  const normalized = text.trim();
  if (/^(?:1|①|商品|決まって|画像)/u.test(normalized)) {
    session.stage = 'collecting';
    const missing = missingIntakeFields(session.fields);
    markSessionFieldsAsked(session, missing);
    return { session, message: intakePrompt(missing, session.fields.productType, session.customerKind, false) };
  }
  if (/^(?:2|②|商品は未定|相談|店頭|お店で|何がある|見て決め)/u.test(normalized)) {
    session.stage = 'schedule_consulting';
    session.fields.consultationMode = 'store_visit';
    return { session, message: scheduleConsultationPrompt(true) };
  }
  if (/^(?:3|③|商品.*予算|予算.*商品|ある程度|提案|おまかせ|分から|わから)/u.test(normalized)) {
    session.stage = 'consulting';
    session.fields.consultationMode = 'proposal';
    return { session, message: consultationPrompt() };
  }
  if (/^(?:4|④|日程|日付|受け取り|受取|スケジュール)/u.test(normalized)) {
    session.stage = 'schedule_consulting';
    session.fields.consultationMode = 'schedule_only';
    return { session, message: scheduleConsultationPrompt(false) };
  }
  return { session, message: '1：商品番号・参考画像がある\n2：商品は未定で、店頭で相談したい\n3：商品・ご予算がある程度決まっている\n4：日程・受け取り方法を先に相談したい\n\n1〜4の番号だけでお知らせください。\n※「①」のような丸数字でも受け付けています。' };
}
function consultationPrompt() {
  return 'ご回答ありがとうございます😊\n\n商品が決まっていない場合も、店頭でのご相談や商品のご案内から一緒に進められます。分かる範囲で、次の内容を教えてください。\n\n・ご用途や贈る相手：\n・飾る場所（分かる範囲で）：\n・ご予算：\n・使いたい日：\n・参考画像・気になる商品（あれば）：\n\n画像がなくても大丈夫です。「未定」や「おまかせ」だけでも受け付けています。その他のご希望は自由にご記入ください。';
}
function collectConsultationDetail(text, session) {
  session.fields.consultationText = [session.fields.consultationText, stripIntakeTemplateHints(text)].filter(Boolean).join('\n').slice(0, 3000);
  session.fields.purpose = session.fields.purpose || ['開店','結婚','出産','誕生日','発表会','卒業','退職','イベント','装飾'].find((purpose) => text.includes(purpose)) || null;
  session.fields.productType = session.fields.productType || detectProductType(text);
  session.fields.budgetValue = session.fields.budgetValue || labeledAnswer(text, 'ご予算');
  session.fields.useDateValue = session.fields.useDateValue || labeledAnswer(text, '必要な日|使用予定日');
  if (/(?:ご予算|必要な日|使用予定日|その他|相談|提案)/u.test(text) || session.fields.consultationText.length > 20) {
    session.stage = 'review';
    return { session, message: 'ご回答ありがとうございます😊\n\nご相談内容を注文カルテへ記録しました。\n\n・用途・イメージ：確認中\n・バルーンの種類：' + (productTypeLabel(session.fields.productType) || '未定') + '\n・ご予算：' + (session.fields.budgetValue || '未定') + '\n・必要な日：' + (session.fields.useDateValue || '未定') + '\n・その他のご希望：受け付けました\n\n内容に合う商品や装飾案を整理して、統括からご提案します。' };
  }
  return { session, message: consultationPrompt() };
}
function scheduleConsultationPrompt(storeVisit = false) {
  if (storeVisit) return 'ご回答ありがとうございます😊\n\n商品がまだ決まっていない場合は、まず店頭でご相談いただけます。空いている日時を確認するため、次の2点だけ教えてください。\n\n・来店希望日：\n・来店希望時間帯：\n\n分からない場合は「未定」で大丈夫です。ご来店時に相談したい内容や、気になる画像があれば任意で添えてください。確認後、来店可能な日時をご案内します。';
  return 'ご回答ありがとうございます😊 商品がまだ決まっていなくても、日程の空き状況から確認できます。\n\n分かる範囲で教えてください。\n\n・ご希望日（必須。未定でも可）：\n・希望時間帯：\n・受け取り方法（店頭受取／配達／発送／未定）：\n・用途やイベント（任意）：\n・その他のご希望・ご質問：\n\n確認後、対応可能な日程と、次に決める内容をご案内します。';
}
function collectScheduleDetail(text, session) {
  session.fields.scheduleText = [session.fields.scheduleText, stripIntakeTemplateHints(text)].filter(Boolean).join('\n').slice(0, 2000);
  session.fields.receiveDateValue = session.fields.receiveDateValue || labeledAnswer(text, '来店希望日|ご希望日|受取希望日|受け取り希望日|必要な日');
  session.fields.receiveTimeValue = session.fields.receiveTimeValue || labeledAnswer(text, '来店希望時間帯|希望時間帯|受取希望時間|受け取り希望時間');
  session.fields.methodValue = session.fields.methodValue || labeledAnswer(text, '受け取り方法|受取方法') || (session.fields.consultationMode === 'store_visit' ? '店頭相談' : null);
  if (/(?:ご希望日|受取希望日|受け取り希望日|必要な日)/u.test(text) || session.fields.scheduleText.length > 10) {
    session.stage = 'review';
    return { session, message: 'ご回答ありがとうございます😊\n\n日程相談として注文カルテに記録しました。\n\n・ご希望日：' + (session.fields.receiveDateValue || '未定') + '\n・希望時間帯：' + (session.fields.receiveTimeValue || '未定') + '\n・受け取り方法：' + (session.fields.methodValue || '未定') + '\n\n空き状況と対応可能な受け取り方法を確認し、統括からご案内します。商品内容は後から追加でご相談いただけます。' };
  }
  return { session, message: scheduleConsultationPrompt() };
}

function requestCustomerContact(session) {
  session.stage = 'awaiting_contact';
  return { session, message: 'ご注文ありがとうございます😊\n\n注文確定のため、以下の内容を教えてください。\n\n・お名前（本名）：\n・お電話番号：\n\nお預かりした情報は、ご注文内容の確認と当日のご連絡に使用いたします。' };
}

function recordCustomerContact(text, session) {
  const phone = text.match(/(?:電話(?:番号)?|TEL)\s*[：:]?\s*([0-9０-９\-ー－ ]{10,})/iu)?.[1]?.trim() || text.match(/0\d{1,4}[\-ー－ ]?\d{1,4}[\-ー－ ]?\d{3,4}/u)?.[0];
  const name = text.match(/(?:お名前|氏名|名前)\s*[：:]?\s*([^\n]+)/u)?.[1]?.trim();
  if (!name || !phone) return { session, message: 'ご回答ありがとうございます😊\n\n注文確定に必要なため、お名前（本名）とお電話番号を以下の形式でお送りください。\n\n・お名前（本名）：\n・お電話番号：' };
  session.stage = 'confirmed'; session.fields.customerName = name; session.fields.phone = phone;
  return { session, message: 'お名前とお電話番号を確認しました😊\n\nご注文内容と合わせて記録し、店長確認後の制作準備へ進みます。価格・在庫・納期・受取日時は確認後に改めてご案内します。' };
}
function unstructuredOrderInquiry(session) {
  session.stage = 'review';
  return { session, message: 'お問い合わせありがとうございます☺︎\n\n内容を確認し、対応について改めてご連絡いたします。' };
}
function collectOrderDetail(text, session) {
  const fields = session.fields;
  fields.lastCustomerMessage = redactContactDetails(text);
  mergeIntakeAnswers(fields, text);
  const missing = missingIntakeFields(fields);
  if (missing.length) {
    const nextMissing = missing.slice(0, 3);
    markSessionFieldsAsked(session, nextMissing);
    return { session, message: missingIntakePrompt(nextMissing, fields.productType) };
  }
  session.stage = 'review';
  return { session, message: orderDetailsReceivedReply() };
}
function orderDetailsReceivedReply() {
  return 'ご回答ありがとうございます😊\n\nすべての項目を確認しました。\n制作できる内容・在庫・納期・お届け方法を確認し、改めてご案内いたします。\n\n価格やお届け日時は、この時点ではまだ確定していません。追加で確認が必要な場合はご連絡いたします。';
}
function basicOrderConfirmation(text, session) {
  const fields = session.fields;
  return `ご回答ありがとうございます😊\n\n基本内容を確認しました。\n\n・商品番号・参考画像：${fields.productSourceValue || '未定'}\n・バルーンタイプ：${fields.productTypeValue || productTypeLabel(fields.productType) || '未定'}\n・ご予算：${fields.budgetValue || '未定'}\n・色味・雰囲気：${fields.colorValue || '未定'}\n・プレゼント・使用予定日：${fields.useDateValue || '未定'}\n・受取希望日：${fields.receiveDateValue || '未定'}\n・受取希望時間：${fields.receiveTimeValue || '未定'}\n・受取方法：${fields.methodValue || '未定'}\n\nこちらの内容で対応可能か確認を進めます。\n確認ができましたら、改めてご連絡いたします。\nその際、商品タイプに合わせて必要な内容だけ追加でお伺いします。`;
}
function intakePrompt(missing, productType, customerKind, hasKnownDetails) {
  const greeting = customerKind === 'returning' ? 'いつもありがとうございます☺︎ お久しぶりです。ご回答ありがとうございます。' : 'ご回答ありがとうございます😊';
  const guidance = `ご希望に合う形でご用意できるか確認するため、まずは下の基本項目を教えてください。\n\nまだ決まっていない項目は「未定」で大丈夫です。空欄があると確認を進められないため、お手数ですが、すべての項目へご記入をお願いいたします。\n\nHPの商品番号が分かる場合は番号を、分からない場合はスクリーンショットや参考画像をお送りください。\n\n途中で相談方法を選び直したい場合は、回答前に「1」「2」「3」「4」のいずれかを送ってください。\n\n${STORE_SERVICE_HOURS_NOTICE}`;
  const rows = '【ご注文内容】📷\n※そのままコピーしてご記入ください\n※決まっていない項目は「未定」で大丈夫です\n\n・HPの商品番号 または参考画像：\n（例：バルーンアレンジ36番／画像添付済み／未定）\n\n・バルーンのタイプ：\n（ブーケ／置き型アレンジメント／バルーンスタンド／ヘリウム〈浮く〉タイプ／会場装飾／その他）\n・その他の場合（自由記載）：\n（どのようなものか・飾る場所・参考画像など）\n\n・ご予算：\n（例：15,000円くらい／未定）\n\n・全体的なお色味と雰囲気：\n（例：ピンク系で可愛い雰囲気／お任せ／未定）\n\n・プレゼント・使用予定日：\n（例：10月3日／未定）\n\n・受取希望日：\n（例：10月2日／未定）\n\n・受取希望時間：\n（例：14時頃／未定）\n\n・受取方法：\n（店頭受取／配達／発送／未定）';
  const closing = '基本項目を確認できましたら、制作内容・在庫・納期・受取方法について確認を進めます。\n\n対応可能な場合は、当店の価格と納期を改めてご案内いたします。\n\n文字入れやメッセージカードなどは、制作可能な場合に商品内容に合わせて必要な項目だけ追加でお伺いします✨';
  return greeting + '\n\n' + guidance + '\n\n' + rows + '\n\n' + closing;
}
function intakeRows(items) {
  const choices = {
    'HPの商品番号 または参考画像': '（例：バルーンアレンジ36番／画像添付済み／未定）',
    'バルーンのタイプ': '（ブーケ／置き型アレンジメント／バルーンスタンド／ヘリウム〈浮く〉タイプ／会場装飾／その他）\n・その他の場合（自由記載）：',
    'ご予算': '（例：5,000円くらい／未定）',
    '全体的なお色味と雰囲気': '（例：ピンク系で可愛い雰囲気／お任せ／未定）',
    'プレゼント・使用予定日': '（例：10月3日／未定）',
    '受取希望日': '（例：10月2日／未定）',
    '受取希望時間': '（例：14時頃／未定）',
    '受取方法': '（店頭受取／配達／発送／未定）',
  };
  return items.map((item) => `・${item}：\n${choices[item] || ''}`).join('\n\n');
}
function mergeIntakeAnswers(fields, text) {
  text = stripIntakeTemplateHints(text);
  fields.productReference = fields.productReference || extractProductReference(text);
  fields.productSourceValue = fields.productSourceValue || fields.productReference || labeledAnswer(text, 'HPの商品番号\\s*または参考画像|参考画像|商品番号|品番');
  fields.hasProductSource = fields.hasProductSource || Boolean(fields.productSourceValue) || Boolean(fields.productReference) || Boolean(fields.referenceImage) || hasLabeledAnswer(text, 'HPの商品番号\\s*または参考画像|参考画像|商品番号');
  const detectedProductType = detectProductType(text);
  fields.productTypeValue = fields.productTypeValue || (detectedProductType ? productTypeLabel(detectedProductType) : labeledAnswer(text, 'バルーンのタイプ|商品タイプ'));
  fields.hasProductType = fields.hasProductType || Boolean(fields.productTypeValue) || Boolean(detectedProductType) || hasLabeledAnswer(text, 'バルーンのタイプ|商品タイプ');
  fields.productType = fields.productType || detectedProductType || (fields.hasProductType ? 'other' : null);
  fields.hasPurpose = fields.hasPurpose || Boolean(fields.purpose) || hasLabeledAnswer(text, 'ご用途|用途');
  fields.useDateValue = fields.useDateValue || labeledAnswer(text, 'プレゼント・使用予定日|使用予定日|利用日|使用日');
  fields.receiveDateValue = fields.receiveDateValue || labeledAnswer(text, '受取希望日|受け取り希望日|お届け希望日|ご希望日|希望日');
  fields.receiveTimeValue = fields.receiveTimeValue || labeledAnswer(text, '受取希望時間|受け取り希望時間|お届け希望時間|ご希望時間|希望時間');
  fields.budgetValue = fields.budgetValue || labeledAnswer(text, 'ご予算|予算') || text.match(/([0-9０-９][0-9０-９,，]*\s*円(?:くらい|程度)?)/u)?.[1];
  fields.methodValue = fields.methodValue || labeledAnswer(text, '受取方法|受け取り方法|お届け方法|方法') || (/配達|配送/u.test(text) ? '配達' : /発送|郵送/u.test(text) ? '発送' : /店頭受取|店頭で受/u.test(text) ? '店頭受取' : null);
  fields.colorValue = fields.colorValue || labeledAnswer(text, '全体的なお色味と雰囲気|色味・雰囲気|色味|雰囲気');
  fields.hasDate = fields.hasDate || Boolean(fields.receiveDateValue);
  fields.hasUseDate = fields.hasUseDate || Boolean(fields.useDateValue);
  fields.hasTime = fields.hasTime || Boolean(fields.receiveTimeValue);
  fields.hasBudget = fields.hasBudget || Boolean(fields.budgetValue);
  fields.hasMethod = fields.hasMethod || Boolean(fields.methodValue);
  fields.hasColor = fields.hasColor || Boolean(fields.colorValue);
  fields.hasBalloonMessage = fields.hasBalloonMessage || hasLabeledAnswer(text, 'バルーンへのご希望の文字入れ|文字入れ|バルーン(?:の)?(?:文字|メッセージ)') || /(?:文字入れ|バルーン(?:の)?(?:文字|メッセージ))\s*(?:は)?\s*(?:なし|不要)/u.test(text);
  fields.hasCard = fields.hasCard || hasLabeledAnswer(text, 'メッセージカードの有無|メッセージカード|カード(?:の内容)?') || /(?:メッセージカード|カード)\s*(?:は)?\s*(?:なし|不要)/u.test(text);
  fields.hasName = fields.hasName || hasLabeledAnswer(text, 'お名前|氏名|名前');
  fields.hasContact = fields.hasContact || hasLabeledAnswer(text, 'ご連絡先|電話(?:番号)?|TEL') || /0\d{1,4}[\-ー－ ]?\d{1,4}[\-ー－ ]?\d{3,4}/u.test(text);
  fields.hasOtherQuestions = fields.hasOtherQuestions || hasLabeledAnswer(text, 'その他ご質問等|その他|ご質問');
  if (fields.productType === 'venue_decoration' || fields.productType === 'balloon_stand') {
    fields.hasVenue = fields.hasVenue || hasLabeledAnswer(text, '会場名|設置先|場所');
    fields.hasInstallTime = fields.hasInstallTime || hasLabeledAnswer(text, '設置開始|設置時間|搬入時間') || /設置.*(?:\d{1,2}:\d{2}|午前|午後)/u.test(text);
  }
  if (fields.productType === 'floating_balloon') fields.hasEnvironment = fields.hasEnvironment || /室内|屋外|屋内/u.test(text) || hasLabeledAnswer(text, '設置環境|室内外');
}
function hasLabeledAnswer(text, label) {
  const answer = labeledAnswer(text, label);
  return Boolean(answer && !/^(?:未入力|空欄)$/u.test(answer));
}
function missingIntakeFields(fields) {
  return [
    !fields.hasProductSource && !fields.referenceImage && 'HPの商品番号 または参考画像',
    !fields.hasProductType && 'バルーンのタイプ',
    !fields.hasBudget && 'ご予算',
    !fields.hasColor && '全体的なお色味と雰囲気',
    !fields.hasUseDate && 'プレゼント・使用予定日',
    !fields.hasDate && '受取希望日',
    !fields.hasTime && '受取希望時間',
    !fields.hasMethod && '受取方法',
  ].filter(Boolean);
}
function missingIntakePrompt(missing, productType) { return 'ご回答ありがとうございます😊\n\n確認できた内容は注文カルテへ記録しました。\nまだ空欄になっている項目から、まずは以下をご回答ください。\n\n決まっていない項目は「未定」で大丈夫です。\n\n【確認したい項目】\n' + intakeRows(missing); }

function markSessionFieldsAsked(session, missingLabels) {
  if (!session.fields.questionCounts) session.fields.questionCounts = {};
  for (const label of missingLabels) {
    const field = ORDER_FEASIBILITY_FIELDS.find((item) => item.label === label);
    if (!field) continue;
    session.fields.questionCounts[field.key] = Number(session.fields.questionCounts[field.key] || 0) + 1;
  }
}
function intakeIntro(productType) { return ({ arrangement: '置き型アレンジをご希望ですね。', floating_balloon: '浮くタイプのバルーンをご希望ですね。', venue_decoration: '会場装飾のご相談ですね。', balloon_stand: 'バルーンスタンドのご相談ですね。', balloon_bouquet: 'バルーンブーケ・手渡し用ギフトのご相談ですね。', store_consultation: 'ご来店でのご相談ですね。' }[productType] || 'ご希望の内容を確認しながらご案内いたします。'); }
function intakeFollowUp(productType) { return ({ arrangement: '\n色味・大きさ・飾る場所、文字入れやカードの有無も教えてください。', floating_balloon: '\n室内・屋外、飾り始める時刻、サイズ・個数、固定方法の希望も教えてください。ヘリウム在庫は確認してご案内します。', venue_decoration: '\n会場名、設置・撤去の希望時刻、装飾する範囲、会場写真や平面図、テーマ・色味も教えてください。', balloon_stand: '\n設置先、希望の高さ・幅、名札や文字、設置・撤去の希望も教えてください。', balloon_bouquet: '\n贈る相手、色味・大きさ、文字入れ・カード内容も教えてください。', store_consultation: '\nご相談内容、希望日時、人数、参考画像の有無、予算の目安も教えてください。' }[productType] || '\nご希望の色味・雰囲気、文字入れ・メッセージカードの有無も分かる範囲で教えてください。'); }
function redactContactDetails(text) { return text.replace(/\b\d{2,4}[- ]?\d{2,4}[- ]?\d{3,4}\b/g, '[連絡先]').slice(0, 500); }

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
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.log('LINE reply skipped: access token missing');
    return;
  }
  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: message }] }),
  });
  console.log('LINE reply result', response.status, await response.text());
}

async function replyCustomer(replyToken, message, env) {
  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: message.slice(0, 4900) }] }),
  });
  console.log('customer LINE reply result', response.status, await response.text());
}

function customerReplyTiming(profileName, randomValue = randomUnit()) {
  const profile = CUSTOMER_REPLY_TIMINGS[profileName] || CUSTOMER_REPLY_TIMINGS.missing_details;
  const boundedRandom = Math.max(0, Math.min(0.999999999, randomValue));
  const delayRange = profile.maxDelayMs - profile.minDelayMs + 1;
  return {
    delayMs: profile.minDelayMs + Math.floor(boundedRandom * delayRange),
    loadingSeconds: profile.loadingSeconds,
  };
}

function randomUnit() {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return values[0] / 4294967296;
  }
  return Math.random();
}

async function startCustomerLoading(chatId, loadingSeconds, env) {
  try {
    const response = await fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN,
      },
      body: JSON.stringify({ chatId, loadingSeconds }),
    });
    console.log('customer LINE loading result', response.status, await response.text());
    return response.ok;
  } catch (error) {
    console.error('customer LINE loading failed', error);
    return false;
  }
}

async function deliverCustomerMessagesAfterDelay(to, messages, profileName, env, onSent) {
  const timing = customerReplyTiming(profileName);
  console.log('customer reply scheduled', { profileName, delayMs: timing.delayMs, loadingSeconds: timing.loadingSeconds });
  await startCustomerLoading(to, timing.loadingSeconds, env);
  await new Promise((resolve) => setTimeout(resolve, timing.delayMs));
  const sent = await pushCustomerMessages(to, messages, env);
  if (sent && onSent) await onSent();
  return sent;
}

async function continueCustomerDelivery(delivery, ctx) {
  if (ctx?.waitUntil) {
    ctx.waitUntil(delivery.catch((error) => console.error('delayed customer delivery failed', error)));
    return;
  }
  await delivery;
}

async function pushCustomerMessage(to, message, env) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN,
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: message.slice(0, 4900) }] }),
  });
  const responseText = await response.text();
  console.log('customer LINE push result', response.status, responseText);
  return response.ok;
}

async function pushCustomerMessages(to, messages, env) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN,
    },
    body: JSON.stringify({ to, messages: messages.filter(Boolean).map((text) => ({ type: 'text', text: text.slice(0, 4900) })) }),
  });
  const responseText = await response.text();
  console.log('customer LINE multi-message push result', response.status, responseText);
  return response.ok;
}

async function notifyOwners(message, env, extraMessages = [], notificationKey = null) {
  const owners = (env.ADMIN_LINE_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);
  const messages = [
    { type: 'text', text: message.slice(0, 4900) },
    ...extraMessages.filter((item) => item?.type === 'image' && /^https:\/\//u.test(item.originalContentUrl || '') && /^https:\/\//u.test(item.previewImageUrl || '')),
  ].slice(0, 5);
  console.log('owner notification prepared', {
    ownerCount: owners.length,
    hasAccessToken: Boolean(env.LINE_CHANNEL_ACCESS_TOKEN),
    notificationKey,
  });
  if (!owners.length) {
    console.error('LINE owner notification skipped: ADMIN_LINE_USER_IDS is missing');
    await recordOwnerNotificationAudit(env, notificationKey, 'failure', {
      requested: 0,
      sent: 0,
      messageCount: messages.length,
    }, 'OWNER_IDS_MISSING');
    return { requested: 0, sent: 0, error: 'OWNER_IDS_MISSING' };
  }
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error('LINE owner notification skipped: LINE_CHANNEL_ACCESS_TOKEN is missing');
    await recordOwnerNotificationAudit(env, notificationKey, 'failure', {
      requested: owners.length,
      sent: 0,
      messageCount: messages.length,
    }, 'OWNER_ACCESS_TOKEN_MISSING');
    return { requested: owners.length, sent: 0, error: 'OWNER_ACCESS_TOKEN_MISSING' };
  }
  let sent = 0;
  const attempts = [];
  for (const to of owners) {
    try {
      const response = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN },
        body: JSON.stringify({ to, messages }),
      });
      const responseText = await response.text();
      console.log('LINE owner notification result', response.status, responseText);
      attempts.push({ status: response.status, ok: response.ok });
      if (response.ok) sent += 1;
    } catch (error) {
      console.error('LINE owner notification request failed', error);
      attempts.push({ status: null, ok: false });
    }
  }
  const delivered = sent === owners.length;
  await recordOwnerNotificationAudit(env, notificationKey, delivered ? 'success' : 'failure', {
    requested: owners.length,
    sent,
    messageCount: messages.length,
    attempts,
  }, delivered ? null : 'LINE_PUSH_FAILED');
  return { requested: owners.length, sent, error: delivered ? null : 'LINE_PUSH_FAILED' };
}

async function ownerNotificationSucceeded(notificationKey, env) {
  if (!notificationKey) return false;
  const row = await env.DB.prepare(`SELECT id FROM audit_log
      WHERE action = ? AND result = 'success' ORDER BY id DESC LIMIT 1`)
    .bind(ownerNotificationAction(notificationKey)).first();
  return Boolean(row);
}

async function retryPendingOwnerNotifications(env, limit = 10) {
  const rows = await env.DB.prepare(`SELECT d.* FROM owner_decision_requests d
      WHERE d.status = 'needs_owner_review'
        AND NOT EXISTS (
          SELECT 1 FROM audit_log a
          WHERE a.action = ('owner.notification:owner-decision:' || d.id)
            AND a.result = 'success'
        )
        AND EXISTS (
          SELECT 1 FROM audit_log a
          WHERE a.action = ('owner.notification:owner-decision:' || d.id)
            AND a.result = 'failure'
        )
        AND (
          SELECT COUNT(*) FROM audit_log a
          WHERE a.action = ('owner.notification:owner-decision:' || d.id)
            AND a.result = 'failure'
        ) < 5
      ORDER BY d.created_at ASC LIMIT ?`)
    .bind(limit).all();
  let delivered = 0;
  for (const row of rows.results || []) {
    const request = {
      id: row.id,
      requestTypes: JSON.parse(row.request_types || '[]'),
      customerSummary: row.customer_summary,
    };
    const productReference = productReferenceFromOwnerSummary(row.customer_summary);
    const catalogProduct = productReference ? await findProductCatalogMatch(productReference, env) : null;
    const productImages = catalogProduct?.image_url
      ? [{ type: 'image', originalContentUrl: catalogProduct.image_url, previewImageUrl: catalogProduct.image_url }]
      : [];
    const result = await notifyOwners(
      formatOwnerDecisionRequest(request, catalogProduct),
      env,
      productImages,
      `owner-decision:${row.id}`,
    );
    if (!result.error) delivered += 1;
  }
  console.log('pending owner notification retry finished', {
    candidates: rows.results?.length || 0,
    delivered,
  });
  return { candidates: rows.results?.length || 0, delivered };
}

function productReferenceFromOwnerSummary(summary) {
  const value = String(summary || '').match(/・商品番号・参考画像：([^\n]+)/u)?.[1]?.trim();
  if (!value || /^(?:未定|参考画像あり|画像添付済み)$/u.test(value)) return null;
  return value;
}

function ownerNotificationAction(notificationKey) {
  return notificationKey ? `owner.notification:${String(notificationKey).slice(0, 180)}` : 'owner.notification';
}

async function recordOwnerNotificationAudit(env, notificationKey, result, detail, errorCode) {
  try {
    await env.DB.prepare(`INSERT INTO audit_log
        (timestamp, actor_line_user_id, action, before_json, after_json, result, error_code)
      VALUES (?, 'system', ?, NULL, ?, ?, ?)`)
      .bind(
        new Date().toISOString(),
        ownerNotificationAction(notificationKey),
        JSON.stringify(detail),
        result,
        errorCode,
      ).run();
  } catch (error) {
    console.error('owner notification audit failed', error);
  }
}
