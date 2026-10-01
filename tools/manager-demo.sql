-- Local-only UI fixture. Do not execute against a remote database.
INSERT OR IGNORE INTO manager_orders(id,customer_id,title,revision,created_at,updated_at)
VALUES ('M0000000000000001','LOCAL-DEMO-NO-SEND','【操作確認用】卒部ブーケ3個',1,'2026-09-30T01:00:00Z','2026-09-30T01:00:00Z');
INSERT OR IGNORE INTO manager_events(id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at)
VALUES ('LOCAL-DEMO-EVENT','LOCAL-DEMO-NO-SEND','M0000000000000001','customer','卒部式のブーケを3つ、全体で3000円ほどでお願いできますか？10月10日に店頭で受け取りたいです。','2026-09-30T01:00:00Z','2026-09-30T01:00:00Z','2026-09-30T01:00:00Z');
INSERT OR IGNORE INTO manager_fields(order_id,field_key,value_text,status,source_event_id,source_occurred_at) VALUES
('M0000000000000001','product_type','ブーケ','answered','LOCAL-DEMO-EVENT','2026-09-30T01:00:00Z'),
('M0000000000000001','quantity','3','answered','LOCAL-DEMO-EVENT','2026-09-30T01:00:00Z'),
('M0000000000000001','budget','3,000円（合計）','answered','LOCAL-DEMO-EVENT','2026-09-30T01:00:00Z'),
('M0000000000000001','receive_date','2026-10-10','answered','LOCAL-DEMO-EVENT','2026-09-30T01:00:00Z'),
('M0000000000000001','fulfillment_method','店頭受取','answered','LOCAL-DEMO-EVENT','2026-09-30T01:00:00Z');
INSERT OR IGNORE INTO manager_drafts(id,order_id,customer_id,source_event_id,base_revision,message,created_at)
VALUES ('D0000000000000001','M0000000000000001','LOCAL-DEMO-NO-SEND','LOCAL-DEMO-EVENT',1,'ご回答ありがとうございます😊 ご希望のお色はありますか？おまかせでも大丈夫です。','2026-09-30T01:00:00Z');
INSERT OR IGNORE INTO manager_tasks(id,order_id,kind,detail,due_at,created_at)
VALUES ('reply:D0000000000000001','M0000000000000001','reply','【操作確認用】予算内の制作可否と返信案の確認','2026-10-01T03:00:00Z','2026-09-30T01:00:00Z');
