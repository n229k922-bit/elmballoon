-- Additive rollout: legacy records remain available until migration is reviewed.
CREATE TABLE IF NOT EXISTS manager_orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'ご相談',
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','cancelled')),
  production_status TEXT NOT NULL DEFAULT 'consulting',
  fulfillment_status TEXT NOT NULL DEFAULT 'pending',
  payment_status TEXT NOT NULL DEFAULT 'unconfirmed',
  collection_status TEXT NOT NULL DEFAULT 'not_required',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manager_locks (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS manager_orders_customer ON manager_orders(customer_id,status,updated_at);
CREATE TABLE IF NOT EXISTS manager_events (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  order_id TEXT REFERENCES manager_orders(id),
  direction TEXT NOT NULL CHECK(direction IN ('customer','owner','assistant','system')),
  text TEXT NOT NULL,
  media_message_id TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  processing_error TEXT
);
CREATE INDEX IF NOT EXISTS manager_events_pending ON manager_events(processed_at,received_at);
CREATE TABLE IF NOT EXISTS manager_fields (
  order_id TEXT NOT NULL REFERENCES manager_orders(id),
  field_key TEXT NOT NULL,
  value_text TEXT NOT NULL,
  value_json TEXT,
  status TEXT NOT NULL DEFAULT 'answered',
  source_event_id TEXT REFERENCES manager_events(id),
  source_occurred_at TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at TEXT,
  PRIMARY KEY(order_id,field_key)
);
CREATE TABLE IF NOT EXISTS manager_changes (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES manager_orders(id),
  field_key TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES manager_events(id),
  base_revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','superseded')),
  reviewed_by TEXT,
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS manager_questions (
  draft_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES manager_orders(id),
  field_key TEXT NOT NULL,
  question_text TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY(draft_id,field_key)
);
CREATE TABLE IF NOT EXISTS manager_drafts (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES manager_orders(id),
  customer_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE REFERENCES manager_events(id),
  base_revision INTEGER,
  message TEXT NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','sent','held','stale')),
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manager_tasks (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES manager_orders(id),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')),
  last_notified_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS manager_tasks_due ON manager_tasks(status,due_at);
CREATE TABLE IF NOT EXISTS manager_outbox (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('owner','customer')),
  text TEXT NOT NULL,
  draft_id TEXT REFERENCES manager_drafts(id),
  retry_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','uncertain','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TEXT,
  lease_until TEXT,
  next_attempt_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS manager_outbox_pending ON manager_outbox(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS manager_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manager_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES manager_orders(id),
  label TEXT NOT NULL,
  specification TEXT NOT NULL,
  source_event_id TEXT,
  confirmed_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manager_imports (
  id TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_heading TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'unverified',
  linked_customer_id TEXT,
  linked_by TEXT,
  created_at TEXT NOT NULL
);
