import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBundle } from './build-order-knowledge.mjs';
import { planConversation } from '../workers/admin-line-secretary/src/conversation.js';

// Offline evidence-coverage audit. Summary prose is NEVER passed as a customer message.
// Every probe is a derived scenario, not a verbatim replay or an acceptance result.
const rules = [
  { tag: 'withdrawal', match: /キャンセル|取消|辞退|見送/, text: '今回は注文を見送ります。', owner: true },
  { tag: 'previous_order', match: /リピーター|昨年|過去と同様|前年/, text: '前回と同じバルーンをお願いしたいです。', owner: true },
  { tag: 'multiple_items', match: /個別仕様|複数|1点目|選手|21番.*27番/s, text: 'ブーケを3個お願いします。\n背番号1 名前A\n背番号4 名前B\n背番号5 名前C', owner: true },
  { tag: 'delivery', match: /配達|配送|発送/, text: 'バルーンをお店まで配達してもらえますか？', owner: true },
  { tag: 'date_change', match: /再調整|遅延|変更/, text: '受け取り日を変更したいです。', owner: true },
  { tag: 'ceremony', match: /リリース|式典/, text: '学校の式典でバルーンリリースを考えています。', owner: false },
  { tag: 'image_reference', match: /写真|画像|作例/, text: 'この写真のようなバルーンをお願いしたいです。', image: true, owner: false },
  { tag: 'intake', match: /./s, text: 'バルーンの注文を相談したいです。', owner: false },
];
const mustCheck = raw => [
  'Original customer and store turns, timestamps, question context, and final customer-facing output are required for full replay.',
  'Do not promote historical quote, stock, delivery exception, payment plan or summary status to current confirmed facts.',
  ...(/日|時/.test(raw) ? ['Separate use, pickup, delivery, consultation, payment and collection dates; retain change/acceptance provenance.'] : []),
  ...(/金|円|支払|入金/.test(raw) ? ['Separate budget, historical quote, unit/total, payment promise and actual payment evidence.'] : []),
  ...(/配達|住所|店名|店舗/.test(raw) ? ['Verify recipient/store/address independently for each new order; do not reuse by name alone.'] : []),
  ...(/写真|画像|動画|PDF|pdf/.test(raw) ? ['Media body, ownership, consent scope and per-order association require source inspection.'] : []),
  ...(/個別|複数|背番号/.test(raw) ? ['Retain per-item names, numbers, wording, wrapping and prices without collapsing items.'] : []),
];
function deriveProbe(record) {
  if (record.evidence_kind === 'limited_evidence') return null;
  const rule = rules.find(r => r.match.test(record.raw_text));
  const result = planConversation({ text: rule.text, hasImage: !!rule.image });
  const assertions = {
    finite_reply: typeof result.message === 'string' && result.message.length > 0,
    approval_required: result.approvalRequired === true,
    no_unprompted_pii: !/(?:0\d[\d-]{8,}|〒\d{3})/.test(result.message),
    owner_when_required: !rule.owner || result.requiresOwner === true,
    at_most_two_questions: result.questions.length <= 2,
  };
  return { provenance: 'derived_scenario_not_actual_customer_utterance', tag: rule.tag,
    input: { text: rule.text, hasImage: !!rule.image, sourceTimestamp: null },
    actual_result: result, assertions,
    assertion_status: Object.values(assertions).every(Boolean) ? 'bounded_checks_passed_not_acceptance' : 'bounded_check_failed' };
}
export async function audit(privateFile, knowledgeFile, output) {
  let blockedNetworkAttempts = 0;
  globalThis.fetch = async () => { blockedNetworkAttempts++; throw new Error('Network forbidden in offline evidence audit'); };
  if (!output.endsWith('.private.json')) throw new Error('Private output required');
  const b = buildBundle(await readFile(privateFile, 'utf8'), await readFile(knowledgeFile, 'utf8'));
  const records = b.records.map(r => ({ id: r.id, source_hash: r.source_hash, source_line: r.source_line,
    source_heading: r.source_heading, evidence_kind: r.evidence_kind,
    full_verbatim_replay: 'not_possible_from_summary_alone',
    missing_evidence: ['Complete ordered customer/store turns', 'Reliable per-turn year/date/time', 'Linked images and attachments', 'Runtime routing, queue, manager approval and final delivered reply'],
    review_obligations: mustCheck(r.raw_text), probe: deriveProbe(r) }));
  const knowledge = b.knowledge_candidates.map(r => ({ id: r.id, source_hash: r.source_hash,
    source_heading: r.source_heading, source_line: r.source_line,
    status: 'guidance_summary_not_transcript', review_obligations: mustCheck(r.raw_text), probe: deriveProbe({ ...r, evidence_kind: 'knowledge_summary' }) }));
  const all = [...records, ...knowledge], probes = all.filter(r => r.probe);
  const uniqueProbeInputs = new Set(probes.map(r => JSON.stringify(r.probe.input))).size;
  const byCategory = Object.fromEntries([...new Set(probes.map(r => r.probe.tag))].map(tag => [tag, probes.filter(r => r.probe.tag === tag).length]));
  const report = { schema_version: 1, mode: 'offline_no_network_no_db', synthetic: false,
    source_kind: 'real_source_summaries', probe_inputs_derived: true, activation_allowed: false,
    source_hash: b.private_source.source_hash,
    source_hashes: { private_source: b.private_source.source_hash, knowledge_sections: b.knowledge_candidates.map(r => ({ id: r.id, sha256: r.source_hash })) },
    network_guard: { global_fetch_forbidden: true, blocked_attempts: blockedNetworkAttempts, limitation: 'Test imports and functions were inspected: no network or DB call sites; fetch guard is not an OS sandbox.' },
    limitations: ['70 source-linked probes reuse 8 unique inputs: NOT 70 unique conversation tests.', 'Coverage is not proof of natural full conversation or integrated runtime safety.', 'No actual customer messages were sent.', 'No arbitrary year or order state was inferred.', 'Newly acquired verbatim threads are evaluated separately; overlap is not a new unique customer count.'],
    counts: { records: records.length, summarized_orders: records.filter(r => r.evidence_kind === 'summarized_order').length,
      limited_evidence: records.filter(r => r.evidence_kind === 'limited_evidence').length,
      knowledge_summaries: knowledge.length, full_verbatim_replays: 0,
      derived_probes: probes.length, unique_probe_inputs: uniqueProbeInputs, category_counts: byCategory,
      bounded_pass: probes.filter(r => r.probe.assertion_status.startsWith('bounded_checks_passed')).length,
      bounded_fail: probes.filter(r => r.probe.assertion_status === 'bounded_check_failed').length }, records, knowledge };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report.counts));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  audit(...process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
