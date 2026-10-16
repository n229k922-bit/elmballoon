import { managerReleaseStage, managerCanTransmit, managerFeatureEnabled, managerProductionSafetyReady } from './manager-policy.js';

const requiredTables = [
  'business_schedule','manager_orders','manager_locks','manager_events','manager_fields',
  'manager_changes','manager_questions','manager_drafts','manager_tasks','manager_outbox',
  'manager_audit','manager_order_items','manager_imports','manager_login_links',
  'manager_sessions','manager_reply_selection','manager_capacity_limits',
  'manager_capacity_reservations','manager_notification_events',
];
const requiredTriggers = ['manager_capacity_reservation_guard','manager_capacity_cancel_release',
  'manager_capacity_reservation_no_update','manager_capacity_limit_reduction_guard'];
const list = value => String(value || '').split(',').map(x => x.trim()).filter(Boolean);
const all = async (env,sql) => (await env.DB.prepare(sql).all()).results || [];

// Authenticated, read-only diagnostics. No push/reply, queue changes or secret values.
export async function getManagerReadiness(env, {origin, verifyLine = false, fetcher = fetch} = {}) {
  const checks = [], stage = managerReleaseStage(env), production = stage !== 'test';
  const check = (id, ok, message, blocking = true) => checks.push({id,ok:Boolean(ok),blocking,message});
  check('engine',env.ORDER_ENGINE==='v2','新しい注文管理を明示的に選択');
  check('release_stage',stage!=='disabled','公開段階が明示されている');
  check('runtime_safety',!production||managerProductionSafetyReady(env),'本番の受信・送信に必要な安全設定が揃っている');
  check('owners',list(env.ADMIN_LINE_USER_IDS).length>0,'店長の通知先が登録されている');
  check('pilot_customers',stage!=='pilot'||list(env.MANAGER_PILOT_CUSTOMER_IDS).length>0,'限定公開の対象顧客が登録されている');
  check('test_customers',stage!=='test'||list(env.MANAGER_TEST_CUSTOMER_IDS).length>0,'テストの対象顧客が登録されている');
  check('pause_explicit',['true','false'].includes(env.MANAGER_SEND_PAUSED),'注文返信・通知キューの停止設定が明示されている');
  check('test_session_isolation',!production||!env.MANAGER_TEST_SESSION_STARTED_AT,'本番設定にテスト用の注文分離を持ち込んでいない');
  const cutover=Date.parse(env.MANAGER_SEND_NOT_BEFORE||'');
  check('queue_cutover',!production||(Number.isFinite(cutover)&&cutover<=Date.now()),'本番移行以前のキューを流さない開始時刻が設定されている');
  check('customer_credentials',Boolean(env.CUSTOMER_LINE_CHANNEL_SECRET&&env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN),'顧客チャネルの認証設定がある');
  check('owner_credentials',Boolean(env.LINE_CHANNEL_SECRET&&env.LINE_CHANNEL_ACCESS_TOKEN),'店長チャネルの認証設定がある');
  check('channel_separation',Boolean(env.LINE_CHANNEL_SECRET&&env.CUSTOMER_LINE_CHANNEL_SECRET&&env.LINE_CHANNEL_SECRET!==env.CUSTOMER_LINE_CHANNEL_SECRET
    &&env.LINE_CHANNEL_ACCESS_TOKEN!==env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN),'顧客・店長チャネルの認証が別々になっている');
  let validOrigin=false;
  try { const app=new URL(env.MANAGER_APP_ORIGIN);validOrigin=app.protocol==='https:'&&app.pathname==='/'&&!app.search&&!app.hash&&!app.username&&!app.password&&(!origin||origin===app.origin); } catch {}
  check('app_origin',validOrigin,'店長アプリの接続先がこの公開先と一致する');
  check('disclosure',managerFeatureEnabled(env,'disclosure'),'AI受付であることを明示する');
  check('context_buttons',managerFeatureEnabled(env,'context_buttons'),'対象付き確認ボタンが有効');
  check('auto_intake',managerFeatureEnabled(env,'auto_intake'),'安全な基本聞き取りが有効');
  check('build_identity',/^[a-f0-9]{40}$/u.test(env.MANAGER_BUILD_COMMIT||''),'公開コードのコミットを追跡できる',production);

  let schemaOK=false,queues=null,history=null;
  try {
    const schema=await all(env,"SELECT type,name FROM sqlite_master WHERE type IN ('table','trigger')");
    const missingTables=requiredTables.filter(name=>!schema.some(r=>r.type==='table'&&r.name===name));
    const missingTriggers=requiredTriggers.filter(name=>!schema.some(r=>r.type==='trigger'&&r.name===name));
    check('schema_tables',!missingTables.length,missingTables.length?`未適用のテーブル：${missingTables.join('、')}`:'注文管理のテーブルが揃っている');
    check('schema_triggers',!missingTriggers.length,missingTriggers.length?`未適用の保護処理：${missingTriggers.join('、')}`:'受付枠の保護処理が揃っている');
    const columns=await all(env,"SELECT name FROM pragma_table_info('manager_outbox')");
    const payloadOK=['message_json','retry_key','first_attempt_at'].every(name=>columns.some(c=>c.name===name));
    check('schema_payload',payloadOK,'通知本文・ボタン・再送状態を保存できる');
    schemaOK=!missingTables.length&&!missingTriggers.length&&payloadOK;
    if(schemaOK) {
      queues=await all(env,'SELECT channel,status,COUNT(*) AS count FROM manager_outbox GROUP BY channel,status');
      history=await all(env,'SELECT review_status,COUNT(*) AS count FROM manager_imports GROUP BY review_status');
      const risk=queues.some(q=>['sending','failed','uncertain'].includes(q.status)&&q.count>0);
      check('unresolved_delivery',!risk,'送信中・失敗・結果不明のキューを解消または確認する');
    }
  } catch { check('database_available',false,'DBに接続できない、またはスキーマの確認に失敗'); }

  const identities=[],lineAccounts=[];
  for(const [role,token,expected] of [
    ['owner',env.LINE_CHANNEL_ACCESS_TOKEN,env.MANAGER_EXPECTED_OWNER_BASIC_ID],
    ['customer',env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN,env.MANAGER_EXPECTED_CUSTOMER_BASIC_ID],
  ]) {
    let matched=false,identity=null,basicId=null;
    if(verifyLine&&token&&expected) {
      try {
        const response=await fetcher('https://api.line.me/v2/bot/info',{method:'GET',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(8000)});
        if(response.ok) { const body=await response.json();identity=body.userId;basicId=body.basicId;matched=Boolean(identity)&&basicId===expected; }
      } catch { /* report only, never leak credentials or provider errors */ }
    }
    identities.push(identity);
    lineAccounts.push({role,basicId,matched});
    check(`line_${role}_identity`,matched,verifyLine?'公式アカウントが想定した役割と一致する':'公式アカウントの実照合は未実行');
  }
  if(verifyLine)check('line_distinct_bots',Boolean(identities[0]&&identities[1]&&identities[0]!==identities[1]),'顧客・店長の公式アカウントが別々である');
  return {checkedAt:new Date().toISOString(),stage,configurationReady:checks.every(c=>!c.blocking||c.ok),
    queueTransmissionEnabled:managerCanTransmit(env),checks,queues,history,lineAccounts,
    acceptance:{productionApproved:false,status:'実LINEの送受信・店長操作・例外フローは別途実機確認が必要'},
    pauseScope:'停止対象はAI注文の返信・通知キュー。店長への操作案内の直接返信と旧システムは対象外。'};
}
