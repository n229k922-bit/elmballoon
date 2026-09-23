CREATE TABLE IF NOT EXISTS customer_profiles (
  customer_line_user_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  completed_order_count INTEGER NOT NULL DEFAULT 0,
  relationship_override TEXT CHECK (relationship_override IN ('new', 'returning'))
);
