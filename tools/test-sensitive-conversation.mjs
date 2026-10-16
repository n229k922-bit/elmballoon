import assert from 'node:assert/strict';
import { classifyConversationIntent, extractConversationFacts, planConversation } from '../workers/admin-line-secretary/src/conversation.js';

const sourceTimestamp = '2026-10-19T01:00:00Z';
const fields = { product_type: 'ブーケ', quantity: '3', budget: '3000円（合計）', budget_scope: 'total', receive_date: '2026-11-07', fulfillment_method: '店頭受取', color_vibe: 'おまかせ' };
let checks = 0;
for (const [text, kind, owner] of [
  ['ところで今日の天気は？', 'smalltalk', false],
  ['ありがとうございます。また必要なときに相談します😊', 'closing', false],
  ['今回は見送ります。また連絡します', 'withdrawal', true],
  ['今回は注文しないでください', 'withdrawal', true],
  ['スタンドだけ見送りです。母のブーケはそのまま', 'withdrawal', true],
  ['前のブーケはそのまま。別件でスタンド1台をお願いします', 'mixed_orders', true],
  ['ブーケは7日の10時希望です。あと別件なんですが、スタンドも1台15000円で11月14日17時に配達希望です', 'mixed_orders', true],
  ['話が違います。最悪です', 'complaint', true],
  ['人の担当に代わってください', 'handoff', true],
  ['責任者と話したいです', 'handoff', true],
  ['割れた風船を子供が飲み込んだかもしれません', 'safety', true],
  ['ヘリウムを吸ったら苦しいです', 'safety', true],
  ['風船で怪我をしました', 'safety', true],
]) {
  const intent = classifyConversationIntent(text);
  assert.equal(intent.kind, kind, text);
  const extracted = extractConversationFacts({ text, sourceTimestamp });
  assert.deepEqual(extracted.updates, [], text);
  const plan = planConversation({ text, sourceTimestamp, fields });
  assert.equal(plan.questions.length, 0, text);
  assert.equal(plan.requiresOwner, owner, text);
  assert.deepEqual(plan.fields, fields, text);
  assert.equal(plan.intent.kind, kind, text);
  assert.doesNotMatch(plan.message, /😊/, text);
  checks++;
}
assert.equal(classifyConversationIntent('お届けが可能なら相談したいです').kind, 'order'); checks++;
const field = (result, key) => result.updates.find(update => update.key === key)?.value;
const extract = text => extractConversationFacts({ text, sourceTimestamp });
assert.equal(field(extract('色はピンクと紫で、赤は入れないでください'), 'color_vibe'), 'ピンク・紫'); checks++;
assert.equal(field(extract('赤を入れずピンクで'), 'color_vibe'), 'ピンク'); checks++;
assert.equal(field(extract('商品番号88ではなく年齢です'), 'product_source'), undefined); checks++;
assert.equal(field(extract('商品番号: B36'), 'product_source'), 'B36'); checks++;
assert.equal(field(extract('浮くのとアレンジではどっちがいいですか'), 'product_type'), undefined); checks++;
assert.equal(field(extract('ピンクと紫どちらがよいでしょうか'), 'color_vibe'), undefined); checks++;
const changed = extract('使用日：11月1日\n受取希望日：10月31日ではなく30日\n18時に変更したい');
assert.equal(changed.updates.some(update => ['use_date', 'receive_date', 'receive_time'].includes(update.key)), false); checks++;
for (const text of ['葬儀の受付飾りを相談したいです', '子供が亡くなりました。飾りを相談できますか', '父の喜寿祝いのアレンジを相談したいです', 'プロポーズの飾りを相談したいです']) {
  const plan = planConversation({ text, sourceTimestamp });
  assert.ok(plan.questions.length <= 1, text);
  assert.doesNotMatch(plan.message, /😊|おめでとう/, text);
  assert.doesNotMatch(plan.message, /(?:制作|予約|配達)(?:できます|可能です)/, text);
  checks++;
}
assert.equal(field(extract('父の米寿祝いです'), 'purpose'), '米寿'); checks++;
// Ordinary courtesy and rejected labels must not replace an existing order.
for (const text of ['今日もお忙しいところありがとうございます', '今日はありがとうございます', '明日もよろしくお願いします']) {
  assert.equal(field(extract(text), 'receive_date'), undefined, text); checks++;
}
assert.equal(field(extract('今日はありがとうございます。11月7日に受け取りたいです'), 'receive_date'), '2026-11-07'); checks++;
assert.equal(field(extract('今日取りに行きたいです'), 'receive_date'), '2026-10-19'); checks++;
for (const text of ['商品番号：88ではなく年齢です', '品番：B36ではありません']) {
  assert.equal(field(extract(text), 'product_source'), undefined, text); checks++;
}
for (const text of ['色はおまかせではありません', '色はお任せにしません']) {
  assert.notEqual(field(extract(text), 'color_vibe'), 'おまかせ', text); checks++;
}
const continued = planConversation({ text: 'ありがとうございます。数量を2つに変更してください', sourceTimestamp, fields });
assert.equal(continued.intent.kind, 'order');
assert.equal(field(continued, 'quantity'), '2');
assert.ok(continued.ownerReasons.includes('order_exception')); checks++;
for (const purpose of ['お悔やみ', 'お供え']) {
  const plan = planConversation({ text: `${purpose}のバルーンを相談したいです`, sourceTimestamp });
  assert.equal(plan.intent.kind, 'bereavement');
  assert.equal(field(plan, 'purpose'), purpose);
  assert.doesNotMatch(plan.message, /😊|おめでとう/); checks++;
}
const redRefusal = planConversation({ text: '本人は赤が苦手なので、還暦だから赤にはしないでください', sourceTimestamp });
assert.equal(field(redRefusal, 'color_vibe'), undefined);
assert.ok(redRefusal.facts.choiceAmbiguities.some(item => item.key === 'color_vibe')); checks++;
const mergedDates = planConversation({ text: '11月29日に使って28日15時受け取り希望です', sourceTimestamp });
assert.equal(mergedDates.updates.some(item => ['receive_date', 'receive_time', 'use_date'].includes(item.key)), false);
assert.ok(mergedDates.questions.some(item => item.key === 'date_clarification')); checks++;
for (const history of [[], [{ text: '写真とか事情は送りたくないです' }]]) {
  const plan = planConversation({ text: history.length ? '使用日は11月8日です' : '写真とか事情は送りたくないです', sourceTimestamp, history, fields: { receive_date: '2026-11-07' } });
  assert.ok(plan.questions.some(item => item.key === 'product_type'));
  assert.doesNotMatch(plan.message, /写真だけでも|写真を.*ください/); checks++;
}
console.log(`Sensitive conversation: ${checks} checks passed.`);
