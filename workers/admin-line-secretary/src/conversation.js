// Deterministic intake assistance. Facts are suggestions supported by this message;
// availability, prices and acceptance always require shop confirmation.
const QUESTIONS = {
  product_type: 'どのようなバルーンをご希望ですか？写真だけでも大丈夫です😊',
  receive_date: 'いつ頃のお受け取りをご希望ですか？未定でも大丈夫です。',
  fulfillment_method: 'お受け取りは、店頭・配達・発送のどちらをご希望ですか？',
  delivery_area: 'お届け先の市町村を教えていただけますか？',
  quantity: 'いくつご希望ですか？',
  budget: 'ご予算は全体でどのくらいをお考えですか？未定でも大丈夫です。',
  budget_scope: 'その金額は、1つあたりと全体の合計のどちらでしょうか？',
  color_vibe: 'ご希望のお色はありますか？おまかせでも大丈夫です。',
};
const valueOf = value => typeof value === 'object' && value !== null ? String(value.value_text ?? value.value ?? '') : String(value ?? '');
const known = value => Boolean(valueOf(value).trim()) || ['undecided', 'not_applicable', 'confirmed', 'answered'].includes(value?.status);
const normalize = text => String(text ?? '').normalize('NFKC');
const undecided = /未定|まだ決まって|分からない|わからない|決まっていません/u;
const NUMBER = '(\\d[\\d,]*(?:\\.\\d+)?)\\s*(万|千)?';
const amount = (digits, unit) => Number(digits.replaceAll(',', '')) * (unit === '万' ? 10000 : unit === '千' ? 1000 : 1);

function anchorDay(timestamp) {
  if (timestamp == null || timestamp === '') return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

function calendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}

export function resolveConversationDate(value, timestamp) {
  const day=anchorDay(timestamp), text=normalize(value);
  if(!day)return null;
  const relative=text.match(/明後日|あさって|明日|今日/u);
  if(relative){const offset=/明後日|あさって/u.test(relative[0])?2:relative[0]==='明日'?1:0;return new Date(Date.parse(day+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);}
  const explicit=text.match(/(?<![\d-])(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})日?(?![\d-])/u);
  if(!explicit)return null;
  const date=calendarDate(Number(explicit[1]||day.slice(0,4)),Number(explicit[2]),Number(explicit[3]));
  return date&&(explicit[1]||date>=day)?date:null;
}

export function extractConversationFacts({ text = '', sourceTimestamp, lastQuestions = [], hasImage = false } = {}) {
  const rawText = String(text);
  text = normalize(text);
  const updates = [];
  const facts = { budget: null, items: [], dateAmbiguities: [] };
  const add = (key, value, confidence = 0.95, evidence = rawText) => {
    if (!value || updates.some(update => update.key === key)) return;
    updates.push({ key, value: String(value), status: undecided.test(String(value)) ? 'undecided' : 'answered', confidence, phase: 'feasibility', evidence, sourceTimestamp: sourceTimestamp ?? null });
  };
  const labels = { product_type: '商品タイプ|バルーンのタイプ', product_source: '商品番号|品番|参考画像', budget: 'ご予算|予算', color_vibe: '色味|色|全体的なお色味と雰囲気', receive_date: '受取希望日|受け取り希望日|お届け希望日', use_date: '使用日|使用予定日|利用日', fulfillment_method: '受取方法|受け取り方法', quantity: '数量|個数', purpose: '用途', delivery_area: '配達地域|お届け地域', delivery_address: '住所|お届け先', phone: '電話番号|連絡先', customer_name: 'お名前|氏名', balloon_message: '文字入れ', card_message: 'メッセージカード' };
  let hasLabeledDate=false;
  for (const [key, label] of Object.entries(labels)) {
    const match = rawText.match(new RegExp(`(?:^|\\n)[ \\t]*[・•]?[ \\t]*(?:${label})[ \\t]*[:：][ \\t]*([^\\n]+)`, 'u'));
    if (match && !/^（例|^\(例/u.test(match[1].trim())) {
      if(key==='receive_date'||key==='use_date') {
        hasLabeledDate=true;
        const resolved=undecided.test(match[1])?'未定':resolveConversationDate(match[1],sourceTimestamp);
        if(resolved)add(key,resolved,1,match[0].trim());else facts.dateAmbiguities.push(match[1].trim());
      } else add(key, match[1].trim(), 1, match[0].trim());
    }
  }
  const lastKey = typeof lastQuestions.at(-1) === 'string' ? lastQuestions.at(-1) : lastQuestions.at(-1)?.key;
  if (hasImage) add('product_source', '参考画像あり（内容未確認）', 1);
  if (lastQuestions.length === 1 && text.trim().length < 80) {
    if (lastKey === 'quantity' && /^\d+[。！!]?$/u.test(text.trim())) add('quantity', text.trim().replace(/[。！!]/g,''), 1);
    if (lastKey === 'color_vibe' && /おまかせ|お任せ/u.test(text)) add('color_vibe','おまかせ',1);
    if (lastKey === 'budget' && /^\d[\d,]*$/u.test(text.trim())) add('budget',`${Number(text.trim().replaceAll(',','')).toLocaleString('ja-JP')}円（単価・合計未確認）`,0.9);
  }
  if (lastQuestions.length === 1 && lastKey && undecided.test(text) && text.length < 30) add(lastKey, '未定', 0.95);
  const reference = text.match(/(?:商品番号|品番|商品No\.?|HP(?:の)?(?:商品)?番号)\s*[:：#]?\s*([A-Za-z0-9_-]+)/iu);
  if (reference) add('product_source', reference[1], 1, reference[0]);
  for (const [pattern, value] of [[/スタンド/u, 'バルーンスタンド'], [/ブーケ/u, 'ブーケ'], [/おむつケーキ/u, 'おむつケーキ'], [/ヘリウム|浮く/u, 'ヘリウム（浮く）タイプ'], [/アレンジ/u, '置き型アレンジメント'], [/リリース/u, 'バルーンリリース']]) if (pattern.test(text)) { add('product_type', value); break; }
  const purpose = text.match(/卒団|卒業|誕生日|周年|開店|開業|移転|結婚|発表会|退職|還暦/u);
  if (purpose) add('purpose', purpose[0]);
  const quantity = text.match(/(\d+)\s*(?:個|つ|束|基|セット)(?!\s*(?:あたり|当たり|\d+円))(?:[をでに、。\s]|$|お願い|希望|注文)/u);
  if (quantity) add('quantity', quantity[1], 0.95, quantity[0]);
  const range = text.match(new RegExp(`${NUMBER}\\s*[〜~～−–-]\\s*${NUMBER}\\s*円`, 'u'));
  const single = text.match(new RegExp(`${NUMBER}\\s*円`, 'u'));
  if (range || single) {
    const min = range ? amount(range[1], range[2] || range[4]) : amount(single[1], single[2]);
    const max = range ? amount(range[3], range[4]) : min;
    const scope = /1[つ個束基]|一[つ個]|ひとつ|単価|あたり/u.test(text) ? 'unit' : /合計|全体|総額|全部で/u.test(text) ? 'total' : 'unknown';
    if (min <= max && Number.isFinite(max)) {
      facts.budget = { min, max, currency: 'JPY', scope, evidence: (range || single)[0] };
      add('budget', `${min.toLocaleString('ja-JP')}${max !== min ? `〜${max.toLocaleString('ja-JP')}` : ''}円${scope === 'unit' ? '／1つ' : scope === 'total' ? '（合計）' : '（単価・合計未確認）'}`);
      if (scope !== 'unknown') add('budget_scope', scope);
    }
  }
  if (/^(?:全体|合計|全部)(?:です|で|の金額)?[。！!]?$/u.test(text.trim()) && lastKey === 'budget_scope') add('budget_scope', 'total');
  if (/^(?:1つあたり|一つあたり|単価)(?:です)?[。！!]?$/u.test(text.trim()) && lastKey === 'budget_scope') add('budget_scope', 'unit');
  const colors = [...new Set(text.match(/メタリックブラック|ゴールド|シルバー|ピンク|ブルー|ラベンダー|ライム|赤|青|白|黒|黄色|紫|緑/g) || [])];
  if (colors.length) add('color_vibe', colors.join('・'), 0.85);
  // Preserve per-item wording intact; do not collapse multiple names into a customer's name.
  for (const line of rawText.split(/\r?\n/u)) if (/(?:背番号|名入れ|文字入れ|数字)[：:\s]*|(?:\d+)\s+[A-Za-z]{2,}/u.test(line)) facts.items.push({ specification: line.trim(), evidence: line.trim() });
  if (/店頭|取りに|受け取りに|引き取り/u.test(text)) add('fulfillment_method', '店頭受取');
  else if (/発送|郵送/u.test(text)) add('fulfillment_method', '発送');
  else if (/配達|配送|届けて|お届け/u.test(text)) add('fulfillment_method', '配達');
  const area = text.match(/([一-龯ぁ-んァ-ヶ]{2,12}(?:市|郡|区))/u);
  if (area) add('delivery_area', area[1], 0.8, area[0]);
  const day = anchorDay(sourceTimestamp);
  const relative = text.match(/明後日|あさって|明日|今日/u);
  const explicit = text.match(/(?<![\d-])(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})日?(?![\d-])/u);
  const isUseDate = /使用|利用|式|誕生日|イベント/u.test(text) && !/受取|受け取|配達|届|引取|引き取/u.test(text);
  const dateKey = isUseDate ? 'use_date' : 'receive_date';
  if (!hasLabeledDate && relative && day) {
    const offset = /明後日|あさって/u.test(relative[0]) ? 2 : relative[0] === '明日' ? 1 : 0;
    add(dateKey, new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10), 0.95, relative[0]);
  } else if (!hasLabeledDate && explicit) {
    const year = explicit[1] ? Number(explicit[1]) : day ? Number(day.slice(0, 4)) : null;
    const date = year && calendarDate(year, Number(explicit[2]), Number(explicit[3]));
    if (date && (explicit[1] || date >= day)) add(dateKey, date, 0.9, explicit[0]);
    else facts.dateAmbiguities.push(explicit[0]);
  } else if (!hasLabeledDate && (relative || /来週|来月|週末/u.test(text))) facts.dateAmbiguities.push(relative?.[0] || text);
  const time = text.match(/(午前|午後)?\s*(\d{1,2})(?:時(?:(\d{1,2})分?|半)?|:(\d{2}))/u);
  if(time) {
    let hour=Number(time[2]);const minute=time[3]?Number(time[3]):time[4]?Number(time[4]):/半/u.test(time[0])?30:0;
    if(time[1]==='午後'&&hour<12)hour+=12;
    if(time[1]==='午前'&&hour===12)hour=0;
    if(hour<24&&minute<60)add('receive_time',String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0'),0.9,time[0]);
  }
  return { updates, facts };
}

export function planConversation({ text = '', fields = {}, history = [], sourceTimestamp, lastQuestions = [], hasImage = false } = {}) {
  const { updates, facts } = extractConversationFacts({ text, sourceTimestamp, lastQuestions, hasImage });
  const merged = { ...fields };
  for (const update of updates) merged[update.key] = { value_text: update.value, status: update.status };
  const ownerReasons = [];
  const method = valueOf(merged.fulfillment_method);
  if (/配達|発送/u.test(method)) ownerReasons.push('delivery_feasibility');
  const day = anchorDay(sourceTimestamp);
  const wanted = valueOf(merged.receive_date) || valueOf(merged.use_date);
  if (day && /^\d{4}-\d{2}-\d{2}$/u.test(wanted)) {
    const days = (Date.parse(wanted) - Date.parse(day)) / 86400000;
    if (days >= 0 && days <= 3) ownerReasons.push('urgent_capacity');
    else if (days < 0) ownerReasons.push('past_date');
  }
  if (/昨年|去年|前回|いつもの/u.test(text)) ownerReasons.push('verify_previous_order');
  if (/変更|キャンセル|返金|間違|届か|まだ来/u.test(text)) ownerReasons.push('order_exception');
  if (facts.items.length > 1) ownerReasons.push('per_item_specifications');
  const asked = new Set([...lastQuestions, ...history.flatMap(item => item.questions || [])].map(item => typeof item === 'string' ? item : item.key));
  const questions = [];
  const ask = key => { if (questions.length < 2 && !known(merged[key]) && !asked.has(key)) questions.push({ key, text: QUESTIONS[key] }); };
  if (facts.dateAmbiguities.length && !asked.has('date_clarification')) questions.push({ key: 'date_clarification', text: `「${facts.dateAmbiguities[0]}」は何年何月何日のご予定でしょうか？` });
  if (/配達|発送/u.test(method)) ask('delivery_area');
  if (!known(merged.use_date)) ask('receive_date');
  if (!known(merged.product_source)) ask('product_type');
  ask('fulfillment_method');
  if (!ownerReasons.includes('urgent_capacity') && !ownerReasons.includes('delivery_feasibility')) {
    ask('quantity');
    if (known(merged.budget) && !known(merged.budget_scope) && (facts.budget?.scope === 'unknown' || /単価・合計未確認/u.test(valueOf(merged.budget)))) ask('budget_scope');
    ask('budget');
    ask('color_vibe');
  }
  const waiting = !questions.length && !ownerReasons.length;
  if (waiting) ownerReasons.push('review_collected_details');
  const historyCheck=ownerReasons.includes('verify_previous_order') ? '以前のご注文を確認します。変更したい点があれば、その点だけお知らせください。' : '';
  const message = [updates.length ? 'ご回答ありがとうございます😊' : 'ご連絡ありがとうございます😊', historyCheck, ...questions.map(question => question.text), ownerReasons.length ? 'いただいた内容で対応できるか確認いたします。' : ''].filter(Boolean).join('\n\n');
  return { updates, fields: merged, facts, questions, message, requiresOwner: ownerReasons.length > 0, ownerReasons, evidence: updates.map(({ key, evidence, sourceTimestamp: timestamp }) => ({ key, text: evidence, sourceTimestamp: timestamp })), clarificationNeeded: facts.dateAmbiguities.length > 0, approvalRequired: true };
}
