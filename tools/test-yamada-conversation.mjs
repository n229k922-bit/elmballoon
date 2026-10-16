import assert from 'node:assert/strict';
import { extractConversationFacts, planConversation } from '../workers/admin-line-secretary/src/conversation.js';

// Synthetic wording regression, anchored to October 16 Japan time.
const sourceTimestamp = '2026-10-16T08:00:00Z';
const extract = (text, lastQuestions = []) => extractConversationFacts({ text, lastQuestions, sourceTimestamp });
const field = (result, key) => result.updates.find(update => update.key === key)?.value;
let checks = 0;
const opening = planConversation({ text: '娘の誕生日に浮くタイプをお願いします', sourceTimestamp });
assert.equal(opening.questions[0].key, 'use_date');
const useAnswer = planConversation({ text: '明後日なんですけど間に合いますか', fields: opening.fields, lastQuestions: opening.questions, sourceTimestamp });
assert.equal(field(useAnswer, 'use_date'), '2026-10-18');
assert.equal(field(useAnswer, 'receive_date'), undefined);
assert.ok(useAnswer.questions.some(q => q.key === 'receive_date')); checks++;
const greeting = planConversation({ text: 'こんにちは初めての注文です', sourceTimestamp });
const detailAnswer = planConversation({ text: '娘の誕生日に浮くタイプのバルーンを考えています', sourceTimestamp, fields: greeting.fields, lastQuestions: greeting.questions });
assert.ok(detailAnswer.questions.some(q => q.key === 'use_date')); checks++;
const olderUseQuestion = extractConversationFacts({ text: '明後日なんですけど間に合いますか', sourceTimestamp, fields: {}, lastQuestions: [{ key: 'color_vibe' }], history: [{ questions: [{ key: 'use_date' }] }] });
assert.equal(field(olderUseQuestion, 'use_date'), '2026-10-18');
assert.equal(field(olderUseQuestion, 'receive_date'), undefined); checks++;
for (const question of [{ key: 'use_date' }, 'use_date']) {
  const result = extract('明後日なんですけど間に合いますか', [question]);
  assert.equal(field(result, 'use_date'), '2026-10-18');
  assert.equal(field(result, 'receive_date'), undefined); checks++;
}
// Explicit pickup language overrides the contextual use-date question.
assert.equal(field(extract('明後日に受け取りたいです', [{ key: 'use_date' }]), 'receive_date'), '2026-10-18'); checks++;
assert.equal(field(extract('お店に伺います'), 'fulfillment_method'), '店頭受取'); checks++;
assert.equal(field(extract('水色と白でお願いします'), 'color_vibe'), '水色・白'); checks++;
for (const [text, qualifier, saved] of [
  ['予算は3000円以内でお願いします', 'upper_bound', '3,000円以内'],
  ['予算は3000円程度です', 'approximate', '3,000円程度'],
]) {
  const result = extract(text);
  assert.equal(result.facts.budget.qualifier, qualifier);
  assert.ok(field(result, 'budget').startsWith(saved)); checks++;
}
assert.equal(field(extract('NANOでお願いします', [{ key: 'balloon_message' }]), 'balloon_message'), 'NANO'); checks++;
assert.equal(field(extract('NANO'), 'balloon_message'), undefined); checks++;
assert.equal(field(extract('名入れは無料ですか？', [{ key: 'balloon_message' }]), 'balloon_message'), undefined); checks++;

const fields = { use_date: '2026-10-18', receive_date: '2026-10-18', receive_time: '17:00', product_type: 'ブーケ', quantity: '1', budget: '3000円以内', fulfillment_method: '店頭受取' };
const changed = planConversation({ text: '受け取りを10月17日に変更したいです', fields, sourceTimestamp });
assert.equal(field(changed, 'receive_date'), '2026-10-17');
assert.equal(field(changed, 'use_date'), undefined);
assert.equal(changed.fields.use_date, fields.use_date);
assert.ok(changed.questions.some(q => q.key === 'use_date_confirmation'));
assert.equal(changed.clarificationNeeded, true); checks++;
const nextTime = planConversation({ text: '17時希望です', fields, lastQuestions: changed.questions, sourceTimestamp });
assert.ok(nextTime.questions.some(q => q.key === 'use_date_confirmation'));
assert.equal(nextTime.fields.use_date, '2026-10-18'); checks++;
const unknownUse = planConversation({ text: '受取を10月17日に変更したいです', fields: { receive_date: '2026-10-18' }, sourceTimestamp });
assert.equal(unknownUse.questions[0].key, 'use_date_confirmation');
assert.equal(field(unknownUse, 'use_date'), undefined); checks++;
assert.equal(field(extract('明後日です', [{ key: 'use_date_confirmation' }]), 'use_date'), '2026-10-18'); checks++;
const times = planConversation({ text: '17時は無理なので16時にできますか', fields, sourceTimestamp });
assert.equal(field(times, 'receive_time'), undefined);
assert.equal(field(times, 'use_date'), undefined);
assert.equal(times.clarificationNeeded, true); checks++;
for (const text of ['営業時間は何時までですか？', '明日17時まで営業していますか？', 'お店は明日17時までやっていますか？']) {
  const result = planConversation({ text, fields, sourceTimestamp });
  assert.equal(field(result, 'receive_date'), undefined, text);
  assert.equal(field(result, 'receive_time'), undefined, text);
  assert.equal(result.fields.use_date, fields.use_date);
  assert.ok(result.ownerReasons.includes('business_hours_confirmation')); checks++;
}
for (const text of ['明後日なんですけど間に合いますか', '名入れ無料で3000円の水色ブーケできますか', 'この構成で在庫はありますか']) {
  const result = planConversation({ text, sourceTimestamp, lastQuestions: [{ key: 'use_date' }] });
  assert.equal(result.approvalRequired, true);
  assert.doesNotMatch(result.message, /無料です|在庫があります|間に合います|確定しました|予約を承りました|必ずお届け|制作できます/u); checks++;
}
console.log(`Yamada conversation: ${checks} checks passed.`);
