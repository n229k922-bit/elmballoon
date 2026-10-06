-- Persist message buttons together with text so a retry is exactly the same.
-- Existing rows retain text-only payloads, including already attempted sends.
ALTER TABLE manager_outbox ADD COLUMN message_json TEXT;

CREATE TABLE manager_notification_events (
  event_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  draft_id TEXT NOT NULL REFERENCES manager_drafts(id),
  created_at TEXT NOT NULL
);
