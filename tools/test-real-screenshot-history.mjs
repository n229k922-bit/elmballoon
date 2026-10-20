import fs from 'node:fs';
import path from 'node:path';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { receiveManagerEvents, drainManagerInbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node tools/test-real-screenshot-history.mjs PRIVATE_TRANSCRIPT PRIVATE_RESULT');
globalThis.fetch = async () => { throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
const source = JSON.parse(fs.readFileSync(input, 'utf8'));
const results = [];
for (const thread of source.threads) {
  const f = createManagerFixture();
  f.env.MANAGER_RELEASE_STAGE = 'live';
  f.env.MANAGER_AUTO_INTAKE_ENABLED = 'true';
  const customer = `${thread.id}-CUSTOMER`, order = `${thread.id}-ORDER`;
  f.db.prepare('INSERT INTO manager_orders(id,customer_id,created_at,updated_at) VALUES (?,?,?,?)').run(order, customer, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
  const turns = [], checks = [];
  let sequence = 0;
  for (const message of thread.messages) {
    const i = ++sequence;
    const clock = /^\d\d:\d\d$/u.test(message.clock) ? message.clock : '12:00';
    const at = new Date(Date.parse(`${message.date}T${clock}:00+09:00`) + i * 1000).toISOString();
    const id = `${thread.id}-${i}`;
    if (!message.text) { turns.push({ ...message, skipped: 'media without machine-readable content' }); continue; }
    if (message.side === 'store') {
      f.db.prepare("INSERT INTO manager_events(id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at) VALUES (?,?,?,'assistant',?,?,?,?)").run(id, customer, order, message.text, at, at, at);
      turns.push({ ...message, injected: true }); continue;
    }
    const before = f.db.prepare('SELECT COUNT(*) n FROM manager_drafts').get().n;
    const orderCountBefore = f.db.prepare('SELECT COUNT(*) n FROM manager_orders').get().n;
    await receiveManagerEvents([{ type:'message', webhookEventId:id, timestamp:Date.parse(at), source:{userId:customer}, message:{id,type:'text',text:message.text} }], f.env, at);
    await drainManagerInbox(f.env, new Date(Date.parse(at) + 30000).toISOString());
    const drafts = f.db.prepare('SELECT * FROM manager_drafts ORDER BY rowid').all().slice(before);
    const reply = drafts.map(d => d.message).join('\n');
    const fields = f.db.prepare('SELECT * FROM manager_fields').all();
    const check = (name, pass) => checks.push({ source:message.source, index:i, expectation:message.expect, name, pass });
    const noRestart = !/どのようなバルーン|いくつご希望|いつ頃のお受け取り/u.test(reply);
    check('readable_customer_turn_has_reply', reply.trim().length > 0);
    check('no_internal_codes_in_customer_reply', !/M[A-F0-9]{12}|D[A-F0-9]{12}|review_collected_details|pending|consulting/u.test(reply));
    check('no_generic_restart_in_context', noRestart);
    if (thread.kind === 'consultation_visit') {
      check('visit_not_registered_as_goods_pickup', !fields.some(v => ['use_date','receive_date','receive_time'].includes(v.field_key)));
      check('visit_arrival_not_goods_completion', !/受け渡し完了|お受け取り完了|納品完了|配達完了/u.test(reply));
    }
    if (['visit_delay','pickup_time_inquiry','pickup_time_update','conditional_pickup_date','conditional_pickup_time_update'].includes(message.expect)) {
      check('owner_decision_for_schedule_change', drafts.some(d => { try { return JSON.parse(d.reasons_json || '[]').length > 0; } catch { return false; } }));
      check('schedule_not_auto_approved', drafts.every(d => d.status !== 'approved'));
      check('schedule_not_promised_before_owner', !/変更しました|変更いたしました|(?:13|14|18)時.{0,8}(?:確定|お待ちしております)/u.test(reply));
    }
    if (message.expect === 'color_consultation') {
      check('responds_to_color_consultation', /色|ピンク|お着物|着物/u.test(reply));
      check('explicit_event_date_preserved_despite_color_uncertainty', fields.some(v => v.field_key === 'use_date' && v.value_text === '2026-10-17'));
      check('explicit_occasion_preserved_despite_color_uncertainty', fields.some(v => v.field_key === 'purpose' && /成人|前撮/u.test(v.value_text)));
    }
    if (['color_consultation','color_candidate_undecided','future_separate_inquiry'].includes(message.expect)) check('tentative_colors_not_saved_as_customer_selection', !fields.some(v => v.field_key === 'color_vibe' && v.source_event_id === id));
    if (message.expect === 'future_separate_inquiry') {
      check('future_order_not_used_as_current_date_or_quantity', !fields.some(v => ['receive_date','use_date'].includes(v.field_key) && /01-10/u.test(v.value_text)) && !fields.some(v => v.field_key === 'quantity' && v.value_text === '3'));
      check('future_order_not_created_before_customer_returns', f.db.prepare('SELECT COUNT(*) n FROM manager_orders').get().n === orderCountBefore);
      check('mixed_turn_acknowledges_current_lettering_and_future_order', /文字|メッセージ/u.test(reply) && /別|次|改め|その時/u.test(reply));
    }
    if (message.expect === 'conditional_pickup_date') {
      check('conditional_dates_not_committed', !fields.some(v => v.field_key === 'receive_date' && v.source_event_id === id));
      check('customer_travel_destination_not_delivery_area', !fields.some(v => ['delivery_area','delivery_address'].includes(v.field_key) && v.source_event_id === id));
    }
    if (message.expect === 'conditional_pickup_time_update') check('conditional_time_not_committed_without_owner', !fields.some(v => ['receive_date','receive_time'].includes(v.field_key) && v.source_event_id === id && ['answered','confirmed'].includes(v.status)));
    if (message.expect === 'closing') check('closing_has_no_owner_judgement', drafts.every(d => { try { return !JSON.parse(d.reasons_json || '[]').length; } catch { return false; } }));
    const turnChecks = checks.filter(c => c.index === i);
    turns.push({ ...message, at, reply, fields, semanticVerdict:turnChecks.every(c => c.pass) ? 'passes_specific_reviewed_expectations' : 'fails_specific_reviewed_expectations', reviewLimit:message.partial ? 'partial source; missing preceding words not accepted' : 'verdict limited to stated checks; not proof of arbitrary natural language equivalence' });
  }
  results.push({ id:thread.id, customerTextTurns:turns.filter(t => t.side === 'customer' && t.text).length, missing:thread.missing, checks, failures:checks.filter(c => !c.pass).length, turns });
  f.db.close();
}
const report = { mode:'offline_actual_screenshot_transcript_runtime', network:'forbidden', reviewedImageCount:source.visuallyReviewed.length, unreviewedImages:source.unreviewedImages, duplicateThreads:source.duplicates, results, failures:results.reduce((n,r) => n+r.failures,0), limitations:['No assertions about uncaptured conversation turns.', 'Historical years inferred as 2026; unknown clock defaults to noon and is not date/timing evidence.', 'Partial but legible turns replay only visible characters; missing words are never generated.', 'Store replies injected as assistant events; no original unpublished offline agreement presumed.', 'Visual review of screenshot previews does not establish stock, payment or delivery facts.'] };
fs.mkdirSync(path.dirname(output), { recursive:true });
fs.writeFileSync(output, JSON.stringify(report,null,2));
console.log(JSON.stringify({ reviewedImageCount:report.reviewedImageCount, failures:report.failures, threads:results.map(r => ({ id:r.id, customerTextTurns:r.customerTextTurns, checks:r.checks.length, failures:r.failures, failedChecks:r.checks.filter(c => !c.pass) })) },null,2));
process.exitCode = report.failures ? 1 : 0;
