import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('the chat replay executes real quotes and applies only the accepted new pickup',()=>{
  const root=new URL('../',import.meta.url);
  const output=execFileSync(process.execPath,['tools/replay-chat-session.mjs','docs/simulations/yamada-2026-10-16/session.json'],{cwd:root,encoding:'utf8'});
  const result=JSON.parse(output);
  assert.equal(result.externalCommunication,false);
  assert.equal(result.automaticManagerDecisions,false);
  assert.equal(result.records.length,22);
  const before=result.records.at(-2).state.orders[0].fields;
  assert.equal(before.receive_date.value,'2026-10-18','even a sent replacement quote must not cancel the accepted old pickup');
  assert.equal(before.receive_time.value,'11:00');
  const order=result.final.orders[0],fields=order.fields;
  assert.equal(fields.receive_date.value,'2026-10-17');
  assert.equal(fields.receive_time.value,'16:00');
  assert.equal(fields.use_date.value,'2026-10-18');
  assert.equal(fields.quoted_total.value,'4800');
  assert.match(fields.budget.value,/5,000円程度/,'budget remains separate from the shop quotation');
  assert.equal(fields.personalization_fee.value,'0');
  assert.equal(fields.balloon_message.value,'NANO（ピンクの星型）');
  assert.equal(JSON.parse(fields.item_specification.value).length,3);
  assert.equal(fields.customer_agreement.status,'confirmed');
  assert.equal(order.production_status,'consulting');
  assert.equal(order.payment_status,'unconfirmed');
  assert.equal(result.final.changes.filter(c=>c.field_key==='reviewed_proposal'&&c.status==='approved').length,2);
});
