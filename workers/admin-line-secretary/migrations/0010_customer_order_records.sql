-- Canonical customer/order chart for production operation.
-- A customer may have many orders. Each field keeps its own state and evidence.
CREATE TABLE IF NOT EXISTS customer_order_records (
  id TEXT PRIMARY KEY,
  customer_line_user_id TEXT NOT NULL REFERENCES customer_profiles(customer_line_user_id),
  source_thread_id TEXT NOT NULL REFERENCES customer_order_threads(id),
  sequence_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'feasibility_intake', 'feasibility_review', 'detail_intake',
    'awaiting_customer_confirmation', 'confirmed', 'production',
    'ready', 'fulfilled', 'closed', 'cancelled'
  )) DEFAULT 'feasibility_intake',
  is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)) DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_order_records_active_idx
  ON customer_order_records(customer_line_user_id) WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS customer_order_records_customer_idx
  ON customer_order_records(customer_line_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS customer_order_records_status_idx
  ON customer_order_records(status, updated_at ASC);

CREATE TABLE IF NOT EXISTS order_record_fields (
  order_record_id TEXT NOT NULL REFERENCES customer_order_records(id),
  field_key TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'feasibility', 'product_detail', 'customer_confirmation',
    'fulfillment', 'payment', 'completion'
  )),
  value_text TEXT,
  value_json TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'unasked', 'asked', 'answered', 'undecided',
    'not_applicable', 'manager_review', 'confirmed'
  )) DEFAULT 'unasked',
  source_message_id TEXT,
  source_direction TEXT CHECK (source_direction IN (
    'customer_inbound', 'assistant_outbound', 'owner_recorded', 'system'
  )),
  source_occurred_at TEXT,
  confidence REAL,
  question_count INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL CHECK (locked IN (0, 1)) DEFAULT 0,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  confirmed_by TEXT,
  PRIMARY KEY (order_record_id, field_key)
);

CREATE INDEX IF NOT EXISTS order_record_fields_status_idx
  ON order_record_fields(order_record_id, phase, status);

CREATE TABLE IF NOT EXISTS order_field_changes (
  id TEXT PRIMARY KEY,
  order_record_id TEXT NOT NULL REFERENCES customer_order_records(id),
  field_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  requested_status TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_owner', 'approved', 'rejected')) DEFAULT 'pending_owner',
  source_message_id TEXT,
  source_occurred_at TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
);

CREATE INDEX IF NOT EXISTS order_field_changes_pending_idx
  ON order_field_changes(status, created_at ASC);

CREATE TABLE IF NOT EXISTS order_question_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_record_id TEXT NOT NULL REFERENCES customer_order_records(id),
  field_key TEXT NOT NULL,
  question_text TEXT,
  asked_at TEXT NOT NULL,
  answered_at TEXT,
  source_message_id TEXT
);

CREATE INDEX IF NOT EXISTS order_question_history_field_idx
  ON order_question_history(order_record_id, field_key, asked_at DESC);

ALTER TABLE customer_profiles ADD COLUMN confirmed_name TEXT;
ALTER TABLE customer_profiles ADD COLUMN phone TEXT;
ALTER TABLE customer_profiles ADD COLUMN address TEXT;
ALTER TABLE customer_profiles ADD COLUMN contact_notes TEXT;
ALTER TABLE customer_profiles ADD COLUMN owner_notes TEXT;
