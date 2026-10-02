// Capacity is explicit, not derived from budget, product names or opening hours.
export function validateCapacityRequirements(requirements) {
  if (!Array.isArray(requirements) || !requirements.length || requirements.length > 366) return 'capacity_unknown_estimate';
  const dates = new Set();
  for (const item of requirements) {
    if (!item || typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) return 'capacity_invalid_date';
    const parsed = Date.parse(item.date + 'T00:00:00Z');
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0,10) !== item.date || dates.has(item.date)) return 'capacity_invalid_date';
    dates.add(item.date);
    for (const key of ['production_minutes','delivery_count','order_count']) {
      if (!Number.isSafeInteger(item[key]) || item[key] < 0 || item[key] > 1000000) return 'capacity_unknown_estimate';
    }
    if (item.production_minutes + item.delivery_count + item.order_count === 0) return 'capacity_unknown_estimate';
  }
  return null;
}

export async function reserveOrderCapacity(env, orderId, revision, requirements, now = new Date().toISOString()) {
  const invalid = validateCapacityRequirements(requirements);
  if (invalid) return { ok:false, reason:invalid };
  if (typeof orderId !== 'string' || !orderId || !Number.isSafeInteger(revision) || revision < 0) return {ok:false,reason:'capacity_stale_order'};
  const prepare = (sql,...args) => env.DB.prepare(sql).bind(...args);
  try {
    // D1 batch is one transaction: replacing all dates cannot partially reserve.
    // SQLite's write serialization + trigger totals prevents concurrent overselling.
    await env.DB.batch([
      prepare('DELETE FROM manager_capacity_reservations WHERE order_id=?',orderId),
      ...requirements.map(r => prepare(`INSERT INTO manager_capacity_reservations
        (order_id,date,revision,production_minutes,delivery_count,order_count,created_at) VALUES (?,?,?,?,?,?,?)`,
      orderId,r.date,revision,r.production_minutes,r.delivery_count,r.order_count,now))
    ]);
    return {ok:true,revision,dates:requirements.map(r=>r.date)};
  } catch (error) {
    const reason = ['capacity_stale_order','capacity_unknown_limits','capacity_exceeded','capacity_uncertain_existing_load','capacity_unaccounted_existing_load'].find(code => String(error.message).includes(code));
    return {ok:false,reason:reason || 'capacity_unavailable'};
  }
}

export async function getCapacitySummary(env, date) {
  if (validateCapacityRequirements([{date,production_minutes:0,delivery_count:0,order_count:1}])) return {ok:false,reason:'capacity_invalid_date'};
  try {
    const unknown = await env.DB.prepare(`SELECT o.id FROM manager_orders o
      LEFT JOIN manager_fields f ON f.order_id=o.id AND f.field_key='receive_date'
      WHERE o.status='open' AND o.production_status IN ('accepted','confirmed','production','ready')
      AND (f.value_text IS NULL OR f.value_text='' OR f.value_text NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      OR date(f.value_text,'+0 days') IS NULL OR date(f.value_text,'+0 days')!=f.value_text) LIMIT 1`).first();
    if (unknown) return {ok:false,reason:'capacity_uncertain_existing_load'};
    const unaccounted = await env.DB.prepare(`SELECT o.id FROM manager_orders o
      JOIN manager_fields f ON f.order_id=o.id AND f.field_key='receive_date'
      WHERE o.status='open' AND o.production_status IN ('accepted','confirmed','production','ready') AND f.value_text=?
      AND NOT EXISTS(SELECT 1 FROM manager_capacity_reservations r WHERE r.order_id=o.id AND r.date=? AND r.revision=o.revision) LIMIT 1`).bind(date,date).first();
    if (unaccounted) return {ok:false,reason:'capacity_unaccounted_existing_load'};
    const row = await env.DB.prepare(`SELECT l.*,
      COALESCE(SUM(CASE WHEN o.status!='cancelled' THEN r.production_minutes ELSE 0 END),0) AS used_production_minutes,
      COALESCE(SUM(CASE WHEN o.status!='cancelled' THEN r.delivery_count ELSE 0 END),0) AS used_delivery_count,
      COALESCE(SUM(CASE WHEN o.status!='cancelled' THEN r.order_count ELSE 0 END),0) AS used_order_count
      FROM manager_capacity_limits l LEFT JOIN manager_capacity_reservations r ON r.date=l.date
      LEFT JOIN manager_orders o ON o.id=r.order_id WHERE l.date=? GROUP BY l.date`).bind(date).first();
    return row ? {ok:true,...row} : {ok:false,reason:'capacity_unknown_limits'};
  } catch { return {ok:false,reason:'capacity_unavailable'}; }
}
