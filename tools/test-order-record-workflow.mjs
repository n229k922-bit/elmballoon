import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sourcePath = new URL('../workers/admin-line-secretary/src/index.js', import.meta.url);
const source = fs.readFileSync(sourcePath, 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export default {', 'const workerDefault = {')
  + `\nglobalThis.__orderTests = {
    orderReply, selectOrderRoute, collectScheduleDetail, collectOrderDetail, missingIntakeFields, splitCustomerReply,
    extractOrderRecordUpdates, orderFieldStatus, basicOrderConfirmation,
    summarizeOwnerReviewFromRecord, extractScheduleCandidate,
    parseFlexibleCustomerDate, parseFlexibleCustomerTime, formatOrderRecordCard,
    shouldBypassCustomerMessageBundle, createBundledCustomerEvent,
    processCustomerMessageBundleAfterWait, createOrderDisplayCode,
    formatAmbiguousOrderChoices, orderRecordStatusLabel, formatOrderUpdateConflicts,
    ownerDecisionScopeMarker, ownerNotificationAction, formatOwnerDecisionRequest,
    appendOwnerReviewEvents, formatPendingOwnerDecisionList, richMenuPrompt,
    notifyOwners, productReferenceFromOwnerSummary, formatCalendarReport,
    normalizeManagerCommand, detectOrderRiskFlags, detectProductType, productTypeLabel, googleClientId, googleClientSecret
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
  selectOrderRoute,
  collectScheduleDetail,
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
  ownerDecisionScopeMarker,
  ownerNotificationAction,
  formatOwnerDecisionRequest,
  appendOwnerReviewEvents,
  formatPendingOwnerDecisionList,
  richMenuPrompt,
  notifyOwners,
  productReferenceFromOwnerSummary,
  formatCalendarReport,
  normalizeManagerCommand,
  detectOrderRiskFlags,
  detectProductType,
  productTypeLabel,
  googleClientId,
  googleClientSecret,
} = context.__orderTests;

const session = { stage: 'new', fields: {}, customerKind: 'new' };
const start = orderReply('注文担当を呼び出します', session);
assert.equal(start.session.stage, 'awaiting_order_route');
assert.match(start.message, /1：商品番号・参考画像がある/);
assert.match(start.message, /2：商品は未定で、店頭で相談したい/);
assert.match(start.message, /3：商品・ご予算がある程度決まっている/);
assert.match(start.message, /4：日程・受け取り方法を先に相談したい/);
assert.match(start.message, /①.*丸数字でも受け付けています/u);
const routed = orderReply('①', start.session);
assert.equal(routed.session.stage, 'collecting');
assert.equal(missingIntakeFields(routed.session.fields).length, 8);
assert.match(routed.message, /プレゼント・使用予定日/);
assert.match(routed.message, /店舗対応時間は10:00〜16:00/);
assert.doesNotMatch(routed.message, /・お名前：/);
assert.doesNotMatch(routed.message, /メッセージカードの有無/);
assert.equal(splitCustomerReply(routed.message).length, 3);

const scheduleStart = orderReply('注文担当を呼び出します', { stage: 'new', fields: {}, customerKind: 'new' });
const storeVisitRoute = selectOrderRoute('②', scheduleStart.session);
assert.equal(storeVisitRoute.session.stage, 'schedule_consulting');
assert.match(storeVisitRoute.message, /来店希望日/);
assert.doesNotMatch(storeVisitRoute.message, /店長へ/);
const storeVisitResult = collectScheduleDetail('・来店希望日：10月10日\n・来店希望時間帯：午後2時', storeVisitRoute.session);
assert.equal(storeVisitResult.session.stage, 'review');
assert.equal(storeVisitResult.session.fields.receiveDateValue, '10月10日');
assert.equal(storeVisitResult.session.fields.methodValue, '店頭相談');

const proposalRoute = selectOrderRoute('③', { stage: 'awaiting_order_route', fields: {}, customerKind: 'new' });
assert.equal(proposalRoute.session.stage, 'consulting');
assert.match(proposalRoute.message, /ご予算/);
const scheduleRoute = selectOrderRoute('④', { stage: 'awaiting_order_route', fields: {}, customerKind: 'new' });
assert.equal(scheduleRoute.session.stage, 'schedule_consulting');
assert.match(scheduleRoute.message, /ご希望日/);
const scheduleResult = collectScheduleDetail('・ご希望日：10月10日\n・希望時間帯：午後2時\n・受け取り方法：店頭受取', scheduleRoute.session);
assert.equal(scheduleResult.session.stage, 'review');
assert.equal(scheduleResult.session.fields.receiveDateValue, '10月10日');
assert.equal(scheduleResult.session.fields.receiveTimeValue, '午後2時');
assert.equal(scheduleResult.session.fields.methodValue, '店頭受取');
assert.equal(detectProductType('・バルーンのタイプ：バルーンスタンド'), 'balloon_stand');
assert.equal(detectProductType('・バルーンのタイプ：その他（オリジナル装飾）'), 'other');
assert.equal(productTypeLabel('other'), 'その他（自由記載）');

const answer = `【ご注文内容】
・HPの商品番号 または参考画像：バルーンアレンジ36番
・バルーンのタイプ：置き型アレンジメント
・ご予算：15,000円くらい
・全体的なお色味と雰囲気：ブルー系で明るい雰囲気
・プレゼント・使用予定日：10月3日
・受取希望日：10月2日
・受取希望時間：14時頃
・受取方法：店頭受取`;

const completed = collectOrderDetail(answer, routed.session);
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

const placeholderSession = orderReply('①', orderReply('注文担当を呼び出します', {
  stage: 'new', fields: {}, customerKind: 'new',
}).session).session;
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

const nextLineSession = orderReply('①', orderReply('注文担当を呼び出します', {
  stage: 'new', fields: {}, customerKind: 'new',
}).session).session;
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

const blankTemplateSession = orderReply('①', orderReply('注文担当を呼び出します', {
  stage: 'new', fields: {}, customerKind: 'new',
}).session).session;
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

const shorthandPickupSchedule = extractScheduleCandidate(`・受取希望日：来週木曜日
・受取希望時間：午後2時半
・受取方法：店頭`);
assert.equal(shorthandPickupSchedule.type, 'pickup');
assert.equal(shorthandPickupSchedule.time, '14:30');
assert.equal(shorthandPickupSchedule.dateExpression, '来週木曜日');
assert.equal(ownerDecisionScopeMarker({ display_code: 'KTEST01', sequence_number: 7 }), '%注文カルテ KTEST01%');
assert.equal(ownerDecisionScopeMarker({ display_code: null, sequence_number: 7 }), '%注文カルテ No.7%');
assert.equal(ownerNotificationAction('owner-decision:decision:test'), 'owner.notification:owner-decision:decision:test');
const ownerReport = formatOwnerDecisionRequest({
  id: 'decision:test',
  requestTypes: ['schedule'],
  customerSummary: 'テスト注文',
}, {
  name: 'バルーンアレンジ㊱',
  product_number: '36',
  product_url: 'https://example.com/item-36',
});
assert.match(ownerReport, /商品名：バルーンアレンジ㊱/);
assert.match(ownerReport, /該当する商品画像をこの報告に添付/);
assert.match(ownerReport, /【返信方法】/);
assert.match(ownerReport, /・1 受ける：この内容で対応可能/);
assert.match(ownerReport, /・1 難しい 理由：対応が難しい/);
assert.match(ownerReport, /1 受ける/);
assert.doesNotMatch(ownerReport, /店長確認 decision:/);
const pendingMenuReport = formatPendingOwnerDecisionList([
  { display_code: 'KABC123', customer_summary: '山田花子さんからの聞き取り内容\n\n【制作可否の確認項目】\n・ご予算：15,000円' },
], true);
assert.match(pendingMenuReport, /【確認待ち一覧】/);
assert.match(pendingMenuReport, /1 受ける/);
assert.match(pendingMenuReport, /正式カルテ番号/);
assert.match(richMenuPrompt('日付変更依頼'), /店休日・営業時間の変更/);
assert.match(richMenuPrompt('日付変更依頼'), /お客様の注文日時の変更ではありません/);
assert.match(richMenuPrompt('お客様への返信依頼'), /1 お客様へ/);
assert.match(richMenuPrompt('お客様への返信依頼'), /1 指定メッセージ/);
assert.match(formatCalendarReport('2026-10-05', '20:00', '21:00', []), /夜間の配達は.*個別にご案内/);
assert.match(richMenuPrompt('制作進捗更新'), /はい／いいえ/);
assert.match(richMenuPrompt('制作進捗更新'), /制作が完成しました/);
assert.match(richMenuPrompt('制作進捗更新'), /遠隔クレジット決済.*手動/);
assert.match(richMenuPrompt('システム変更依頼'), /変更案と影響範囲を整理/);
assert.equal(googleClientId({ GOOGLE_OAUTH_CLIENT_ID: 'oauth-id' }), 'oauth-id');
assert.equal(googleClientId({ GOOGLE_CLIENT_ID: 'legacy-id' }), 'legacy-id');
assert.equal(googleClientSecret({ GOOGLE_OAUTH_CLIENT_SECRET: 'oauth-secret' }), 'oauth-secret');
const consolidatedOwnerSummary = appendOwnerReviewEvents('テスト様からの聞き取り内容', [
  { event_type: 'customer.name_confirmed', detail: JSON.stringify({ name: '山田花子' }) },
  { event_type: 'product.reference_unmatched', detail: JSON.stringify({ reference: '36' }) },
  { event_type: 'product.reference_unmatched', detail: JSON.stringify({ reference: '36' }) },
  { event_type: 'schedule.conflict', detail: JSON.stringify({ requested: '2026年10月2日 14:00', detail: 'この日は店休日です。' }) },
]);
assert.match(consolidatedOwnerSummary, /【追加確認事項】/);
assert.match(consolidatedOwnerSummary, /商品番号「36」/);
assert.match(consolidatedOwnerSummary, /この日は店休日です/);
assert.equal((consolidatedOwnerSummary.match(/商品番号「36」/g) || []).length, 1);

const ownerNotificationAudits = [];
const notificationEnv = {
  ADMIN_LINE_USER_IDS: 'U-manager',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
  DB: {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async run() { ownerNotificationAudits.push({ sql, args: this.args }); return { meta: { changes: 1 } }; },
      };
    },
  },
};
const originalFetch = context.fetch;
context.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
const notificationResult = await notifyOwners('統括報告', notificationEnv, [], 'owner-decision:decision:test');
context.fetch = originalFetch;
assert.equal(notificationResult.requested, 1);
assert.equal(notificationResult.sent, 1);
assert.equal(notificationResult.error, null);
assert.equal(ownerNotificationAudits.length, 1);
assert.equal(ownerNotificationAudits[0].args[1], 'owner.notification:owner-decision:decision:test');
assert.equal(productReferenceFromOwnerSummary('・商品番号・参考画像：36\n・ご予算：15,000円'), '36');
assert.equal(productReferenceFromOwnerSummary('・商品番号・参考画像：参考画像あり'), null);
assert.equal(productReferenceFromOwnerSummary('・商品番号・参考画像：未定'), null);

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
assert.match(ambiguous, /例：1 制作開始/);
assert.equal(normalizeManagerCommand('1 受ける'), '受ける 1');
assert.equal(normalizeManagerCommand('2 難しい 納期が合わない'), '難しい 2 納期が合わない');
assert.equal(normalizeManagerCommand('1 支払案内済み'), '支払案内済み 1');
assert.match(detectOrderRiskFlags('明日の夜に配達、画像と同じ仕上がり、返金の相談', { time: '20:00' }).join('\n'), /直前・急ぎ/);
assert.match(detectOrderRiskFlags('明日の夜に配達、画像と同じ仕上がり、返金の相談', { time: '20:00' }).join('\n'), /夜間配達/);
const conflictText = formatOrderUpdateConflicts([
  { fieldKey: 'receive_time', oldValue: '14時頃', newValue: '15時頃' },
  { fieldKey: 'budget', oldValue: '15,000円', newValue: '18,000円' },
]);
assert.match(conflictText, /受取希望時間[\s\S]*変更前：14時頃[\s\S]*変更後：15時頃/);
assert.match(conflictText, /ご予算[\s\S]*変更前：15,000円[\s\S]*変更後：18,000円/);

console.log('order record workflow tests: 101 assertions passed');
