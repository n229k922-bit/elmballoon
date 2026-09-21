CREATE TABLE IF NOT EXISTS business_schedule (
  date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'special_hours')),
  open_time TEXT,
  close_time TEXT,
  pickup_window TEXT,
  delivery_window TEXT,
  note TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  actor_line_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  result TEXT NOT NULL,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_timestamp_idx ON audit_log(timestamp DESC);
