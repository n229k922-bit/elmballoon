-- Short human-friendly code used only when multiple active orders make a command ambiguous.
ALTER TABLE customer_order_records ADD COLUMN display_code TEXT;

UPDATE customer_order_records
SET display_code = 'K' || printf('%06d', rowid)
WHERE display_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS customer_order_records_display_code_idx
  ON customer_order_records(display_code);
