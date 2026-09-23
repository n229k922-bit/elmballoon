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
  const sendReply = text.match(/^送信\s+(review:[^\s]+)(?:\s+([\s\S]+))?$/u);
  if (sendReply) return prepareCustomerReplySend(event.replyToken, userId, sendReply[1], sendReply[2]?.trim() || null, false, env);
  const confirmReply = text.match(/^送信確認\s+(review:[^\s]+)$/u);
  if (confirmReply) return prepareCustomerReplySend(event.replyToken, userId, confirmReply[1], null, true, env);
  const holdReply = text.match(/^保留\s+(review:[^\s]+)(?:\s+([\s\S]+))?$/u);
  if (holdReply) {
    const result = await env.DB.prepare(`UPDATE customer_reply_reviews
        SET status = 'held', proposed_message = ? WHERE id = ? AND status IN ('needs_review', 'needs_change_confirmation')`)
      .bind(holdReply[2]?.trim().slice(0, 500) || '店長確認待ち', holdReply[1]).run();
    return reply(event.replyToken, result.meta.changes ? '返信を保留として記録しました。' : '確認待ちの返信案が見つからないか、すでに処理済みです。', env);
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
    await queueCustomerReplyReview(event, env);
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

  const candidate = extractScheduleCandidate(text);
  await upsertOrderCard(threadId, text, candidate, now, env);

  const customerNames = await getCustomerNames(threadId, env);
  const customerName = customerNames.confirmedName || customerNames.displayName;
  const customerLabel = formatCustomerLabel(customerName);
  if (confirmedName) {
    await notifyOwners(`統括マネージャーです。\n\n注文担当から、${customerLabel}のお名前確認が取れたと共有がありました。\n今後の注文・予定候補は、このお名前で管理します。`, env);
  }

  const ownerRequest = await createOwnerDecisionRequest({
    threadId,
    sourceEventId: event.webhookEventId || event.message.id,
    text,
    candidate,
    customerLabel,
    now,
    env,
  });
  if (ownerRequest) await notifyOwners(formatOwnerDecisionRequest(ownerRequest), env);

  if (!candidate) {
    console.log('customer message recorded without schedule candidate');
    return;
  }
  const candidateId = 'candidate:' + (event.webhookEventId || event.message.id);
  await env.DB.prepare(`INSERT OR IGNORE INTO schedule_candidates
      (id, order_thread_id, event_type, event_date, event_time, status, source_summary, created_at)
      VALUES (?, ?, ?, ?, ?, 'needs_owner_review', ?, ?)`)
    .bind(candidateId, threadId, candidate.type, candidate.date, candidate.time, text, now).run();
  console.log('schedule candidate created', { type: candidate.type, date: candidate.date });
}

async function queueCustomerReplyReview(event, env) {
  const customerId = event.source?.userId;
  if (!customerId) return;
  const sourceEventId = event.webhookEventId || event.message?.id;
  if (!sourceEventId) return;
  const key = 'customer-session:' + customerId;
  const session = (await env.SECRETARY_KV.get(key, 'json')) || { stage: 'new', fields: {} };
  if (!session.customerKind) session.customerKind = await getCustomerKind(customerId, event.message?.text || '', env);
  const result = event.message?.type === 'image'
    ? receiveReferenceImage(session)
    : buildCustomerReply(event.message?.text?.trim() || '', session);
  await env.SECRETARY_KV.put(key, JSON.stringify(result.session), { expirationTtl: CUSTOMER_SESSION_TTL });

  const threadId = 'customer:' + customerId;
  const reviewId = `review:${sourceEventId}`;
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO customer_reply_reviews
      (id, source_event_id, order_thread_id, customer_line_user_id, draft_message, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'needs_review', ?)`)
    .bind(reviewId, sourceEventId, threadId, customerId, result.message, new Date().toISOString()).run();
  if (!inserted.meta.changes) return;

  const names = await getCustomerNames(threadId, env);
  const customerLabel = formatCustomerLabel(names.confirmedName || names.displayName);
  const incoming = event.message?.type === 'image' ? '参考画像が届きました。' : redactContactDetails(event.message?.text || '').slice(0, 500);
  await notifyOwners(`統括マネージャーです。\n\n【お客様への返信確認】\n${customerLabel}からの連絡：\n「${incoming}」\n\n【送信案】\n${result.message.slice(0, 2500)}\n\n内容を確認してから送信します。\n・このまま送る：送信 ${reviewId}\n・文章を修正して送る：送信 ${reviewId} 修正した文章\n・保留する：保留 ${reviewId} 理由`, env);
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

async function upsertOrderCard(threadId, text, candidate, now, env) {
  const details = extractOrderDetails(text, candidate);
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

async function createOwnerDecisionRequest({ threadId, sourceEventId, text, candidate, customerLabel, now, env }) {
  const card = await env.DB.prepare(`SELECT * FROM order_cards WHERE order_thread_id = ?`).bind(threadId).first();
  if (!orderCardReadyForOwnerReview(card)) return null;
  const existing = await env.DB.prepare(`SELECT id FROM owner_decision_requests
      WHERE order_card_id = ? AND status != 'cancelled' AND customer_summary LIKE '%聞き取り内容%' LIMIT 1`).bind(`order-card:${threadId}`).first();
  if (existing) return null;
  const requestTypes = detectOwnerDecisionTypesFromCard(card);
  const requestId = `decision:${sourceEventId}`;
  const customerSummary = summarizeOwnerReviewFromCard(customerLabel, card);
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO owner_decision_requests
      (id, source_event_id, order_thread_id, order_card_id, request_types, status, customer_summary, created_at)
      VALUES (?, ?, ?, ?, ?, 'needs_owner_review', ?, ?)`)
    .bind(requestId, sourceEventId, threadId, `order-card:${threadId}`, JSON.stringify(requestTypes), customerSummary, now).run();
  return result.meta.changes ? { id: requestId, requestTypes, customerSummary } : null;
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

function formatOwnerDecisionRequest(request) {
  const labels = {
    schedule: '予約・受取時間の可否',
    delivery: '配達エリア・配達料・対応可否',
    quote_and_production: '見積・制作可否・納期',
    store_policy: '在庫・休業・キャンセル等の個別判断',
  };
  const checks = request.requestTypes.map((type) => `・${labels[type]}`).join('\n');
  return `統括マネージャーです。\n\n注文担当から店長確認が必要な内容を受け取りました。AIは価格・在庫・納期・配達可否を確約しません。\n\n【店長確認フォーム】\n${request.customerSummary}\n\n【ご判断をお願いします】\n${checks}\n\n判断内容は「店長確認 ${request.id} （判断内容）」と返信してください。\n例：店長確認 ${request.id} 配達可。配達料は個別見積、16時以降は不可`;
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
    return '統括マネージャーです。システム担当への依頼として受け取りました。現在は営業日・営業時間のテスト更新だけが有効です。変更したいページと内容を教えてください。';
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

async function getCustomerKind(customerId, text, env) {
  const profile = await env.DB.prepare(`SELECT completed_order_count, relationship_override
      FROM customer_profiles WHERE customer_line_user_id = ?`).bind(customerId).first();
  if (profile?.relationship_override === 'returning' || Number(profile?.completed_order_count || 0) > 0) return 'returning';
  if (/(?:前回|以前|またお願い|いつも|リピート)/u.test(text)) return 'returning';
  return 'new';
}

function buildCustomerReply(text, session) {
  if (/^(こんにちは|こんばんは|はじめまして|お世話になります)[！!。]*$/u.test(text)) return { session, message: 'こんにちは☺︎ ご連絡ありがとうございます。気になるお写真やご希望の内容がありましたら、そのままお送りください。ご用途・ご希望日・ご予算が分かるとスムーズにご案内できます🎈' };
  if (session.stage === 'collecting') return collectOrderDetail(text, session);
  if (/(今日|本日|明日|あした|急ぎ|至急)/u.test(text)) return urgentReply(session);
  if (/(ヘリウム|浮[かき]|ガス)/u.test(text)) return heliumReply(session);
  if (/(配送|配達|送[っり]て|郵送)/u.test(text)) return deliveryReply(session);
  if (/(しぼ|どのくらい持|日持ち|持ちます)/u.test(text)) return longevityReply(session);
  if (/(注文|お願い|作れ|作って|欲しい|ほしい|祝い|誕生日|開店|結婚|出産|発表会|卒業|退職)/u.test(text)) return orderReply(text, session);
  return { session, message: 'ご連絡ありがとうございます☺︎ 内容を確認して、できるだけご希望に沿えるようご案内します。差し支えなければ、①ご用途 ②ご希望日 ③ご予算 ④お受け取り・配達のどちらか を教えてください。参考のお写真があれば一緒に送っていただいて大丈夫です🎈' };
}

function urgentReply(session) { session.stage = 'urgent'; session.fields.urgent = true; return { session, message: 'お急ぎですね。ご相談ありがとうございます☺︎ 当日・翌日のご注文は、制作状況と商品の内容を確認してからのご案内になります。\nご希望日と、①ご用途 ②ご予算 ③お受け取り・配達のどちらか ④参考のお写真または商品番号 をお送りいただけますか？確認でき次第、可能な範囲をお返事します。' }; }
function heliumReply(session) { session.stage = 'helium'; return { session, message: 'ヘリウムバルーンのご相談ですね☺︎ バルーンの大きさ・種類・個数で必要量が変わるため、商品パッケージのお写真か、サイズと個数をお送りください。持ち込みの場合も確認してご案内します。\n※在庫状況や対応可能な時間は日によって変わるため、希望日も一緒にお願いします。' }; }
function deliveryReply(session) { session.stage = 'delivery'; return { session, message: '配達のご相談ありがとうございます☺︎ お届け地域・ご希望日・ご希望時間・ご予算を確認してご案内します。夏場は高温による破損を防ぐため、発送を控える場合があります。近隣への配達や店頭受け取りも含めて、いちばん良い方法をご提案しますね。' }; }
function longevityReply(session) { session.stage = 'faq'; return { session, message: 'ご質問ありがとうございます☺︎ バルーンは種類や飾る環境によって異なります。直射日光・高温・尖った物を避けて室内に飾ると、より長く楽しんでいただけます。お写真を送っていただければ、その商品に合わせた目安と保管方法をご案内します🎈' }; }
function orderReply(text, session) {
  session.stage = 'collecting';
  session.fields.purpose = ['開店','結婚','出産','誕生日','発表会','卒業','退職'].find((purpose) => text.includes(purpose)) || null;
  session.fields.productType = detectProductType(text);
  mergeIntakeAnswers(session.fields, text);
  const missing = missingIntakeFields(session.fields);
  if (!missing.length) {
    session.stage = 'review';
    return { session, message: orderDetailsReceivedReply() };
  }
  return { session, message: intakePrompt(missing, session.fields.productType, session.customerKind, Boolean(session.fields.productType || session.fields.purpose)) };
}
function collectOrderDetail(text, session) {
  const fields = session.fields;
  fields.lastCustomerMessage = redactContactDetails(text);
  mergeIntakeAnswers(fields, text);
  const missing = missingIntakeFields(fields);
  if (missing.length) return { session, message: missingIntakePrompt(missing, fields.productType) };
  session.stage = 'review';
  return { session, message: orderDetailsReceivedReply() };
}
function orderDetailsReceivedReply() {
  return 'ありがとうございます☺︎ ご希望内容を承りました。制作・在庫・配達・予約状況を店長が確認し、対応可否とお見積りを改めてご連絡いたします。現時点では価格・在庫・納期は確約せず、確認してご案内します。';
}
function intakePrompt(missing, productType, customerKind, hasKnownDetails) {
  const greeting = customerKind === 'returning' ? 'いつもありがとうございます☺︎ お久しぶりです。今回もご連絡いただき、うれしいです。' : 'はじめまして☺︎ ご連絡ありがとうございます。';
  const guidance = hasKnownDetails ? 'すでにいただいた内容は確認できています。次の項目だけ、コピーしてご返信ください。' : '分かるところだけで大丈夫です。下の項目をコピーしてご返信ください。';
  return greeting + ' ' + intakeIntro(productType) + '\n\n' + guidance + '\n\n【確認したい内容】\n' + intakeRows(missing) + '\n\n参考画像は、このまま画像で送っていただいて大丈夫です。制作・在庫・配達・予約状況を確認し、改めてご連絡いたします。';
}
function intakeRows(items) {
  const choices = {
    '商品タイプ': '商品タイプ：バルーンブーケ／アレンジ／浮くタイプ／会場装飾／スタンド／来店相談／未定',
    '受取方法': '受取方法：店頭受取／配達／来店相談／発送',
  };
  return items.map((item) => choices[item] || `${item}：`).join('\n');
}
function mergeIntakeAnswers(fields, text) {
  fields.productType = fields.productType || detectProductType(text) || (hasLabeledAnswer(text, '商品タイプ') ? 'other' : null);
  fields.hasPurpose = fields.hasPurpose || Boolean(fields.purpose) || hasLabeledAnswer(text, 'ご用途|用途');
  fields.hasDate = fields.hasDate || /\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}月\d{1,2}日|今日|明日|あした|今週|来週|今度/u.test(text) || hasLabeledAnswer(text, 'ご希望日|希望日');
  fields.hasTime = fields.hasTime || /\d{1,2}:\d{2}|午前|午後|時頃?|まで/u.test(text) || hasLabeledAnswer(text, 'ご希望時間|希望時間');
  fields.hasBudget = fields.hasBudget || /円/u.test(text) || hasLabeledAnswer(text, 'ご予算|予算');
  fields.hasMethod = fields.hasMethod || /受取|受け取|来店|配達|配送|発送|郵送/u.test(text) || hasLabeledAnswer(text, '受取方法|受け取り方法|方法');
  fields.hasColor = fields.hasColor || /ピンク|赤|青|黄|緑|紫|白|黒|金|銀|色味|カラー|おまかせ/u.test(text) || hasLabeledAnswer(text, '色味|雰囲気');
  if (fields.productType === 'venue_decoration' || fields.productType === 'balloon_stand') {
    fields.hasVenue = fields.hasVenue || hasLabeledAnswer(text, '会場名|設置先|場所');
    fields.hasInstallTime = fields.hasInstallTime || hasLabeledAnswer(text, '設置開始|設置時間|搬入時間') || /設置.*(?:\d{1,2}:\d{2}|午前|午後)/u.test(text);
  }
  if (fields.productType === 'floating_balloon') fields.hasEnvironment = fields.hasEnvironment || /室内|屋外|屋内/u.test(text) || hasLabeledAnswer(text, '設置環境|室内外');
}
function hasLabeledAnswer(text, label) { return new RegExp(`(?:${label})\\s*[：:]\\s*(?!\\s*(?:$|未定|未入力))[^\\n]{1,80}`, 'u').test(text); }
function missingIntakeFields(fields) {
  const missing = [!fields.productType && '商品タイプ', !fields.hasPurpose && 'ご用途', !fields.hasDate && 'ご希望日', !fields.hasTime && 'ご希望時間', !fields.hasMethod && '受取方法', !fields.hasBudget && 'ご予算', !fields.hasColor && '色味・雰囲気'];
  if (fields.productType === 'venue_decoration' || fields.productType === 'balloon_stand') missing.push(!fields.hasVenue && '会場名・設置先', !fields.hasInstallTime && '設置・搬入時間');
  if (fields.productType === 'floating_balloon') missing.push(!fields.hasEnvironment && '室内・屋外の別');
  return missing.filter(Boolean);
}
function missingIntakePrompt(missing, productType) { return 'ありがとうございます☺︎ 受け取りました。\n\nあと、次の項目だけ教えてください。該当部分をコピーしてご返信いただければ大丈夫です。\n\n' + missing.map((item) => `${item}：`).join('\n') + intakeFollowUp(productType) + '\n\n確認後、制作・在庫・配達・予約状況を確認してご案内します。'; }
function intakeIntro(productType) { return ({ arrangement: '置き型アレンジをご希望ですね。', floating_balloon: '浮くタイプのバルーンをご希望ですね。', venue_decoration: '会場装飾のご相談ですね。', balloon_stand: 'バルーンスタンドのご相談ですね。', balloon_bouquet: 'バルーンブーケ・手渡し用ギフトのご相談ですね。', store_consultation: 'ご来店でのご相談ですね。以下の内容で承りました。店舗の予約状況を確認し、改めてご連絡いたします。' }[productType] || 'できるだけイメージに近づけられるよう確認します。'); }
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
