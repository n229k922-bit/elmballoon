import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { managerConsole } from '../workers/admin-line-secretary/src/manager-console.js';

const html = await managerConsole().text();
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const helpers = script.slice(script.indexOf('const states='),script.indexOf('function el('));
const context = vm.createContext({});
vm.runInContext(helpers, context);

test('manager page script remains valid after copy changes',()=> {
  assert.doesNotThrow(()=>new vm.Script(script));
});
test('routine order cards do not display internal order ids',()=> {
  assert.ok(!script.includes("el('div',o.id,'muted')"));
  assert.ok(!script.includes("el('div',orderId,'muted')"));
  assert.ok(script.includes("command('承認送信 '+draft.id)"));
  assert.ok(script.includes("command('変更承認 '+change.id)"));
});
test('budget and business dates use understandable labels without changing stored values',()=> {
  assert.equal(vm.runInContext("friendlyValue('budget_scope','total')",context),'全体のご予算');
  assert.equal(vm.runInContext("friendlyValue('budget_scope','unit')",context),'1個あたりのご予算');
  assert.equal(vm.runInContext("friendlyValue('receive_date','2026-10-09')",context),'2026年10月9日');
  assert.equal(vm.runInContext("friendlyValue('phone','08012345678')",context),'08012345678');
});
test('unknown status and server codes are not presented as technical words',()=> {
  assert.equal(vm.runInContext("friendlyState('new_internal_state')",context),'確認が必要です');
  assert.equal(vm.runInContext("friendlyReview('needs_review')",context),'内容・本人の確認前');
  assert.ok(!vm.runInContext("friendlyError('database_internal_error')",context).includes('database'));
  assert.ok(!script.includes("'送信の確認が必要：'+f.status"));
  assert.ok(script.includes('重複を防ぐため、再送はしていません。'));
});
test('reply actions are conversational, numbered and preserve revision-first safeguard',()=> {
  for(const text of ['1：この返信を送る','2：修正した文章を保存','3：あとで確認する'])assert.ok(script.includes(text));
  assert.ok(script.includes("if(area.value!==draft.message)throw new Error"));
  assert.ok(script.includes("command('対応確認 '+orderId)"));
});
