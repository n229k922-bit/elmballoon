import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOrderSpecifications, specificationTextForFacts } from '../workers/admin-line-secretary/src/conversation-specifications.js';

test('phone and address have their own evidence, multiple contact roles remain uncollapsed', () => {
 assert.equal(extractOrderSpecifications('090-0000-0000に連絡ください').updates[0].key,'phone');
 assert.equal(extractOrderSpecifications('配達先担当者：090-0000-0000に連絡ください').updates[0].key,'delivery_phone');
 const multiple=extractOrderSpecifications('依頼者：090-0000-0000\n配達先：080-0000-0000');
 assert.equal(multiple.updates.length,0);assert.equal(multiple.items.length,2);
 assert.equal(extractOrderSpecifications('架空市中央3丁目1-2です♪').updates[0].value,'架空市中央3丁目1-2');
 assert.equal(extractOrderSpecifications('送り主住所：架空市中央3丁目1-2').updates.length,0);
});
test('explicit balloon and card text are preserved independently and never mistaken for fulfilment', () => {
 const one=extractOrderSpecifications('文字入れは：Happy Birthday 12\n受取は10月9日');
 assert.equal(one.updates[0].key,'balloon_message');assert.equal(one.updates[0].value,'Happy Birthday 12');
 const generic=extractOrderSpecifications('メッセージ→おめでとう\n贈り主B');
 assert.equal(generic.updates.length,0);assert.ok(generic.items[0].evidence.includes('贈り主B'));
 const both=extractOrderSpecifications('文字入れ：店舗A\nメッセージカード：送り主Bより');
 assert.equal(both.updates.length,2);assert.ok(both.items.length>=2);
 assert.equal(both.updates[0].value,'店舗A');assert.equal(both.updates[1].value,'送り主Bより');
});
test('multiple recipients and products retain original individual budgets without invented allocation', () => {
 const input='3名分です。Aは青で15000円、Bは小さく8000円、Cはピンクで10000円';
 const result=extractOrderSpecifications(input);
 assert.ok(result.items.some(item=>item.evidence===input));
 assert.ok(result.items.some(item=>item.evidence.includes('Bは小さく8000円')));
 const products=extractOrderSpecifications('アレンジ21番\nメッセージ→カードA\nアレンジ27番\nメッセージ→カードB');
 assert.equal(products.updates.length,0);assert.ok(products.items.some(item=>item.evidence.includes('カードA')&&item.evidence.includes('カードB')));
});
test('print dates, birth dates, packaging color and card body do not pollute generic facts', () => {
 const masked=specificationTextForFacts('生年月日：2026年2月20日、受取4月8日10時。持帰り赤袋、バルーンは青。カード日付2026.4');
 assert.doesNotMatch(masked,/2月20日|赤|2026\.4/u);assert.match(masked,/4月8日10時|青/u);
 assert.doesNotMatch(specificationTextForFacts('文字入れ：Happy birthday 12\n受取10月9日'),/12/u);
 assert.match(specificationTextForFacts('文字入れ：Happy birthday 12\n受取10月9日'),/10月9日/u);
});
test('pickup time windows are retained as windows rather than their last endpoint', () => {
 for (const [input, expected] of [['翌日10〜12時に受取ります','10:00〜12:00'],['8月17日12時30分〜13時に受取希望です','12:30〜13:00'],['昼休み12〜13時に受取ります','12:00〜13:00'],['12時半〜13時に受取希望','12:30〜13:00'],['今夜20時〜20時半に配達','20:00〜20:30']]) {
  assert.equal(extractOrderSpecifications(input).updates.find(item=>item.key==='receive_time')?.value,expected);
  assert.doesNotMatch(specificationTextForFacts(input),/12時|13時/u);
 }
 assert.equal(extractOrderSpecifications('支払相談は10〜12時').updates.some(item=>item.key==='receive_time'),false);
});
