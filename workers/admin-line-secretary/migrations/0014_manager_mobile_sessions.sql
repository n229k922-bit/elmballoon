CREATE TABLE IF NOT EXISTS manager_login_links (
  token_hash TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS manager_sessions (
  token_hash TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS manager_sessions_expiry ON manager_sessions(expires_at);
