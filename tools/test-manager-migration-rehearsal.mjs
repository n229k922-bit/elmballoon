import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

// LOCAL ONLY. No remote DB, credentials, LINE sends, or deployment commands.
// This rehearses SQLite SQL semantics, not Cloudflare D1 restoration or Worker rollback.
const root = new URL('../workers/admin-line-secretary/migrations/', import.meta.url);
const files = readdirSync(root).filter(name => name.endsWith('.sql')).sort();
const pending = ['0013_manager_v2.sql', '0014_manager_mobile_sessions.sql',
  '0015_manager_reply_selection.sql', '0017_capacity_safety.sql', '0018_manager_message_payload.sql',
  '0019_notification_audit_lookup.sql'];
const quote = name => `"${name.replaceAll('"', '""')}"`;
const sql = name => readFileSync(new URL(name, root), 'utf8');
function tables(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
}
function fingerprint(db, names) {
  // Hash the complete row content (including nulls and column names), not counts.
  return Object.fromEntries(names.map(name => {
    const records = db.prepare(`SELECT * FROM ${quote(name)}`).all()
      .map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))))
      .sort();
    return [name, createHash('sha256').update(JSON.stringify(records)).digest('hex')];
  }));
}
function apply(db, name) {
  db.exec('BEGIN IMMEDIATE');
  try { db.exec(sql(name)); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function legacyFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of files.filter(name => name < '0013')) apply(db, name);
  // All names, addresses, numbers and identifiers below are synthetic test data.
  db.exec(`
    INSERT INTO business_schedule VALUES ('2027-10-20','special_hours','13:00','16:00',NULL,NULL,'架空の午後営業','2026-10-15T00:00:00Z','test-owner');
    INSERT INTO audit_log(timestamp,actor_line_user_id,action,before_json,after_json,result)
      VALUES ('2026-10-15T00:00:00Z','test-owner','schedule','{}','{"note":"架空"}','success');
    INSERT INTO customer_order_threads(id,customer_line_user_id,status,summary,fulfillment_type,desired_date,created_at,updated_at,customer_display_name,customer_confirmed_name)
      VALUES ('test-thread','test-customer','confirmed','架空：誕生日ブーケ','pickup','2027-10-20','2026-10-15','2026-10-15','テスト表示名','架空 花子');
    INSERT INTO order_messages(webhook_event_id,order_thread_id,direction,message_text,occurred_at)
      VALUES ('test-incoming','test-thread','customer_inbound','架空 花子です。電話000-0000-0000。架空県架空市1番地。','2026-10-15');
    INSERT INTO schedule_candidates(id,order_thread_id,event_type,event_date,event_time,status,source_summary,created_at)
      VALUES ('test-candidate','test-thread','pickup','2027-10-20','14:00','approved','架空予約','2026-10-15');
    INSERT INTO order_cards(id,order_thread_id,status,requested_quantity,budget_yen,owner_notes,created_at,updated_at,product_type)
      VALUES ('test-card','test-thread','production_confirmed',3,10000,'架空：本人に確認済み','2026-10-15','2026-10-15','ブーケ');
    INSERT INTO order_card_events(order_card_id,event_type,actor,detail,occurred_at)
      VALUES ('test-card','confirmed','owner','架空の確約記録','2026-10-15');
    INSERT INTO owner_decision_requests(id,source_event_id,order_thread_id,order_card_id,request_types,customer_summary,created_at)
      VALUES ('test-decision','test-decision-source','test-thread','test-card','["capacity"]','架空：制作可否','2026-10-15');
    INSERT INTO customer_reply_reviews(id,source_event_id,order_thread_id,customer_line_user_id,draft_message,status,created_at)
      VALUES ('test-review','test-review-source','test-thread','test-customer','架空：未送信の返信案','held','2026-10-15');
    INSERT INTO customer_profiles(customer_line_user_id,first_seen_at,last_seen_at,completed_order_count,relationship_override,confirmed_name,phone,address,contact_notes,owner_notes)
      VALUES ('test-customer','2025-01-01','2026-10-15',2,'returning','架空 花子','000-0000-0000','架空県架空市1番地','架空：電話連絡可','架空：前回ピンク');
    INSERT INTO customer_order_records(id,customer_line_user_id,source_thread_id,sequence_number,status,created_at,updated_at,display_code)
      VALUES ('test-record','test-customer','test-thread',1,'confirmed','2026-10-15','2026-10-15','K999999');
    INSERT INTO order_record_fields(order_record_id,field_key,phase,value_text,status,source_message_id,source_direction,source_occurred_at,confidence,question_count,locked,updated_at,confirmed_at,confirmed_by)
      VALUES ('test-record','phone','fulfillment','000-0000-0000','confirmed','test-incoming','customer_inbound','2026-10-15',1,1,1,'2026-10-15','2026-10-15','test-owner');
    INSERT INTO order_field_changes(id,order_record_id,field_key,old_value,new_value,requested_status,source_message_id,created_at)
      VALUES ('test-change','test-record','receive_time','14:00','15:00','answered','test-incoming','2026-10-15');
    INSERT INTO order_question_history(order_record_id,field_key,question_text,asked_at,answered_at,source_message_id)
      VALUES ('test-record','phone','架空：連絡先は？','2026-10-14','2026-10-15','test-incoming');
    INSERT INTO customer_reply_bundles VALUES ('test-customer','test-generation','2026-10-15','2026-10-15','test-incoming',0,'2026-10-15');
  `);
  const legacy = tables(db);
  for (const name of legacy) assert.ok(db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get().n > 0, `fixture must exercise ${name}`);
  return { db, legacy, before: fingerprint(db, legacy) };
}

test('pending migrations preserve every legacy table content and relationships, without automatic history linking', t => {
  const { db, legacy, before } = legacyFixture(); t.after(() => db.close());
  assert.deepEqual(files.filter(name => name >= '0013'), pending, 'new migrations must be added to this rehearsal explicitly');
  for (const name of pending) {
    apply(db, name);
    assert.deepEqual(fingerprint(db, legacy), before, `${name} altered legacy row content`);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM manager_orders').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM manager_imports').get().n, 0);
  // A newly imported source remains unverified and unlinked by default.
  db.exec(`INSERT INTO manager_imports(id,source_hash,source_file,source_heading,source_line,raw_text,created_at)
    VALUES ('test-import','fake-hash','synthetic.txt','架空履歴',1,'架空 花子／000-0000-0000','2026-10-15')`);
  const imported = db.prepare('SELECT review_status,linked_customer_id,linked_by FROM manager_imports').get();
  assert.deepEqual({ ...imported }, { review_status: 'unverified', linked_customer_id: null, linked_by: null });
  assert.deepEqual(fingerprint(db, legacy), before);
});

test('release schema contains mobile, selection, outbox payload, notification and capacity safeguards', t => {
  const { db } = legacyFixture(); t.after(() => db.close()); for (const name of pending) apply(db, name);
  for (const name of ['manager_login_links','manager_sessions','manager_reply_selection','manager_notification_events','manager_capacity_limits','manager_capacity_reservations']) assert.ok(tables(db).includes(name), name);
  assert.ok(db.prepare('PRAGMA table_info(manager_outbox)').all().some(column => column.name === 'message_json'));
  for (const name of ['manager_sessions_expiry','manager_orders_customer','manager_events_pending','manager_outbox_pending','manager_tasks_due']) assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name=?").get(name), name);
  for (const name of ['manager_capacity_reservation_guard','manager_capacity_cancel_release','manager_capacity_reservation_no_update','manager_capacity_limit_reduction_guard']) assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name), name);
  db.exec(`INSERT INTO manager_orders(id,customer_id,created_at,updated_at) VALUES ('test-new-order','test-customer','2026-10-15','2026-10-15');
    INSERT INTO manager_capacity_limits VALUES ('2027-10-20',30,0,1,'test-owner','2026-10-15')`);
  assert.throws(() => db.exec("INSERT INTO manager_capacity_reservations VALUES ('test-new-order','2027-10-20',1,10,0,1,'2026-10-15')"), /capacity_stale_order/);
  assert.throws(() => db.exec("INSERT INTO manager_capacity_reservations VALUES ('test-new-order','2027-10-20',0,31,0,1,'2026-10-15')"), /capacity_exceeded/);
  db.exec("INSERT INTO manager_capacity_reservations VALUES ('test-new-order','2027-10-20',0,20,0,1,'2026-10-15')");
  assert.throws(() => db.exec("UPDATE manager_capacity_reservations SET production_minutes=1"), /capacity_replace_required/);
  assert.throws(() => db.exec("UPDATE manager_capacity_limits SET production_minutes=1"), /capacity_existing_commitments/);
  db.exec("UPDATE manager_orders SET status='cancelled' WHERE id='test-new-order'");
  assert.equal(db.prepare('SELECT count(*) n FROM manager_capacity_reservations').get().n, 0);
});

test('remaining upgrades preserve previously reviewed and unreviewed v2 history without relinking', t => {
  const { db, legacy, before } = legacyFixture(); t.after(() => db.close());
  apply(db, pending[0]);
  db.exec(`INSERT INTO manager_imports(id,source_hash,source_file,source_heading,source_line,raw_text,review_status,linked_customer_id,linked_by,created_at)
    VALUES ('test-verified','fake-hash-verified','synthetic.txt','架空の確認済み履歴',1,'架空 花子：000-0000-0000／架空県架空市1番地','verified','test-customer','test-owner','2026-10-15'),
    ('test-unverified','fake-hash-unverified','synthetic.txt','架空の未確認履歴',2,'同姓同名の架空 花子：関連付け禁止','unverified',NULL,NULL,'2026-10-15')`);
  const historyBefore = fingerprint(db, ['manager_imports']);
  for (const name of pending.slice(1)) {
    apply(db, name);
    assert.deepEqual(fingerprint(db, ['manager_imports']), historyBefore, `${name} altered history content or review/link state`);
    assert.deepEqual(fingerprint(db, legacy), before);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('failed transactional migration rolls back DDL and destructive DML, preserving exact legacy content', t => {
  const { db, legacy, before } = legacyFixture(); t.after(() => db.close());
  const schemaBefore = db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(sql(pending[0]));
    db.exec("UPDATE customer_profiles SET phone='SHOULD-ROLL-BACK'; DELETE FROM order_question_history; CREATE TABLE failed_rollout_marker(id TEXT)");
    db.exec('INSERT INTO definitely_missing_table VALUES (1)');
    assert.fail('injected migration failure was not reached');
  } catch (error) {
    db.exec('ROLLBACK');
    assert.match(error.message, /definitely_missing_table/);
  }
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(), schemaBefore);
  assert.deepEqual(fingerprint(db, legacy), before);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // Recovery can reapply the release after rollback without a DROP or data reset.
  for (const name of pending) apply(db, name);
  assert.deepEqual(fingerprint(db, legacy), before);
});

test('legacy SQL remains usable after additive upgrade; engine rollback is not database rollback', t => {
  const { db, legacy, before } = legacyFixture(); t.after(() => db.close()); for (const name of pending) apply(db, name);
  const profile = db.prepare('SELECT confirmed_name,phone,address FROM customer_profiles WHERE customer_line_user_id=?').get('test-customer');
  assert.equal(profile.confirmed_name, '架空 花子');
  assert.equal(db.prepare("SELECT count(*) n FROM customer_reply_reviews WHERE status='held'").get().n, 1);
  db.exec('BEGIN');
  db.prepare('UPDATE customer_order_records SET updated_at=? WHERE id=?').run('2026-10-16', 'test-record');
  db.prepare('INSERT INTO order_messages(webhook_event_id,order_thread_id,direction,message_text,occurred_at) VALUES (?,?,?,?,?)')
    .run('test-post-upgrade','test-thread','owner_recorded','架空：旧画面から記録','2026-10-16');
  assert.equal(db.prepare('SELECT count(*) n FROM order_messages').get().n, 2);
  db.exec('ROLLBACK');
  assert.deepEqual(fingerprint(db, legacy), before);
  assert.ok(tables(db).includes('manager_outbox'), 'switching engine/code back must not pretend to undo the schema');
});
