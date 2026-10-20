import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { receiveManagerEvents, drainManagerInbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

// Private historic source only; no real service or outbound delivery is used.
const [input, output] = process.argv.slice(2);
if (!input || !output || !path.resolve(output).includes(`${path.sep}private${path.sep}`)) throw new Error('Private source JSON and private output directory required');
globalThis.fetch = async () => { throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
const source = JSON.parse(fs.readFileSync(input, 'utf8'));
const messages = (source.groups || []).flatMap(group => (group.messages || []).map(message => ({ ...message, date: group.date })));
assert.ok(messages.length > 0);
const f = createManagerFixture();
f.env.MANAGER_RELEASE_STAGE = 'live';
f.env.MANAGER_AUTO_INTAKE_ENABLED = 'true';
f.env.MANAGER_SEND_NOT_BEFORE = '2026-01-01T00:00:00.000Z';
const all = (sql, ...args) => f.db.prepare(sql).all(...args);
const clean = message => (message.renderedText || message.text || '').replace(/^あっこ\s*\n/u, '').replace(/\n?既読/gu, '').replace(/\n?ダウンロード/gu, '').replace(/\n?\b\d{1,2}:\d{2}\b\s*$/u, '').trim();
let sequence = 0;
const reviewed = [];
for (const message of messages) {
  const clock = (message.renderedText || '').match(/(?:^|\n)(\d{1,2}):(\d{2})(?:\n|$)/u);
  const day = message.date.match(/(\d+)\/(\d+)/u);
  assert.ok(day, 'Source day must be known');
  const at = new Date(Date.UTC(2026, Number(day[1]) - 1, Number(day[2]), Number(clock?.[1] || 12) - 9, Number(clock?.[2] || 0), sequence++ % 30)).toISOString();
  const text = clean(message);
  if (!text) { reviewed.push({ source: message, at, outcome: 'nontext_requires_visual_review' }); continue; }
  if (message.side === 'store') {
    const order = f.db.prepare('SELECT id FROM manager_orders ORDER BY rowid DESC LIMIT 1').get();
    f.db.prepare("INSERT INTO manager_events(id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at) VALUES (?,?,?,'assistant',?,?,?,?)").run(`HIST-STORE-${sequence}`, 'CUSTOMER', order?.id || null, text, at, at, at);
    reviewed.push({ source: message, at, outcome: 'historic_store_reply_injected_as_assistant_evidence' });
    continue;
  }
  const beforeFields = all('SELECT order_id,field_key,value_text FROM manager_fields');
  const beforeDrafts = all('SELECT id FROM manager_drafts').length;
  const eventId = `AUDIT-002-${sequence}`;
  let error = null;
  try {
    await receiveManagerEvents([{ type: 'message', webhookEventId: eventId, timestamp: Date.parse(at), source: { userId: 'CUSTOMER' }, message: { id: eventId, type: 'text', text } }], f.env, at);
    await drainManagerInbox(f.env, new Date(Date.parse(at) + 30000).toISOString());
  } catch (e) { error = String(e.stack || e); }
  const drafts = all('SELECT * FROM manager_drafts ORDER BY rowid').slice(beforeDrafts);
  const fields = all('SELECT order_id,field_key,value_text FROM manager_fields');
  const checks = [];
  const check = (rule, pass, expected) => checks.push({ rule, pass, expected });
  const turnNumber = reviewed.filter(turn => turn.checks).length + 1;
  const reply = drafts.map(draft => draft.message).join('\n');
  const intakeRestart = /お届け先の市町村|どのようなバルーン|いくつご希望|いつ頃のお受け取り|ご使用日とお受け取り希望日|何年何月何日/u;
  check('runtime_no_exception', !error, 'Every acquired customer turn is processed');
  check('no_internal_codes', drafts.every(d => !/review_collected_details|M[A-F0-9]{16}|D[A-F0-9]{16}/u.test(d.message)), 'Customer-facing reply has no internal identifiers');
  if (/支払|領収|PayPay/u.test(text)) {
    check('payment_not_fulfillment_date', fields.filter(field => /use_date|receive_date/u.test(field.field_key)).every(field => beforeFields.some(old => old.order_id === field.order_id && old.field_key === field.field_key && old.value_text === field.value_text)), 'Payment visit timing never overwrites delivery/use date');
    check('payment_reply_relevant', drafts.every(d => !/どのようなバルーン|いくつご希望|受取方法|使用日は/u.test(d.message)), 'Payment/receipt follow-up stays on payment, no intake restart');
  }
  if (/この二つに変更/u.test(text)) check('image_selection_no_guess', drafts.every(d => /画像|写真|確認|担当/u.test(d.message)), 'Image-dependent selection is acknowledged without guessing image contents');
  if (/配達ありがとうございました|お届け有難う|ありがとうございます.*宜しく/u.test(text)) check('delivery_thanks_no_restart', drafts.every(d => !/どのようなバルーン|いくつご希望|いつ頃のお受け取り/u.test(d.message)), 'Completed delivery thanks never restarts ordering');
  if (/後6月30日|8日に.*届け|バルーンを2つ、10月2日|スタンドバルーン.*10日に/u.test(text)) check('distinct_order_not_overwrite', all('SELECT id FROM manager_orders').length > 1, 'Different occasion/date/destination is separated or explicitly disambiguated');
  if ([4, 6, 7, 10, 11, 16, 18, 22, 24, 26, 29, 32, 33, 37, 38, 40].includes(turnNumber)) check('historic_context_no_intake_restart', !intakeRestart.test(reply), 'Short acceptance/correction/payment visit/arrival respects the preceding store reply');
  if ([25, 26, 37].includes(turnNumber)) check('historic_payment_context', /支払|来店|お越し|伺|ご連絡.*確認/u.test(reply) && !intakeRestart.test(reply), 'Payment visit is resolved from actual store/customer history');
  if (turnNumber === 15) check('callback_request_acknowledged', /電話|連絡先|折り返|担当/u.test(reply) && !intakeRestart.test(reply), 'Phone-number-plus-callback request reaches human callback flow');
  if (turnNumber === 20) check('rename_not_new_occasion', !fields.some(field => field.field_key === 'purpose' && field.value_text === '移転'), 'Destination-name correction must not change anniversary occasion into relocation');
  if (turnNumber === 8) check('prior_month_not_reasked', !/何年何月何日/u.test(reply), 'Previously stated full date supplies month for subsequent day-only same-order reference');
  if (turnNumber === 29) check('deferred_consultation_respected', !intakeRestart.test(reply), 'Customer will contact later, do not demand outstanding order details');
  reviewed.push({ source: message, at, text, error, checks, drafts, fields, orders: all('SELECT id,title,status FROM manager_orders') });
}
const customer = reviewed.filter(turn => turn.checks);
const failures = customer.flatMap((turn, i) => turn.checks.filter(check => !check.pass).map(check => ({ customerTurn: i + 1, sourceId: turn.source.id, ...check })));
const summary = {
  audit: 'AUDIT-002', sourceMessages: messages.length, customerMessages: messages.filter(m => m.side === 'customer').length,
  storeMessages: messages.filter(m => m.side === 'store').length, customerTextTurns: customer.length,
  injectedStoreTextTurns: reviewed.filter(t => t.outcome === 'historic_store_reply_injected_as_assistant_evidence').length,
  nontextTurns: reviewed.filter(t => t.outcome === 'nontext_requires_visual_review').length,
  checks: customer.reduce((n, t) => n + t.checks.length, 0), failures: failures.length,
  failedRules: [...new Set(failures.map(fail => fail.rule))], runtimeErrors: customer.filter(t => t.error).length,
  limitations: ['Historic year inferred as 2026 from matching weekday labels; no source year marker', 'All acquired structured text reviewed; image content requires separate visual review', 'Historic assistant turns injected as evidence, not falsely converted into confirmed business fields or completed-order state', 'Runtime currently selects customer-only history; injected assistant evidence may therefore be ignored', 'No real delivery or owner acceptance is claimed'],
};
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'AUDIT-002-history-context.private.json'), JSON.stringify({ summary, failures, reviewed }, null, 2));
console.log(JSON.stringify(summary, null, 2));
f.db.close();
process.exitCode = failures.length ? 1 : 0;
