-- Short aggregation window for consecutive customer LINE messages.
-- Raw messages remain in order_messages immediately; this table only coordinates one reply.
CREATE TABLE IF NOT EXISTS customer_reply_bundles (
  customer_line_user_id TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  latest_source_event_id TEXT NOT NULL,
  has_image INTEGER NOT NULL CHECK (has_image IN (0, 1)) DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS customer_reply_bundles_updated_idx
  ON customer_reply_bundles(updated_at ASC);
