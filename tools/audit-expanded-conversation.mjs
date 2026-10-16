import assert from 'node:assert/strict';
import {planConversation, startsNewOrder} from '../workers/admin-line-secretary/src/conversation.js';
const fields={product_type:'ブーケ',quantity:'3',budget:'3,000円（合計）',budget_scope:'total',receive_date:'2026-11-07',fulfillment_method:'店頭受取',color_vibe:'おまかせ'};
const specs=[
 {id:'EXP-G01',intent:'mixed_orders',text:'ブーケは7日の10時希望です。あと別件なんですが、スタンドも1台15000円で11月14日17時に配達希望です',expected:'元注文の数量・予算・方法を上書きしない',check:p=>!p.updates.some(u=>['quantity','budget','fulfillment_method'].includes(u.key))},
 {id:'EXP-G02',intent:'off_topic',text:'ところで今日の天気は？',expected:'雑談で注文フィールドを更新しない',check:p=>p.updates.length===0},
 {id:'EXP-G03',intent:'withdrawal',text:'今回は見送ります。また連絡します',expected:'通常の対応可否確認を続けない',check:p=>!p.ownerReasons.includes('review_collected_details')&&!p.questions.length},
 {id:'EXP-G04',intent:'human_handoff',text:'話が違います。最悪です。責任者と話したい',expected:'通常の注文可否確認ではなく人への交代を明示',check:p=>p.intent.kind==='handoff'&&p.ownerReasons.includes('human_handoff')&&/担当者|人の担当|責任者|店長/u.test(p.message)&&!p.questions.length},
 {id:'EXP-G05',intent:'safety',text:'割れた風船を子供が飲み込んだかもしれません',expected:'安全専用の分岐と人への緊急引継ぎ。医療文面そのものは別審査',check:p=>p.ownerReasons.some(r=>/safety|emergency/u.test(r))&&!p.questions.length},
 {id:'EXP-G06',intent:'closing',text:'ありがとうございます。また必要なときに相談します',expected:'終話で新たな通常判断依頼を生成しない',check:p=>!p.requiresOwner&&!p.questions.length},
];
const records=specs.map(s=>{const p=planConversation({text:s.text,fields,sourceTimestamp:'2026-10-16T01:00:00Z'});return {id:s.id,intent:s.intent,text:s.text,expected:s.expected,passed:s.check(p),actual:{updates:p.updates,message:p.message,ownerReasons:p.ownerReasons,questions:p.questions,startsNewOrder:startsNewOrder(s.text)}};});
assert.equal(records.length,6);
console.log(JSON.stringify({synthetic:true,activation_allowed:false,scope:'planner_diagnostic_not_full_webhook',notLiveLine:true,checks:records.length,passed:records.filter(r=>r.passed).length,failed:records.filter(r=>!r.passed).length,records},null,2));
// This diagnostic deliberately exits nonzero when business expectations fail.
if(records.some(r=>!r.passed))process.exitCode=1;
