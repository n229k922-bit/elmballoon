import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { receiveManagerEvents, drainManagerInbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

// Anonymous reproductions of AUDIT-001. No customer names, ids, URLs or network.
globalThis.fetch = async () => { throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
function scenario() {
  const f = createManagerFixture();
  f.env.MANAGER_AUTO_INTAKE_ENABLED = 'true';
  f.env.AI_DISCLOSURE_ENABLED = 'false';
  let n = 0;
  async function receive(text, at, image = false) {
    const id = `AUDIT001-${++n}`;
    await receiveManagerEvents([{ type:'message', webhookEventId:id, timestamp:Date.parse(at), source:{userId:'CUSTOMER'}, message:{ id, type:image?'image':'text', ...(image?{}:{text}) } }], f.env, at);
    await drainManagerInbox(f.env, new Date(Date.parse(at)+30000).toISOString());
    return f.db.prepare('SELECT * FROM manager_drafts ORDER BY rowid DESC LIMIT 1').get();
  }
  return { ...f, receive, fields:()=>Object.fromEntries(f.db.prepare('SELECT field_key,value_text FROM manager_fields').all().map(x=>[x.field_key,x.value_text])) };
}
const first = 'こんにちは！前回と同様同じお店にバルーンを送りたいのですがスタンドのバルーンはいくらからになりますか';

test('AUDIT-001 price question retains explicit product facts without inventing price or date', async () => {
  const f=scenario();
  try {
    const draft=await f.receive(first,'2026-10-10T05:19:00Z');
    assert.match(draft.reasons_json,/price_confirmation/);
    assert.doesNotMatch(draft.message,/1万円|10,000円/);
    assert.equal(f.fields().use_date,undefined);
    assert.equal(f.fields().product_type,'バルーンスタンド','price intent must not erase the explicit requested product');
  } finally {f.db.close();}
});

test('AUDIT-001 rich-menu invocation does not restart intake after the requested stand', async () => {
  const f=scenario();
  try {
    await f.receive(first,'2026-10-10T05:19:00Z');
    const draft=await f.receive('注文担当を呼び出します。（準備中）','2026-10-10T05:20:00Z');
    assert.doesNotMatch(draft.message,/どのようなバルーン/,'existing product question must not be repeated');
  } finally {f.db.close();}
});

test('AUDIT-001 image then deictic price request retains unread image warning for owner', async () => {
  const f=scenario();
  try {
    await f.receive(first,'2026-10-10T05:19:00Z');
    await f.receive('注文担当を呼び出します。（準備中）','2026-10-10T05:20:00Z');
    await f.receive('','2026-10-10T05:22:00Z',true);
    const draft=await f.receive('これはいくらでしょうか','2026-10-10T05:22:20Z');
    assert.match(draft.reasons_json,/画像|image/,'previous image reference must survive into this price question');
    assert.equal(f.fields().budget,undefined,'a quote question does not express customer budget');
  } finally {f.db.close();}
});

test('AUDIT-001 actual store response is preserved chronologically as assistant evidence', async () => {
  const f=scenario();
  try {
    await f.receive(first,'2026-10-10T05:19:00Z');
    await f.receive('注文担当を呼び出します。（準備中）','2026-10-10T05:20:00Z');
    await f.receive('','2026-10-10T05:22:00Z',true);
    await f.receive('これはいくらでしょうか','2026-10-10T05:22:20Z');
    const order=f.db.prepare('SELECT id FROM manager_orders').get();
    const store='こんにちは。連休のため返信が遅くなりました。お祝いに間に合いますでしょうか？こちらのスタンドバルーンは店舗名とメッセージ入れも含め1万円です。1週間でスタンド自体は回収し、バルーンアレンジ自体はそのまま飾っていただけます。';
    // Historic store evidence is not fed as customer text or customer budget.
    f.db.prepare("INSERT INTO manager_events(id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at) VALUES (?,?,?,'assistant',?,?,?,?)").run('HISTORIC-STORE','CUSTOMER',order.id,store,'2026-10-13T05:56:00Z','2026-10-13T05:56:00Z','2026-10-13T05:56:00Z');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_events').get().n,5);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM manager_events WHERE direction='assistant'").get().n,1);
    assert.equal(f.fields().budget,undefined);
    assert.equal(f.fields().receive_date,undefined);
  } finally {f.db.close();}
});
