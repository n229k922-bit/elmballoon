const encoder = new TextEncoder();
const CUSTOMER_SESSION_TTL = 60 * 60 * 24 * 14;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/business-schedule') {
      return publicSchedule(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/webhook/line') {
      return lineWebhook(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/webhook/customer-line') {
      return customerLineWebhook(request, env);
    }
    return new Response('Not found', { status: 404 });
  },
};

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
  if (/^(取消|キャンセル)$/u.test(text)) {
    await env.SECRETARY_KV.delete(pendingKey);
    return reply(event.replyToken, '確認待ちの変更を取り消しました。', env);
  }

  if (/^(?:今週|来週|再来週)末(?:は)?(?:休業|休み)(?:にして)?$/u.test(text)) {
    return reply(event.replyToken, '「週末」は土曜・日曜のどちらか、または両日かを確認したいです。例: 「今週末の土曜休み」「来週末の日曜休み」', env);
  }

  const route = routeManagerRequest(text);
  if (route) return reply(event.replyToken, route, env);
  const change = parseCommand(text);
  if (!change) return reply(event.replyToken, '例:「休業 2026-09-22」または「営業時間 2026-09-23 10:00-18:00」。内容を確認後に「確定」と返信してください。', env);
  await env.SECRETARY_KV.put(pendingKey, JSON.stringify(change), { expirationTtl: 600 });
  return reply(event.replyToken, change.summary + '。よろしければ10分以内に「確定」と返信してください。', env);
}

async function customerLineWebhook(request, env) {
  console.log('customer webhook received');
  if (!env.CUSTOMER_LINE_CHANNEL_SECRET || !env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN) {
    console.log('customer channel credentials missing');
    return new Response('Customer channel is not configured', { status: 503 });
  }
  const body = await request.text();
  const signature = request.headers.get('x-line-signature') || '';
  if (!(await signatureIsValid(body, signature, env.CUSTOMER_LINE_CHANNEL_SECRET))) {
    console.log('customer webhook signature invalid');
    return new Response('Invalid signature', { status: 401 });
  }

  const payload = JSON.parse(body);
  console.log('customer webhook signature valid', { eventCount: (payload.events || []).length });
  for (const event of payload.events || []) {
    console.log('customer webhook event', { type: event.type, messageType: event.message?.type || null });
    if (event.type !== 'message' || !['text', 'image'].includes(event.message?.type)) continue;
    if (event.message.type === 'text') await recordCustomerMessage(event, env);
    else await replyCustomerConversation(event, env);
  }
  return new Response('OK');
}

async function recordCustomerMessage(event, env) {
  const customerId = event.source?.userId;
  const text = event.message.text.trim();
  const now = new Date().toISOString();
  const threadId = 'customer:' + customerId;
  const displayName = await fetchCustomerDisplayName(customerId, env);
  const confirmedName = extractConfirmedCustomerName(text);
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

  const candidate = extractScheduleCandidate(text);
  await upsertOrderCard(threadId, text, candidate, now, env);

  const customerNames = await getCustomerNames(threadId, env);
  const customerName = customerNames.confirmedName || customerNames.displayName;
  const customerLabel = formatCustomerLabel(customerName);
  if (confirmedName) {
    await notifyOwners(`統括マネージャーです。\n\n注文担当から、${customerLabel}のお名前確認が取れたと共有がありました。\n今後の注文・予定候補は、このお名前で管理します。`, env);
  }

  if (!candidate) {
    console.log('customer message recorded without schedule candidate');
    await replyCustomerConversation(event, env);
    return;
  }
  const candidateId = 'candidate:' + (event.webhookEventId || event.message.id);
  await env.DB.prepare(`INSERT OR IGNORE INTO schedule_candidates
      (id, order_thread_id, event_type, event_date, event_time, status, source_summary, created_at)
      VALUES (?, ?, ?, ?, ?, 'needs_owner_review', ?, ?)`)
    .bind(candidateId, threadId, candidate.type, candidate.date, candidate.time, text, now).run();
  console.log('schedule candidate created', { type: candidate.type, date: candidate.date });
  const scheduledAt = formatScheduleDate(candidate.date, candidate.time);
  const dateNote = candidate.dateExpression ? `\n・日付の解釈：${candidate.dateExpression} → ${formatJapanDate(candidate.date)}` : '';
  const deliveryPlace = candidate.type === 'delivery' ? extractDeliveryPlaceHint(text) : null;
  const deliveryNote = formatDeliveryPlaceNote(deliveryPlace);
  await notifyOwners(`統括マネージャーです。\n\n注文担当から、${customerLabel}の予定に関する情報が共有されました。\n店長への案内内容と合っているか、ご確認をお願いします。\n\n【${customerLabel}からのご注文・予定候補】\n・${candidate.typeLabel}予定：${scheduledAt}${dateNote}${deliveryNote}\n・お客様のご希望：\n　「${text}」\n\n問題なければ、スケジュール担当に予定登録を依頼します。\n登録してよければ「予定登録 ${candidateId}」と返信してください。\n修正がある場合は、変更内容をそのまま返信してください。`, env);
  await replyCustomerConversation(event, env);
}

async function upsertOrderCard(threadId, text, candidate, now, env) {
  const details = extractOrderDetails(text, candidate);
  const cardId = `order-card:${threadId}`;
  await env.DB.prepare(`INSERT INTO order_cards
      (id, order_thread_id, status, purpose, recipient_profile, product_reference,
       requested_quantity, budget_yen, color_preference, size_preference,
       character_request, balloon_message, card_message, fulfillment_type,
       requested_date, requested_time, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        updated_at = excluded.updated_at`)
    .bind(
      cardId, threadId, details.status, details.purpose, details.recipientProfile, details.productReference,
      details.quantity, details.budgetYen, details.colorPreference, details.sizePreference,
      details.characterRequest, details.balloonMessage, details.cardMessage, details.fulfillmentType,
      details.requestedDate, details.requestedTime, now, now,
    ).run();
  await env.DB.prepare(`INSERT INTO order_card_events
      (order_card_id, event_type, actor, detail, occurred_at) VALUES (?, 'customer.message_analyzed', 'assistant', ?, ?)`)
    .bind(cardId, summarizeOrderDetails(details), now).run();
}

function extractOrderDetails(text, candidate) {
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
    colorPreference: extractLabeledText(text, /(?:色味|色|カラー)\s*(?:は|:|：)?\s*/u),
    sizePreference: extractLabeledText(text, /(?:大きさ|サイズ)\s*(?:は|:|：)?\s*/u),
    characterRequest: extractLabeledText(text, /(?:キャラクター)\s*(?:は|:|：)?\s*/u),
    balloonMessage: extractLabeledText(text, /(?:文字入れ|バルーン(?:の)?(?:文字|メッセージ))\s*(?:は|:|：)?\s*/u),
    cardMessage: extractLabeledText(text, /(?:メッセージカード|カード(?:の内容)?)\s*(?:は|:|：)?\s*/u),
    fulfillmentType,
    requestedDate: candidate?.date || null,
    requestedTime: candidate?.time || null,
  };
}

function extractLabeledText(text, labelPattern) {
  const match = text.match(new RegExp(labelPattern.source + '([^、。！!\\n]{1,80})', 'u'));
  return match ? match[1].trim() : null;
}

function extractProductReference(text) {
  const number = text.match(/(?:商品番号|品番|商品No\.?|No\.?)\s*(?:は|:|：)?\s*([A-Za-z0-9_-]{1,40})/iu);
  if (number) return number[1];
  const url = text.match(/https?:\/\/[^\s]+/u);
  return url ? url[0].slice(0, 300) : null;
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
  const type = /配達|お届け/u.test(text) ? 'delivery' : /受取|受け取り|引取/u.test(text) ? 'pickup' : /来店/u.test(text) ? 'visit' : null;
  if (!type) return null;
  let dateMatch = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/u);
  let dateExpression = null;
  if (!dateMatch) {
    const japaneseDate = text.match(/(\d{1,2})月(\d{1,2})日/u);
    if (japaneseDate) dateMatch = [null, japanDate(0).slice(0, 4), japaneseDate[1], japaneseDate[2]];
  }
  let date;
  if (dateMatch) {
    date = `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`;
  } else {
    const relative = extractRelativeCustomerDate(text);
    if (!relative) return null;
    date = relative.date;
    dateExpression = relative.expression;
  }
  const timeMatch = text.match(/(\d{1,2}):(\d{2})/u);
  const typeLabel = { pickup: '受取', delivery: '配達', visit: '来店' }[type];
  return { type, typeLabel, date, time: timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}` : null, dateExpression };
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
  if (/(?:配達|受取|引取|制作|納期|進捗|スケジュール|カレンダー)/u.test(text)) {
    return '統括マネージャーです。スケジュール担当への依頼として受け取りました。Googleカレンダー連携はまだ設定前のため、予定の登録は行っていません。対象の注文名・受取または配達日・時間を教えてください。';
  }
  if (/(?:注文|見積|お客様|問い合わせ|問合せ|予約)/u.test(text)) {
    return '統括マネージャーです。注文担当への依頼として整理します。お客様向けLINEはまだこの店主窓口と接続していないため、お客様への送信や注文確定は行っていません。内容・希望日・予算を教えてください。';
  }
  if (/(?:ホームページ|サイト|掲載|ページ|文章|写真)/u.test(text)) {
    return '統括マネージャーです。ホームページ管理AIへの依頼として受け取りました。現在は営業日・営業時間のテスト更新だけが有効です。変更したいページと内容を教えてください。';
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
  await env.DB.prepare(`INSERT INTO audit_log (actor_line_user_id, action, business_date, detail)
    VALUES (?, 'schedule.update', ?, ?)`)
    .bind(userId, change.date, JSON.stringify({ before: before || null, after: change })).run();
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

async function notifyOwners(message, env) {
  const owners = (env.ADMIN_LINE_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);
  for (const to of owners) {
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: message }] }),
    });
    console.log('LINE owner notification result', response.status, await response.text());
  }
}
