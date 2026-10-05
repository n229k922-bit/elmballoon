import { planConversation, extractConversationFacts, resolveConversationDate } from './conversation.js';
import { parseHistoryRequest, searchHistory, getHistoryDetail, formatCustomerHistory } from './manager-history.js';
import { reserveOrderCapacity, getCapacitySummary, validateCapacityRequirements } from './capacity-safety.js';
import { getOperationalMetrics, formatOperationalMetrics } from './operational-metrics.js';
import { discloseAssistant } from './ai-disclosure.js';
import { isJapanesePublicHoliday } from './japan-calendar.js';

const iso = (value = Date.now()) => new Date(value).toISOString();
const statement = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const rows = async (env, sql, ...args) => (await statement(env, sql, ...args).all()).results || [];
const first = (env, sql, ...args) => statement(env, sql, ...args).first();
const id = (prefix) => prefix + crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
const owners = (env) => [...new Set((env.ADMIN_LINE_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean))];
const fieldValue = (fields, key) => fields[key]?.value_text || '';
const LABELS = { purpose:'用途', product_type:'商品', product_source:'参考商品', receive_date:'受取希望日', use_date:'使用日', receive_time:'受取時間', fulfillment_method:'受取方法', delivery_area:'配達地域', delivery_address:'お届け先', quantity:'数量', budget:'予算', budget_scope:'予算の単位', color_vibe:'色・雰囲気', customer_name:'お名前', phone:'電話番号', balloon_message:'文字入れ', card_message:'カード' };
const REASON_LABELS = { delivery_feasibility:'配達・発送できるか確認', urgent_capacity:'直近の日程で対応できるか確認', past_date:'希望日が過去の日付になっています', verify_previous_order:'前回の注文内容を確認', order_exception:'変更・キャンセルなどの対応確認', per_item_specifications:'商品ごとの仕様を確認', review_collected_details:'注文内容で対応できるか確認' };
const replyActions = '\n1：この内容で送信\n2：修正（「2 修正した文章」）\n3：保留';
const STATUS_LABELS = {consulting:'相談中',pending:'確認待ち',unconfirmed:'未確認',confirmed:'確認済み',producing:'制作中',completed:'完成',fulfilled:'お渡し済み',paid:'入金済み',not_required:'不要',awaiting_confirmation:'入金確認待ち',sending:'送信中',sent:'送信済み',failed:'送信できていません',uncertain:'送信結果の確認が必要',cancelled:'取り消し済み',held:'保留中',approved:'送信準備中',open:'対応中',closed:'終了',collected:'回収済み'};
export function managerFriendlyText(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\b[MD][A-F0-9]{16}\b/gu,'対象の注文').replace(/（版\d+）/gu,'').replace(/\b(?:consulting|pending|unconfirmed|confirmed|producing|completed|fulfilled|paid|not_required|awaiting_confirmation|sending|sent|failed|uncertain|cancelled|held|approved|open|closed|collected)\b/gu,s=>STATUS_LABELS[s]).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu,s=>new Date(s).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}));
}
const ORDER_ACTIONS = ['カルテ','過去情報','制作開始','完成','受渡完了','支払完了','案件終了','対応確認','変更確認','返信作成','電話メモ'];
async function saveMenu(env,actor,stage,entries,now) {
  await statement(env,`INSERT INTO manager_reply_selection(actor,stage,draft_ids_json,expires_at) VALUES (?,?,?,?) ON CONFLICT(actor) DO UPDATE SET stage=excluded.stage,draft_ids_json=excluded.draft_ids_json,expires_at=excluded.expires_at`,actor,stage,JSON.stringify(entries),iso(Date.parse(now)+600000)).run();
}
const capacityMessage = reason => ({capacity_unknown_limits:'その日の受付上限が未設定です。店長が「受付上限」を設定してください。',capacity_exceeded:'他の注文と合計すると受付上限を超えます。日程・作業量を見直してください。',capacity_stale_order:'注文内容が変わっています。最新のカルテで枠を確認し直してください。',capacity_unavailable:'受付枠を確認できません。制作開始を止め、システムの状態を確認してください。',capacity_unaccounted_existing_load:'同じ日に、枠が未確認の受注済み注文があります。先に既存注文の作業量を整理してください。',capacity_uncertain_existing_load:'受注済み注文に日付が未確認のものがあります。既存注文の日付と作業量を整理してください。'}[reason] || '日付・制作分数・配達件数・注文件数を正しい数字で指定してください。');

export function managerV2Enabled(env) { return env.ORDER_ENGINE === 'v2'; }
export function managerTestRecipientAllowed(customerId,channel,env) {
  if(env.MANAGER_TEST_MODE!=='true')return true;
  const list=(channel==='owner'?env.ADMIN_LINE_USER_IDS:env.MANAGER_TEST_CUSTOMER_IDS)||'';
  return list.split(',').map(x=>x.trim()).filter(Boolean).includes(customerId);
}

export function eventTime(event, receivedAt = iso()) {
  const timestamp = Number(event.timestamp);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.parse(receivedAt) + 300_000
    ? iso(timestamp) : receivedAt;
}

// The raw inbox is the recovery point. A duplicate webhook must not erase unfinished work.
export async function receiveManagerEvents(events, env, now = iso()) {
  const statements = [];
  for (const event of events) {
    if (event.type !== 'message' || !event.source?.userId || !['text', 'image'].includes(event.message?.type)) continue;
    if(!managerTestRecipientAllowed(event.source.userId,'customer',env))continue;
    const eventId = event.webhookEventId || event.message.id;
    if (!eventId) continue;
    statements.push(statement(env, `INSERT OR IGNORE INTO manager_events
      (id,customer_id,direction,text,media_message_id,occurred_at,received_at)
      VALUES (?,?,'customer',?,?,?,?)`, eventId, event.source.userId,
    event.message.type === 'image' ? '[参考画像：内容未確認]' : (event.message.text || '').slice(0, 20000),
    event.message.type === 'image' ? event.message.id : null, eventTime(event, now), now));
  }
  if (statements.length) await env.DB.batch(statements);
}

function outboxStatement(env, key, recipient, channel, text, now, draftId = null) {
  return statement(env, `INSERT OR IGNORE INTO manager_outbox
    (id,recipient,channel,text,draft_id,retry_key,next_attempt_at,created_at)
    VALUES (?,?,?,?,?,?,?,?)`, key, recipient, channel, text.slice(0, 4900), draftId, crypto.randomUUID(), now, now);
}

function ownerMessages(env, key, text, now) {
  return owners(env).map(owner => outboxStatement(env, `${key}:${owner}`, owner, 'owner', managerFriendlyText(text), now));
}

export function chooseOrder(text, orders) {
  const requestedIds = [...new Set((text.match(/\bM[A-F0-9]{16}\b/giu) || []).map(value => value.toUpperCase()))];
  if (requestedIds.length > 1) return { ambiguous: true };
  const requested = requestedIds[0];
  if (requested) return { order: orders.find(order => order.id === requested) || null, unknown: !orders.some(order => order.id === requested) };
  if (/^(?:別の注文|新しい注文|新規注文)(?:[\s：:。]|$)/u.test(text.trim())) return { create: true };
  if (orders.length === 1) return { order: orders[0] };
  if (!orders.length) return { create: true };
  return { ambiguous: true };
}

export async function loadCustomerHistory(customerId, env) {
  // Private history is only looked up by an explicitly linked immutable customer id.
  const imported = await rows(env, `SELECT id,source_heading,raw_text,review_status FROM manager_imports
    WHERE linked_customer_id = ? AND review_status = 'verified' ORDER BY created_at DESC LIMIT 3`, customerId);
  const previous = await rows(env, `SELECT id,title FROM manager_orders
    WHERE customer_id = ? AND status = 'closed' ORDER BY updated_at DESC LIMIT 3`, customerId);
  return { imported, previous };
}

export function businessDeadline(now, urgent, schedule = [], hours = 8) {
  if (urgent) return iso(Date.parse(now) + 30 * 60_000);
  // Count weekday store hours. Unknown weekdays use 10–16; weekends, public holidays,
  // and explicit closures pause the timer.
  const exceptions = new Map(schedule.map(row => [row.date, row]));
  let cursor = Math.ceil(Date.parse(now) / 60_000) * 60_000;
  let remaining = hours * 60;
  for (let i = 0; i < 60 * 24 * 370; i++, cursor += 60_000) {
    const local = new Date(cursor + 9 * 3600_000).toISOString();
    const day = local.slice(0, 10), time = local.slice(11, 16);
    const row = exceptions.get(day);
    if (row?.status === 'closed') continue;
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6 || isJapanesePublicHoliday(day)) continue;
    const start = row?.open_time || '10:00', end = row?.close_time || '16:00';
    if (time >= start && time < end && --remaining <= 0) return iso(cursor + 60_000);
  }
  return iso(cursor);
}

function japanDateTime(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { ...parts, date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function reminderWindow(now, schedule) {
  const local = japanDateTime(now);
  if (local.weekday === 'Sat' || local.weekday === 'Sun' || isJapanesePublicHoliday(local.date)) return false;
  const override = schedule.find(row => row.date === local.date);
  if (override?.status === 'closed') return false;
  const opens = override?.open_time || '10:00';
  const closes = override?.close_time || '16:00';
  return local.time >= opens && local.time < closes;
}

function readableJapanDateTime(value) {
  const local = japanDateTime(value);
  return `${Number(local.month)}月${Number(local.day)}日 ${Number(local.hour)}:${local.minute}`;
}

function reminderOrderText(task) {
  const identity = [task.customer_name, task.title].filter(Boolean).join('・') || '注文内容を確認中のお客様';
  const details = [
    task.quantity ? `${task.quantity}個` : '',
    task.receive_date ? `受取希望：${String(task.receive_date).replace(/^(?:\d{4}-)?(\d{2})-(\d{2})$/u, (_, month, day) => `${Number(month)}月${Number(day)}日`)}` : '',
  ].filter(Boolean);
  const reasons = (() => { try { return JSON.parse(task.reasons_json || '[]'); } catch { return []; } })();
  const decision = task.kind === 'reply'
    ? [...new Set(reasons.map(reason => REASON_LABELS[reason] || (/^[a-z_]+$/u.test(reason) ? '注文内容で対応できるか確認' : reason)))].join('・') || 'お客様への返信内容を確認'
    : task.kind === 'manual_review' ? '電話・店頭で確認した内容を見直し、返信が必要か確認'
      : '必要な対応を確認';
  return `・${identity}${details.length ? `（${details.join('／')}）` : ''}\n  確認すること：${decision}\n  確認予定：${readableJapanDateTime(task.due_at)}`;
}

async function processInboxGroup(events, env, now) {
  const latest = events.at(-1), customerId = latest.customer_id;
  const text = events.map(event => event.text).join('\n');
  const active = await rows(env, `SELECT * FROM manager_orders WHERE customer_id = ? AND status = 'open' ORDER BY created_at`, customerId);
    const routedOrderId = events.find(event => event.order_id)?.order_id;
    let selection = routedOrderId
      ? { order: active.find(order => order.id === routedOrderId), unknown: !active.some(order => order.id === routedOrderId) }
    : chooseOrder(text, active);
  const batch = [];
  if (selection.create) {
    const orderId = id('M');
    selection = { order: { id: orderId, customer_id: customerId, revision: 0, title: 'ご相談', status: 'open' } };
    batch.push(statement(env, `INSERT INTO manager_orders(id,customer_id,created_at,updated_at) VALUES (?,?,?,?)`, orderId, customerId, now, now));
  }
  const order = selection.order;
  const draftId = id('D');
  if (!order) {
    const message = selection.unknown
      ? 'ご指定の注文を確認しています。担当者から改めてご案内いたします。'
      : `ご相談中の注文が複数あるため、どちらについてのお話か教えてください。\n${active.map(o => `・${o.id} ${o.title}`).join('\n')}\n別のご注文でしたら「別の注文」とお送りください。`;
    batch.push(statement(env, `INSERT OR IGNORE INTO manager_drafts
      (id,customer_id,source_event_id,message,created_at) VALUES (?,?,?,?,?)`, draftId, customerId, latest.id, message, now));
    batch.push(statement(env, `INSERT OR IGNORE INTO manager_tasks(id,kind,detail,due_at,created_at)
      VALUES (?,'routing',?,?,?)`, `route:${latest.id}`, `案件振分待ち。振分 ${latest.id} カルテ番号`, now, now));
    batch.push(...ownerMessages(env, `draft:${draftId}`, `【どの注文についてのご連絡か確認】\n${text.slice(0, 800)}\n候補：\n${active.map(o => o.title).join('\n')}\nお客様に尋ねる案：\n${message}\n\n「返信待ち」で返信案を番号から確認できます。`, now));
  } else {
    const existing = await rows(env, `SELECT * FROM manager_fields WHERE order_id = ?`, order.id);
    const fields = Object.fromEntries(existing.map(f => [f.field_key, f]));
    const asked = await rows(env, `SELECT field_key AS key, question_text AS text,draft_id FROM manager_questions
      WHERE order_id = ? AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 20`, order.id);
    const customerHistory = /昨年|去年|前回|以前|同じ/u.test(text) ? await loadCustomerHistory(customerId, env) : null;
    const latestQuestions = asked.filter(q => q.draft_id === asked[0]?.draft_id);
    const plan = planConversation({ text, fields, lastQuestions: latestQuestions, sourceTimestamp: latest.occurred_at,
      history: [{questions:asked}], hasImage: events.some(e => e.media_message_id) });
    const evidenceUpdates=new Map();
    for(const event of events) {
      const parsed=extractConversationFacts({text:event.text,sourceTimestamp:event.occurred_at,lastQuestions:latestQuestions,hasImage:Boolean(event.media_message_id)});
      for(const update of parsed.updates) evidenceUpdates.set(update.key,{...update,sourceEventId:event.id});
    }
    const changes = [], proposed = { ...fields };
    for (const update of evidenceUpdates.values()) {
      if (!update.key || update.value == null) continue;
      const value = String(update.value).slice(0, 4000);
      const previous = fields[update.key];
      if (previous?.value_text === value) continue;
      // Older evidence can be inspected, but must never overwrite a newer statement.
      const needsReview = previous && (previous.confirmed_at || previous.status === 'confirmed'
        || update.sourceTimestamp < previous.source_occurred_at);
      if (needsReview) {
        const changeId = id('C');
        changes.push({ id: changeId, key: update.key, old: previous.value_text, value });
        batch.push(statement(env, `INSERT INTO manager_changes
          (id,order_id,field_key,old_value,new_value,source_event_id,base_revision) VALUES (?,?,?,?,?,?,?)`,
        changeId, order.id, update.key, previous.value_text, value, update.sourceEventId, order.revision + 1));
      } else {
        proposed[update.key] = { value_text: value, status: update.status || 'answered' };
        batch.push(statement(env, `INSERT INTO manager_fields
          (order_id,field_key,value_text,status,source_event_id,source_occurred_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(order_id,field_key) DO UPDATE SET
          value_text=excluded.value_text,status=excluded.status,source_event_id=excluded.source_event_id,
          source_occurred_at=excluded.source_occurred_at`, order.id, update.key, value, update.status || 'answered', update.sourceEventId, update.sourceTimestamp));
      }
    }
    const reasons = [...(plan.ownerReasons || [])];
    if (changes.length) reasons.push('承認済み内容または時系列の異なる内容に変更候補あり');
    if (events.some(e => e.media_message_id)) reasons.push('参考画像の内容は未判読。原トークで確認が必要');
    if (customerHistory) reasons.push(customerHistory.imported.length || customerHistory.previous.length
      ? '本人に紐付く過去記録あり。今回の仕様は再確認が必要' : '過去注文の確認済み記録なし。昨年と同じ仕様を推測しない');
    const baseMessage = changes.length ? 'ご変更の内容を確認しています。対応できるか確認のうえ、改めてご案内いたします。'
      : String(plan.message || 'ご連絡ありがとうございます。内容を確認してご案内いたします。');
    const message = await discloseAssistant(reasons.length ? `${baseMessage}\n\n確認が取れ次第、ご返信いたします。店休日・営業時間外は、次の営業時間内のご返信となる場合がございます。` : baseMessage, customerId, env);
    const title = [fieldValue(proposed, 'purpose'), fieldValue(proposed, 'product_type')].filter(Boolean).join('・').slice(0, 100) || order.title;
    for (let index=0; index<(plan.facts?.items || []).length; index++) {
      const item = plan.facts.items[index];
      batch.push(statement(env, `INSERT OR IGNORE INTO manager_order_items(id,order_id,label,specification,source_event_id,updated_at)
        VALUES (?,?,?,?,?,?)`, `${latest.id}:item:${index}`, order.id, `確認待ち明細 ${index+1}`, item.specification, latest.id, now));
    }
    batch.push(statement(env, `UPDATE manager_orders SET revision=revision+1,title=?,updated_at=? WHERE id=?`, title, now, order.id));
    batch.push(statement(env, `UPDATE manager_drafts SET status='stale' WHERE order_id=? AND status IN ('pending','held')`, order.id));
    batch.push(statement(env, `UPDATE manager_tasks SET status='cancelled',completed_at=? WHERE order_id=? AND kind='reply' AND status='open'`, now, order.id));
    batch.push(statement(env, `INSERT INTO manager_drafts
      (id,order_id,customer_id,source_event_id,base_revision,message,reasons_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`, draftId, order.id, customerId, latest.id, order.revision + 1, message, JSON.stringify(reasons), now));
    for (const question of (plan.questions || []).slice(0, 2)) {
      batch.push(statement(env, `INSERT OR IGNORE INTO manager_questions(draft_id,order_id,field_key,question_text) VALUES (?,?,?,?)`, draftId, order.id, question.key, question.text));
    }
    const schedule = await rows(env, `SELECT date,status,open_time,close_time FROM business_schedule WHERE date >= ?`, now.slice(0, 10));
    const urgent = /今日|本日|明日|至急|急ぎ|破損|けが|怪我/u.test(text);
    const dueAt = businessDeadline(now, urgent, schedule, Number(env.MANAGER_REVIEW_WORK_HOURS) || 8);
    batch.push(statement(env, `INSERT INTO manager_tasks(id,order_id,kind,detail,due_at,created_at)
      VALUES (?,?,'reply',?,?,?)`, `reply:${draftId}`, order.id, `返信・判断待ち ${draftId}`, dueAt, now));
    const summary = Object.entries(proposed).filter(([key]) => key !== 'budget_scope' && Object.hasOwn(LABELS, key)).map(([key, value]) => {
      let display = value.value_text;
      if (key === 'receive_date' || key === 'use_date') display = String(display).replace(/^\d{4}-(\d{2})-(\d{2})$/u, (_, month, day) => `${Number(month)}月${Number(day)}日`);
      return `${LABELS[key]}：${display}`;
    }).join('\n');
    const historyNote = await formatCustomerHistory(customerId,env,order.id);
    const ownerText = `【返信の確認】${title}\n${urgent ? '急ぎの対応が必要です\n' : ''}${summary.slice(0, 1200)}\n`
      + (reasons.length ? `確認点：${reasons.map(reason => REASON_LABELS[reason] || (/^[a-z_]+$/u.test(reason) ? '注文内容の確認が必要です' : reason)).join('／')}\n` : '')
      + changes.map(c => `${c.id} ${c.key}：${c.old} → ${c.value}\n変更承認 ${c.id}`).join('\n')
      + (historyNote ? `\n【本人の過去記録・今回未確定】\n${historyNote}\n` : '')
      + `\n【返信案】\n${message}\n\n番号でご回答ください\n1：この内容で送信\n2：修正（「2 修正した文章」）\n3：保留\n複数案件がある場合は対象を確認します。`;
    batch.push(...ownerMessages(env, `draft:${draftId}`, ownerText, now));
    for (const event of events) batch.push(statement(env, `UPDATE manager_events SET order_id=? WHERE id=?`, order.id, event.id));
  }
  for (const event of events) batch.push(statement(env, `UPDATE manager_events SET processed_at=?,processing_error=NULL WHERE id=?`, now, event.id));
  await env.DB.batch(batch);
}

async function withInboxLock(env, now, fn) {
  const token = crypto.randomUUID(), until = iso(Date.parse(now) + 120_000);
  const lock = await statement(env, `INSERT INTO manager_locks(id,token,expires_at) VALUES ('inbox',?,?)
    ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE expires_at < ?`, token, until, now).run();
  if (!lock.meta.changes) return false;
  try { await fn(); return true; }
  finally { await statement(env, `DELETE FROM manager_locks WHERE id='inbox' AND token=?`, token).run(); }
}

export async function drainManagerInbox(env, now = iso()) {
  return withInboxLock(env, now, async () => {
    const pending = await rows(env, `SELECT * FROM manager_events WHERE processed_at IS NULL AND direction='customer'
      ORDER BY received_at,rowid LIMIT 20`);
    const grouped = new Map();
    const currentGroup = new Map();
    for (const event of pending) {
      const newOrder = /^(?:別の注文|新しい注文|新規注文)(?:[\s：:。]|$)/u.test(event.text.trim());
      // An explicit target begins a new contiguous burst. Never merge A→B→A
      // into a single group: that would attach another order's trailing replies.
      const explicitTarget = event.order_id || event.text.match(/\bM[A-F0-9]{16}\b/iu)?.[0];
      const key = newOrder || explicitTarget || !currentGroup.has(event.customer_id)
        ? `${event.customer_id}:${event.id}` : currentGroup.get(event.customer_id);
      currentGroup.set(event.customer_id, key);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(event);
    }
    for (const events of grouped.values()) {
      const newer = await first(env, `SELECT id FROM manager_events WHERE customer_id=? AND processed_at IS NULL AND received_at>? AND received_at>? LIMIT 1`, events[0].customer_id, events.at(-1).received_at, iso(Date.parse(now)-12_000));
      if (newer) continue;
      const lastReceived = events.at(-1).received_at;
      if (Date.parse(now) - Date.parse(lastReceived) < 12_000 && !events.some(e => /至急|緊急|破損|怪我|けが/u.test(e.text))) continue;
      await processInboxGroup(events, env, now);
    }
  });
}

export async function flushManagerOutbox(env, now = iso(), fetcher = fetch) {
  if (env.MANAGER_SEND_PAUSED === 'true') return;
  const pending = await rows(env, `SELECT * FROM manager_outbox WHERE
    (status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_until<?)
    ORDER BY created_at LIMIT 20`, now, now);
  for (const item of pending) {
    await withInboxLock(env, now, async () => {
    if(!managerTestRecipientAllowed(item.recipient,item.channel,env)) {
      await statement(env,`UPDATE manager_outbox SET status='cancelled',last_error='outside_test_allowlist' WHERE id=?`,item.id).run();
      return;
    }
    if(env.MANAGER_SEND_NOT_BEFORE&&(!Number.isFinite(Date.parse(env.MANAGER_SEND_NOT_BEFORE))||Date.parse(item.created_at)<Date.parse(env.MANAGER_SEND_NOT_BEFORE))) {
      await statement(env,`UPDATE manager_outbox SET status='cancelled',last_error='before_test_cutover' WHERE id=?`,item.id).run();
      return;
    }
    if(item.channel==='customer'&&item.recipient.startsWith('manual:')) {
      await statement(env,`UPDATE manager_outbox SET status='cancelled',last_error='manual_order_no_line_recipient' WHERE id=?`,item.id).run();
      return;
    }
    if (item.first_attempt_at && Date.parse(now) - Date.parse(item.first_attempt_at) >= 23 * 3600_000) {
      await statement(env, `UPDATE manager_outbox SET status='uncertain',last_error='retry_window_expired' WHERE id=? AND status IN ('pending','sending')`, item.id).run();
      return;
    }
    // Check a draft's version immediately before its first attempt, not only at approval.
    if (item.draft_id && !item.first_attempt_at) {
      const draft = await first(env, `SELECT d.*,o.revision FROM manager_drafts d LEFT JOIN manager_orders o ON o.id=d.order_id WHERE d.id=?`, item.draft_id);
      const incoming = draft ? await first(env, `SELECT id FROM manager_events WHERE customer_id=? AND direction='customer' AND processed_at IS NULL LIMIT 1`, draft.customer_id) : null;
      if (incoming) return;
      if (!draft || draft.status !== 'approved' || (draft.order_id && draft.revision !== draft.base_revision)) {
        await env.DB.batch([
          statement(env, `UPDATE manager_outbox SET status='cancelled',last_error='stale_approval' WHERE id=? AND first_attempt_at IS NULL`, item.id),
          statement(env, `UPDATE manager_drafts SET status='stale' WHERE id=? AND status='approved'`, item.draft_id),
        ]);
        return;
      }
    }
    const token = item.channel === 'owner' ? env.LINE_CHANNEL_ACCESS_TOKEN : env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) return;
    const leaseUntil = iso(Date.parse(now) + 60_000);
    const claim = await statement(env, `UPDATE manager_outbox SET status='sending',lease_until=?,attempts=attempts+1,
      first_attempt_at=COALESCE(first_attempt_at,?) WHERE id=? AND
      ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_until<?))`, leaseUntil, now, item.id, now, now).run();
    if (!claim.meta.changes) return;
    let accepted = false, status = null;
    try {
      const response = await fetcher('https://api.line.me/v2/bot/message/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Line-Retry-Key': item.retry_key },
        body: JSON.stringify({ to: item.recipient, messages: [{ type: 'text', text: item.text }] }),
        signal: AbortSignal.timeout(15_000),
      });
      status = response.status;
      accepted = response.ok || (status === 409 && Boolean(response.headers.get('x-line-accepted-request-id')));
    } catch { /* same payload and retry key will be used after the lease/backoff */ }
    if (accepted) {
      const done = [statement(env, `UPDATE manager_outbox SET status='sent',sent_at=?,lease_until=NULL,last_error=NULL WHERE id=?`, now, item.id)];
      if (item.draft_id) {
        done.push(statement(env, `UPDATE manager_drafts SET status='sent' WHERE id=?`, item.draft_id));
        done.push(statement(env, `UPDATE manager_questions SET sent_at=? WHERE draft_id=?`, now, item.draft_id));
        done.push(statement(env, `UPDATE manager_tasks SET status='done',completed_at=? WHERE id=?`, now, `reply:${item.draft_id}`));
        done.push(statement(env, `INSERT OR IGNORE INTO manager_events
          (id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at)
          SELECT ?,customer_id,order_id,'assistant',?,?,?,? FROM manager_drafts WHERE id=?`,
        `sent:${item.id}`, item.text, now, now, now, item.draft_id));
      }
      await env.DB.batch(done);
    } else {
      const retryable = status === null || status >= 500;
      await statement(env, `UPDATE manager_outbox SET status=?,next_attempt_at=?,lease_until=NULL,last_error=? WHERE id=?`,
        retryable ? 'pending' : 'failed', iso(Date.parse(now) + Math.min(3600_000, 30_000 * 2 ** Math.min(item.attempts, 7))),
        status === null ? 'network_or_timeout' : `http_${status}`, item.id).run();
    }
    });
  }
}

export async function monitorManagerTasks(env, now = iso()) {
  const local = japanDateTime(now);
  if (!reminderWindow(now, await rows(env, 'SELECT date,status,open_time,close_time FROM business_schedule WHERE date=?', local.date))) return;
  const overdue = await rows(env, `SELECT t.*,o.title,
      (SELECT value_text FROM manager_fields WHERE order_id=o.id AND field_key='customer_name') AS customer_name,
      (SELECT value_text FROM manager_fields WHERE order_id=o.id AND field_key='receive_date') AS receive_date,
      (SELECT value_text FROM manager_fields WHERE order_id=o.id AND field_key='quantity') AS quantity,
      (SELECT reasons_json FROM manager_drafts WHERE id=substr(t.id,7)) AS reasons_json
    FROM manager_tasks t LEFT JOIN manager_orders o ON o.id=t.order_id
    WHERE t.status='open' AND t.due_at<=?
    AND (t.last_notified_at IS NULL OR date(t.last_notified_at,'+9 hours')<?)
    AND (?='' OR t.created_at>=?) ORDER BY t.due_at LIMIT 20`, now,local.date,env.MANAGER_SEND_NOT_BEFORE||'',env.MANAGER_SEND_NOT_BEFORE||'');
  if (!overdue.length || !owners(env).length) return;
  const text = `店長、確認をお願いします😊\n以下の注文で、お客様へのご案内が止まっています。\n\n${overdue.map(reminderOrderText).join('\n\n')}\n\n「返信待ち」と送ると、注文ごとの確認点を見て番号で選べます。`;
  const key = `due:${local.date}:${overdue.map(task => task.id).sort().join(':')}`;
  await env.DB.batch([
    ...ownerMessages(env, key, text, now),
    ...overdue.map(t => statement(env, `UPDATE manager_tasks SET last_notified_at=? WHERE id=?
      AND (last_notified_at IS NULL OR date(last_notified_at,'+9 hours')<?)`, now, t.id, local.date)),
  ]);
}

export async function runManagerMaintenance(env, now = iso()) {
  await drainManagerInbox(env, now);
  await monitorManagerTasks(env, now);
  await flushManagerOutbox(env, now);
}

export async function handleManagerCommand(text, actor, env, now = iso()) {
  // api:admin is used only by the authenticated HTTP adapter, never from LINE input.
  const appOwners=(env.MANAGER_APP_USER_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
  if (!owners(env).includes(actor) && !appOwners.includes(actor) && actor !== 'api:admin') return null;
  let result = null;
  const acquired = await withInboxLock(env, now, async () => { result = await executeManagerCommand(text, actor, env, now); });
  return acquired ? managerFriendlyText(result) : '受信内容を整理中です。少し待ってから同じ操作をお願いします。';
}

async function executeManagerCommand(text, actor, env, now) {
  if (/^(?:運用確認|改善状況)$/u.test(text.trim())) {
    return formatOperationalMetrics(await getOperationalMetrics(env,{since:iso(Date.parse(now)-7*86400_000),until:now}));
  }
  const loadMatch=text.match(/^負荷確認\s+(\d{4}-\d{2}-\d{2})$/u);
  if(loadMatch) {
    const load=await getCapacitySummary(env,loadMatch[1]);
    if(!load.ok)return capacityMessage(load.reason);
    return `${loadMatch[1]}の受付枠\n制作：${load.used_production_minutes}／${load.production_minutes}分\n配達：${load.used_delivery_count}／${load.delivery_count}件\n注文：${load.used_order_count}／${load.order_count}件\n未登録の電話・店頭注文は集計に含まれません。`;
  }
  const multiCapacity=text.match(/^受注枠\s+(M[A-F0-9]{16})\s+(\[[\s\S]*\])$/iu);
  if(multiCapacity) {
    let requirements;try{requirements=JSON.parse(multiCapacity[2]);}catch{return '受付枠の入力形式を確認してください。';}
    const invalid=validateCapacityRequirements(requirements);
    if(invalid)return capacityMessage(invalid);
    const order=await first(env,`SELECT * FROM manager_orders WHERE id=? AND status='open'`,multiCapacity[1].toUpperCase());
    if(!order)return '進行中のカルテがありません。';
    const result=await reserveOrderCapacity(env,order.id,order.revision,requirements,now);
    if(!result.ok)return capacityMessage(result.reason);
    await statement(env,`INSERT INTO manager_audit(order_id,actor,action,detail,created_at) VALUES (?,?,'capacity.reserved',?,?)`,order.id,actor,JSON.stringify({revision:order.revision,requirements}),now).run();
    return '指定した全日程の制作・配達・注文枠をまとめて確保しました。価格や注文確定の承認ではありません。';
  }
  // Capacity is explicit owner evidence, never guessed from budget or opening hours.
  let capacityMatch=text.match(/^(受付上限|受注枠)\s+(?:(M[A-F0-9]{16})\s+)?(\d{4}-\d{2}-\d{2})\s+(\d+)\s+(\d+)\s+(\d+)$/iu);
  if(capacityMatch) {
    const [,action,orderId,date,minutes,deliveries,ordersCount]=capacityMatch;
    const requirement={date,production_minutes:Number(minutes),delivery_count:Number(deliveries),order_count:Number(ordersCount)};
    const invalid=validateCapacityRequirements([action==='受付上限'&&Object.values(requirement).slice(1).every(x=>x===0)?{...requirement,order_count:1}:requirement]);
    if(invalid)return capacityMessage(invalid);
    if(action==='受付上限') {
      if(orderId)return '受付上限にはカルテ番号は不要です。';
      const used=await getCapacitySummary(env,date);
      if(used.ok&&(requirement.production_minutes<used.used_production_minutes||requirement.delivery_count<used.used_delivery_count||requirement.order_count<used.used_order_count))return '予約済みの作業量より小さい上限には変更できません。';
      await statement(env,`INSERT INTO manager_capacity_limits(date,production_minutes,delivery_count,order_count,updated_by,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET production_minutes=excluded.production_minutes,delivery_count=excluded.delivery_count,order_count=excluded.order_count,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,date,requirement.production_minutes,requirement.delivery_count,requirement.order_count,actor,now).run();
      return `${date}の受付上限を記録しました。制作${minutes}分・配達${deliveries}件・注文${ordersCount}件です。`;
    }
    if(!orderId)return '受注枠はカルテ番号・日付・制作分数・配達件数・注文件数を指定してください。';
    const order=await first(env,`SELECT * FROM manager_orders WHERE id=? AND status='open'`,orderId.toUpperCase());
    if(!order)return '進行中のカルテがありません。';
    const existing=await rows(env,`SELECT date,production_minutes,delivery_count,order_count FROM manager_capacity_reservations WHERE order_id=? AND date<>?`,order.id,date);
    const result=await reserveOrderCapacity(env,order.id,order.revision,[...existing,requirement],now);
    if(!result.ok)return capacityMessage(result.reason);
    await statement(env,`INSERT INTO manager_audit(order_id,actor,action,detail,created_at) VALUES (?,?,'capacity.reserved',?,?)`,order.id,actor,JSON.stringify({revision:order.revision,requirements:[...existing,requirement]}),now).run();
    return '制作・配達・注文の枠を確保しました。価格や注文確定の承認ではありません。';
  }
  if(/^(受付上限|受注枠)(?:\s|$)/u.test(text))return 'その日に制作できる時間と、配達・注文の件数を教えてください。\n例：受付上限 2026-10-10 480 3 8\n（10月10日、制作480分・配達3件・注文8件）\n注文ごとの作業枠は、店長アプリで確認してください。';
  const numericInput = String(text).trim().match(/^([0-9０-９]{1,2})([\s\S]*)$/u);
  // Normalize only the operation number; preserve the customer's proposed reply verbatim.
  const numbered = numericInput ? [numericInput[0], numericInput[1].normalize('NFKC'), numericInput[2].trim()] : null;
  if (numbered) {
    const selection = await first(env, 'SELECT * FROM manager_reply_selection WHERE actor=?', actor);
    if (selection && selection.expires_at <= now) {
      await statement(env, 'DELETE FROM manager_reply_selection WHERE actor=?', actor).run();
      return '選択の有効時間が切れました。まだ送信していません。「返信待ち」で選び直してください。';
    }
    if(selection?.stage==='completed')return 'この操作は確認済みです。別の操作は「案件一覧」または「返信待ち」で選び直してください。';
    // Never infer approval from a number left over from another dialog or an old notification.
    if(!selection)return executeManagerCommand('返信待ち',actor,env,now);
    if (selection?.stage === 'order_choose') {
      const entry = JSON.parse(selection.draft_ids_json)[Number(numbered[1])-1];
      if (!entry || numbered[2]) return '一覧の番号だけで注文を選んでください。まだ変更しません。';
      const order = await first(env,`SELECT * FROM manager_orders WHERE id=? AND status='open'`,entry.id);
      if (!order || order.revision !== entry.revision || !managerTestRecipientAllowed(order.customer_id,'customer',env) && !order.customer_id.startsWith('manual:')) return '注文内容が変わりました。「案件一覧」で選び直してください。';
      await saveMenu(env,actor,'order_action',[entry],now);
      return `【${entry.label}】\n何を確認・記録しますか？\n${ORDER_ACTIONS.map((a,i)=>`${i+1}：${a}`).join('\n')}\n番号で選んでください。`;
    }
    if (selection?.stage === 'order_action') {
      const entry = JSON.parse(selection.draft_ids_json)[0];
      const action = ORDER_ACTIONS[Number(numbered[1])-1];
      if (!action || numbered[2]) return '表示された操作の番号だけで選んでください。';
      const order=await first(env,`SELECT * FROM manager_orders WHERE id=? AND status='open'`,entry.id);
      if (!order || order.revision!==entry.revision) return '注文内容が変わりました。「案件一覧」で選び直してください。';
      if (action==='変更確認') {
        const changes=await rows(env,`SELECT * FROM manager_changes WHERE order_id=? AND status='pending' ORDER BY id`,order.id);
        if(!changes.length)return 'この注文に変更の確認待ちはありません。';
        await saveMenu(env,actor,'change_choose',changes.map(c=>({...entry,changeId:c.id,field:c.field_key,old:c.old_value,value:c.new_value})),now);
        return `【${entry.label}・どの変更ですか？】\n${changes.map((c,i)=>`${i+1}：${LABELS[c.field_key]||'注文内容'}\n変更前：${c.old_value}\n変更後：${c.new_value}`).join('\n\n')}\n番号で選んでください。まだ変更しません。`;
      }
      if(['返信作成','電話メモ'].includes(action)){
        await saveMenu(env,actor,'order_text',[{...entry,action}],now);
        return action==='返信作成'?'お客様への返信案を「1 本文」の形で送ってください。まだお客様へは送信しません。':'電話・店頭で決まった内容を「1 内容」の形で教えてください。以前の返信案は見直し待ちになります。';
      }
      if (!['カルテ','過去情報'].includes(action)) {
        await saveMenu(env,actor,'order_confirm',[{...entry,action}],now);
        return `【${entry.label}】\n「${action}」を記録してよいですか？\n1：記録する\n2：戻る\nまだ変更していません。`;
      }
      return executeManagerCommand(`${action} ${entry.id}`,actor,env,now);
    }
    if(selection?.stage==='order_text'){
      const entry=JSON.parse(selection.draft_ids_json)[0];
      if(numbered[1]!=='1'||!numbered[2])return '「1 内容」の形で文章を入力してください。';
      const order=await first(env,`SELECT * FROM manager_orders WHERE id=? AND status='open'`,entry.id);
      if(!order||order.revision!==entry.revision)return '注文内容が変わりました。「案件一覧」で選び直してください。';
      await saveMenu(env,actor,'completed',[],now);
      return executeManagerCommand(`${entry.action} ${entry.id} ${numbered[2]}`,actor,env,now);
    }
    if(selection?.stage==='change_choose'){
      const entry=JSON.parse(selection.draft_ids_json)[Number(numbered[1])-1];
      if(!entry||numbered[2])return '変更一覧の番号だけで選んでください。';
      await saveMenu(env,actor,'change_confirm',[entry],now);
      return `【${entry.label}】\n${LABELS[entry.field]||'注文内容'}を変更しますか？\n変更前：${entry.old}\n変更後：${entry.value}\n\n1：変更してよい\n2：変更できない\n3：保留`;
    }
    if(selection?.stage==='change_confirm'){
      const entry=JSON.parse(selection.draft_ids_json)[0];
      if(numbered[2]||!['1','2','3'].includes(numbered[1]))return '1：変更してよい／2：変更できない／3：保留、から番号で回答してください。';
      if(numbered[1]==='3')return '変更は保留しました。まだ注文内容は変えていません。';
      const order=await first(env,`SELECT * FROM manager_orders WHERE id=? AND status='open'`,entry.id);
      await saveMenu(env,actor,'completed',[],now);
      if(!order||order.revision!==entry.revision)return '注文内容が変わりました。「案件一覧」で最新の変更を確認してください。';
      return executeManagerCommand(`${numbered[1]==='1'?'変更承認':'変更却下'} ${entry.changeId}`,actor,env,now);
    }
    if (selection?.stage === 'order_confirm') {
      const entry=JSON.parse(selection.draft_ids_json)[0];
      if(numbered[2] || !['1','2'].includes(numbered[1]))return '1：記録する／2：戻る、の番号だけで回答してください。';
      if(numbered[1]==='2'){await saveMenu(env,actor,'order_action',[entry],now);return `【${entry.label}】\n${ORDER_ACTIONS.map((a,i)=>`${i+1}：${a}`).join('\n')}`;}
      const order=await first(env,`SELECT * FROM manager_orders WHERE id=? AND status='open'`,entry.id);
      await saveMenu(env,actor,'completed',[],now);
      if(!order || order.revision!==entry.revision)return '注文内容が変わりました。まだ変更していません。「案件一覧」で選び直してください。';
      return executeManagerCommand(`${entry.action} ${entry.id}`,actor,env,now);
    }
    if (selection?.stage === 'choose') {
      const selectedId = JSON.parse(selection.draft_ids_json)[Number(numbered[1])-1];
      if (!selectedId || numbered[2]) return '一覧にある注文の番号だけで選んでください。まだ送信しません。';
      const draft = await first(env, `SELECT d.*,o.revision,o.title FROM manager_drafts d LEFT JOIN manager_orders o ON o.id=d.order_id WHERE d.id=?`, selectedId);
      if (!draft || !['pending','held'].includes(draft.status) || (draft.order_id && draft.revision !== draft.base_revision)) {
        await statement(env, 'DELETE FROM manager_reply_selection WHERE actor=?', actor).run();
        return 'この返信案は更新または処理されています。「返信待ち」で最新の案を選んでください。';
      }
      await statement(env, `UPDATE manager_reply_selection SET stage='action',draft_ids_json=?,expires_at=? WHERE actor=?`, JSON.stringify([draft.id]), iso(Date.parse(now)+600000), actor).run();
      return `【選んだ注文】${draft.title || '注文の振分確認'}\n【返信案】\n${draft.message}\n\nまだ送信していません。${replyActions}`;
    }
    const candidates = selection?.stage === 'action' ? JSON.parse(selection.draft_ids_json).map(id => ({id})) : (await rows(env, `SELECT d.id,d.customer_id FROM manager_drafts d LEFT JOIN manager_orders o ON o.id=d.order_id
      WHERE d.status IN ('pending','held') AND (d.order_id IS NULL OR o.revision=d.base_revision)
      AND COALESCE(o.title,'') NOT LIKE '%架空サンプル%'
      ORDER BY d.created_at DESC`)).filter(d => !d.customer_id.startsWith('manual:') && managerTestRecipientAllowed(d.customer_id,'customer',env)).slice(0,2);
    if (!candidates.length) return '回答待ちの返信案はありません。新しい通知をご確認ください。';
    if (candidates.length > 1) return executeManagerCommand('返信待ち', actor, env, now);
    if (!['1','2','3'].includes(numbered[1])) return `操作は1〜3でご回答ください。${replyActions}`;
    if (numbered[1] === '2' && !numbered[2]) return '「2 修正した文章」の形で、お客様へ送る全文を入力してください。まだ送信しません。';
    if (numbered[1] !== '2' && numbered[2]) return '送信は「1」、保留は「3」だけでご回答ください。文章を変更する場合は「2 修正した文章」です。まだ送信しません。';
    const result = await executeManagerCommand(`${{'1':'承認送信','2':'返信修正','3':'返信保留'}[numbered[1]]} ${candidates[0].id}${numbered[2] ? ` ${numbered[2]}` : ''}`, actor, env, now);
    // Keep the selected target even after approval: a repeated number must never approve another order.
    await statement(env, `INSERT INTO manager_reply_selection(actor,stage,draft_ids_json,expires_at) VALUES (?,'action',?,?) ON CONFLICT(actor) DO UPDATE SET stage='action',draft_ids_json=excluded.draft_ids_json,expires_at=excluded.expires_at`, actor, JSON.stringify([candidates[0].id]), iso(Date.parse(now)+600000)).run();
    return result;
  }
  if (/^(?:返信待ち|確認待ち一覧|受注判断)$/u.test(text)) {
    const drafts = (await rows(env, `SELECT d.id,d.customer_id,d.reasons_json,o.title,
      (SELECT value_text FROM manager_fields WHERE order_id=d.order_id AND field_key='customer_name') AS name,
      (SELECT value_text FROM manager_fields WHERE order_id=d.order_id AND field_key='receive_date') AS receive_date,
      (SELECT value_text FROM manager_fields WHERE order_id=d.order_id AND field_key='quantity') AS quantity,
      (SELECT value_text FROM manager_fields WHERE order_id=d.order_id AND field_key='fulfillment_method') AS method
      FROM manager_drafts d LEFT JOIN manager_orders o ON o.id=d.order_id
      WHERE d.status IN ('pending','held') AND (d.order_id IS NULL OR o.revision=d.base_revision)
      AND COALESCE(o.title,'') NOT LIKE '%架空サンプル%'
      ORDER BY d.created_at DESC,d.id`)).filter(d => !d.customer_id.startsWith('manual:') && managerTestRecipientAllowed(d.customer_id,'customer',env)).slice(0,30);
    if (!drafts.length) return '回答待ちの返信案はありません。';
    await statement(env, `INSERT INTO manager_reply_selection(actor,stage,draft_ids_json,expires_at) VALUES (?,'choose',?,?) ON CONFLICT(actor) DO UPDATE SET stage='choose',draft_ids_json=excluded.draft_ids_json,expires_at=excluded.expires_at`, actor, JSON.stringify(drafts.map(d => d.id)), iso(Date.parse(now)+600000)).run();
    return `【確認待ち・どの注文ですか？】\n${drafts.map((d,i) => {
      const date = String(d.receive_date || '').replace(/^\d{4}-(\d{2})-(\d{2})$/u,(_,m,day)=>`${Number(m)}月${Number(day)}日`);
      const reasons = JSON.parse(d.reasons_json || '[]').map(r => REASON_LABELS[r] || (/^[a-z_]+$/u.test(r) ? '注文内容の確認' : r));
      return `${i+1}：${[d.name,d.title || '注文の振分確認',d.quantity ? `${d.quantity}個` : '',date,d.method].filter(Boolean).join('／')}\n確認：${[...new Set(reasons)].join('／') || 'お客様への返信内容'}`;
    }).join('\n\n')}\n\n番号で返信案を確認できます。選ぶだけでは送信しません。`;
  }
  const historyRequest=parseHistoryRequest(text);
  if(historyRequest) {
    if(historyRequest.detailId)return (await getHistoryDetail(historyRequest.detailId,env))||'指定の過去カルテはありません。';
    if(historyRequest.orderId) {
      const current=await first(env,`SELECT customer_id FROM manager_orders WHERE id=?`,historyRequest.orderId);
      if(!current)return '注文カルテがありません。';
      return (await formatCustomerHistory(current.customer_id,env,historyRequest.orderId))||'本人に紐付く過去カルテはまだありません。名前や電話で候補を検索して本人を確認してください。';
    }
    if(!historyRequest.query)return 'お名前・電話番号・商品などを添えてください。例：山田さんの過去の注文を確認したい';
    const found=await searchHistory(historyRequest.query,env);
    if(!found.records.length)return '一致する保存済み過去カルテはありません。別の名前・電話・商品で確認してください。全トーク履歴を網羅した資料ではありません。';
    return `【過去情報の検索候補】本人はまだ断定していません。\n当時の価格・仕様・住所は現在の条件ではありません。\n\n`+found.records.map((r,i)=>`${i+1}. ${r.label}［${r.reviewStatus}］\n${r.summary}\n履歴詳細 ${r.id}`).join('\n\n')+(found.hasMore?'\nほかにも候補があります。名前や電話で絞り込んでください。':'');
  }
  if (['案件一覧','カルテ','最新カルテ','注文確認'].includes(text.trim())) {
    const orders = await rows(env, `SELECT o.*,(SELECT COUNT(*) FROM manager_tasks t WHERE t.order_id=o.id AND t.status='open') AS tasks
      FROM manager_orders o WHERE status='open' ORDER BY updated_at DESC LIMIT 30`);
    const visible = orders.filter(o => !o.title.includes('架空サンプル') && (o.customer_id.startsWith('manual:') || managerTestRecipientAllowed(o.customer_id,'customer',env)));
    if(!visible.length)return '進行中の注文はありません。';
    const entries=[];
    for(const o of visible){const name=await first(env,`SELECT value_text FROM manager_fields WHERE order_id=? AND field_key='customer_name'`,o.id);entries.push({id:o.id,revision:o.revision,label:[name?.value_text,o.title].filter(Boolean).join('／')});}
    await saveMenu(env,actor,'order_choose',entries,now);
    return `【どの注文を確認しますか？】\n${entries.map((e,i)=>`${i+1}：${e.label}`).join('\n\n')}\n\n番号で選んでください。選ぶだけでは変更しません。\n返信の確認は「返信待ち」で選べます。`;
  }
  if (text === '統括状況') {
    const inbox = await first(env, `SELECT COUNT(*) AS n FROM manager_events WHERE processed_at IS NULL`);
    const delivery = await rows(env, `SELECT status,COUNT(*) AS n FROM manager_outbox GROUP BY status`);
    return `【対応状況】\n整理中のご連絡：${inbox.n}件\n返信：${delivery.map(x => `${STATUS_LABELS[x.status]||'確認が必要'} ${x.n}件`).join('／')}\n${env.MANAGER_SEND_PAUSED === 'true' ? '現在は返信を止めています' : '店長の確認後に返信します'}\n注文を見る：「案件一覧」\n返信を確認：「返信待ち」`;
  }
  let match = text.match(/^カルテ\s+(M[A-F0-9]{16})$/iu);
  if (match) {
    const order = await first(env, `SELECT * FROM manager_orders WHERE id=?`, match[1].toUpperCase());
    if (!order) return '該当カルテがありません。';
    const fields = await rows(env, `SELECT * FROM manager_fields WHERE order_id=?`, order.id);
    const items = await rows(env, `SELECT * FROM manager_order_items WHERE order_id=? ORDER BY label`, order.id);
    const drafts = await rows(env, `SELECT id,message FROM manager_drafts WHERE order_id=? AND status='pending'`, order.id);
    const tasks = await rows(env, `SELECT detail,due_at FROM manager_tasks WHERE order_id=? AND status='open'`, order.id);
    const ownerNotes=await rows(env,`SELECT text,occurred_at FROM manager_events WHERE order_id=? AND direction='owner' ORDER BY occurred_at DESC,id DESC LIMIT 3`,order.id);
    return `【${order.title}】\n制作：${STATUS_LABELS[order.production_status]||'確認が必要'}／受渡：${STATUS_LABELS[order.fulfillment_status]||'確認が必要'}／支払：${STATUS_LABELS[order.payment_status]||'確認が必要'}\n`
      + fields.filter(f=>LABELS[f.field_key]).map(f => `${LABELS[f.field_key]}：${f.value_text}${f.status==='confirmed'?'':'（未確認）'}`).join('\n')
      + '\n【個別商品】\n' + items.map(i => `${i.label}：${i.specification}`).join('\n')
      + '\n【次の対応】\n' + tasks.map(t => `${t.detail} ${t.due_at}`).join('\n')
      + '\n【最近の店長記録】\n' + ownerNotes.map(n=>`${n.occurred_at}：${n.text}`).join('\n')
      + '\n【返信案】\n' + drafts.map(d => d.message).join('\n\n')+'\n\n返信の確認は「返信待ち」、次の操作は番号で選べます。';
  }
  match = text.match(/^(承認送信|返信修正|返信保留|返信取消)\s+(D[A-F0-9]{16})(?:\s+([\s\S]+))?$/iu);
  if (match) {
    const draft = await first(env, `SELECT d.*,o.revision FROM manager_drafts d LEFT JOIN manager_orders o ON o.id=d.order_id WHERE d.id=?`, match[2].toUpperCase());
    if (!draft || !['pending','held'].includes(draft.status)) return 'この返信案は処理済み、または古い版です。カルテを確認してください。';
    if(match[1]==='返信取消') {
      await env.DB.batch([
        statement(env,`UPDATE manager_drafts SET status='stale' WHERE id=?`,draft.id),
        statement(env,`UPDATE manager_tasks SET status='cancelled',completed_at=? WHERE id=?`,now,`reply:${draft.id}`),
      ]);
      return '不要な返信案を取り消しました。';
    }
    if (draft.order_id && draft.revision !== draft.base_revision) return '注文内容が更新されています。最新の返信案を確認してください。';
    if (match[1] === '返信修正') {
      if (!match[3] || match[3].length > 4900) return '修正する本文を4900文字以内で入力してください。';
      await statement(env, `UPDATE manager_drafts SET message=?,status='pending' WHERE id=? AND status IN ('pending','held')`, match[3], draft.id).run();
      return `返信案を更新しました。\n${match[3]}\n\n1：送信\n2 修正した文章：再修正\n3：保留\nまだ送信していません。`;
    }
    if (match[1] === '返信保留') {
      await statement(env, `UPDATE manager_drafts SET status='held' WHERE id=? AND status='pending'`, draft.id).run();
      return '返信を保留しました。対応期限は引き続き管理します。';
    }
    if (draft.order_id) {
      const manualReview=await first(env,`SELECT id FROM manager_tasks WHERE order_id=? AND kind='manual_review' AND status='open' LIMIT 1`,draft.order_id);
      if(manualReview)return '電話・店頭での対応後の確認が必要です。「案件一覧」で注文を選び、最新の内容を確認してから「対応確認」を選んでください。返信と受注確定は別の判断です。';
      const changes = await first(env, `SELECT COUNT(*) AS n FROM manager_changes WHERE order_id=? AND status='pending'`, draft.order_id);
      if (changes.n) return '注文内容の変更が確認待ちです。「案件一覧」で注文を選び、「変更確認」で判断してください。';
    }
    if(draft.customer_id.startsWith('manual:'))return '電話・来店のカルテはLINE送信先に接続していません。電話または店頭でご案内ください。';
    const incoming = await first(env, `SELECT id FROM manager_events WHERE customer_id=? AND direction='customer' AND processed_at IS NULL LIMIT 1`, draft.customer_id);
    if (incoming) return '新しいお客様の連絡を整理中です。最新内容を確認してから返信を承認してください。';
    await env.DB.batch([
      statement(env, `UPDATE manager_drafts SET status='approved',approved_by=?,approved_at=? WHERE id=? AND status IN ('pending','held')`, actor, now, draft.id),
      outboxStatement(env, `customer:${draft.id}`, draft.customer_id, 'customer', draft.message, now, draft.id),
      statement(env, `INSERT INTO manager_audit(order_id,actor,action,detail,created_at) VALUES (?,?,'reply.approved',?,?)`, draft.order_id, actor, JSON.stringify({ draftId:draft.id, scope:'reply_only', revision:draft.base_revision, message:draft.message }), now),
    ]);
    return '承認した文面を送信待ちに登録しました。実際の送信結果は「統括状況」で確認できます。';
  }
  match = text.match(/^(変更承認|変更却下)\s+(C[A-F0-9]{16})$/iu);
  if (match) {
    const change = await first(env, `SELECT c.*,o.revision FROM manager_changes c JOIN manager_orders o ON o.id=c.order_id WHERE c.id=?`, match[2].toUpperCase());
    if (!change || change.status !== 'pending') return 'この変更は処理済み、または存在しません。';
    const current = await first(env, `SELECT value_text FROM manager_fields WHERE order_id=? AND field_key=?`, change.order_id, change.field_key);
    if (current?.value_text !== change.old_value) return '元の値が更新されています。最新のカルテと変更候補を確認してください。';
    const approved = match[1] === '変更承認';
    const commands = [statement(env, `UPDATE manager_changes SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?`, approved ? 'approved' : 'rejected', actor, now, change.id)];
    if (approved) commands.push(statement(env, `UPDATE manager_fields SET value_text=?,status='confirmed',confirmed_by=?,confirmed_at=?,source_event_id=?,source_occurred_at=(SELECT occurred_at FROM manager_events WHERE id=?) WHERE order_id=? AND field_key=?`, change.new_value, actor, now, change.source_event_id, change.source_event_id, change.order_id, change.field_key));
    commands.push(statement(env, `UPDATE manager_orders SET revision=revision+1,updated_at=? WHERE id=?`, now, change.order_id));
    commands.push(statement(env, `UPDATE manager_drafts SET status='stale' WHERE order_id=? AND status IN ('pending','held')`, change.order_id));
    commands.push(statement(env, `INSERT INTO manager_audit(order_id,actor,action,detail,created_at) VALUES (?,?,'change.reviewed',?,?)`, change.order_id, actor, JSON.stringify({ id: change.id, approved }), now));
    await env.DB.batch(commands);
    return `変更を${approved ? '承認' : '見送り'}ました。お客様への返信はまだ送っていません。「案件一覧」で注文を選び、返信案を作成できます。`;
  }
  match = text.match(/^返信作成\s+(M[A-F0-9]{16})\s+([\s\S]+)$/iu);
  if (match) {
    const order = await first(env, `SELECT * FROM manager_orders WHERE id=? AND status='open'`, match[1].toUpperCase());
    if (!order) return '進行中のカルテがありません。';
    if (match[2].length > 4900) return '本文は4900文字以内で入力してください。';
    const eventId = id('O'), draftId = id('D');
    await env.DB.batch([
      statement(env, `INSERT INTO manager_events(id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at) VALUES (?,?,?,'owner',?,?,?,?)`, eventId, order.customer_id, order.id, match[2], now, now, now),
      statement(env, `INSERT INTO manager_drafts(id,order_id,customer_id,source_event_id,base_revision,message,created_at) VALUES (?,?,?,?,?,?,?)`, draftId, order.id, order.customer_id, eventId, order.revision, match[2], now),
      statement(env, `INSERT INTO manager_tasks(id,order_id,kind,detail,due_at,created_at) VALUES (?,?,'reply',?,?,?)`, `reply:${draftId}`, order.id, `返信確認 ${draftId}`, iso(Date.parse(now) + 3600_000), now),
    ]);
    return `${match[2]}\n\n返信案を保存しました。まだ送っていません。「返信待ち」で番号から確認できます。`;
  }
  match = text.match(/^振分\s+(\S+)\s+(M[A-F0-9]{16})$/iu);
  if (match) {
    const event = await first(env, `SELECT * FROM manager_events WHERE id=? AND direction='customer'`, match[1]);
    const order = await first(env, `SELECT * FROM manager_orders WHERE id=? AND status='open'`, match[2].toUpperCase());
    if (!event || !order || event.customer_id !== order.customer_id) return '同じお客様の受信と進行中カルテを指定してください。';
    if (event.order_id) return 'すでに紐付いた受信です。重複反映を避けるため変更していません。';
    await env.DB.batch([
      statement(env, `INSERT OR IGNORE INTO manager_events(id,customer_id,direction,text,occurred_at,received_at,processed_at)
        VALUES (?,?,'system',?,?,?,?)`, `routed:${event.id}`, event.customer_id, '振分前の返信案の記録', now, now, now),
      statement(env, `UPDATE manager_drafts SET status='stale',source_event_id=? WHERE source_event_id=? AND status IN ('pending','held','approved','sent')`, `routed:${event.id}`, event.id),
      statement(env, `UPDATE manager_events SET order_id=?,processed_at=NULL WHERE id=?`, order.id, event.id),
      statement(env, `UPDATE manager_tasks SET status='done',completed_at=? WHERE id=?`, now, `route:${event.id}`),
    ]);
    return '対象の注文に紐付け、再整理待ちにしました。';
  }
  match = text.match(/^項目確定\s+(M[A-F0-9]{16})\s+(\S+)\s*[:：]\s*([\s\S]+)$/iu);
  if (match) {
    const order = await first(env, `SELECT * FROM manager_orders WHERE id=? AND status='open'`, match[1].toUpperCase());
    const key = Object.entries(LABELS).find(([k,v])=>k===match[2]||v===match[2])?.[0];
    if (!order || !key) return 'カルテ番号と項目名を確認してください。例：項目確定 M番号 予算：3000円';
    const eventId=id('O');let value=match[3].trim().slice(0,4000);
    if(['receive_date','use_date'].includes(key)) {
      value=resolveConversationDate(value,now);
      if(!value)return '実在する年月日で入力してください。例：2026-10-10';
    }
    if(key==='quantity'&&!/^[1-9]\d{0,4}$/.test(value))return '数量は1以上の数字で入力してください。';
    await env.DB.batch([
      statement(env,`INSERT INTO manager_events(id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at) VALUES (?,?,?,'owner',?,?,?,?)`,eventId,order.customer_id,order.id,text,now,now,now),
      statement(env,`INSERT INTO manager_fields(order_id,field_key,value_text,status,source_event_id,source_occurred_at,confirmed_by,confirmed_at)
        VALUES (?,?,?,'confirmed',?,?,?,?) ON CONFLICT(order_id,field_key) DO UPDATE SET value_text=excluded.value_text,status='confirmed',source_event_id=excluded.source_event_id,source_occurred_at=excluded.source_occurred_at,confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at`,order.id,key,value,eventId,now,actor,now),
      statement(env,`UPDATE manager_changes SET status='superseded',reviewed_by=?,reviewed_at=? WHERE order_id=? AND field_key=? AND status='pending'`,actor,now,order.id,key),
      statement(env,`UPDATE manager_orders SET revision=revision+1,updated_at=? WHERE id=?`,now,order.id),
      statement(env,`INSERT INTO manager_audit(order_id,actor,action,detail,created_at) VALUES (?,?,'field.confirmed',?,?)`,order.id,actor,JSON.stringify({key,value}),now),
    ]);
    return `${LABELS[key]}を店長確認済みとして保存しました。返信案は最新内容で確認してください。`;
  }
  match = text.match(/^(履歴紐付|履歴承認)\s+(M[A-F0-9]{16})\s+(legacy_[a-f0-9]{32})$/iu);
  if (match) {
    const order=await first(env,`SELECT * FROM manager_orders WHERE id=?`,match[2].toUpperCase());
    const imported=await first(env,`SELECT * FROM manager_imports WHERE id=?`,match[3]);
    if(!order||!imported) return 'カルテまたは取込資料がありません。';
    if(imported.linked_customer_id && imported.linked_customer_id!==order.customer_id) return '別のお客様へ紐付け済みの資料です。変更していません。';
    if(match[1]==='履歴紐付') {
      await statement(env,`UPDATE manager_imports SET linked_customer_id=?,linked_by=?,review_status='linked' WHERE id=?`,order.customer_id,actor,imported.id).run();
      return `【履歴の本人・内容確認】\n${imported.raw_text.slice(0,3500)}\n間違いがなければ：履歴承認 ${order.id} ${imported.id}`;
    }
    if(imported.review_status!=='linked' || imported.linked_customer_id!==order.customer_id) return '先に履歴紐付を行い、本文を確認してください。';
    await env.DB.batch([
      statement(env,`UPDATE manager_imports SET review_status='verified',linked_by=? WHERE id=?`,actor,imported.id),
      statement(env,`INSERT INTO manager_audit(order_id,actor,action,detail,created_at) VALUES (?,?,'history.verified',?,?)`,order.id,actor,imported.id,now),
    ]);
    return '本人に紐付く参考履歴として承認しました。今回の仕様・価格は別途確認します。';
  }
  match = text.match(/^(制作開始|完成|受渡完了|支払案内済み|支払確認待ち|支払完了|回収必要|回収完了|案件終了)\s+(M[A-F0-9]{16})$/iu);
  if (match) return lifecycle(match[1], match[2].toUpperCase(), actor, env, now);
  match = text.match(/^明細\s+(M[A-F0-9]{16})\s+([^\n：:]+)[：:]\s*([\s\S]+)$/iu);
  if (match) {
    const order = await first(env, `SELECT * FROM manager_orders WHERE id=? AND status='open'`, match[1].toUpperCase());
    if (!order) return '進行中のカルテがありません。';
    await env.DB.batch([
      statement(env, `INSERT INTO manager_order_items(id,order_id,label,specification,confirmed_by,updated_at) VALUES (?,?,?,?,?,?)`, id('I'), order.id, match[2].trim(), match[3], actor, now),
      statement(env, `UPDATE manager_orders SET revision=revision+1,updated_at=? WHERE id=?`, now, order.id),
      statement(env, `INSERT INTO manager_audit(order_id,actor,action,detail,created_at) VALUES (?,?,'item.recorded',?,?)`, order.id, actor, match[2], now),
    ]);
    return '個別商品明細を記録しました。名前・番号・表記は入力どおり保存しました。';
  }
  match = text.match(/^(?:電話メモ|店頭メモ|手動対応メモ)\s+(M[A-F0-9]{16})\s+([\s\S]+)$/iu);
  if (match) {
    const order = await first(env, `SELECT * FROM manager_orders WHERE id=?`, match[1].toUpperCase());
    if (!order) return 'カルテがありません。';
    if (!match[2].trim() || match[2].length > 4000) return '対応内容を4000文字以内で入力してください。';
    await env.DB.batch([
      statement(env, `INSERT INTO manager_events(id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at) VALUES (?,?,?,'owner',?,?,?,?)`, id('O'), order.customer_id, order.id, match[2], now, now, now),
      statement(env, `UPDATE manager_orders SET revision=revision+1,updated_at=? WHERE id=?`, now, order.id),
      statement(env, `UPDATE manager_outbox SET status='cancelled',last_error='manual_update_requires_review' WHERE draft_id IN (SELECT id FROM manager_drafts WHERE order_id=?) AND channel='customer' AND first_attempt_at IS NULL AND status='pending'`, order.id),
      statement(env, `UPDATE manager_drafts SET status='stale' WHERE order_id=? AND status IN ('pending','held','approved')`, order.id),
      statement(env, `UPDATE manager_tasks SET status='cancelled',completed_at=? WHERE order_id=? AND kind='reply' AND status='open'`, now, order.id),
      statement(env, `INSERT INTO manager_tasks(id,order_id,kind,detail,due_at,created_at) VALUES (?,?,'manual_review',?,?,?)`, id('T'), order.id, '手動対応後の最新内容と返信の必要性を確認', now, now),
      statement(env, `INSERT INTO manager_audit(order_id,actor,action,detail,created_at) VALUES (?,?,'manual_update.recorded',?,?)`, order.id, actor, JSON.stringify({ scope:'note_only', revision:order.revision+1 }), now),
    ]);
    return '店長メモを原文で残しました。以前の返信案と未送信の承認は取り消しました。「案件一覧」で注文を選び、最新内容を確認後「対応確認」を選んでください。送信を開始済みの文面は取り消せない場合があります。';
  }
  match=text.match(/^対応確認\s+(M[A-F0-9]{16})$/iu);
  if(match) {
    const order=await first(env,`SELECT * FROM manager_orders WHERE id=? AND status='open'`,match[1].toUpperCase());
    if(!order)return '進行中のカルテがありません。';
    const pending=await first(env,`SELECT id FROM manager_tasks WHERE order_id=? AND kind='manual_review' AND status='open' LIMIT 1`,order.id);
    if(!pending)return '手動対応後の確認はすでに記録済み、または確認待ちはありません。';
    const incoming=await first(env,`SELECT id FROM manager_events WHERE customer_id=? AND direction='customer' AND processed_at IS NULL LIMIT 1`,order.customer_id);
    if(incoming)return '新しいお客様の連絡を整理中です。最新内容を確認してから対応確認してください。';
    await env.DB.batch([
      statement(env,`UPDATE manager_tasks SET status='done',completed_at=? WHERE order_id=? AND kind='manual_review' AND status='open'`,now,order.id),
      statement(env,`INSERT INTO manager_audit(order_id,actor,action,detail,created_at) VALUES (?,?,'manual_update.reviewed',?,?)`,order.id,actor,JSON.stringify({scope:'latest_information_only',revision:order.revision}),now),
    ]);
    return '手動対応後の最新内容を確認済みとして記録しました。制作可否・価格・受注確定・返信送信は別の判断です。';
  }
  if (/^(?:送信|はい|確定|承認|受ける|難しい|確認|変更OK|顧客送信確認|最新カルテ|カルテ|お客様へ|制作開始|完成|受渡完了|支払完了)(?:\s|$)/u.test(text)) {
    return 'どの注文についてか、先に確認しましょう😊\n「案件一覧」で注文を番号から選べます。\nお客様への返信は「返信待ち」で確認できます。\n「はい」だけでは変更や送信はしません。';
  }
  return null;
}

async function lifecycle(action, orderId, actor, env, now) {
  const order = await first(env, `SELECT * FROM manager_orders WHERE id=? AND status='open'`, orderId);
  if (!order) return '進行中のカルテがありません。';
    if (action === '完成' && !['production','ready'].includes(order.production_status)) return '制作開始の確認がまだありません。注文項目を確認し、制作開始を記録してから完成に進めてください。';
    if (action === '制作開始' && order.production_status === 'ready') return '完成済みの注文です。制作開始へ戻す操作は実行しません。変更内容を確認してください。';
  const mapping = {
    制作開始: ['production_status','production'], 完成: ['production_status','ready'],
    受渡完了: ['fulfillment_status','fulfilled'], 支払案内済み: ['payment_status','instructed'],
    支払確認待ち: ['payment_status','awaiting_confirmation'], 支払完了: ['payment_status','paid'],
    回収必要: ['collection_status','pending'], 回収完了: ['collection_status','collected'],
  };
  if (action === '案件終了') {
    if (order.fulfillment_status !== 'fulfilled' || order.payment_status !== 'paid' || order.collection_status === 'pending') return '受渡し・入金・必要な回収が揃っていません。未完了項目を確認してください。';
    const pending = await first(env, `SELECT COUNT(*) AS n FROM manager_changes WHERE order_id=? AND status='pending'`, orderId);
    if (pending.n) return '変更判断待ちがあります。先に確認してください。';
    const openReplies=await first(env,`SELECT COUNT(*) AS n FROM manager_drafts WHERE order_id=? AND status IN ('pending','held','approved')`,orderId);
    if(openReplies.n) return '未送信・保留の返信案があります。送信または不要な返信を整理してから終了してください。';
    mapping.案件終了 = ['status','closed'];
  }
  if (action === '制作開始') {
    const manualReview=await first(env,`SELECT id FROM manager_tasks WHERE order_id=? AND kind='manual_review' AND status='open' LIMIT 1`,orderId);
    if(manualReview)return '電話・店頭での最新内容を確認するまで制作開始できません。「案件一覧」で注文を選び、「対応確認」で確認済みを記録してください。';
    const pending = await first(env, `SELECT COUNT(*) AS n FROM manager_changes WHERE order_id=? AND status='pending'`, orderId);
    if (pending.n) return '変更判断待ちがあります。確認が済むまで制作開始には進めません。';
    const detail=await rows(env,`SELECT field_key,value_text,status FROM manager_fields WHERE order_id=?`,orderId);
    const verified=Object.fromEntries(detail.map(f=>[f.field_key,f]));
    const required=['product_type','quantity','budget','receive_date','fulfillment_method'];
    const missing=required.filter(key=>verified[key]?.status!=='confirmed'||/未定/u.test(verified[key]?.value_text||''));
    if(missing.length) return `制作開始前に店長確認が必要です：${missing.map(k=>LABELS[k]).join('、')}\n項目確定 ${orderId} 項目名：内容`;
    const reserved=await rows(env,`SELECT date,revision,production_minutes,delivery_count,order_count FROM manager_capacity_reservations WHERE order_id=?`,orderId);
    if(!reserved.length)return '制作・配達の枠が未確認です。「受付上限」と「受注枠」を確認してから制作開始してください。';
    if(reserved.some(r=>r.revision!==order.revision))return '枠の確認後に注文内容が変わっています。最新の内容で「受注枠」を確認し直してください。';
    if(!reserved.some(r=>r.production_minutes>0)||!reserved.some(r=>r.date===verified.receive_date.value_text&&r.order_count>0))return '必要な制作時間と受取日の注文枠が未確認です。「受注枠」を確認してください。';
    if(/配達/u.test(verified.fulfillment_method.value_text)&&!reserved.some(r=>r.date===verified.receive_date.value_text&&r.delivery_count>0))return '配達日の配達枠が未確認です。「受注枠」を確認してください。';
    const capacity=await reserveOrderCapacity(env,orderId,order.revision,reserved.map(({revision,...requirement})=>requirement),now);
    if(!capacity.ok)return capacityMessage(capacity.reason);
  }
  const [column, value] = mapping[action];
  if (order[column] === value) return 'すでに記録済みです。';
  const currentReservations=await rows(env,`SELECT * FROM manager_capacity_reservations WHERE order_id=?`,orderId);
  const rebase=currentReservations.length&&currentReservations.every(r=>r.revision===order.revision);
  const commands=[
    statement(env, `UPDATE manager_orders SET ${column}=?,revision=revision+1,updated_at=? WHERE id=?`, value, now, orderId),
    // Lifecycle bookkeeping does not change the agreed work estimate. Preserve
    // freshness only when the reservation was already current; never bless a stale plan.
    ...(rebase ? [statement(env,`DELETE FROM manager_capacity_reservations WHERE order_id=?`,orderId),...currentReservations.map(r=>statement(env,`INSERT INTO manager_capacity_reservations(order_id,date,revision,production_minutes,delivery_count,order_count,created_at) VALUES (?,?,?,?,?,?,?)`,orderId,r.date,order.revision+1,r.production_minutes,r.delivery_count,r.order_count,r.created_at))] : []),
    statement(env, `INSERT INTO manager_audit(order_id,actor,action,detail,created_at) VALUES (?,?,'lifecycle',?,?)`, orderId, actor, JSON.stringify({ action, before: order[column], after: value }), now),
  ];
  const completeKind={完成:'production',受渡完了:'handoff',支払完了:'payment',回収完了:'collection'}[action];
  if(completeKind)commands.push(statement(env,`UPDATE manager_tasks SET status='done',completed_at=? WHERE order_id=? AND kind=? AND status='open'`,now,orderId,completeKind));
  const taskKind={制作開始:'production',完成:'handoff',受渡完了:'payment',回収必要:'collection'}[action];
  if(taskKind && !(taskKind==='payment'&&order.payment_status==='paid')) {
    const dateField=await first(env,`SELECT value_text FROM manager_fields WHERE order_id=? AND field_key='receive_date'`,orderId);
    const rawDue=/^\d{4}-\d{2}-\d{2}$/.test(dateField?.value_text||'')?Date.parse(`${dateField.value_text}T10:00:00+09:00`):Date.parse(now)+86400_000;
    const due=iso(Math.max(Date.parse(now),rawDue-(taskKind==='production'?86400_000:0)));
    commands.push(statement(env,`INSERT OR IGNORE INTO manager_tasks(id,order_id,kind,detail,due_at,created_at) VALUES (?,?,?,?,?,?)`,`${taskKind}:${orderId}`,orderId,taskKind,`${action}後の${taskKind==='production'?'制作':taskKind==='handoff'?'受渡し':taskKind==='payment'?'入金':'回収'}確認`,due,now));
  }
  if(action==='案件終了')commands.push(statement(env,`UPDATE manager_tasks SET status='done',completed_at=? WHERE order_id=? AND status='open'`,now,orderId));
  await env.DB.batch(commands);
  return `${orderId}：${action}を店長確認として記録しました。`;
}
