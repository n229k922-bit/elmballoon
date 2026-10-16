import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { managerReleaseStage, managerRecipientAllowed, managerCanTransmit, managerFeatureEnabled } from '../workers/admin-line-secretary/src/manager-policy.js';
import { receiveManagerEvents, drainManagerInbox, flushManagerOutbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

const NOW = '2026-10-01T01:00:00.000Z';
const LATER = '2026-10-01T01:03:00.000Z';
const PRODUCTION_BASE = {
  ADMIN_LINE_USER_IDS: 'OWNER', MANAGER_SEND_NOT_BEFORE: '2026-09-01T00:00:00.000Z',
  LINE_CHANNEL_ACCESS_TOKEN: 'fixture-owner-token', CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN: 'fixture-customer-token',
  LINE_CHANNEL_SECRET: 'fixture-owner-secret', CUSTOMER_LINE_CHANNEL_SECRET: 'fixture-customer-secret',
};
beforeEach(context => context.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) }));
function fixture(context) {
  const f = createManagerFixture();
  context.after(() => f.db.close());
  return f;
}
function queue(f, recipient = 'CUSTOMER', channel = 'customer', id = 'Q1') {
  f.db.prepare(`INSERT INTO manager_outbox(id,recipient,channel,text,retry_key,next_attempt_at,created_at,message_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, recipient, channel, '確認します', `retry-${id}`, NOW, NOW, JSON.stringify({ type: 'text', text: '確認します' }));
}
function event(userId, id = userId) {
  return { type: 'message', webhookEventId: id, timestamp: Date.parse(NOW), source: { userId }, message: { type: 'text', id, text: '娘の誕生日にバルーンをお願いしたいです' } };
}
const noSend = async () => assert.fail('policy must prevent any network attempt');

test('release mode requires exact explicit production opt-in and preserves test selection', () => {
  for (const env of [{}, { MANAGER_TEST_MODE: 'False', MANAGER_RELEASE_STAGE: 'live' }, { MANAGER_TEST_MODE: false, MANAGER_RELEASE_STAGE: 'live' },
    { MANAGER_TEST_MODE: 'false' }, { MANAGER_TEST_MODE: 'false', MANAGER_RELEASE_STAGE: 'production' },
    { MANAGER_TEST_MODE: 'false', MANAGER_RELEASE_STAGE: 'Live' }, { MANAGER_TEST_MODE: 'false', MANAGER_RELEASE_STAGE: 'disabled' }]) {
    assert.equal(managerReleaseStage(env), 'disabled');
    assert.equal(managerCanTransmit({ ...PRODUCTION_BASE, ...env, MANAGER_SEND_PAUSED: 'false' }), false);
    assert.equal(managerRecipientAllowed('CUSTOMER', 'customer', env), false);
    assert.equal(managerFeatureEnabled({ ...env, MANAGER_AUTO_INTAKE_ENABLED: 'true', AI_DISCLOSURE_ENABLED: 'true' }, 'auto_intake'), false);
  }
  assert.equal(managerReleaseStage({ MANAGER_TEST_MODE: 'true', MANAGER_RELEASE_STAGE: 'live' }), 'test');
  for (const stage of ['pilot', 'live']) assert.equal(managerReleaseStage({ MANAGER_TEST_MODE: 'false', MANAGER_RELEASE_STAGE: stage }), stage);
});

test('production send enable requires exact false; test keeps its existing optional pause flag', () => {
  for (const stage of ['pilot', 'live']) {
    const env = { ...PRODUCTION_BASE, MANAGER_TEST_MODE: 'false', MANAGER_RELEASE_STAGE: stage };
    for (const paused of [undefined, true, false, 'true', 'False', '', '0']) assert.equal(managerCanTransmit({ ...env, MANAGER_SEND_PAUSED: paused }), false);
    assert.equal(managerCanTransmit({ ...env, MANAGER_SEND_PAUSED: 'false' }), true);
  }
  assert.equal(managerCanTransmit({ MANAGER_TEST_MODE: 'true' }), true);
  assert.equal(managerCanTransmit({ MANAGER_TEST_MODE: 'true', MANAGER_SEND_PAUSED: 'true' }), false);
});

test('production transmission requires a valid nonfuture cutoff; test retains optional cutoff behavior', async context => {
  for (const stage of ['pilot', 'live']) {
    for (const cutoff of [undefined, '', 'not-a-date', '2026-02-30T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z']) {
      const f = fixture(context);
      Object.assign(f.env, { MANAGER_RELEASE_STAGE: stage, MANAGER_SEND_NOT_BEFORE: cutoff });
      assert.equal(managerCanTransmit(f.env), false, `${stage}: ${cutoff}`);
      queue(f);
      await flushManagerOutbox(f.env, NOW, noSend);
      assert.equal(f.db.prepare('SELECT attempts FROM manager_outbox').get().attempts, 0);
    }
    const env = { ...PRODUCTION_BASE, MANAGER_TEST_MODE: 'false', MANAGER_RELEASE_STAGE: stage, MANAGER_SEND_PAUSED: 'false', MANAGER_SEND_NOT_BEFORE: NOW };
    assert.equal(managerCanTransmit(env), true, 'exact current instant is a valid cutoff');
  }
  assert.equal(managerCanTransmit({ MANAGER_TEST_MODE: 'true' }), true);
});

test('production cutoff excludes pre-cutover queued messages while accepting new ones', async context => {
  const f = fixture(context); f.env.MANAGER_SEND_NOT_BEFORE = NOW;
  queue(f); queue(f, 'CUSTOMER', 'customer', 'BEFORE');
  f.db.prepare("UPDATE manager_outbox SET created_at='2026-10-01T00:59:59.999Z' WHERE id='BEFORE'").run();
  const sent = [];
  await flushManagerOutbox(f.env, NOW, async (_, options) => { sent.push(options.headers['X-Line-Retry-Key']); return new Response('{}'); });
  assert.deepEqual(sent, ['retry-Q1']);
  const before = f.db.prepare("SELECT * FROM manager_outbox WHERE id='BEFORE'").get();
  assert.equal(before.status, 'cancelled'); assert.equal(before.attempts, 0);
});

test('production baseline requires configured owners and distinct complete channel credentials', async context => {
  for (const stage of ['pilot', 'live']) {
    for (const overrides of [
      { ADMIN_LINE_USER_IDS: undefined }, { ADMIN_LINE_USER_IDS: ' , ' },
      { LINE_CHANNEL_ACCESS_TOKEN: undefined }, { CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN: '' },
      { LINE_CHANNEL_SECRET: undefined }, { CUSTOMER_LINE_CHANNEL_SECRET: '' },
      { CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN: PRODUCTION_BASE.LINE_CHANNEL_ACCESS_TOKEN },
      { CUSTOMER_LINE_CHANNEL_SECRET: PRODUCTION_BASE.LINE_CHANNEL_SECRET },
    ]) {
      const f = fixture(context); Object.assign(f.env, { MANAGER_RELEASE_STAGE: stage }, overrides);
      assert.equal(managerCanTransmit(f.env), false, JSON.stringify(overrides));
      assert.equal(managerRecipientAllowed('CUSTOMER', 'customer', f.env), false, JSON.stringify(overrides));
      await receiveManagerEvents([event('CUSTOMER')], f.env, NOW);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_events').get().n, 0);
      queue(f); await flushManagerOutbox(f.env, NOW, noSend);
      assert.equal(f.db.prepare('SELECT attempts FROM manager_outbox').get().attempts, 0);
    }
  }
});

test('recipient policy always validates owner allowlist and denies unknown channels', () => {
  for (const stage of ['test', 'pilot', 'live', 'disabled']) {
    const env = { ...PRODUCTION_BASE, MANAGER_TEST_MODE: stage === 'test' ? 'true' : 'false', MANAGER_RELEASE_STAGE: stage,
      ADMIN_LINE_USER_IDS: ' OWNER, SECOND ', MANAGER_TEST_CUSTOMER_IDS: 'CUSTOMER', MANAGER_PILOT_CUSTOMER_IDS: 'CUSTOMER' };
    assert.equal(managerRecipientAllowed('OWNER', 'owner', env), true);
    assert.equal(managerRecipientAllowed('SECOND', 'owner', env), true);
    assert.equal(managerRecipientAllowed('OTHER', 'owner', env), false);
    for (const channel of ['OWNER', '', 'unknown', undefined]) assert.equal(managerRecipientAllowed('OWNER', channel, env), false);
    for (const channel of ['owner', 'customer']) assert.equal(managerRecipientAllowed('', channel, env), false);
    assert.equal(managerRecipientAllowed('OTHER', 'customer', env), stage === 'live');
    assert.equal(managerRecipientAllowed('CUSTOMER', 'customer', env), stage !== 'disabled');
  }
});

test('production automation requires explicit disclosure and feature flag; test remains compatible', () => {
  for (const stage of ['pilot', 'live']) {
    const env = { ...PRODUCTION_BASE, MANAGER_TEST_MODE: 'false', MANAGER_RELEASE_STAGE: stage, MANAGER_AUTO_INTAKE_ENABLED: 'true' };
    for (const flag of [undefined, 'false', true, 'True']) assert.equal(managerFeatureEnabled({ ...env, AI_DISCLOSURE_ENABLED: flag }, 'auto_intake'), false);
    assert.equal(managerFeatureEnabled({ ...env, AI_DISCLOSURE_ENABLED: 'true' }, 'auto_intake'), true);
    assert.equal(managerFeatureEnabled({ ...env, AI_DISCLOSURE_ENABLED: 'true', MANAGER_AUTO_INTAKE_ENABLED: 'false' }, 'auto_intake'), false);
    assert.equal(managerFeatureEnabled(env, 'context_buttons'), false);
    assert.equal(managerFeatureEnabled({ ...env, MANAGER_CONTEXT_BUTTONS_ENABLED: 'true' }, 'context_buttons'), true);
    assert.equal(managerFeatureEnabled(env, 'typo'), false);
  }
  assert.equal(managerFeatureEnabled({ MANAGER_TEST_MODE: 'true', MANAGER_AUTO_INTAKE_ENABLED: 'true' }, 'auto_intake'), true);
  assert.equal(managerFeatureEnabled({ MANAGER_TEST_MODE: 'true' }, 'context_buttons'), true);
});

test('pilot receives only allowed customers and applies policy again to every outbound row', async context => {
  const f = fixture(context);
  await receiveManagerEvents([event('CUSTOMER'), event('OTHER')], f.env, NOW);
  assert.deepEqual(f.db.prepare('SELECT customer_id FROM manager_events').all().map(row => row.customer_id), ['CUSTOMER']);
  queue(f); queue(f, 'OTHER', 'customer', 'Q2'); queue(f, 'OWNER', 'owner', 'Q3'); queue(f, 'OTHER', 'owner', 'Q4');
  const sent = [];
  await flushManagerOutbox(f.env, NOW, async (_, options) => { sent.push({ body: JSON.parse(options.body), token: options.headers.Authorization }); return new Response('{}'); });
  assert.deepEqual(sent.map(send => send.body.to).sort(), ['CUSTOMER', 'OWNER']);
  assert.equal(sent.find(send => send.body.to === 'OWNER').token, 'Bearer fixture-owner-token');
  assert.equal(sent.find(send => send.body.to === 'CUSTOMER').token, 'Bearer fixture-customer-token');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM manager_outbox WHERE status='cancelled' AND last_error='outside_recipient_policy'").get().n, 2);
});

test('live opens customer receipt but never arbitrary owner delivery', async context => {
  const f = fixture(context); f.env.MANAGER_RELEASE_STAGE = 'live';
  await receiveManagerEvents([event('OTHER')], f.env, NOW);
  assert.equal(f.db.prepare('SELECT customer_id FROM manager_events').get().customer_id, 'OTHER');
  queue(f, 'OTHER'); queue(f, 'OTHER', 'owner', 'Q2');
  const sent = [];
  await flushManagerOutbox(f.env, NOW, async (_, options) => { sent.push(JSON.parse(options.body).to); return new Response('{}'); });
  assert.deepEqual(sent, ['OTHER']);
  assert.equal(f.db.prepare("SELECT status FROM manager_outbox WHERE id='Q2'").get().status, 'cancelled');
});

test('missing production mode, missing pause opt-in and legacy engine never flush v2 queue', async context => {
  for (const overrides of [{ MANAGER_TEST_MODE: undefined }, { MANAGER_RELEASE_STAGE: undefined }, { MANAGER_SEND_PAUSED: undefined },
    { MANAGER_SEND_PAUSED: 'False' }, { ORDER_ENGINE: 'legacy' }, { ORDER_ENGINE: undefined }]) {
    const f = fixture(context); Object.assign(f.env, overrides); queue(f);
    await flushManagerOutbox(f.env, NOW, noSend);
    assert.equal(f.db.prepare('SELECT attempts,status FROM manager_outbox').get().attempts, 0);
    assert.equal(f.db.prepare('SELECT status FROM manager_outbox').get().status, 'pending');
  }
});

test('test stage still requires explicit customer allowlist for receipt and queue send', async context => {
  const f = fixture(context); Object.assign(f.env, { MANAGER_TEST_MODE: 'true', MANAGER_TEST_CUSTOMER_IDS: 'CUSTOMER' });
  delete f.env.MANAGER_SEND_PAUSED;
  await receiveManagerEvents([event('CUSTOMER'), event('OTHER')], f.env, NOW);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_events').get().n, 1);
  queue(f); queue(f, 'OTHER', 'customer', 'Q2');
  const sent = [];
  await flushManagerOutbox(f.env, NOW, async (_, options) => { sent.push(JSON.parse(options.body).to); return new Response('{}'); });
  assert.deepEqual(sent, ['CUSTOMER']);
});

test('production intake is automatic only with disclosure and allowed recipient', async context => {
  for (const [disclosure, recipient, expected] of [['true', 'CUSTOMER', 1], [undefined, 'CUSTOMER', 0], ['false', 'CUSTOMER', 0], ['true', 'OTHER', 0]]) {
    const f = fixture(context); Object.assign(f.env, { MANAGER_AUTO_INTAKE_ENABLED: 'true', AI_DISCLOSURE_ENABLED: disclosure });
    await receiveManagerEvents([event(recipient)], f.env, NOW); await drainManagerInbox(f.env, LATER);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").get().n, expected);
    if (expected) {
      const sent = [];
      await flushManagerOutbox(f.env, LATER, async (_, options) => { sent.push(JSON.parse(options.body)); return new Response('{}'); });
      assert.equal(sent.length, 1); assert.equal(sent[0].to, 'CUSTOMER');
      assert.match(sent[0].messages[0].text, /AI/);
    }
  }
});

test('recipient revocation after ambiguous timeout stops retries as uncertain', async context => {
  for (const channel of ['customer', 'owner']) {
    const f = fixture(context); queue(f, channel === 'owner' ? 'OWNER' : 'CUSTOMER', channel);
    await flushManagerOutbox(f.env, NOW, async () => { throw new Error('timeout after potential acceptance'); });
    assert.equal(f.db.prepare('SELECT attempts FROM manager_outbox').get().attempts, 1);
    if (channel === 'owner') f.env.ADMIN_LINE_USER_IDS = 'OTHER';
    else f.env.MANAGER_PILOT_CUSTOMER_IDS = 'OTHER';
    await flushManagerOutbox(f.env, LATER, noSend);
    const row = f.db.prepare('SELECT * FROM manager_outbox').get();
    assert.equal(row.status, 'uncertain'); assert.equal(row.last_error, 'outside_recipient_policy'); assert.equal(row.attempts, 1);
  }
});

test('disclosure revocation cancels an unattempted production auto reply before transmitting', async context => {
  const f = fixture(context); Object.assign(f.env, { MANAGER_AUTO_INTAKE_ENABLED: 'true', AI_DISCLOSURE_ENABLED: 'true' });
  await receiveManagerEvents([event('CUSTOMER')], f.env, NOW); await drainManagerInbox(f.env, LATER);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").get().n, 1);
  f.env.AI_DISCLOSURE_ENABLED = 'false';
  await flushManagerOutbox(f.env, LATER, noSend);
  const row = f.db.prepare("SELECT * FROM manager_outbox WHERE channel='customer'").get();
  assert.equal(row.status, 'cancelled'); assert.equal(row.attempts, 0); assert.equal(row.last_error, 'auto_intake_disabled');
  assert.equal(f.db.prepare('SELECT status FROM manager_drafts').get().status, 'stale');
});

test('global pause suppresses attempted retries and resumed retry keeps identical key and payload', async context => {
  const f = fixture(context); queue(f);
  let first;
  await flushManagerOutbox(f.env, NOW, async (_, options) => { first = options; throw new Error('network timeout'); });
  f.env.MANAGER_SEND_PAUSED = 'true';
  await flushManagerOutbox(f.env, LATER, noSend);
  assert.equal(f.db.prepare('SELECT attempts FROM manager_outbox').get().attempts, 1);
  assert.equal(f.db.prepare('SELECT status FROM manager_outbox').get().status, 'pending');
  f.env.MANAGER_SEND_PAUSED = 'false';
  await flushManagerOutbox(f.env, LATER, async (_, options) => {
    assert.equal(options.body, first.body); assert.equal(options.headers['X-Line-Retry-Key'], first.headers['X-Line-Retry-Key']);
    return new Response('{}', { status: 409, headers: { 'x-line-accepted-request-id': 'original-request' } });
  });
  const row = f.db.prepare('SELECT * FROM manager_outbox').get();
  assert.equal(row.status, 'sent'); assert.equal(row.attempts, 2);
  await flushManagerOutbox(f.env, LATER, noSend);
});

test('switching live to pilot rechecks recipient even after an attempted send', async context => {
  const f = fixture(context); f.env.MANAGER_RELEASE_STAGE = 'live'; queue(f, 'OTHER');
  await flushManagerOutbox(f.env, NOW, async () => { throw new Error('unknown result'); });
  f.env.MANAGER_RELEASE_STAGE = 'pilot';
  await flushManagerOutbox(f.env, LATER, noSend);
  assert.equal(f.db.prepare('SELECT status FROM manager_outbox').get().status, 'uncertain');
});
