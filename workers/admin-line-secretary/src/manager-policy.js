// Production explicitly opts into pilot or live; missing values fail closed.
const ids = value => String(value || '').split(',').map(id => id.trim()).filter(Boolean);

export function managerProductionSafetyReady(env) {
  const credential = value => typeof value==='string'&&value.length>0&&value===value.trim();
  const raw=env.MANAGER_SEND_NOT_BEFORE||'',cutover=Date.parse(raw);
  const validDate=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(raw)
    && Number.isFinite(cutover) && new Date(cutover).toISOString().slice(0,10)===raw.slice(0,10) && cutover<=Date.now();
  return Boolean(validDate&&ids(env.ADMIN_LINE_USER_IDS).length
    &&credential(env.LINE_CHANNEL_SECRET)&&credential(env.CUSTOMER_LINE_CHANNEL_SECRET)&&env.LINE_CHANNEL_SECRET!==env.CUSTOMER_LINE_CHANNEL_SECRET
    &&credential(env.LINE_CHANNEL_ACCESS_TOKEN)&&credential(env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN)&&env.LINE_CHANNEL_ACCESS_TOKEN!==env.CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN);
}

export function managerReleaseStage(env) {
  if (env.MANAGER_TEST_MODE === 'true') return 'test';
  if (env.MANAGER_TEST_MODE !== 'false') return 'disabled';
  return ['pilot', 'live'].includes(env.MANAGER_RELEASE_STAGE) ? env.MANAGER_RELEASE_STAGE : 'disabled';
}

export function managerRecipientAllowed(recipient, channel, env) {
  if (!recipient) return false;
  if (channel === 'owner') return ids(env.ADMIN_LINE_USER_IDS).includes(recipient);
  if (channel !== 'customer') return false;
  const stage = managerReleaseStage(env);
  if (stage === 'test') return ids(env.MANAGER_TEST_CUSTOMER_IDS).includes(recipient);
  if (!managerProductionSafetyReady(env)) return false;
  if (stage === 'pilot') return ids(env.MANAGER_PILOT_CUSTOMER_IDS).includes(recipient);
  return stage === 'live';
}

export function managerCanTransmit(env) {
  const stage = managerReleaseStage(env);
  return stage === 'test' ? env.MANAGER_SEND_PAUSED !== 'true'
    : stage !== 'disabled' && env.MANAGER_SEND_PAUSED === 'false' && managerProductionSafetyReady(env);
}

export function managerFeatureEnabled(env, feature) {
  const stage = managerReleaseStage(env);
  if (stage === 'disabled') return false;
  if (feature === 'context_buttons') return stage === 'test' || env.MANAGER_CONTEXT_BUTTONS_ENABLED === 'true';
  if (feature === 'disclosure') return env.AI_DISCLOSURE_ENABLED === 'true';
  if (feature === 'auto_intake') return env.MANAGER_AUTO_INTAKE_ENABLED === 'true'
    && (stage === 'test' || env.AI_DISCLOSURE_ENABLED === 'true');
  return false;
}
