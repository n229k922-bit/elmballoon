import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('../workers/admin-line-secretary/src/index.js', import.meta.url), 'utf8');
const recordSource = source.slice(source.indexOf('async function recordCustomerMessage('), source.indexOf('async function findBusinessScheduleConflict('));
const triggerSource = source.slice(source.indexOf('function isOrderStartTrigger('), source.indexOf('\n}', source.indexOf('function isOrderStartTrigger(')) + 2);

function fixture({ session = null, pending = false } = {}) {
  const reads = [], writes = [], allows = [];
  let namesReads = 0;
  const env = {
    SECRETARY_KV: { async get(key) { reads.push(key); return session; }, async put() { throw Error('recording must not change session or TTL'); } },
    DB: { prepare(sql) { return { bind(...args) { return { async run() { writes.push({ sql, args }); } }; } }; } },
  };
  const context = vm.createContext({
    console: { log() {} }, Date, env,
    fetchCustomerDisplayName: async () => 'Customer', extractConfirmedCustomerName: () => null,
    syncCustomerOrderRecord: async args => { allows.push(args.allowCreate); return { pendingChanges: pending ? ['change'] : [] }; },
    getCustomerNames: async () => { namesReads++; return { confirmedName: 'Name', displayName: 'Customer' }; },
    notifyOwners: async () => {}, formatPendingOrderChanges: () => 'review', formatCustomerLabel: name => name,
    extractScheduleCandidate: () => null, extractOrderDetails: () => ({}), upsertOrderCard: async () => {},
  });
  vm.runInContext(recordSource + '\n' + triggerSource + '\nthis.record = recordCustomerMessage;', context);
  return { env, reads, writes, allows, namesReads: () => namesReads, record: context.record };
}

test('explicit order start skips irrelevant KV read without changing persisted message or TTL', async () => {
  const f = fixture();
  await f.record({ source: { userId: 'A' }, message: { type: 'text', id: 'msg', text: '注文したい' }, webhookEventId: 'evt' }, f.env);
  assert.deepEqual(f.allows, [true]);
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 3);
  assert.equal(f.writes[2].args[0], 'evt');
  assert.equal(f.writes[2].args[2], '注文したい');
});

test('ordinary text and images still consult fresh session for each event', async () => {
  const f = fixture({ session: { stage: 'collecting' } });
  for (const type of ['text', 'image']) await f.record({ source: { userId: type }, message: { type, id: type, text: 'ありがとうございます' } }, f.env);
  assert.deepEqual(f.reads, ['customer-session:text', 'customer-session:image']);
  assert.deepEqual(f.allows, [true, true]);
});

test('missing session cannot create an order from ordinary text; customer names are reused for pending changes', async () => {
  const f = fixture({ pending: true });
  await f.record({ source: { userId: 'A' }, message: { type: 'text', id: 'msg', text: 'ありがとうございます' } }, f.env);
  assert.deepEqual(f.allows, [false]);
  assert.equal(f.reads.length, 1);
  assert.equal(f.namesReads(), 1);
});

test('audit migration preserves lookup results and replaces full scan with covering index search', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(fs.readFileSync(new URL('../workers/admin-line-secretary/migrations/0001_initial.sql', import.meta.url), 'utf8'));
    const insert = db.prepare("INSERT INTO audit_log(timestamp,actor_line_user_id,action,result) VALUES ('2026-10-26','owner',?,?)");
    for (let i = 0; i < 10000; i++) insert.run(`owner.notification:${i}`, i % 2 ? 'success' : 'failure');
    const sql = "SELECT id FROM audit_log WHERE action = ? AND result = 'success' ORDER BY id DESC LIMIT 1";
    const before = db.prepare(sql).all('owner.notification:9999');
    const planBefore = db.prepare('EXPLAIN QUERY PLAN ' + sql).all('owner.notification:9999').map(r => r.detail).join(' ');
    const migration = fs.readFileSync(new URL('../workers/admin-line-secretary/migrations/0019_notification_audit_lookup.sql', import.meta.url), 'utf8');
    db.exec(migration); db.exec(migration);
    assert.deepEqual(db.prepare(sql).all('owner.notification:9999'), before);
    assert.match(planBefore, /SCAN audit_log/);
    assert.match(db.prepare('EXPLAIN QUERY PLAN ' + sql).all('owner.notification:9999').map(r => r.detail).join(' '), /SEARCH audit_log USING COVERING INDEX audit_log_notification_action_result_idx/);
    const retryQuery = source.match(/const rows = await env\.DB\.prepare\(`(SELECT d\.\* FROM owner_decision_requests d[\s\S]*?)`\)/)[1];
    db.exec(fs.readFileSync(new URL('../workers/admin-line-secretary/migrations/0005_owner_decision_requests.sql', import.meta.url), 'utf8'));
    const retryPlan = db.prepare('EXPLAIN QUERY PLAN ' + retryQuery).all(10).map(r => r.detail).join(' ');
    assert.equal((retryPlan.match(/USING COVERING INDEX audit_log_notification_action_result_idx/g) || []).length, 3);
  } finally { db.close(); }
});
