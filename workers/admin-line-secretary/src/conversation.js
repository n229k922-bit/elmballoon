// Deterministic intake assistance. Facts are suggestions supported by this message;
// availability, prices and acceptance always require shop confirmation.
const QUESTIONS = {
  product_type: 'どのようなバルーンをご希望ですか？写真だけでも大丈夫です😊',
  use_date: 'いつご使用の予定でしょうか？お受け取り希望日とは分けて確認いたします。未定でも大丈夫です。',
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

// Intent precedes extraction: dates, colours and money mentioned in complaints,
// greetings or unrelated chat must never mutate an order.
export function classifyConversationIntent(value = '') {
  const text = normalize(value).trim();
  const result = (kind, suppressFacts, requiresOwner, reason, message) => ({ kind, suppressFacts, requiresOwner, reason, message });
  if (/誤飲|飲み込|のみ込|窒息|息ができ|呼吸が|意識が|ヘリウム.{0,8}(?:吸った|吸い込|吸って)|火傷|やけど|怪我|(?:^|[。\s、])けが|けがを|けがした|出血/u.test(text)) return result('safety', true, true, 'safety_incident', '安全に関わるご相談として、人の担当へ優先して引き継ぎます。差し迫った危険がある場合は、店舗の返信を待たず地域の緊急窓口や医療機関へご相談ください。');
  if (/責任者|人間|人の担当|スタッフ|店長/u.test(text) && /話したい|代わって|かわって|つないで|繋いで|直接/u.test(text)) return result('handoff', true, true, 'human_handoff', '人の担当へ引き継ぎます。確認前に対応内容や返金などを確約せず、担当からご案内します。');
  if (/苦情|クレーム|ひどい|酷い|最悪|話が違|納得でき|返品|返金|交換して|しぼみ|萎み|色が.{0,8}違|届か|まだ来/u.test(text)) return result('complaint', true, true, 'customer_complaint', 'ご不便をおかけし申し訳ありません。人の担当へ引き継ぎ、注文内容と状況を確認して対応をご案内します。交換・返金などは確認後のご案内となります。');
  if (/見送|注文(?:は|を)?しない|今回は(?:やめ|止め|不要)|相談.{0,6}(?:終了|やめ)/u.test(text)) return result('withdrawal', true, true, 'consultation_withdrawal', '見送りのご希望として承りました。対象のご相談と正式注文の状況を確認し、ほかのご相談を変えずに扱います。');
  if (!startsNewOrder(text) && /別件|別の(?:ご)?注文|新しい(?:ご)?注文|新規注文/u.test(text)) return result('mixed_orders', true, true, 'order_exception', '別のご注文を含むご相談として承りました。既存のご注文は変更せず、今回のご希望がどちらのご注文についてか、人の担当が確認いたします。');
  if (/葬儀|葬式|お葬式|告別式|法要|追悼|お悔やみ|お供え|亡くな|亡くし|死ん|死去|(?:子供|子ども|娘|息子).{0,5}死/u.test(text)) return result('bereavement', false, true, 'sensitive_occasion', 'ご事情をお聞かせいただきありがとうございます。ご希望に沿えるか、内容を慎重に確認いたします。');
  if (/^(?:(?:どうも|こちらこそ|はい)[、,。\s]*)?(?:ありがとうございます|ありがとうございました|ありがとう|了解です|承知しました|わかりました|分かりました|助かりました)[😊🙏👍✨!！。\s]*(?:また(?:必要な|機会|今度|よろしく|連絡|相談)[\s\S]*)?$/u.test(text) || /^(?:また必要な(?:とき|時)に相談します|今回はここまで)[😊🙏👍。!！\s]*$/u.test(text)) return result('closing', true, false, null, 'こちらこそ、ありがとうございます。また必要なときにお声がけください。');
  const unrelated = /天気|天候|ニュース|株価|選挙|政治|占い|晩ご飯|夕飯|冗談|ジョーク/u.test(text);
  const orderClause = /注文|バルーン|ブーケ|スタンド|配達|受取|受け取|取りに|色は|予算|葬儀|飾り/u.test(text);
  if (unrelated && !orderClause) return result('smalltalk', true, false, null, 'こちらではバルーンのご注文・ご相談をお手伝いしています。ご注文の内容は変更せずにおきます。');
  return result('order', false, false, null, null);
}

const PRODUCT_OPTIONS = [[/スタンド/gu, 'バルーンスタンド'], [/ブーケ/gu, 'ブーケ'], [/おむつケーキ/gu, 'おむつケーキ'], [/ヘリウム|浮く/gu, 'ヘリウム（浮く）タイプ'], [/アレンジ/gu, '置き型アレンジメント'], [/リリース/gu, 'バルーンリリース']];
const COLOR_OPTIONS = [[/メタリックブラック|ゴールド|シルバー|ピンク|ブルー|ラベンダー|ライム|水色|赤|青|白|黒|黄色|紫|緑/gu, null]];
const METHOD_OPTIONS = [[/店頭|取りに|受け取りに|引き取り|お店に(?:伺い|行き|行く|伺う)/gu, '店頭受取'], [/発送|郵送/gu, '発送'], [/配達|配送|届けて|お届け/gu, '配達']];
// A mentioned option is not necessarily a request. Keep explicit corrections,
// but do not turn rejected options or conditional alternatives into facts.
function requestedOptions(text, options, allowCombination = false, numeric = false) {
  const mentions = options.flatMap(([pattern, value]) => [...text.matchAll(pattern)].map(match => ({ value: typeof value === 'function' ? value(match) : value || match[0], index: match.index, end: match.index + match[0].length, evidence: match[0] })));
  mentions.sort((a, b) => a.index - b.index);
  const rejected = mention => /^(?:色)?(?:は|を|が|には)?\s*(?:ではなく|じゃなく|でなく|ではない|ではありません|じゃない|不要|いらない|なし|無し|以外|やめ|苦手|嫌い|しない|しません|使わない|使わず|入れない|入れず|入れません|避け|抜き|希望しない|希望しません|できない|出来ない|できません|出来ません|行けない|行けません)/u.test(text.slice(mention.end));
  const accepted = mentions.filter(mention => !rejected(mention));
  const values = [...new Set(accepted.map(mention => mention.value))];
  const conditional = accepted.some(mention => /^(?:は|が|を|で|も)?\s*(?:無理|難し|できな|出来な|不可|なら|だったら|の場合)/u.test(text.slice(mention.end)) || (!numeric && /^(?:は|が|を|で|も)?\s*(?:可能(?:です)?か|でき(?:ます)?か|出来(?:ます)?か)/u.test(text.slice(mention.end))) || /(?:なら|場合)[^、,。\n；;]*$/u.test(text.slice(0, mention.index)));
  const alternative = accepted.some((mention, index) => index && /か|または|又は|どちら|と/u.test(text.slice(accepted[index - 1].end, mention.index)) && (!allowCombination || /どちら|どっち|迷|比較/u.test(text))) || /どちら|どっち|比較|比べ/u.test(text) && mentions.length > 0;
  const ambiguous = conditional || alternative || (!allowCombination && values.length > 1) || (mentions.length > 0 && values.length === 0);
  return { values: ambiguous ? [] : values, ambiguous, evidence: accepted.map(mention => mention.evidence).join('／') };
}

const DATE_TOKEN = /明後日|あさって|明日|今日|(?<![\d-])(?:(?:\d{4})[年/-])?\d{1,2}[月/-]\d{1,2}日?(?![\d-])|(?<!\d)\d{1,2}日/gu;
const dateTokens = text => [...text.matchAll(DATE_TOKEN)];
const businessHoursQuestion = text => /営業|何時(?:まで|から)|(?:開店|閉店)(?:時間|時刻)|(?:お店|店舗).{0,12}(?:開いて|空いて|閉ま|やって)/u.test(text) && /[?？]|ですか|ますか|でしょうか|教えて|知りたい/u.test(text);
const ambiguousDateWording = text => /ではなく|じゃなく|ではない|ではありません|じゃない|以外|なら|場合|変更前|(?:日|あさって)(?:は|が)?(?:無理|不可|だめ|ダメ|難し)/u.test(text);
const dateRole = text => {
  const use = /使用|利用|使う|使って|使い|式|誕生日|イベント/u.test(text);
  const receive = /受取|受け取|配達|届|引取|引き取|取りに/u.test(text);
  return use && receive ? null : use ? 'use_date' : receive ? 'receive_date' : null;
};

// Shared by order routing and burst grouping: a new order must also begin a
// new burst, so preceding facts cannot leak into its intake.
export function startsNewOrder(text) {
  return /^(?:別件(?:で|の|です|[\s：:。、,]|$)|(?:別の注文|別のご注文|新しい注文|新しいご注文|新規注文|もう(?:一つ|ひとつ|1つ)(?:の注文|注文)?)(?=[\s：:。、,]|$|お願い|を|は))/u.test(normalize(text).trim());
}

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

export function extractConversationFacts({ text = '', sourceTimestamp, lastQuestions = [], hasImage = false, history = [], fields = {} } = {}) {
  const rawText = String(text);
  text = normalize(text);
  const updates = [];
  const intent = classifyConversationIntent(text);
  const facts = { budget: null, items: [], dateAmbiguities: [], choiceAmbiguities: [], intent };
  if (intent.suppressFacts) return { updates, facts };
  const quantityLabel = text.match(/(?:^|\n)\s*(?:数量|個数)\s*[:：]\s*([^\n]+)/u);
  const budgetLabel = text.match(/(?:^|\n)\s*(?:ご予算|予算)\s*[:：]\s*([^\n]+)/u);
  const budgetPattern = new RegExp(`${NUMBER}(?:\\s*[〜~～−–-]\\s*${NUMBER})?\\s*${budgetLabel ? '円?' : '円'}`, 'gu');
  const choices = {
    product_type: requestedOptions(text, PRODUCT_OPTIONS),
    color_vibe: requestedOptions(text, COLOR_OPTIONS, true),
    fulfillment_method: requestedOptions(text, METHOD_OPTIONS),
    quantity: requestedOptions(quantityLabel?.[1] || text, [[quantityLabel ? /(\d+)\s*(?:個|つ|束|基|台|本|セット)?/gu : /(\d+)\s*(?:個|つ|束|基|台|本|セット)(?!\s*(?:あたり|当たり|\d+円))/gu, match => match[1]]], false, true),
    budget: requestedOptions(budgetLabel?.[1] || text, [[budgetPattern, match => `${amount(match[1], match[2] || match[4])}|${match[3] ? amount(match[3], match[4]) : amount(match[1], match[2])}`]], false, true),
  };
  for (const [key, choice] of Object.entries(choices)) if (choice.ambiguous) facts.choiceAmbiguities.push({ key, evidence: rawText });
  const add = (key, value, confidence = 0.95, evidence = rawText) => {
    if (!value || choices[key]?.ambiguous || updates.some(update => update.key === key)) return;
    updates.push({ key, value: String(value), status: undecided.test(String(value)) ? 'undecided' : 'answered', confidence, phase: 'feasibility', evidence, sourceTimestamp: sourceTimestamp ?? null });
  };
  const labels = { product_type: '商品タイプ|バルーンのタイプ', product_source: '商品番号|品番|参考画像', budget: 'ご予算|予算', color_vibe: '色味|色|全体的なお色味と雰囲気', receive_date: '受取希望日|受け取り希望日|お届け希望日', use_date: '使用日|使用予定日|利用日', fulfillment_method: '受取方法|受け取り方法', quantity: '数量|個数', purpose: '用途', delivery_area: '配達地域|お届け地域', delivery_address: '住所|お届け先', phone: '電話番号|連絡先', customer_name: 'お名前|氏名', balloon_message: '文字入れ', card_message: 'メッセージカード' };
  let hasLabeledDate=false;
  for (const [key, label] of Object.entries(labels)) {
    const match = rawText.match(new RegExp(`(?:^|\\n)[ \\t]*[・•]?[ \\t]*(?:${label})[ \\t]*[:：][ \\t]*([^\\n]+)`, 'u'));
    if (match && !/^（例|^\(例/u.test(match[1].trim())) {
      if(key==='receive_date'||key==='use_date') {
        hasLabeledDate=true;
        const resolved=undecided.test(match[1])?'未定':dateTokens(normalize(match[1])).length===1&&!ambiguousDateWording(match[1])?resolveConversationDate(match[1],sourceTimestamp):null;
        if(resolved)add(key,resolved,1,match[0].trim());else facts.dateAmbiguities.push(match[1].trim());
      } else if (key === 'quantity') {
        const count = normalize(match[1]).trim().match(/^([1-9]\d{0,4})(?:\s*(?:個|つ|束|基|台|本|セット))?$/u);
        if (count) add(key, count[1], 1, match[0].trim());
      } else if (key === 'budget') {
        // Numeric values (including corrections) are normalized below. Never
        // let a raw labelled answer bypass their ambiguity checks.
        if (!choices.budget.values.length) add(key, match[1].trim(), 1, match[0].trim());
      } else if (choices[key]) {
        if (!choices[key].ambiguous) add(key, choices[key].values.join('・') || match[1].trim(), 1, match[0].trim());
      } else if (key === 'product_source') {
        // A label must not bypass the same rejection guard as free text.
        if (!/ではなく|じゃなく|ではない|ではありません|じゃない|不要|いらない/u.test(match[1])) add(key, match[1].trim(), 1, match[0].trim());
      } else add(key, match[1].trim(), 1, match[0].trim());
    }
  }
  const lastKey = typeof lastQuestions.at(-1) === 'string' ? lastQuestions.at(-1) : lastQuestions.at(-1)?.key;
  const questionKeys = lastQuestions.map(q => typeof q === 'string' ? q : q.key);
  const priorQuestionKeys = history.flatMap(item => item.questions || []).map(q => typeof q === 'string' ? q : q.key);
  if (!questionKeys.some(key => ['use_date', 'receive_date', 'use_date_confirmation'].includes(key)) && !known(fields.use_date) && priorQuestionKeys.includes('use_date')) questionKeys.push('use_date');
  if (text.trim().length < 80 && /おまかせ|お任せ/u.test(text)
      && (questionKeys.includes('color_vibe') || /色(?:味)?(?:は|を|も|について)|お色/u.test(text))
      && !/(?:おまかせ|お任せ)(?:ではなく|じゃなく|ではない|ではありません|じゃない|にしない|にしません)/u.test(text)) add('color_vibe', 'おまかせ', 1);
  if (hasImage) add('product_source', '参考画像あり（内容未確認）', 1);
  if (lastQuestions.length === 1 && text.trim().length < 80) {
    if (lastKey === 'quantity' && /^\d+[。！!]?$/u.test(text.trim())) add('quantity', text.trim().replace(/[。！!]/g,''), 1);
    if (lastKey === 'budget' && /^\d[\d,]*$/u.test(text.trim())) add('budget',`${Number(text.trim().replaceAll(',','')).toLocaleString('ja-JP')}円（単価・合計未確認）`,0.9);
    // Only a short answer to the explicit lettering question is a name to
    // print. Do not turn other names or questions into personalization.
    if (lastKey === 'balloon_message') {
      const lettering = text.trim().match(/^(?:名入れ(?:は)?[：:\s]*)?[「『"]?([A-Za-z][A-Za-z0-9 ._-]{0,39})[」』"]?(?:で(?:お願いします)?|です)?[。!！]?$/u);
      if (lettering) add('balloon_message', lettering[1].trim(), 1);
    }
  }
  if (lastQuestions.length === 1 && lastKey && undecided.test(text) && text.length < 30) add(lastKey, '未定', 0.95);
  const reference = text.match(/(?:商品番号|品番|商品No\.?|HP(?:の)?(?:商品)?番号)\s*[:：#]?\s*([A-Za-z0-9_-]+)/iu);
  if (reference && !/^(?:は|が)?\s*(?:ではなく|じゃなく|ではない|ではありません|じゃない)/u.test(text.slice(reference.index + reference[0].length))) add('product_source', reference[1], 1, reference[0]);
  if (choices.product_type.values.length) add('product_type', choices.product_type.values[0]);
  const purpose = text.match(/卒団|卒業|卒部|誕生日|周年|開店|開業|移転|結婚|発表会|退職|還暦|喜寿|米寿|プロポーズ|葬儀|告別式|法要|追悼|お悔やみ|お供え|受付飾り/u);
  if (purpose) add('purpose', purpose[0]);
  if (choices.quantity.values.length) add('quantity', choices.quantity.values[0], 0.95, choices.quantity.evidence);
  if (choices.budget.values.length) {
    const [min, max] = choices.budget.values[0].split('|').map(Number);
    const scope = /単価|あたり|当たり|(?:1[つ個束基台本]|一つ|ひとつ)\s*\d[\d,]*(?:万|千)?\s*円/u.test(text) ? 'unit' : /合計|全体|総額|全部で/u.test(text) ? 'total' : 'unknown';
    if (min <= max && Number.isFinite(max)) {
      const qualifier = /(?:円|万|千)\s*(?:以内|以下|まで|を超えない)/u.test(text) ? 'upper_bound' : /(?:円|万|千)\s*(?:程度|くらい|位|前後)/u.test(text) ? 'approximate' : 'unspecified';
      facts.budget = { min, max, currency: 'JPY', scope, qualifier, evidence: choices.budget.evidence };
      add('budget', `${min.toLocaleString('ja-JP')}${max !== min ? `〜${max.toLocaleString('ja-JP')}` : ''}円${qualifier === 'upper_bound' ? '以内' : qualifier === 'approximate' ? '程度' : ''}${scope === 'unit' ? '／1つ' : scope === 'total' ? '（合計）' : '（単価・合計未確認）'}`);
      if (scope !== 'unknown') add('budget_scope', scope);
    }
  }
  if (/^(?:全体|合計|全部)(?:です|で|の金額)?[。！!]?$/u.test(text.trim()) && questionKeys.includes('budget_scope')) add('budget_scope', 'total');
  if (/^(?:1つあたり|一つあたり|単価)(?:です)?[。！!]?$/u.test(text.trim()) && questionKeys.includes('budget_scope')) add('budget_scope', 'unit');
  const colors = choices.color_vibe.values;
  if (colors.length) add('color_vibe', colors.join('・'), 0.85);
  // Preserve per-item wording intact; do not collapse multiple names into a customer's name.
  for (const line of rawText.split(/\r?\n/u)) if (/(?:背番号|名入れ|文字入れ|数字)[：:\s]*|(?:\d+)\s+[A-Za-z]{2,}/u.test(line)) facts.items.push({ specification: line.trim(), evidence: line.trim() });
  if (choices.fulfillment_method.values.length) add('fulfillment_method', choices.fulfillment_method.values[0]);
  const area = text.match(/([一-龯ぁ-んァ-ヶ]{2,12}(?:市|郡|区))/u);
  if (area) add('delivery_area', area[1], 0.8, area[0]);
  const tokens = dateTokens(text);
  if (!hasLabeledDate && tokens.length) {
    const candidates = [];
    const clauses = text.split(/[、,。\n；;]/u);
    for (const clause of clauses) {
      const dates = dateTokens(clause);
      if (!dates.length) continue;
      if (businessHoursQuestion(clause)) continue;
      // Relative dates in courtesy phrases describe the conversation, not
      // pickup. Keep bare answers such as "明日です" available to intake.
      if (!dateRole(clause) && /(?:今日|明日|明後日|あさって)(?:も|は)?[^。\n]*(?:ありがとう|お忙し|よろしく|こんにちは|お世話)/u.test(clause)) continue;
      const resolved = dates.length === 1 && resolveConversationDate(dates[0][0], sourceTimestamp);
      const role = dateRole(clause);
      // With multiple dates, a local role is mandatory. Do not use the first
      // event date as receipt just because another clause mentions pickup.
      if (!resolved || (tokens.length > 1 && !role)
          || (/使用|利用|式|誕生日|イベント/u.test(clause) && /受取|受け取|配達|届|引取|引き取/u.test(clause))
          || ambiguousDateWording(clause)) facts.dateAmbiguities.push(clause.trim());
      else {
        const dateQuestions = questionKeys.map(key => key === 'use_date_confirmation' ? 'use_date' : key).filter(key => ['use_date', 'receive_date'].includes(key));
        candidates.push({ key: role || (new Set(dateQuestions).size === 1 ? dateQuestions[0] : 'receive_date'), value: resolved, evidence: clause.trim() });
      }
    }
    if (candidates.some((candidate, index) => candidates.some((other, otherIndex) => otherIndex !== index && other.key === candidate.key && other.value !== candidate.value))) facts.dateAmbiguities.push(text);
    if (!facts.dateAmbiguities.length) for (const candidate of candidates) add(candidate.key, candidate.value, 0.95, candidate.evidence);
  } else if (!hasLabeledDate && /来週|来月|週末/u.test(text)) facts.dateAmbiguities.push(text);
  const timePattern = /(午前|午後)?\s*(\d{1,2})(?:時(?:(\d{1,2})分?|半)?|:(\d{2}))/gu;
  const timeCandidates = text.split(/[、,。\n；;]/u).filter(clause => dateRole(clause) !== 'use_date' && !businessHoursQuestion(clause)).flatMap(clause => [...clause.matchAll(timePattern)]);
  if (timeCandidates.length > 1) facts.dateAmbiguities.push('お受け取りの時間が複数あります');
  const dateChangeUnresolved = /変更|変え|ではなく|じゃなく/u.test(text) && tokens.length > 0 && facts.dateAmbiguities.length > 0;
  if (dateChangeUnresolved) for (let i = updates.length - 1; i >= 0; i--) if (['receive_date', 'use_date', 'receive_time'].includes(updates[i].key)) updates.splice(i, 1);
  const time = !facts.dateAmbiguities.length && timeCandidates.length === 1 ? timeCandidates[0] : null;
  if(time) {
    let hour=Number(time[2]);const minute=time[3]?Number(time[3]):time[4]?Number(time[4]):/半/u.test(time[0])?30:0;
    if(time[1]==='午後'&&hour<12)hour+=12;
    if(time[1]==='午前'&&hour===12)hour=0;
    if(hour<24&&minute<60)add('receive_time',String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0'),0.9,time[0]);
  }
  return { updates, facts };
}

export function planConversation({ text = '', fields = {}, history = [], sourceTimestamp, lastQuestions = [], hasImage = false } = {}) {
  const { updates, facts } = extractConversationFacts({ text, sourceTimestamp, lastQuestions, hasImage, history, fields });
  const merged = { ...fields };
  const intent = facts.intent;
  if (intent.suppressFacts) return { updates: [], fields: merged, facts, intent, questions: [], message: intent.message, requiresOwner: intent.requiresOwner, ownerReasons: intent.reason ? [intent.reason] : [], evidence: [], clarificationNeeded: false, approvalRequired: intent.requiresOwner };
  for (const update of updates) merged[update.key] = { value_text: update.value, status: update.status };
  const ownerReasons = [];
  if (intent.requiresOwner && intent.reason) ownerReasons.push(intent.reason);
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
  const hoursInquiry = businessHoursQuestion(normalize(text));
  if (hoursInquiry) ownerReasons.push('business_hours_confirmation');
  if (facts.choiceAmbiguities.length) ownerReasons.push('order_exception');
  if (facts.items.length > 1) ownerReasons.push('per_item_specifications');
  // Old unanswered questions remain unresolved. Suppress only the immediate
  // repetition; when all other questions are exhausted, clarify them again.
  const asked = new Set(lastQuestions.map(item => typeof item === 'string' ? item : item.key));
  const questions = [];
  const receiveChanged = updates.some(update => update.key === 'receive_date' && valueOf(fields.receive_date) && update.value !== valueOf(fields.receive_date));
  const answeredUseConfirmation = updates.some(update => update.key === 'use_date') || /^(?:はい[、,。\s]*)?(?:変更なし|変更ありません|そのまま|同じ日|使用日はそのまま|ご使用日はそのまま)(?:です|でお願いします)?[。!！\s]*$/u.test(normalize(text).trim());
  const confirmationPending = lastQuestions.some(q => (typeof q === 'string' ? q : q.key) === 'use_date_confirmation');
  const useDateNeedsConfirmation = !answeredUseConfirmation && (receiveChanged || confirmationPending);
  if (useDateNeedsConfirmation) questions.push({ key: 'use_date_confirmation', text: known(fields.use_date) ? 'お受け取り希望日の変更ですね。ご使用日は以前お知らせいただいた日から変更なしでよろしいでしょうか？' : 'お受け取り希望日の変更ですね。ご使用日はいつでしょうか？お受け取り日から推測せず確認いたします。' });
  const deferred = [];
  const ask = key => {
    if (known(merged[key]) || questions.some(question => question.key === key)) return;
    if (asked.has(key)) deferred.push({ key, text: `念のため、${QUESTIONS[key]}` });
    else if (questions.length < 2) questions.push({ key, text: QUESTIONS[key] });
  };
  if (facts.dateAmbiguities.length && !asked.has('date_clarification')) questions.push({ key: 'date_clarification', text: dateTokens(normalize(text)).length > 1 ? 'ご使用日とお受け取り希望日を、それぞれ何年何月何日か教えていただけますか？' : `「${facts.dateAmbiguities[0]}」は何年何月何日のご予定でしょうか？` });
  const choiceQuestions = { product_type: 'ご希望の商品はどのタイプでしょうか？複数の場合は、それぞれ教えてください。', color_vibe: '最終的にご希望のお色を教えていただけますか？', fulfillment_method: 'お受け取り方法のご希望を確認させてください。配達・発送の可否は確認いたします。', quantity: '最終的にご希望の数量を教えていただけますか？複数の商品は、それぞれの数量をお願いします。', budget: '最終的なご予算を教えていただけますか？1つあたりか、全体の合計かもお願いします。' };
  for (const ambiguity of facts.choiceAmbiguities) if (questions.length < 2) questions.push({ key: ambiguity.key, text: choiceQuestions[ambiguity.key] });
  if (/配達|発送/u.test(method)) ask('delivery_area');
  if (!known(merged.use_date)) {
    // Usage is a separate prerequisite. Keep this unanswered question in the
    // immediate context even when the customer first answers another detail.
    if (!useDateNeedsConfirmation && questions.length < 2 && !questions.some(q => q.key === 'use_date')) questions.push({ key: 'use_date', text: QUESTIONS.use_date });
  } else ask('receive_date');
  if (!known(merged.product_source)) ask('product_type');
  ask('fulfillment_method');
  if (!ownerReasons.includes('urgent_capacity') && !ownerReasons.includes('delivery_feasibility')) {
    ask('quantity');
    if (known(merged.budget) && !known(merged.budget_scope) && (facts.budget?.scope === 'unknown' || /単価・合計未確認/u.test(valueOf(merged.budget)))) ask('budget_scope');
    ask('budget');
    ask('color_vibe');
  }
  if (!questions.length && !ownerReasons.length) questions.push(...deferred.slice(0, 2));
  const waiting = !questions.length && !ownerReasons.length;
  if (waiting) ownerReasons.push('review_collected_details');
  const historyCheck=ownerReasons.includes('verify_previous_order') ? '以前のご注文を確認します。変更したい点があれば、その点だけお知らせください。' : '';
  const restrained = intent.kind === 'bereavement' || /葬儀|法要|追悼|お悔やみ|お供え|受付飾り|還暦|喜寿|米寿|プロポーズ/u.test(text + valueOf(merged.purpose));
  const photoRefused = [text, ...history.map(item => item.text || '')].some(value => /(?:写真|画像|名前や写真)[^。\n]{0,24}(?:送ら|送りたく|出さ|共有しない|共有したく)/u.test(value));
  const selectedQuestions = (restrained ? questions.slice(0, 1) : questions).map(q => {
    let questionText = restrained ? q.text.replaceAll('😊', '') : q.text;
    if (photoRefused) questionText = questionText.replace(/写真だけでも大丈夫です😊?/u, '');
    return { ...q, text: questionText };
  });
  const message = [intent.kind === 'bereavement' ? intent.message : updates.length ? `ご回答ありがとうございます${restrained ? '。' : '😊'}` : `ご連絡ありがとうございます${restrained ? '。' : '😊'}`, historyCheck, hoursInquiry ? '営業時間は店舗の担当者に確認してご案内します。' : '', ...selectedQuestions.map(question => question.text), ownerReasons.length && intent.kind !== 'bereavement' ? 'いただいた内容で対応できるか確認いたします。' : ''].filter(Boolean).join('\n\n');
  return { updates, fields: merged, facts, intent, questions: selectedQuestions, message, requiresOwner: ownerReasons.length > 0, ownerReasons, evidence: updates.map(({ key, evidence, sourceTimestamp: timestamp }) => ({ key, text: evidence, sourceTimestamp: timestamp })), clarificationNeeded: useDateNeedsConfirmation || facts.dateAmbiguities.length > 0 || facts.choiceAmbiguities.length > 0, approvalRequired: true };
}
