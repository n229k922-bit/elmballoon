export const AI_DISCLOSURE = 'こんにちは😊 elm・balloonです🎈\nご注文の相談は、AIアシスタントがお手伝いします。\n制作やお届けの確認が必要なときは、スタッフと連携してご案内します。';

// Test-only rollout: an accidental flag in the live environment does not enable it.
export async function discloseAssistant(message, customerId, env) {
  if (env.MANAGER_TEST_MODE !== 'true' || env.AI_DISCLOSURE_ENABLED !== 'true') return message;
  const seen = await env.DB.prepare(`SELECT id FROM manager_drafts WHERE customer_id=?
    AND status IN ('pending','held','approved','sent') AND instr(message,?)>0 LIMIT 1`)
    .bind(customerId, AI_DISCLOSURE).first();
  return seen ? message : `${AI_DISCLOSURE}\n\n${message}`;
}
