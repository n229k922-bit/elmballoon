-- Each request represents a decision that only the store owner may make.
CREATE TABLE IF NOT EXISTS owner_decision_requests (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL UNIQUE,
  order_thread_id TEXT NOT NULL REFERENCES customer_order_threads(id),
  order_card_id TEXT NOT NULL REFERENCES order_cards(id),
  request_types TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('needs_owner_review', 'recorded', 'cancelled')) DEFAULT 'needs_owner_review',
  customer_summary TEXT NOT NULL,
  owner_response TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);

CREATE INDEX IF NOT EXISTS owner_decision_requests_status_idx
  ON owner_decision_requests(status, created_at ASC);
