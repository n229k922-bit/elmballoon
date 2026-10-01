import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBundle } from './build-order-knowledge.mjs';

const cards = '# Cards\n## Conditions\nUnverified\n## A. Active\n### A-01 Sample\n- 電話：000-0000-0000\n- 状態：未確認\n\n## D. Limited\n- Sample two：本文なし\n## E. Hidden\n- Older unavailable\n';
const knowledge = '# Knowledge\n## ケース：相談\nHistorical price 800\n';
test('PII is preserved in private staging with source location and no identity inference', () => {
  const bundle = buildBundle(cards, knowledge, '2026-09-30T00:00:00Z');
  assert.equal(bundle.records.length, 2);
  assert.equal(bundle.records[0].source_line, 5);
  assert.match(bundle.records[0].raw_text, /000-0000-0000/);
  assert.equal(bundle.private_source.raw_text, cards);
  for (const row of bundle.records) {
    assert.equal(row.linked_customer_id, null);
    assert.equal(row.review_status, 'needs_review');
    assert.equal(row.activation_allowed, false);
  }
  assert.equal(bundle.records[1].evidence_kind, 'limited_evidence');
  assert.equal(bundle.knowledge_candidates[0].approved_for_pricing, false);
  assert.equal(bundle.knowledge_candidates[0].approved_for_runtime, false);
});
test('IDs are stable across timestamps, line endings and preceding line offsets', () => {
  const first = buildBundle(cards, knowledge, 'a');
  const next = buildBundle('\n' + cards.replaceAll('\n', '\r\n'), knowledge, 'b');
  assert.deepEqual(first.records.map(r => r.id), next.records.map(r => r.id));
  assert.equal(next.records[0].source_line, first.records[0].source_line + 1);
});
test('changed source content produces a new review version', () => {
  assert.notEqual(buildBundle(cards, knowledge).records[0].id, buildBundle(cards.replace('未確認', '確認済'), knowledge).records[0].id);
});
test('invalid and duplicate card sources fail closed', () => {
  assert.throws(() => buildBundle('# Empty', knowledge));
  assert.throws(() => buildBundle('### A-01 Same\ntext\n### A-01 Same\ntext\n', knowledge), /Duplicate/);
});
