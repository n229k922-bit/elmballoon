import assert from 'node:assert/strict';
import vm from 'node:vm';
import { managerConsole } from '../workers/admin-line-secretary/src/manager-console.js';

const html=await managerConsole().text();
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
const calls=[];
function element(tag,text){return {tag,text,value:'',children:[],append(...nodes){this.children.push(...nodes)},setAttribute(){}}}
const context={labels:{quantity:'数量',phone:'電話番号'},el:element,button:(text,action)=>({text,action}),command:async text=>calls.push(text)};
vm.createContext(context);
const editorCode=script.split('\n').find(line=>line.startsWith('function fieldEditor('));
vm.runInContext(editorCode,context);
const editor=context.fieldEditor('M0000000000000001',[{field_key:'quantity',value_text:'3'}]);
const select=editor.children.find(node=>node.tag==='select');
const input=editor.children.find(node=>node.tag==='textarea');
const save=editor.children.find(node=>node.action);
select.value='phone';select.onchange();
assert.equal(input.value,'');
await assert.rejects(save.action(),/入力/);
input.value=' 090-0000-0000 ';
await save.action();
assert.equal(calls[0],'項目確定 M0000000000000001 phone：090-0000-0000');
select.value='quantity';select.onchange();
assert.equal(input.value,'3');
assert.match(script,/c\.append\(dl,fieldEditor\(orderId,d\.fields\)\)/);
console.log('Mobile field editor: empty input, missing fields, existing-value edits and command binding passed.');
