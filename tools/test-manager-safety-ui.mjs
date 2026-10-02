import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {managerConsole} from '../workers/admin-line-secretary/src/manager-console.js';

async function fixture(){
 const html=await managerConsole().text();
 const code=html.match(/function safetyControls\(orderId\)\{[\s\S]*?\n\}/)[0];
 const nodes=[],commands=[];let accepted=true;
 const node=(tag,text)=>{const value={tag,text,value:'',children:[],append(...items){this.children.push(...items);},setAttribute(){}};nodes.push(value);return value;};
 const context=vm.createContext({el:node,button:(text,fn)=>{const n=node('button',text);n.run=fn;return n;},command:async text=>commands.push(text),window:{confirm:()=>accepted},Error,Number,JSON});
 vm.runInContext(code+'; safetyControls("M0123456789ABCDEF");',context);
 const inputs=nodes.filter(n=>n.tag==='input');
 const button=text=>nodes.find(n=>n.tag==='button'&&n.text===text);
 return {inputs,button,commands,cancel:()=>{accepted=false;}};
}
test('mobile capacity form rejects missing/negative values and preserves separate production and handoff dates',async()=>{
 const f=await fixture();
 await assert.rejects(f.button('その日の受付上限を保存').run());assert.equal(f.commands.length,0);
 const values=['2026-10-10','480','3','8','2026-10-09','2026-10-10','60','0'];
 f.inputs.forEach((input,i)=>input.value=values[i]);
 await f.button('その日の受付上限を保存').run();assert.equal(f.commands[0],'受付上限 2026-10-10 480 3 8');
 await f.button('この注文の枠を確保').run();const requirements=JSON.parse(f.commands[1].split(' ').slice(2).join(' '));
 assert.deepEqual(requirements.map(r=>r.date),['2026-10-09','2026-10-10']);
 assert.equal(requirements[0].production_minutes,60);assert.equal(requirements[1].order_count,1);
 f.inputs[6].value='-1';await assert.rejects(f.button('この注文の枠を確保').run());assert.equal(f.commands.length,2);
});
test('manual review acknowledgement requires an explicit confirmation and targets one order',async()=>{
 const f=await fixture();await f.button('手動対応の内容とカルテを確認済み').run();
 assert.equal(f.commands[0],'対応確認 M0123456789ABCDEF');
 f.cancel();await f.button('手動対応の内容とカルテを確認済み').run();assert.equal(f.commands.length,1);
});
