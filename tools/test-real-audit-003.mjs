import fs from 'node:fs';
import path from 'node:path';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { receiveManagerEvents, drainManagerInbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

// Reads the actual private transcript; never embeds customer details in Git.
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Usage: node tools/test-real-audit-003.mjs PRIVATE_SOURCE_JSON PRIVATE_OUTPUT_JSON');
globalThis.fetch = async () => { throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
const f = createManagerFixture();
f.env.MANAGER_RELEASE_STAGE = 'live';
f.env.MANAGER_AUTO_INTAKE_ENABLED = 'true';
const customer = 'AUDIT-003-CUSTOMER';
const order = 'AUDIT-003-ORDER';
const start = '2026-09-24T07:00:00.000Z';
f.db.prepare('INSERT INTO manager_orders(id,customer_id,created_at,updated_at) VALUES (?,?,?,?)').run(order, customer, start, start);
const rows = sql => f.db.prepare(sql).all();
const checks = [];
const turns = [];
const messages = raw.groups.flatMap(g => g.messages.map(m => ({ ...m, date: g.date })));
let index = 0;
for (const m of messages) {
  index++;
  const date = m.date.match(/(\d+)\/(\d+)/u);
  const clock = m.renderedText.match(/(?:^|\n)(\d{1,2}):(\d{2})(?:\n|$)/u);
  const at = new Date(Date.UTC(2026, Number(date[1]) - 1, Number(date[2]), Number(clock?.[1] || 12) - 9, Number(clock?.[2] || 0), index)).toISOString();
  const text = m.side === 'customer'
    ? m.renderedText.replace(/\n\s*\d{1,2}:\d{2}\s*$/u, '').trim()
    : m.text.trim();
  const id = `AUDIT003-${index}`;
  if (m.side === 'store') {
    f.db.prepare("INSERT INTO manager_events(id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at) VALUES (?,?,?,'assistant',?,?,?,?)").run(id, customer, order, text, at, at, at);
    turns.push({ index, role: 'store', sourceId: m.id, text, at, interpretation: text ? 'actual store reply injected into current order history' : 'image/sticker: content unavailable' });
    continue;
  }
  if (!m.text.trim()) {
    turns.push({ index, role: 'customer', sourceId: m.id, at, interpretation: 'image/sticker not visually available; cannot claim content acceptance' });
    continue;
  }
  const before = rows('SELECT * FROM manager_drafts').length;
  await receiveManagerEvents([{ type: 'message', webhookEventId: id, timestamp: Date.parse(at), source: { userId: customer }, message: { id, type: 'text', text } }], f.env, at);
  await drainManagerInbox(f.env, new Date(Date.parse(at) + 30000).toISOString());
  const drafts = rows('SELECT * FROM manager_drafts ORDER BY rowid').slice(before);
  const fields = rows('SELECT * FROM manager_fields');
  const reply = drafts.map(d => d.message).join('\n');
  const check = (name, pass, expectation) => checks.push({ index, name, pass, expectation });
  if (/明日までお待ち/u.test(text)) {
    check('response_wait_is_not_order_date', !fields.some(v => ['use_date','receive_date'].includes(v.field_key)), 'Wait for the customer response; do not infer event or pickup date.');
    check('response_wait_acknowledged', /お待ち|ご都合|承知|お返事/u.test(reply) && !/いつ頃|どのようなバルーン|いくつ/u.test(reply), 'Acknowledge reply deferral and partial alternative approval; do not start intake again.');
  } else if (/デイサービス/u.test(text)) {
    check('personal_context_does_not_restart_intake', !/いつ頃|どのようなバルーン|いくつ/u.test(reply), 'Recognize explanation of response delay without storing third-party medical/care facts as order specifications.');
  } else if (/なければ/u.test(text)) {
    check('inventory_question_escalates', drafts.some(d => { try { return JSON.parse(d.reasons_json || '[]').some(r => /inventory|stock|availability|商品|在庫|入荷/u.test(r)); } catch { return false; } }), 'Refer stock question against the prior unavailable-product statement to the owner; preserve conditional alternatives.');
  } else if (/それでお願/u.test(text)) {
    check('acceptance_refers_to_actual_store_offer', !/いつ頃|どのようなバルーン|いくつ/u.test(reply) && /承|確認|内容|文字/u.test(reply), 'Resolve acceptance to the latest actual store product/lettering proposal, retaining owner-confirmed stock evidence.');
  } else if (/話したところ/u.test(text)) {
    check('followup_context_preserved', !/いつ頃|どのようなバルーン|いくつ/u.test(reply), 'Treat as continuation of conditional product selection, not a fresh inquiry.');
  } else if (/感謝/u.test(text)) {
    check('closing_does_not_restart_intake', !/いつ頃|どのようなバルーン|いくつ/u.test(reply), 'Acknowledge closing without asking for order details.');
  }
  turns.push({ index, role: 'customer', sourceId: m.id, at, input: text, reply, fields, draftStatuses: drafts.map(d => d.status) });
}
const report = { auditId: 'AUDIT-003', mode: 'actual_store_and_customer_history_injected_local_runtime', network: 'forbidden', source, totalMessages: messages.length, storeMessages: messages.filter(m => m.side === 'store').length, customerTextTurns: turns.filter(t => t.input).length, unavailableCustomerMedia: messages.filter(m => m.side === 'customer' && !m.text.trim()).length, checks, failures: checks.filter(c => !c.pass).length, turns, limitations: ['Source capture has no explicit complete flag and begins at friend-add; earlier in-person history referenced by store is unavailable.', 'Images and stickers have no captured visible contents; no visual interpretation claimed.', 'Store replies are injected as assistant history; product fields are not reverse-engineered by the harness.', 'No external sending or live LINE acceptance is performed.'] };
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ auditId: report.auditId, totalMessages: report.totalMessages, storeMessages: report.storeMessages, customerTextTurns: report.customerTextTurns, unavailableCustomerMedia: report.unavailableCustomerMedia, checks: checks.length, failures: report.failures, failedChecks: checks.filter(c => !c.pass) }, null, 2));
f.db.close();
process.exitCode = report.failures ? 1 : 0;
