export const AI_DISCLOSURE = 'こんにちは😊 elm・balloonです🎈\nご注文の相談は、AIアシスタントがお手伝いします。\n制作やお届けの確認が必要なときは、スタッフと連携してご案内します。';
export const AI_DISCLOSURE_RESTRAINED = 'elm・balloonです。\nご相談は、AIアシスタントがお手伝いします。\n必要な確認は、スタッフと連携してご案内します。';

import { managerFeatureEnabled } from './manager-policy.js';

// An explicit release stage is required outside the isolated test environment.
export async function discloseAssistant(message, customerId, env, { restrained = false } = {}) {
  if (!managerFeatureEnabled(env, 'disclosure')) return message;
  const seen = await env.DB.prepare(`SELECT id FROM manager_drafts WHERE customer_id=?
    AND status IN ('pending','held','approved','sent') AND (instr(message,?)>0 OR instr(message,?)>0) LIMIT 1`)
    .bind(customerId, AI_DISCLOSURE, AI_DISCLOSURE_RESTRAINED).first();
  return seen ? message : `${restrained ? AI_DISCLOSURE_RESTRAINED : AI_DISCLOSURE}\n\n${message}`;
}
