-- Every customer-facing reply is reviewed by the manager before it is sent.
CREATE TABLE IF NOT EXISTS customer_reply_reviews (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL UNIQUE,
  order_thread_id TEXT NOT NULL REFERENCES customer_order_threads(id),
  customer_line_user_id TEXT NOT NULL,
  draft_message TEXT NOT NULL,
  proposed_message TEXT,
  status TEXT NOT NULL CHECK (status IN ('needs_review', 'needs_change_confirmation', 'held', 'sent', 'cancelled')) DEFAULT 'needs_review',
  created_at TEXT NOT NULL,
  sent_at TEXT,
  sent_by TEXT
);

CREATE INDEX IF NOT EXISTS customer_reply_reviews_status_idx
  ON customer_reply_reviews(status, created_at ASC);
