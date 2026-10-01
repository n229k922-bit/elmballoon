CREATE TABLE IF NOT EXISTS manager_reply_selection (
  actor TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  draft_ids_json TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
