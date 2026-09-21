-- Compatibility upgrade for the database created before the repository migration.
-- This adds the columns required by 0001 without removing the original data.
ALTER TABLE business_schedule ADD COLUMN date TEXT;
ALTER TABLE business_schedule ADD COLUMN open_time TEXT;
ALTER TABLE business_schedule ADD COLUMN close_time TEXT;
ALTER TABLE business_schedule ADD COLUMN note TEXT;
ALTER TABLE business_schedule ADD COLUMN updated_by TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS business_schedule_date_idx ON business_schedule(date);

ALTER TABLE audit_log ADD COLUMN timestamp TEXT;
ALTER TABLE audit_log ADD COLUMN before_json TEXT;
ALTER TABLE audit_log ADD COLUMN after_json TEXT;
ALTER TABLE audit_log ADD COLUMN result TEXT NOT NULL DEFAULT 'success';
ALTER TABLE audit_log ADD COLUMN error_code TEXT;
CREATE INDEX IF NOT EXISTS audit_log_timestamp_idx ON audit_log(timestamp DESC);
