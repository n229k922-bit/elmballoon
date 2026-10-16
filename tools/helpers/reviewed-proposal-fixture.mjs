import assert from 'node:assert/strict';
import {createReviewedProposal,acceptReviewedProposal} from '../../workers/admin-line-secretary/src/reviewed-proposal.js';

// Synthetic fixture only: exercise the real offer/consent functions while
// recording delivery locally. This helper never calls a network API.
export async function seedAcceptedProposal(f,orderId,{now='2026-10-02T01:00:00.000Z',proposal={}}={}) {
  const get=(sql,...args)=>f.db.prepare(sql).get(...args);
  const customer=get('SELECT customer_id FROM manager_orders WHERE id=?',orderId).customer_id;
  const fields=Object.fromEntries(f.db.prepare('SELECT field_key,value_text FROM manager_fields WHERE order_id=?').all(orderId).map(f=>[f.field_key,f.value_text]));
  const p={items:[{type:fields.product_type||'ブーケ',quantity:Number(fields.quantity)||3,size:'確認済み30cm'}],total_yen:3000,tax_included:true,personalization_fee_yen:0,feasible:true,receive_date:fields.receive_date||'2026-10-10',receive_time:fields.receive_time||'12:00',use_date:fields.use_date||'2026-10-10',fulfillment_method:fields.fulfillment_method||'店頭受取',balloon_message:fields.balloon_message||'なし',...proposal};
  assert.match(await createReviewedProposal(orderId,JSON.stringify(p),'OWNER',f.env,now),/返信案に保存/);
  const c=get("SELECT c.id,d.id draft_id FROM manager_changes c JOIN manager_drafts d ON d.source_event_id=c.source_event_id WHERE c.order_id=? AND c.field_key='reviewed_proposal' AND c.status='pending'",orderId);
  f.db.prepare("UPDATE manager_drafts SET status='sent' WHERE id=?").run(c.draft_id);
  f.db.prepare("INSERT INTO manager_outbox(id,recipient,channel,text,draft_id,retry_key,status,next_attempt_at,sent_at,created_at) VALUES (?,?,'customer','synthetic offer',?,?,'sent',?,?,?)").run(`synthetic:${c.id}`,customer,c.draft_id,c.id,now,now,now);
  const id=`synthetic-consent:${c.id}`,text=`提案承諾 ${c.id}`,at=new Date(Date.parse(now)+1).toISOString();
  f.db.prepare("INSERT INTO manager_events(id,customer_id,direction,text,occurred_at,received_at) VALUES (?,?,'customer',?,?,?)").run(id,customer,text,at,at);
  assert.equal(await acceptReviewedProposal([{id,customer_id:customer,text,occurred_at:at}],f.env,at),true);
  assert.equal(get("SELECT status FROM manager_changes WHERE id=?",c.id).status,'approved');
  return c;
}
