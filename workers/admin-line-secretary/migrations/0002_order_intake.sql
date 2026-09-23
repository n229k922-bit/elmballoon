CREATE TABLE IF NOT EXISTS customer_order_threads (
  id TEXT PRIMARY KEY,
  customer_line_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new', 'collecting', 'owner_review', 'confirmed', 'closed')),
  summary TEXT,
  fulfillment_type TEXT CHECK (fulfillment_type IN ('pickup', 'delivery', 'visit', 'unknown')) DEFAULT 'unknown',
  desired_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS customer_order_threads_customer_idx
  ON customer_order_threads(customer_line_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS order_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_event_id TEXT UNIQUE,
  order_thread_id TEXT NOT NULL REFERENCES customer_order_threads(id),
  direction TEXT NOT NULL CHECK (direction IN ('customer_inbound', 'assistant_outbound', 'owner_recorded')),
  message_text TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS order_messages_thread_idx
  ON order_messages(order_thread_id, occurred_at ASC);

CREATE TABLE IF NOT EXISTS schedule_candidates (
  id TEXT PRIMARY KEY,
  order_thread_id TEXT NOT NULL REFERENCES customer_order_threads(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('pickup', 'delivery', 'visit')),
  event_date TEXT NOT NULL,
  event_time TEXT,
  status TEXT NOT NULL CHECK (status IN ('needs_owner_review', 'approved', 'rejected', 'registered')),
  source_summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
);

CREATE INDEX IF NOT EXISTS schedule_candidates_review_idx
  ON schedule_candidates(status, event_date ASC);
