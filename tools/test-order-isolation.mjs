import assert from 'node:assert/strict';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { receiveManagerEvents, drainManagerInbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

// Offline regression: one customer starts a second order with "別の注文で".
// The two orders must never share an order_id or fields. No network/send.
const { db, env } = createManagerFixture();
Object.assign(env, {
  MANAGER_TEST_MODE: 'true',
  MANAGER_TEST_CUSTOMER_IDS: 'C1',
  ADMIN_LINE_USER_IDS: 'OWNER',
  MANAGER_AUTO_INTAKE_ENABLED: 'false',
});
const anchor = Date.parse('2026-10-19T01:00:00Z');
const event = (n, text, at) => ({ type: 'message', webhookEventId: `ISOLATION-${n}`, timestamp: at,
  source: { userId: 'C1' }, message: { id: `ISOLATION-${n}`, type: 'text', text } });
async function ingest(n, text, at) {
  await receiveManagerEvents([event(n, text, at)], env, new Date(at).toISOString());
  await drainManagerInbox(env, new Date(at + 20_000).toISOString());
}
await ingest(1, 'スタンドを1つお願いします', anchor);
await ingest(2, '別の注文でブーケをお願いします', anchor + 60_000);
const orders = db.prepare('SELECT id,title FROM manager_orders ORDER BY created_at').all();
const events = db.prepare('SELECT id,order_id FROM manager_events ORDER BY occurred_at').all();
assert.equal(orders.length, 2);
assert.notEqual(orders[0].id, orders[1].id);
assert.equal(events.length, 2);
assert.equal(events[0].order_id, orders[0].id);
assert.equal(events[1].order_id, orders[1].id);
console.log(JSON.stringify({ test: 'order-isolation', passed: true, orders: orders.map(o => o.title) }));
