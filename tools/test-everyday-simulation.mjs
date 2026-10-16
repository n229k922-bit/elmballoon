import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { receiveManagerEvents, drainManagerInbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

// Synthetic customers, fixed dates, local SQLite only. No real messages are sent.
const anchor = Date.parse('2026-10-19T01:00:00Z');
const routine = /いつ頃|いつごろ|ご希望日|希望日は|どのような|どんな|いくつ|ご予算|ご希望のお色|ご希望の色/u;
function setup(t) {
  const f = createManagerFixture();
  t.after(() => f.db.close());
  f.env.MANAGER_RELEASE_STAGE = 'live';
  let tick = 0;
  const fields = () => Object.fromEntries(f.db.prepare('SELECT field_key,value_text FROM manager_fields WHERE order_id=(SELECT id FROM manager_orders ORDER BY rowid LIMIT 1)').all().map(r => [r.field_key, r.value_text]));
  const send = async text => {
    const at = anchor + tick++ * 60000;
    const id = `SYNTH-EVERYDAY-${tick}`;
    await receiveManagerEvents([{type:'message',webhookEventId:id,timestamp:at,source:{userId:'SYNTH-EVERYDAY'},message:{id,type:'text',text}}], f.env, new Date(at).toISOString());
    await drainManagerInbox(f.env, new Date(at + 30000).toISOString());
  };
  const draft = () => f.db.prepare('SELECT message FROM manager_drafts ORDER BY rowid DESC LIMIT 1').get()?.message || '';
  return {...f, fields, send, draft};
}

test('日常01: 挨拶のお礼に含む「今日」は予約日を変更しない', async t => {
  const f = setup(t);
  await f.send('11月7日10時にブーケ3個、合計3000円で店頭受取希望です');
  assert.equal(f.fields().receive_date, '2026-11-07', '事前条件: 予約日が保存される');
  const before = f.fields();
  await f.send('今日もありがとうございます。よろしくお願いします');
  assert.deepEqual(f.fields(), before, '期待: 注文情報は不変。実際: お礼で情報が変化');
});

test('日常02: 既存注文と別件が一文に混在しても元の注文を壊さない', async t => {
  const f = setup(t);
  await f.send('11月7日10時にブーケ3個、合計3000円で店頭受取');
  const before = f.fields();
  await f.send('前の注文はそのままで。別件でスタンド1台を11月14日17時に配達、予算15000円です');
  assert.deepEqual(f.fields(), before, '期待: 元注文の全項目を維持。実際: 別件の情報が混入');
});

test('日常03: 候補日2つを確定した受取日として扱わない', async t => {
  const f = setup(t);
  await f.send('11月7日10時にブーケ1つ店頭受取');
  await f.send('11月8日か11月9日に受け取りを変更したいです');
  assert.equal(f.fields().receive_date, '2026-11-07', '期待: 候補日は要確認、元の受取日は維持');
});

test('日常04: 受取変更で旧日付と新時刻を合成しない', async t => {
  const f = setup(t);
  await f.send('受取日：10月31日。受取時間：12時。使用日：11月1日。ブーケ1つ店頭受取');
  await f.send('受け取りだけ30日の18時に変更できますか？使用は11月1日のままです');
  const actual = f.fields();
  assert.ok(!(actual.receive_date === '2026-10-31' && actual.receive_time === '18:00'), `期待: 旧日付+新時刻は禁止。実際: ${JSON.stringify(actual)}`);
  assert.equal(actual.use_date, '2026-11-01', '期待: 使用日を維持');
});

test('日常05: 苦情の確認待ちにお礼が来ても通常受付を再開しない', async t => {
  const f = setup(t);
  await f.send('昨日受け取ったバルーンがしぼみました。交換してください');
  assert.doesNotMatch(f.draft(), routine, '期待: 苦情への通常商品質問なし');
  await f.send('ありがとうございます。確認のご連絡を待っています');
  assert.doesNotMatch(f.draft(), routine, '期待: お礼後も人の確認待ち。実際: 通常質問を再開');
});

test('日常06: 見送り後のお礼で注文を再開しない', async t => {
  const f = setup(t);
  await f.send('誕生日のブーケを検討しています');
  await f.send('今回は見送ります');
  await f.send('ありがとうございます。またお願いします');
  assert.doesNotMatch(f.draft(), routine, '期待: 見送り後の通常質問なし');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM manager_orders WHERE production_status='confirmed'").get().n, 0, '期待: 注文を確定しない');
});

test('日常07: 弔事の初回と後続のお礼に祝い文言を付けない', async t => {
  const f = setup(t);
  for (const text of ['葬儀のお供え用に白のバルーンを相談したいです', 'ありがとうございます。白で控えめにお願いします']) {
    await f.send(text);
    assert.ok(f.draft(), '期待: 店長確認用の返信案がある');
    assert.doesNotMatch(f.draft(), /😊|🎉|おめでとう|お祝い/u, `期待: 弔事の控えた応答。入力: ${text}`);
  }
});

test('日常08: 色の否定訂正では否定された赤を記録しない', async t => {
  const f = setup(t);
  await f.send('ブーケ1個、赤ではなくピンクでお願いします');
  assert.equal(f.fields().color_vibe, 'ピンク', '期待: ピンクのみ。実際: 色の否定を誤抽出');
});

test('日常09: 数量の訂正では否定された数量を記録しない', async t => {
  const f = setup(t);
  await f.send('ブーケを3個ではなく1個でお願いします');
  assert.equal(f.fields().quantity, '1', '期待: 1個。実際: 否定された3個を誤抽出');
});

test('日常10: 配達できるかの質問は配達の確定希望にしない', async t => {
  const f = setup(t);
  await f.send('11月7日にブーケ1個、店頭受取希望です');
  const before = f.fields().fulfillment_method;
  assert.equal(before, '店頭受取', '事前条件: 店頭受取が保存される');
  await f.send('配達できますか？');
  assert.equal(f.fields().fulfillment_method, before, '期待: 配達可否の相談で受取方法を上書きしない');
});
