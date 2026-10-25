-- Notification retry/dedup checks filter by both action and result.
CREATE INDEX IF NOT EXISTS audit_log_notification_action_result_idx
ON audit_log(action, result);
