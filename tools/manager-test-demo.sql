-- Synthetic sample for the isolated test DB only. Requires MANAGER_SEND_PAUSED=true.
-- No personal data and no valid LINE recipient ID. Never apply to production.
INSERT OR IGNORE INTO manager_orders(id,customer_id,title,revision,created_at,updated_at)
VALUES ('M0000000000000010','TEST-DEMO-NO-SEND','【架空サンプル】卒部ブーケ3個',1,'2026-10-01T02:00:00Z','2026-10-01T02:00:00Z');
INSERT OR IGNORE INTO manager_events(id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at)
VALUES ('TEST-DEMO-EVENT','TEST-DEMO-NO-SEND','M0000000000000010','customer','【架空のご相談】10月10日に卒部ブーケ3個を店頭受取。合計3000円で相談したいです。','2026-10-01T02:00:00Z','2026-10-01T02:00:00Z','2026-10-01T02:00:00Z');
INSERT OR IGNORE INTO manager_fields(order_id,field_key,value_text,status,source_event_id,source_occurred_at) VALUES
('M0000000000000010','product_type','ブーケ','answered','TEST-DEMO-EVENT','2026-10-01T02:00:00Z'),
('M0000000000000010','quantity','3','answered','TEST-DEMO-EVENT','2026-10-01T02:00:00Z'),
('M0000000000000010','budget','3000円（合計）','answered','TEST-DEMO-EVENT','2026-10-01T02:00:00Z'),
('M0000000000000010','receive_date','2026-10-10','answered','TEST-DEMO-EVENT','2026-10-01T02:00:00Z'),
('M0000000000000010','fulfillment_method','店頭受取','answered','TEST-DEMO-EVENT','2026-10-01T02:00:00Z');
INSERT OR IGNORE INTO manager_drafts(id,order_id,customer_id,source_event_id,base_revision,message,created_at)
VALUES ('D0000000000000010','M0000000000000010','TEST-DEMO-NO-SEND','TEST-DEMO-EVENT',1,'ご回答ありがとうございます😊 ご希望のお色はありますか？おまかせでも大丈夫です。','2026-10-01T02:00:00Z');
