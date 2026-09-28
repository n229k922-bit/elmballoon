import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sourcePath = new URL('../workers/admin-line-secretary/src/index.js', import.meta.url);
const source = fs.readFileSync(sourcePath, 'utf8')
  .replace('export default {', 'const workerDefault = {')
  + `\nglobalThis.__orderTests = {
    orderReply, collectOrderDetail, missingIntakeFields, splitCustomerReply,
    extractOrderRecordUpdates, orderFieldStatus, basicOrderConfirmation,
    summarizeOwnerReviewFromRecord, extractScheduleCandidate,
    parseFlexibleCustomerDate, parseFlexibleCustomerTime, formatOrderRecordCard,
    shouldBypassCustomerMessageBundle, createBundledCustomerEvent,
    processCustomerMessageBundleAfterWait, createOrderDisplayCode,
    formatAmbiguousOrderChoices, orderRecordStatusLabel, formatOrderUpdateConflicts
  };`;

const context = vm.createContext({
  console,
  TextEncoder,
  URL,
  URLSearchParams,
  Response,
  Request,
  Headers,
  fetch,
  crypto,
  btoa,
  atob,
  setTimeout,
  clearTimeout,
});
vm.runInContext(source, context, { filename: sourcePath.pathname });

const {
  orderReply,
  collectOrderDetail,
  missingIntakeFields,
  splitCustomerReply,
  extractOrderRecordUpdates,
  orderFieldStatus,
  basicOrderConfirmation,
  summarizeOwnerReviewFromRecord,
  extractScheduleCandidate,
  parseFlexibleCustomerDate,
  parseFlexibleCustomerTime,
  formatOrderRecordCard,
  shouldBypassCustomerMessageBundle,
  createBundledCustomerEvent,
  processCustomerMessageBundleAfterWait,
  createOrderDisplayCode,
  formatAmbiguousOrderChoices,
  orderRecordStatusLabel,
  formatOrderUpdateConflicts,
} = context.__orderTests;

const session = { stage: 'new', fields: {}, customerKind: 'new' };
const start = orderReply('注文担当を呼び出します', session);
assert.equal(start.session.stage, 'collecting');
assert.equal(missingIntakeFields(start.session.fields).length, 8);
assert.match(start.message, /プレゼント・使用予定日/);
assert.doesNotMatch(start.message, /・お名前：/);
assert.doesNotMatch(start.message, /メッセージカードの有無/);
assert.equal(splitCustomerReply(start.message).length, 3);

const answer = `【ご注文内容】
・HPの商品番号 または参考画像：バルーンアレンジ36番
・バルーンのタイプ：置き型アレンジメント
・ご予算：15,000円くらい
・全体的なお色味と雰囲気：ブルー系で明るい雰囲気
・プレゼント・使用予定日：10月3日
・受取希望日：10月2日
・受取希望時間：14時頃
・受取方法：店頭受取`;

const completed = collectOrderDetail(answer, start.session);
assert.equal(completed.session.stage, 'review');
assert.equal(missingIntakeFields(completed.session.fields).length, 0);
assert.equal(completed.session.fields.useDateValue, '10月3日');
assert.equal(completed.session.fields.receiveDateValue, '10月2日');
assert.equal(completed.session.fields.receiveTimeValue, '14時頃');

const confirmation = basicOrderConfirmation(answer, completed.session);
assert.match(confirmation, /商品番号・参考画像：36/);
assert.match(confirmation, /プレゼント・使用予定日：10月3日/);
assert.match(confirmation, /受取希望日：10月2日/);
assert.match(confirmation, /ご予算：15,000円くらい/);

const updates = extractOrderRecordUpdates(answer, false, null);
const updateMap = Object.fromEntries(updates.map((update) => [update.key, update]));
assert.equal(updateMap.product_source.value, '36');
assert.equal(updateMap.product_type.value, '置き型アレンジメント');
assert.equal(updateMap.budget.value, '15,000円くらい');
assert.equal(updateMap.use_date.value, '10月3日');
assert.equal(updateMap.receive_date.value, '10月2日');
assert.equal(updateMap.receive_time.value, '14時頃');
assert.equal(updateMap.fulfillment_method.value, '店頭受取');
assert.equal(orderFieldStatus('未定', 'budget'), 'undecided');
assert.equal(orderFieldStatus('なし', 'card_message'), 'not_applicable');

const placeholderSession = orderReply('注文担当を呼び出します', {
  stage: 'new', fields: {}, customerKind: 'new',
}).session;
const placeholderAnswer = `【ご注文内容】📷
・HPの商品番号 または参考画像：36
（例：バルーンアレンジ36番／画像添付済み／未定）
・バルーンのタイプ：置き型アレンジメント
（ブーケ／置き型アレンジメント／ヘリウム〈浮く〉タイプ／未定）
・ご予算：3000
（例：15,000円くらい／未定）
・全体的なお色味と雰囲気：パープル系・派手な感じ
（例：ピンク系で可愛い雰囲気／お任せ／未定）
・プレゼント・使用予定日：来月1日
（例：10月3日／未定）
・受取希望日：
（例：10月2日／未定）
・受取希望時間：
（例：14時頃／未定）
・受取方法：
（店頭受取／配達／発送／未定）`;
const placeholderResult = collectOrderDetail(placeholderAnswer, placeholderSession);
assert.equal(placeholderResult.session.stage, 'collecting');
assert.deepEqual(
  [...missingIntakeFields(placeholderResult.session.fields)],
  ['受取希望日', '受取希望時間', '受取方法'],
);
assert.equal(placeholderResult.session.fields.receiveDateValue, null);
assert.equal(placeholderResult.session.fields.receiveTimeValue, null);
assert.equal(placeholderResult.session.fields.methodValue, null);
assert.match(placeholderResult.message, /受取希望日/);
assert.match(placeholderResult.message, /受取希望時間/);
assert.match(placeholderResult.message, /受取方法/);
const placeholderUpdates = Object.fromEntries(
  extractOrderRecordUpdates(placeholderAnswer, false, null).map((update) => [update.key, update]),
);
assert.equal(placeholderUpdates.receive_date, undefined);
assert.equal(placeholderUpdates.receive_time, undefined);
assert.equal(placeholderUpdates.fulfillment_method, undefined);

const nextLineSession = orderReply('注文担当を呼び出します', {
  stage: 'new', fields: {}, customerKind: 'new',
}).session;
const nextLineAnswer = `・HPの商品番号 または参考画像：
36
・バルーンのタイプ：
置き型アレンジメント
・ご予算：
3000円
・全体的なお色味と雰囲気：
パープル系
・プレゼント・使用予定日：
10月3日
・受取希望日：
10月2日
・受取希望時間：
14時頃
・受取方法：
店頭受取`;
const nextLineResult = collectOrderDetail(nextLineAnswer, nextLineSession);
assert.equal(nextLineResult.session.stage, 'review');
assert.equal(missingIntakeFields(nextLineResult.session.fields).length, 0);
assert.equal(nextLineResult.session.fields.receiveDateValue, '10月2日');
assert.equal(nextLineResult.session.fields.receiveTimeValue, '14時頃');
assert.equal(nextLineResult.session.fields.methodValue, '店頭受取');

const blankTemplateSession = orderReply('注文担当を呼び出します', {
  stage: 'new', fields: {}, customerKind: 'new',
}).session;
const blankTemplateResult = collectOrderDetail(`・HPの商品番号 または参考画像：
（例：バルーンアレンジ36番／画像添付済み／未定）
・バルーンのタイプ：
（ブーケ／置き型アレンジメント／ヘリウム〈浮く〉タイプ／未定）
・ご予算：
（例：15,000円くらい／未定）
・全体的なお色味と雰囲気：
（例：ピンク系で可愛い雰囲気／お任せ／未定）
・プレゼント・使用予定日：
（例：10月3日／未定）
・受取希望日：
（例：10月2日／未定）
・受取希望時間：
（例：14時頃／未定）
・受取方法：
（店頭受取／配達／発送／未定）`, blankTemplateSession);
assert.equal(blankTemplateResult.session.stage, 'collecting');
assert.equal(missingIntakeFields(blankTemplateResult.session.fields).length, 8);
assert.equal(extractOrderRecordUpdates(blankTemplateResult.session.fields.lastCustomerMessage, false, null).length, 0);

const undecidedUpdates = extractOrderRecordUpdates(`・HPの商品番号 または参考画像：未定
・バルーンのタイプ：未定
・ご予算：未定
・全体的なお色味と雰囲気：お任せ
・プレゼント・使用予定日：R8/10/3
・受取希望日：令和8年10月2日
・受取希望時間：午後2時頃
・受取方法：未定`, false, null);
const undecidedMap = Object.fromEntries(undecidedUpdates.map((update) => [update.key, update]));
assert.equal(undecidedMap.product_source.status, 'undecided');
assert.equal(undecidedMap.product_type.status, 'undecided');
assert.equal(undecidedMap.budget.status, 'undecided');
assert.equal(undecidedMap.use_date.value, 'R8/10/3');
assert.equal(undecidedMap.receive_date.value, '令和8年10月2日');
assert.equal(parseFlexibleCustomerDate('R8/10/3').date, '2026-10-03');
assert.equal(parseFlexibleCustomerDate('令和8年10月2日').date, '2026-10-02');
assert.equal(parseFlexibleCustomerDate('2026-10-01').date, '2026-10-01');
assert.equal(parseFlexibleCustomerTime('午後2時頃'), '14:00');
assert.equal(parseFlexibleCustomerTime('14:30頃'), '14:30');
const schedule = extractScheduleCandidate(answer);
assert.equal(schedule.date, '2026-10-02');
assert.equal(schedule.time, '14:00');
assert.equal(schedule.type, 'pickup');

const fieldRows = Object.fromEntries(updates.map((update) => [update.key, {
  value_text: update.value,
  status: update.status,
}]));
const managerSummary = summarizeOwnerReviewFromRecord('テスト様', { sequence_number: 2 }, fieldRows);
assert.match(managerSummary, /注文カルテ No\.2/);
assert.match(managerSummary, /商品番号・参考画像：36/);
assert.match(managerSummary, /制作可否・在庫・納期・受取方法の判断待ち/);

const card = formatOrderRecordCard('テスト様', {
  sequence_number: 2,
  status: 'feasibility_review',
}, fieldRows, 1);
assert.match(card, /制作可否の判断待ち/);
assert.match(card, /【確認済み】/);
assert.match(card, /内容変更 1件/);

assert.equal(shouldBypassCustomerMessageBundle({ message: { type: 'text', text: '注文担当を呼び出します' } }), true);
assert.equal(shouldBypassCustomerMessageBundle({ message: { type: 'text', text: '届いた商品が破損しています' } }), true);
assert.equal(shouldBypassCustomerMessageBundle({ message: { type: 'text', text: '予算は15,000円です' } }), false);
assert.equal(shouldBypassCustomerMessageBundle({ message: { type: 'image' } }), false);

const bundledEvent = createBundledCustomerEvent('U-test', {
  latest_source_event_id: 'event-3',
  has_image: 1,
}, [
  { message_text: '注文担当を呼び出します' },
  { message_text: '予算は15,000円です' },
  { message_text: '[参考画像]' },
  { message_text: 'ブルー系でお願いします' },
]);
assert.equal(bundledEvent.__bundled, true);
assert.equal(bundledEvent.__bundleHasImage, true);
assert.equal(bundledEvent.__bundleMessageCount, 4);
assert.equal(bundledEvent.message.type, 'text');
assert.equal(bundledEvent.message.text, '予算は15,000円です\nブルー系でお願いします');

const supersededEnv = {
  DB: {
    prepare() {
      return {
        bind() { return this; },
        async first() { return { generation: 'newer-generation' }; },
      };
    },
  },
};
assert.equal(await processCustomerMessageBundleAfterWait('U-test', 'old-generation', supersededEnv, 0), false);

const displayCode = createOrderDisplayCode(1_790_000_000_000, 0.5);
assert.match(displayCode, /^K[A-Z0-9]{7}$/);
assert.equal(orderRecordStatusLabel('production'), '制作中');
const ambiguous = formatAmbiguousOrderChoices([
  { display_code: 'KABC123', customer_confirmed_name: '山田花子', status: 'confirmed' },
  { display_code: 'KDEF456', customer_display_name: '田中', status: 'production' },
], '制作開始 カルテ番号');
assert.match(ambiguous, /KABC123：山田花子さん（注文確定）/);
assert.match(ambiguous, /例：制作開始 KABC123/);
const conflictText = formatOrderUpdateConflicts([
  { fieldKey: 'receive_time', oldValue: '14時頃', newValue: '15時頃' },
  { fieldKey: 'budget', oldValue: '15,000円', newValue: '18,000円' },
]);
assert.match(conflictText, /受取希望時間[\s\S]*変更前：14時頃[\s\S]*変更後：15時頃/);
assert.match(conflictText, /ご予算[\s\S]*変更前：15,000円[\s\S]*変更後：18,000円/);

console.log('order record workflow tests: 70 assertions passed');
