import assert from 'node:assert/strict';
import { extractConversationFacts, planConversation } from '../workers/admin-line-secretary/src/conversation.js';

// Fixed shop-local reference date: these checks must not age with the clock.
const sourceTimestamp = '2026-10-01T00:00:00Z';
const extract = text => extractConversationFacts({ text, sourceTimestamp });
const field = (result, key) => result.updates.find(update => update.key === key)?.value;
let checks = 0;
for (const [text, key, expected] of [
  ['赤ではなくピンクでお願いします', 'color_vibe', 'ピンク'],
  ['色：赤ではなくピンク', 'color_vibe', 'ピンク'],
  ['赤色じゃなくてピンク色で', 'color_vibe', 'ピンク'],
  ['赤は使わずピンクでお願いします', 'color_vibe', 'ピンク'],
  ['スタンドではなくブーケを3つお願いします', 'product_type', 'ブーケ'],
  ['商品タイプ：スタンドじゃなくブーケ', 'product_type', 'ブーケ'],
  ['店頭ではなく配達でお願いします', 'fulfillment_method', '配達'],
  ['受取方法：発送ではなく店頭で', 'fulfillment_method', '店頭受取'],
  ['赤とピンクでお願いします', 'color_vibe', '赤・ピンク'],
  ['明日取りに行きます', 'receive_date', '2026-10-02'],
  ['10月10日が誕生日、10月9日に受け取り希望です', 'use_date', '2026-10-10'],
  ['10月10日が誕生日、10月9日に受け取り希望です', 'receive_date', '2026-10-09'],
  ['使用日：10月10日\n受取希望日：10月9日', 'receive_date', '2026-10-09'],
  ['使用日：10月10日\n受取希望日：10月9日', 'use_date', '2026-10-10'],
  ['今日は相談だけです。10月10日に受け取りたい', 'receive_date', undefined],
  ['10月10日が誕生日18時、10月9日10時に受け取り希望です', 'receive_time', '10:00'],
  ['10月10日18時が誕生日です', 'receive_time', undefined],
  ['3個ではなく1個でお願いします', 'quantity', '1'],
  ['数量：3個ではなく1個', 'quantity', '1'],
  ['個数：3ではなく1', 'quantity', '1'],
  ['予算3000円ではなく5000円でお願いします', 'budget', '5,000円（単価・合計未確認）'],
  ['予算：3000円ではなく5000円', 'budget', '5,000円（単価・合計未確認）'],
  ['予算：3000ではなく5000', 'budget', '5,000円（単価・合計未確認）'],
  ['3個じゃなくて1個、全体の合計5000円です', 'budget_scope', 'total'],
]) {
  assert.equal(field(extract(text), key), expected, text);
  checks++;
}

for (const [text, key] of [
  ['赤かピンクで迷っています', 'color_vibe'],
  ['赤はいらないです', 'color_vibe'],
  ['スタンドかブーケをお願いしたい', 'product_type'],
  ['スタンドとブーケをそれぞれ1つ', 'product_type'],
  ['配達が無理なら店頭で受け取ります', 'fulfillment_method'],
  ['受取方法：配達が無理なら店頭', 'fulfillment_method'],
  ['配達できますか？', 'fulfillment_method'],
  ['店頭には行けないです', 'fulfillment_method'],
  ['それが無理なら配達でお願いします', 'fulfillment_method'],
  ['3個か1個で迷っています', 'quantity'],
  ['数量：3個か1個', 'quantity'],
  ['3個はいらないです', 'quantity'],
  ['数量：3個ではありません', 'quantity'],
  ['2個と3個、それぞれお願いします', 'quantity'],
  ['3000円が無理なら5000円で', 'budget'],
  ['予算：3000円か5000円', 'budget'],
  ['予算：3000か5000', 'budget'],
  ['予算3000円ではありません', 'budget'],
  ['予算：3000円ではありません', 'budget'],
]) {
  const result = planConversation({ text, sourceTimestamp });
  assert.equal(field(result, key), undefined, text);
  assert.equal(result.clarificationNeeded, true, text);
  assert.ok(result.facts.choiceAmbiguities.some(item => item.key === key), text);
  assert.ok(result.ownerReasons.includes('order_exception'), text);
  assert.ok(result.questions.length <= 2, text);
  if (['quantity', 'budget'].includes(key)) assert.ok(result.questions.some(question => question.key === key && question.text), text);
  checks++;
}

for (const text of [
  '10月10日が誕生日で10月9日に受け取り希望です',
  '10月10日か10月11日に受け取りたいです',
  '10月10日ではなく10月11日に受け取りたいです',
  '受取希望日：10月10日か10月11日',
  '10月10日に受け取り、10月11日に受け取りたいです',
  '2月30日に受け取りたいです',
  '10月10日は無理です',
  '受取希望日：10月10日ではありません',
]) {
  const result = planConversation({ text, sourceTimestamp });
  assert.equal(field(result, 'receive_date'), undefined, text);
  assert.equal(result.clarificationNeeded, true, text);
  assert.ok(result.facts.dateAmbiguities.length > 0, text);
  assert.ok(result.questions.some(item => item.key === 'date_clarification'), text);
  assert.ok(result.questions.length <= 2, text);
  checks++;
}

// Ambiguity must remain visible even if there was already a prior selection.
const prior = planConversation({ text: '配達が無理なら店頭で', fields: { fulfillment_method: '配達' }, sourceTimestamp });
assert.equal(prior.clarificationNeeded, true);
assert.equal(prior.requiresOwner, true);
assert.ok(prior.questions.some(item => item.key === 'fulfillment_method'));
checks++;
// Explicit use/pickup roles with a shared month are unambiguous. This was
// approved as contextual date recording; retain both instead of discarding it.
const sharedMonth=planConversation({text:'10月10日が誕生日、9日に受け取りたいです',sourceTimestamp});
assert.equal(field(sharedMonth,'use_date'),'2026-10-10');
assert.equal(field(sharedMonth,'receive_date'),'2026-10-09');
checks++;
const times = planConversation({ text: '受取は10時か11時で迷っています', sourceTimestamp });
assert.equal(field(times, 'receive_time'), undefined);
assert.equal(times.clarificationNeeded, true);
checks++;
const correctedBudget = extract('予算3000円ではなく5000円');
assert.equal(correctedBudget.facts.budget.min, 5000);
assert.equal(correctedBudget.facts.budget.max, 5000);
assert.equal(extract('3000円か5000円').facts.budget, null);
checks++;
console.log(`Conversation adversarial: ${checks} scenario checks passed.`);
