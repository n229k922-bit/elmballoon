-- Limits are configured by the owner; absence is never interpreted as unlimited.
CREATE TABLE IF NOT EXISTS manager_capacity_limits (
  date TEXT PRIMARY KEY,
  production_minutes INTEGER NOT NULL CHECK(typeof(production_minutes)='integer' AND production_minutes>=0),
  delivery_count INTEGER NOT NULL CHECK(typeof(delivery_count)='integer' AND delivery_count>=0),
  order_count INTEGER NOT NULL CHECK(typeof(order_count)='integer' AND order_count>=0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manager_capacity_reservations (
  order_id TEXT NOT NULL REFERENCES manager_orders(id),
  date TEXT NOT NULL REFERENCES manager_capacity_limits(date),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),
  production_minutes INTEGER NOT NULL CHECK(typeof(production_minutes)='integer' AND production_minutes>=0),
  delivery_count INTEGER NOT NULL CHECK(typeof(delivery_count)='integer' AND delivery_count>=0),
  order_count INTEGER NOT NULL CHECK(typeof(order_count)='integer' AND order_count>=0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(order_id,date)
);
CREATE TRIGGER IF NOT EXISTS manager_capacity_reservation_guard
BEFORE INSERT ON manager_capacity_reservations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM manager_orders WHERE id=NEW.order_id AND status='open' AND revision=NEW.revision)
 THEN RAISE(ABORT,'capacity_stale_order') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM manager_capacity_limits WHERE date=NEW.date)
 THEN RAISE(ABORT,'capacity_unknown_limits') END;
 -- Legacy commitments must not disappear merely because no workload was entered.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM manager_orders o
 LEFT JOIN manager_fields f ON f.order_id=o.id AND f.field_key='receive_date'
 WHERE o.id!=NEW.order_id AND o.status='open'
 AND o.production_status IN ('accepted','confirmed','production','ready')
 AND (f.value_text IS NULL OR f.value_text='' OR f.value_text NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
 OR date(f.value_text,'+0 days') IS NULL OR date(f.value_text,'+0 days')!=f.value_text))
 THEN RAISE(ABORT,'capacity_uncertain_existing_load') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM manager_orders o
 JOIN manager_fields f ON f.order_id=o.id AND f.field_key='receive_date'
 WHERE o.id!=NEW.order_id AND o.status='open'
 AND o.production_status IN ('accepted','confirmed','production','ready') AND f.value_text=NEW.date
 AND NOT EXISTS(SELECT 1 FROM manager_capacity_reservations r WHERE r.order_id=o.id AND r.date=NEW.date AND r.revision=o.revision))
 THEN RAISE(ABORT,'capacity_unaccounted_existing_load') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM manager_capacity_limits l WHERE l.date=NEW.date AND (
 NEW.production_minutes + COALESCE((SELECT SUM(r.production_minutes) FROM manager_capacity_reservations r JOIN manager_orders o ON o.id=r.order_id WHERE r.date=NEW.date AND o.status!='cancelled'),0)>l.production_minutes OR
 NEW.delivery_count + COALESCE((SELECT SUM(r.delivery_count) FROM manager_capacity_reservations r JOIN manager_orders o ON o.id=r.order_id WHERE r.date=NEW.date AND o.status!='cancelled'),0)>l.delivery_count OR
 NEW.order_count + COALESCE((SELECT SUM(r.order_count) FROM manager_capacity_reservations r JOIN manager_orders o ON o.id=r.order_id WHERE r.date=NEW.date AND o.status!='cancelled'),0)>l.order_count))
 THEN RAISE(ABORT,'capacity_exceeded') END;
END;
CREATE TRIGGER IF NOT EXISTS manager_capacity_cancel_release
AFTER UPDATE OF status ON manager_orders WHEN NEW.status='cancelled' BEGIN
 DELETE FROM manager_capacity_reservations WHERE order_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS manager_capacity_reservation_no_update
BEFORE UPDATE ON manager_capacity_reservations BEGIN
 SELECT RAISE(ABORT,'capacity_replace_required');
END;
CREATE TRIGGER IF NOT EXISTS manager_capacity_limit_reduction_guard
BEFORE UPDATE ON manager_capacity_limits BEGIN
 SELECT CASE WHEN
 NEW.production_minutes < COALESCE((SELECT SUM(r.production_minutes) FROM manager_capacity_reservations r JOIN manager_orders o ON o.id=r.order_id WHERE r.date=OLD.date AND o.status!='cancelled'),0) OR
 NEW.delivery_count < COALESCE((SELECT SUM(r.delivery_count) FROM manager_capacity_reservations r JOIN manager_orders o ON o.id=r.order_id WHERE r.date=OLD.date AND o.status!='cancelled'),0) OR
 NEW.order_count < COALESCE((SELECT SUM(r.order_count) FROM manager_capacity_reservations r JOIN manager_orders o ON o.id=r.order_id WHERE r.date=OLD.date AND o.status!='cancelled'),0)
 THEN RAISE(ABORT,'capacity_existing_commitments') END;
END;
