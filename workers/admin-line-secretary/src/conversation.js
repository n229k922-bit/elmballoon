import { extractOrderSpecifications, specificationTextForFacts } from './conversation-specifications.js';
// Deterministic intake assistance. Facts are suggestions supported by this message;
// availability, prices and acceptance always require shop confirmation.
const QUESTIONS = {
  product_type: 'どのようなバルーンをご希望ですか？写真だけでも大丈夫です😊',
  receive_date: 'いつ頃のお受け取りをご希望ですか？未定でも大丈夫です。',
  use_date: 'ご使用日・イベント日はいつ頃でしょうか？未定でも大丈夫です。',
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
export function classifyConversationIntent(value = '', history = []) {
  const text = normalize(value).trim();
  const result = (kind, suppressFacts, requiresOwner, reason, message) => ({ kind, suppressFacts, requiresOwner, reason, message });
  if (/誤飲|飲み込|のみ込|窒息|息ができ|呼吸が|意識が|ヘリウム.{0,8}(?:吸った|吸い込|吸って)|火傷|やけど|怪我|(?:^|[。\s、])けが|けがを|けがした|出血/u.test(text)) return result('safety', true, true, 'safety_incident', '安全に関わるご相談として、人の担当へ優先して引き継ぎます。差し迫った危険がある場合は、店舗の返信を待たず地域の緊急窓口や医療機関へご相談ください。');
  if (/責任者|人間|人の担当|スタッフ|店長/u.test(text) && /話したい|代わって|かわって|つないで|繋いで|直接/u.test(text)) return result('handoff', true, true, 'human_handoff', '人の担当へ引き継ぎます。確認前に対応内容や返金などを確約せず、担当からご案内します。');
  if (/苦情|クレーム|ひどい|酷い|最悪|話が違|納得でき|返品|返金|交換して|しぼみ|萎み|色が.{0,8}違|届か|まだ来/u.test(text)) return result('complaint', true, true, 'customer_complaint', 'ご不便をおかけし申し訳ありません。人の担当へ引き継ぎ、注文内容と状況を確認して対応をご案内します。交換・返金などは確認後のご案内となります。');
  if (/店(?:側)?(?:の|で)?(?:日付|日時|注文|手配).{0,6}間違|日付間違/u.test(text)) return result('complaint',true,true,'customer_complaint','ご不便をおかけし申し訳ありません。これまでのお約束と今回の状況を確認し、担当者から対応をご案内いたします。');
  if (/キャンセル|取消|取り消|いったん保留|一旦保留|注文.{0,12}保留/u.test(text) && !/キャンセル(?:料|無料|規定|ポリシー)|キャンセルは(?:しない|しません)/u.test(text)) return result('withdrawal',true,true,'consultation_withdrawal','取り消し・保留のご希望として承りました。対象のご相談と現在の手配状況を担当者が確認いたします。');
  if (/業務提携|取材|営業のご案内|商品の注文ではなく/u.test(text)) return result('handoff',true,true,'human_handoff','ご相談内容を担当者へ引き継ぎます。注文の受付とは分けて確認いたします。');
  if (/実注文では|呼出しテスト|呼び出しテスト/u.test(text)) return result('test',true,false,null,'テストのご連絡として受け取りました。商品の注文としては登録いたしません。');
  if (/今回(?:は|の)?(?:新しい|新規)?注文(?:は|が)?(?:ありません|ないです)|注文内容はありません/u.test(text)) return result('non_order',true,false,null,'ご連絡ありがとうございます。またご相談がありましたら、お気軽にお声がけください。');
  if (/支払|入金|領収書|振込/u.test(text) && /伺|行き|来店|予定|お願いします|希望|お願い|相談|できなく/u.test(text)
      && !/予算|新しい注文|別の注文|別注文|商品.{0,5}変更/u.test(text)) return result('payment_followup',true,true,'payment_or_receipt_confirmation','お支払い・領収書についてのご希望として承りました。これまでのご相談内容と合わせて確認いたします。');
  if ((/文字|メッセージ|名入れ|ローマ字|表記/u.test(text) || /\d+番[^。\n]{0,24}(?:ではなく|変え)/u.test(text)) && /変更|ではなく|じゃなく|削除|消して|消す|訂正|変え/u.test(text)) return result('specification_change',true,true,'order_exception','文字・メッセージの変更希望として承りました。変更前と今回の内容を照合して確認いたします。');
  if (/今後の流れ|この後の流れ|次はどう|次に何|注文の流れ/u.test(text)) return result('process_question',true,false,null,'ご希望を整理した後、制作やお届けの可否・金額を確認してご案内します。内容をご確認いただいてから正式なご注文へ進みます。決まっていない点は、引き続き一緒に相談できます。');
  if (/もう少し待|待っていただ|待ってもら|返事を待|機会があれば/u.test(text)) return result('response_timing',true,false,null,'承知しました。ご都合が整いましたら、ご相談の続きとしてご連絡ください。');
  if (/フォント.{0,15}(?:何|なに|こと)|文字の形.{0,10}(?:こと|ですか)/u.test(text)) return result('explanation',true,false,null,'フォントは、文字の形や書体のことです。すっきりした文字や手書きのような文字などがあります。専門的な名前が分からなくても、雰囲気や見本をもとに一緒に選べます。');
  if (/^(?:おけ|おっけー|OK|オッケー)(?:です|ですー|ー|!|！|。|\s)*$/iu.test(text)) return result('closing',true,false,null,'承知しました。ありがとうございます。');
  if (/色|配色|ピンク/u.test(text) && /なや|悩|迷|合い|合う|似合|いいですね|どうでしょう|提案/u.test(text)) return result('color_consultation',true,true,'design_consultation',`お色のご相談ですね。${/着物|衣装|前撮り/u.test(text+' '+history.map(item=>item.text||'').join(' '))?'お着物や衣装に':'贈るお相手や飾る場所に'}合わせて、やわらかなピンク系や落ち着いた色の組み合わせなど、ご希望の印象を伺いながら候補をご案内します。気になっているお色は候補として確認いたします。`);
  if (/(?:また|あと|次回|その後|別に)[\s\S]{0,20}(?:\d{1,2}月\d{1,2}日|来年)[\s\S]{0,50}(?:改めて|またその時|次の注文)|(?:\d{1,2}月\d{1,2}日)[\s\S]{0,40}また[\s\S]{0,20}(?:お願い|連絡|注文)/u.test(text))
    return result('future_order_preview',true,true,'separate_order_confirmation', `${/文字[\s\S]{0,20}それで/u.test(text) ? '文字は先ほどのご提案へのお返事として受け取りました。' : ''}次回のご注文は別のご相談として、改めてのご連絡をお待ちしています。今回の内容と混ざらないよう確認いたします。`);
  if (/見送|注文(?:は|を)?しない|今回は(?:やめ|止め|不要)|相談.{0,6}(?:終了|やめ)/u.test(text)) return result('withdrawal', true, true, 'consultation_withdrawal', '見送りのご希望として承りました。対象のご相談と正式注文の状況を確認し、ほかのご相談を変えずに扱います。');
  const lastStore = history.filter(item => ['assistant', 'store'].includes(item.direction || item.side) && item.text?.trim()).at(-1)?.text || '';
  const recentContext = history.filter(item => item.text).slice(-4).map(item => item.text).join('\n');
  // A deadline for answering a proposal is neither the event nor pickup date.
  if (/(?:今日|明日|明後日|あさって|\d{1,2}日).{0,12}(?:待って|お待ち|待ちください|返事|回答|連絡します|連絡いたします|相談して|相談します|検討して)/u.test(text)
      || /(?:相談|検討).{0,20}(?:連絡|返事|回答)/u.test(text))
    return result('response_timing', true, false, null, '承知しました。ご検討後にご連絡ください。ご相談中の内容は引き続き確認できるようにしておきます。');
  const shortAnswer = text.length < 140 && !startsNewOrder(text);
  const conversationalEvents=history.filter(item=>item.text?.trim());
  const latestStoreIndex=[...conversationalEvents].map((item,index)=>['assistant','store'].includes(item.direction||item.side)?index:-1).filter(index=>index>=0).at(-1);
  const customerBeforeLatestStore=latestStoreIndex==null?-1:[...conversationalEvents.slice(0,latestStoreIndex)].map((item,index)=>item.direction==='customer'||item.side==='customer'?index:-1).filter(index=>index>=0).at(-1);
  const paymentTimePrompt=latestStoreIndex!=null&&customerBeforeLatestStore!=null&&customerBeforeLatestStore>=0
    &&/(?:支払|入金|領収書|振込|PayPay|お会計)/u.test(conversationalEvents[customerBeforeLatestStore].text)
    &&/(?:来店|お店に伺|伺|お越し|訪問|お時間|何時|時刻|時間)/u.test(lastStore);
  const paymentAcknowledgementFollowup=latestStoreIndex!=null&&customerBeforeLatestStore!=null&&customerBeforeLatestStore>=0
    &&/(?:支払|入金|領収書|振込|PayPay|お会計)/u.test(conversationalEvents[customerBeforeLatestStore].text)
    &&/(?:支払|入金|PayPay|お会計|お支払い)/u.test(lastStore)
    &&/(?:今日|明日|明後日|\d{1,2}日|\d{1,2}時|伺|行き|行きます)/u.test(text);
  if ((/支払|入金|領収書|振込|PayPay|お会計/u.test(text)
      || (shortAnswer && (paymentTimePrompt || paymentAcknowledgementFollowup) && /(?:今日|明日|明後日|\d{1,2}日|\d{1,2}時|伺|行き|大丈夫|お願い|はい)/u.test(text)))
      && !/使用|受取|受け取|配達|発送|届け|誕生日|注文を|バルーン|文字|メッセージ|ブーケ|スタンド/u.test(text)
      && !/折り返|電話/u.test(lastStore))
    return result('payment_followup', true, true, 'payment_or_receipt_confirmation', 'お支払い・領収書についてのご希望として承りました。これまでのご相談内容と合わせて確認いたします。');
  if(shortAnswer&&/(?:配達|配送|お届け).{0,5}(?:時間|時刻)|(?:配達|配送).{0,5}\d{1,2}時/u.test(text))
    return result('schedule_followup',true,true,'order_exception','配達日時のご希望として承りました。対象のご注文と変更内容を照合して、対応できるか確認いたします。');
  if(lastStore && shortAnswer && /\d{1,2}時[^。\n]{0,16}(?:なりました|変わりました|変更)/u.test(text))
    return result('schedule_followup',true,true,'order_exception','日時についての変更希望として承りました。これまでのお約束と今回の候補を照合して、対応できるか確認いたします。');
  if (lastStore && shortAnswer && /\d{1,2}時|夕方|午前|午後|祝日|遅れ/u.test(text)
      && /受取|受け取|お渡し|営業時間|来店|お越し|取りに|大体のお時間/u.test(recentContext+' '+text)
      && /お願い|大丈夫|可能|変更|遅れ|いけ|行け|伺|受取|受け取|なりました|なんじ|何時/u.test(text)
      && !/支払|領収/u.test(recentContext))
    return result('schedule_followup',true,true,'order_exception','日時についてのご希望として承りました。これまでのお約束と今回の候補を照合して、対応できるか確認いたします。');
  if (shortAnswer && /来店|ご来店|お越し|相談予約|打ち合わせ/u.test(lastStore)
      && /(?:今日|明日|\d{1,2}日|\d{1,2}時|遅れ|遅く|伺|大丈夫)/u.test(text)
      && !/受取|受け取|配達|発送|使用|商品を/u.test(text))
    return result('appointment_followup', true, true, 'appointment_confirmation', 'ご来店相談についてのご希望として承りました。お約束の日時と合わせて確認いたします。');
  if (/なければ|在庫|入荷|欠品|売り切れ|品切れ/u.test(text)
      && /あります|どう|大丈夫|なければ|無ければ|代わり|いつ|できます|できますか|代替|見たい/u.test(text))
    return result('inventory_question', true, true, 'inventory_confirmation', '在庫・代替商品のご相談として承りました。先ほどのご案内と今回のご希望を合わせて、用意できるか確認いたします。');
  if (shortAnswer && /(?:それで|そちらで|その内容で|その形で|そのままで|大丈夫です|よろしく|宜しく|お願い)/u.test(text)
      && /(?:いかが|よろしい|どうでしょう|ご提案|代わり|代替|変更|構成|文字|お入れ|お作り|ご用意|こちらで|こちらの|見積|円)/u.test(lastStore)
      && !/変更したい|ではなく|じゃなく|キャンセル/u.test(text))
    return result('proposal_confirmation', true, true, 'proposal_confirmation', 'ありがとうございます。先ほどご案内した内容へのご希望として承りました。内容を照合して、次のご案内をいたします。');
  if (/折り返|電話(?:を|して)|連絡(?:を)?(?:お願い|ください|下さい)|電話番号/u.test(text) && /\d[\d-]{8,}|折り返|電話/u.test(text)
      && !/バルーン.{0,30}(?:届け|注文)|ブーケ|スタンド/u.test(text))
    return result('contact_update', true, true, 'contact_confirmation', 'ご連絡先とお電話のご希望として承りました。担当者へ引き継ぎ、これまでのご相談内容と合わせて確認いたします。');
  if (!startsNewOrder(text) && /話したところ|相談したところ|外出|デイサービス|今.{0,20}(?:信号|向か|近く|着|到着)|後ほど|また[、,\s]*(?:連絡|選び)|改めて連絡|検討します|注文する時.{0,8}また/u.test(text))
    return result('context_followup', true, true, 'conversation_context_review', 'ご連絡ありがとうございます。これまでのご相談の続きとして承りました。いただいた内容を確認いたします。');
  if (/今.{0,8}(?:店前|お店の前|店舗前)|看板.{0,10}CLOSE/u.test(text)) return result('appointment_followup',true,true,'appointment_confirmation','ご来店のご連絡として受け取りました。現在の対応状況を担当者に確認いたします。');
  if (/感謝です|感謝いたします|ありがとうございます.{0,12}(?:よろしく|宜しく)|有難うございます|有難うございました|^(?:ありがとうございます|了解しました|こちらこそです)[♪♡😊🙏👍✨!！。\s]*$|^は[ーい]+(?:宜しく|よろしく)お願いします/u.test(text)
      && !/注文|変更|支払|配達|受取|円|個/u.test(text))
    return result('closing', true, false, null, 'こちらこそ、ありがとうございます。また必要なときにお声がけください。');
  if (/(?:配達|配送|届け|お届け).{0,12}(?:ありがとう|ありがとうございました|有難う|助かりました)/u.test(text) || /喜んで.{0,8}(?:もら|いただ|頂)|完成写真.{0,30}確認/u.test(text) && /ありがとう/u.test(text)) return result('delivery_acknowledgement', true, false, null, 'ご連絡ありがとうございます。喜んでいただけたようで安心しました。また何かございましたら、お気軽にご相談ください。');
  // Operational follow-ups must not fall back into the new-order questionnaire.
  // In particular, address-only replies contain numbers that look like dates.
  if (/電話|連絡先/u.test(text) && !/注文|バルーン|ブーケ|スタンド/u.test(text)) {
    return result('contact_update', true, true, 'contact_confirmation', 'ご連絡先の情報として受け取りました。対象のご注文と登録内容を確認して、担当からご案内します。');
  }
  if (/住所|お届け先|所在地|番地|丁目|号室|建物|ビル/u.test(text)
      && !/注文|バルーン|ブーケ|スタンド|配達.{0,8}(?:したい|できます|希望|お願い)/u.test(text)) {
    return result('address_update', true, true, 'address_confirmation', 'お届け先の情報として受け取りました。対象のご注文と配達条件を確認して、担当からご案内します。');
  }
  if (/領収書|レシート|請求書|支払(?:い|の)|入金|PayPay|振込|現金/u.test(text)
      && !/注文|バルーン|ブーケ|スタンド|アレンジ|予算|別注文/u.test(text)) {
    return result('payment_followup', true, true, 'payment_or_receipt_confirmation', 'お支払い・領収書に関するご連絡として受け取りました。対象のご注文と金額を確認して、担当からご案内します。');
  }
  if (/(?:いくら|(?:価格|料金|値段|金額)[^。\n]{0,20}(?:教え|ですか|でしょう|知りたい|確認|[?？]))/u.test(text)
      && !/予算/u.test(text)) {
    return result('price_inquiry', true, true, 'price_confirmation', '料金についてのご質問として受け取りました。商品内容と条件を確認して、担当からご案内します。');
  }
  if (!startsNewOrder(text) && /別件|別の(?:ご)?注文|新しい(?:ご)?注文|新規注文/u.test(text)) return result('mixed_orders', true, true, 'order_exception', '別のご注文を含むご相談として承りました。既存のご注文は変更せず、今回のご希望がどちらのご注文についてか、人の担当が確認いたします。');
  if (/葬儀|葬式|お葬式|告別式|法要|追悼|お悔やみ|お供え|亡くな|亡くし|死ん|死去|(?:子供|子ども|娘|息子).{0,5}死/u.test(text)) return result('bereavement', false, true, 'sensitive_occasion', 'ご事情をお聞かせいただきありがとうございます。ご希望に沿えるか、内容を慎重に確認いたします。');
  if (/^(?:(?:どうも|こちらこそ|はい)[、,。\s]*)?(?:ありがとうございます|ありがとうございました|ありがとう|了解です|承知しました|わかりました|分かりました|助かりました)[😊🙏👍✨!！。\s]*(?:また(?:必要な|機会|今度|よろしく|連絡|相談)[\s\S]*)?$/u.test(text) || /^(?:また必要な(?:とき|時)に相談します|今回はここまで)[😊🙏👍。!！\s]*$/u.test(text)) return result('closing', true, false, null, 'こちらこそ、ありがとうございます。また必要なときにお声がけください。');
  if (lastStore && /^(?:はい|はーい|お願いします|お願いいたします|宜しくお願いします|よろしくお願いします|了解しました|こちらこそです)[♪♡😊🙏👍✨!！。、\s]*$/u.test(text))
    return /お気をつけ|おきをつけ|お待ちして|かしこまりました/u.test(lastStore)
      ? result('closing',true,false,null,'ありがとうございます。ご不明な点がありましたら、お気軽にご連絡ください。')
      : result('proposal_confirmation',true,true,'proposal_confirmation','承知しました。先ほどご案内した内容へのお返事として受け取り、これまでのご相談内容と合わせて確認いたします。');
  if (lastStore && text.length<80 && /でした|です/u.test(text) && !/\d|注文|予算|使用|受取|色|配達|商品/u.test(text))
    return result('context_followup',true,true,'conversation_context_review','補足のご連絡ありがとうございます。これまでのご相談内容と合わせて確認いたします。');
  const unrelated = /天気|天候|ニュース|株価|選挙|政治|占い|晩ご飯|夕飯|冗談|ジョーク/u.test(text);
  const orderClause = /注文|バルーン|ブーケ|スタンド|配達|受取|受け取|取りに|色は|予算|葬儀|飾り/u.test(text);
  if (unrelated && !orderClause) return result('smalltalk', true, false, null, 'こちらではバルーンのご注文・ご相談をお手伝いしています。ご注文の内容は変更せずにおきます。');
  const serviceQuestion = /持込|持ち込|充填|営業時間.{0,16}(?:行け|合|相談)|代替.{0,12}相談|可能ですか|過去|前回|以前|利用しました/u.test(text);
  return result('order', false, serviceQuestion, serviceQuestion ? 'service_feasibility' : null, null);
}

const PRODUCT_OPTIONS = [[/スタンド/gu, 'バルーンスタンド'], [/ブーケ/gu, 'ブーケ'], [/おむつケーキ/gu, 'おむつケーキ'], [/ヘリウム|浮く/gu, 'ヘリウム（浮く）タイプ'], [/アレンジ/gu, '置き型アレンジメント'], [/リリース/gu, 'バルーンリリース']];
const COLOR_OPTIONS = [[/メタリックブラック|ゴールド|シルバー|ピンク|ブルー|ラベンダー|ライム|グレー|赤|青|白|黒|黄色|紫|緑/gu, null]];
const METHOD_OPTIONS = [[/店頭|取りに|受け取りに|引き取り/gu, '店頭受取'], [/発送|郵送/gu, '発送'], [/配達|配送|届けて|お届け/gu, '配達']];
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
const ambiguousDateWording = text => /ではなく|じゃなく|ではない|ではありません|じゃない|以外|なら|場合|変更前|(?:日|あさって)(?:は|が)?(?:無理|不可|だめ|ダメ|難し)/u.test(text);
const dateRole = text => {
  const use = /使用|利用|使う|使って|使い|式|発表会|周年|卒業|卒団|前撮り|撮影|誕生日|イベント/u.test(text);
  const receive = /受取|受け取|配達|届|引取|引き取|取りに/u.test(text);
  if(/預け|預かり|持込日|持ち込み日/u.test(text) && !use && !receive)return 'dropoff_date';
  return use && receive ? null : use ? 'use_date' : receive ? 'receive_date' : null;
};

// Shared by order routing and burst grouping: a new order must also begin a
// new burst, so preceding facts cannot leak into its intake.
export function startsNewOrder(text) {
  return /^(?:別件(?:で|の|です|[\s：:。、,]|$)|(?:別の注文|別のご注文|新しい注文|新しいご注文|新規注文|もう(?:一つ|ひとつ|1つ)(?:の注文|注文)?)(?=[\s：:。、,]|$|お願い|を|は|で))/u.test(normalize(text).trim());
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

export function extractConversationFacts({ text = '', fields = {}, sourceTimestamp, lastQuestions = [], hasImage = false, history = [] } = {}) {
  const rawText = String(text);
  text = normalize(text);
  const updates = [];
  const intent = classifyConversationIntent(text, history);
  const facts = { budget: null, items: [], dateAmbiguities: [], choiceAmbiguities: [], intent };
  const spec = extractOrderSpecifications(rawText);
  if (!['safety','complaint','withdrawal','handoff','test','future_order_preview'].includes(intent.kind)) {
    updates.push(...spec.updates.map(update => ({...update,confidence:0.95,sourceTimestamp:sourceTimestamp ?? null})));
    facts.items.push(...spec.items);
    if(intent.kind==='specification_change'&&!facts.items.length)facts.items.push({specification:rawText,evidence:rawText});
  }
  if (intent.suppressFacts && !['color_consultation','inventory_question','price_inquiry'].includes(intent.kind)) {
    // A price question can still explicitly identify the product and method.
    // Do not turn a quoted price/question into the customer's budget.
    if (intent.kind === 'price_inquiry') {
      for (const [key, options] of [['product_type', PRODUCT_OPTIONS], ['fulfillment_method', METHOD_OPTIONS]]) {
        const choice = requestedOptions(text, options);
        if (choice.values.length === 1) updates.push({key,value:choice.values[0],status:'answered',confidence:0.95,evidence:rawText,sourceTimestamp:sourceTimestamp ?? null});
      }
      if (hasImage) updates.push({key:'product_source',value:'参考画像あり（内容未確認）',status:'answered',confidence:1,evidence:'添付画像',sourceTimestamp:sourceTimestamp ?? null});
    }
    return { updates, facts };
  }
  text = normalize(specificationTextForFacts(rawText));
  // Quoted lettering/recipient names are product content, never order counts.
  if(/名前|名入れ|文字|メッセージ|カード/u.test(text)&&/[「『]/u.test(text)) {
    facts.items.push({specification:rawText,evidence:rawText});
    text=text.replace(/[「『][^」』]*[」』]/gu,' ');
  }
  const quantityText=text.replace(/(?:一(?=個|つ|台|束|本)|ひと(?=つ))/gu,'1').replace(/(?:二(?=個|つ|台|束|本)|ふた(?=つ))/gu,'2');
  const quantityLabel = quantityText.match(/(?:^|\n)\s*(?:数量|個数)\s*[:：]\s*([^\n]+)/u);
  const budgetLabel = text.match(/(?:^|\n)\s*(?:ご予算|予算)\s*[:：]\s*([^\n]+)/u);
  const budgetPattern = new RegExp(`${NUMBER}(?:\\s*[〜~～−–-]\\s*${NUMBER})?\\s*${budgetLabel ? '円?' : '円'}`, 'gu');
  const choices = {
    product_type: requestedOptions(text, PRODUCT_OPTIONS),
    color_vibe: requestedOptions(text, COLOR_OPTIONS, true),
    fulfillment_method: requestedOptions(text, METHOD_OPTIONS),
    quantity: requestedOptions(quantityLabel?.[1] || quantityText, [[quantityLabel ? /(\d+)\s*(?:個|つ|束|基|台|本|セット)?/gu : /(\d+)\s*(?:個|つ|束|基|台|本|セット)(?!\s*(?:あたり|当たり|\d+円))/gu, match => match[1]]], false, true),
    budget: requestedOptions(budgetLabel?.[1] || text, [[budgetPattern, match => `${amount(match[1], match[2] || match[4])}|${match[3] ? amount(match[3], match[4]) : amount(match[1], match[2])}`]], false, true),
  };
  const revisedBudget=text.match(/(?:予算|金額)[^。\n]{0,12}?\d[\d,]*(?:万|千)?円(?:から|→)\s*(\d[\d,]*)(万|千)?円/u);
  if(revisedBudget) {
    const revised=amount(revisedBudget[1],revisedBudget[2]);
    choices.budget={values:[`${revised}|${revised}`],ambiguous:false,evidence:revisedBudget[0]};
  }
  if(intent.kind==='price_inquiry')choices.budget={values:[],ambiguous:false,evidence:''};
  if(intent.kind==='color_consultation')choices.color_vibe={...choices.color_vibe,values:[]};
  if(intent.kind==='inventory_question'&&/なければ|無ければ|欠品|未定|代替/u.test(text))choices.color_vibe={values:[],ambiguous:false,evidence:''};
  const finishedCount=text.match(/(?:ブーケ|アレンジ|スタンド|おむつケーキ|バルーン)?\s*(\d+)\s*(?:点|名分|名へ|名様分|人分)/u);
  const recipientCount=text.match(/(\d+)\s*(?:名分|名様分|人分)/u);
  const changedCount=quantityText.match(/(\d+)\s*(?:個|つ|束|基|台|本)(?:から|→|を)\s*(\d+)\s*(?:個|つ|束|基|台|本)(?:へ|に|まで|[、。\s]|$)/u);
  if(recipientCount||changedCount||finishedCount) choices.quantity={values:[changedCount?.[2]||recipientCount?.[1]||finishedCount[1]],ambiguous:false,evidence:(changedCount||recipientCount||finishedCount)[0]};
  const invalidCount=/(?:[-−]\s*\d+|\d+\.\d+|(?<!\d)0)\s*(?:個|つ|束|基|台|本|セット|点|名分|名様分|人分)/u.test(quantityText)
    || Boolean(quantityLabel&&/(?:[-−]\s*\d|\d+\.\d+)/u.test(quantityLabel[1]))
    || choices.quantity.values.some(value=>! /^[1-9]\d{0,4}$/u.test(value));
  const allocatedCount=/(?:個|つ|束|基|台|本|セット)\s*ずつ|(?:各|一人|ひとり|1人)[^。\n]{0,12}\d+\s*(?:個|つ|束|台|本)|(?:個|つ|台|本)\s*[×x*]/u.test(quantityText);
  const countChanges=[...quantityText.matchAll(/\d+\s*(?:個|つ|束|基|台|本)(?:から|→|を)\s*\d+\s*(?:個|つ|束|基|台|本)/gu)];
  const deniedChange=/(?:変更|訂正)(?:は)?(?:しない|しません|しなく|せず)/u.test(quantityText);
  if(invalidCount||allocatedCount||countChanges.length>1||deniedChange) {
    choices.quantity={values:[],ambiguous:true,evidence:rawText};
    facts.items.push({specification:rawText,evidence:rawText});
  }
  else if(/(?:星|ハート|キャラ|音符|かすみ草).{0,10}\d+\s*個/u.test(text) && !/(?:ブーケ|アレンジ|スタンド|おむつケーキ)\s*\d+\s*(?:個|つ|台|基)/u.test(text)) {
    facts.items.push({specification:rawText,evidence:rawText});
    choices.quantity={values:[],ambiguous:false,evidence:''};
  }
  if(/(?:かすみ草|名入れ|文字入れ|追加料金)\s*\d+(?:万|千)?円/u.test(text) && !/予算|合計|総額|全体/u.test(text)) {
    facts.items.push({specification:rawText,evidence:rawText});
    choices.budget={values:[],ambiguous:false,evidence:''};
  }
  for (const [key, choice] of Object.entries(choices)) if (choice.ambiguous) facts.choiceAmbiguities.push({ key, evidence: rawText });
  const add = (key, value, confidence = 0.95, evidence = rawText) => {
    if (!value || choices[key]?.ambiguous || updates.some(update => update.key === key)) return;
    if(key==='quantity'&&!/^[1-9]\d{0,4}$/u.test(String(value)))return;
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
  if (text.trim().length < 80 && /おまかせ|お任せ/u.test(text)
      && (questionKeys.includes('color_vibe') || /色(?:味)?(?:は|を|も|について)|お色/u.test(text))
      && !/(?:おまかせ|お任せ)(?:ではなく|じゃなく|ではない|ではありません|じゃない|にしない|にしません)/u.test(text)) add('color_vibe', 'おまかせ', 1);
  if (hasImage) add('product_source', '参考画像あり（内容未確認）', 1);
  if (lastQuestions.length === 1 && text.trim().length < 80) {
    if (lastKey === 'quantity' && /^\d+[。！!]?$/u.test(text.trim())) add('quantity', text.trim().replace(/[。！!]/g,''), 1);
    if (lastKey === 'budget' && /^\d[\d,]*$/u.test(text.trim())) add('budget',`${Number(text.trim().replaceAll(',','')).toLocaleString('ja-JP')}円（単価・合計未確認）`,0.9);
  }
  if (lastQuestions.length === 1 && lastKey && undecided.test(text) && text.length < 30) add(lastKey, '未定', 0.95);
  const reference = text.match(/(?:商品番号|品番|商品No\.?|HP(?:の)?(?:商品)?番号)\s*[:：#]?\s*([A-Za-z0-9_-]+)/iu);
  if (reference && !/^(?:は|が)?\s*(?:ではなく|じゃなく|ではない|ではありません|じゃない)/u.test(text.slice(reference.index + reference[0].length))) add('product_source', reference[1], 1, reference[0]);
  const catalogReferences=[...text.matchAll(/(?:アレンジ|商品)\s*(\d+)\s*番/gu)];
  if(catalogReferences.length && !/ではなく|じゃなく|違う|やめ/u.test(text)) add('product_source',catalogReferences.map(match=>match[0]).join('／'),1,catalogReferences.map(match=>match[0]).join('／'));
  if (choices.product_type.values.length) add('product_type', choices.product_type.values[0]);
  if(!choices.product_type.values.length&&/(?:ハート|星)(?:の)?(?:小さい|小さな|大きい|大きな)(?:方|ほう|タイプ)/u.test(text)) {
    const shape=text.match(/(?:ハート|星)(?:の)?(?:小さい|小さな|大きい|大きな)(?:方|ほう|タイプ)/u)[0];
    add('product_source',shape,0.95,shape);
    facts.items.push({specification:shape,evidence:shape});
  }
  const purpose = text.match(/卒団|卒業|卒部|誕生日|周年|開店|開業|移転|結婚|発表会|成人式|前撮り|退職|還暦|喜寿|米寿|プロポーズ|葬儀|告別式|法要|追悼|お悔やみ|お供え|受付飾り/u);
  if (purpose) add('purpose', purpose[0]);
  if (choices.quantity.values.length) add('quantity', choices.quantity.values[0], 0.95, choices.quantity.evidence);
  if (choices.budget.values.length) {
    const [min, max] = choices.budget.values[0].split('|').map(Number);
    const scope = /単価|あたり|当たり|(?:1[つ個束基台本]|一つ|ひとつ)\s*\d[\d,]*(?:万|千)?\s*円/u.test(text) ? 'unit' : /合計|全体|総額|全部で/u.test(text) ? 'total' : 'unknown';
    if (min <= max && Number.isFinite(max)) {
      facts.budget = { min, max, currency: 'JPY', scope, evidence: choices.budget.evidence };
      add('budget', `${min.toLocaleString('ja-JP')}${max !== min ? `〜${max.toLocaleString('ja-JP')}` : ''}円${scope === 'unit' ? '／1つ' : scope === 'total' ? '（合計）' : '（単価・合計未確認）'}`);
      if (scope !== 'unknown') add('budget_scope', scope);
    }
  }
  if (/^(?:全体|合計|全部)(?:です|で|の金額)?[。！!]?$/u.test(text.trim()) && questionKeys.includes('budget_scope')) add('budget_scope', 'total');
  if (/^(?:1つあたり|一つあたり|単価)(?:です)?[。！!]?$/u.test(text.trim()) && questionKeys.includes('budget_scope')) add('budget_scope', 'unit');
  const colors = choices.color_vibe.values;
  if (colors.length) add('color_vibe', colors.join('・'), 0.85);
  // Preserve per-item wording intact; do not collapse multiple names into a customer's name.
  for (const line of rawText.split(/\r?\n/u)) if (/(?:背番号|名入れ|文字入れ|数字)[：:\s]*|(?:\d+)\s+[A-Za-z]{2,}/u.test(line) && !facts.items.some(item=>item.evidence===line.trim())) facts.items.push({ specification: line.trim(), evidence: line.trim() });
  if (choices.fulfillment_method.values.length) add('fulfillment_method', choices.fulfillment_method.values[0]);
  const area = text.match(/([一-龯ぁ-んァ-ヶ]{2,12}(?:市|郡|区))/u);
  if (area && (/配達|配送|お届け|届け先|届け(?:たい|て|る|ます)|住所/u.test(text)||questionKeys.includes('delivery_area'))) add('delivery_area', area[1].split(/[のでへはがをにと]/u).at(-1), 0.8, area[0]);
  const tokens = dateTokens(text);
  if (!hasLabeledDate && tokens.length) {
    const candidates = [];
    const clauses = text.split(/[、,。\n；;]/u);
    const wholeReceiptContext = /受取|受け取|配達|発送|届|引取|引き取|取りに/u.test(text);
    for (const clause of clauses) {
      const dates = dateTokens(clause);
      if (!dates.length) continue;
      // Relative dates in courtesy phrases describe the conversation, not
      // pickup. Keep bare answers such as "明日です" available to intake.
      if (!dateRole(clause) && /(?:今日|明日|明後日|あさって)(?:も|は)?[^。\n]*(?:ありがとう|お忙し|よろしく|こんにちは|お世話)/u.test(clause)) continue;
      let resolved = dates.length === 1 && resolveConversationDate(dates[0][0], sourceTimestamp);
      let matchedExistingDateKey = null;
      if(!resolved && dates.length===1 && /^\d{1,2}日$/u.test(dates[0][0])) {
        const reference=text.match(/(?:(\d{4})年)?(\d{1,2})月\d{1,2}日/u);
        const day=anchorDay(sourceTimestamp);
        if(reference&&day)resolved=calendarDate(Number(reference[1]||day.slice(0,4)),Number(reference[2]),parseInt(dates[0][0]));
        else if(/今月/u.test(clause)&&day)resolved=calendarDate(Number(day.slice(0,4)),Number(day.slice(5,7)),parseInt(dates[0][0]));
        else {
          // If routing already selected one existing order because this day
          // uniquely matches its recorded date, carry that exact date and
          // field into the continuation. Do not infer a month from unrelated
          // orders or from a date that does not match the customer's wording.
          const dayNumber=Number(dates[0][0].match(/\d+/u)?.[0]);
          const matches=['use_date','receive_date'].flatMap(key=>{
            const value=valueOf(fields[key]);
            const match=value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
            return match&&Number(match[3])===dayNumber?[{key,value}]:[];
          });
          const unique=[...new Map(matches.map(match=>[`${match.key}:${match.value}`,match])).values()];
          if(unique.length===1){resolved=unique[0].value;matchedExistingDateKey=unique[0].key;}
        }
      }
      const dateQuestions = lastQuestions.filter(q => ['use_date','receive_date'].includes(typeof q === 'string' ? q : q.key));
      const directDateAnswer = /^(?:\s*)(?:今日|明日|明後日|あさって|(?:(?:\d{4})[年/-])?\d{1,2}[月/-]\d{1,2}日?)(?:です|でお願いします|希望です)?[。!！?？\s]*$/u.test(text);
      const lastStore = history.filter(item => ['assistant','store'].includes(item.direction || item.side)).at(-1);
      const question = dateQuestions.length === 1 ? dateQuestions[0] : null;
      const questionStillCurrent = !lastStore || typeof question !== 'object' || (question && lastStore.text.includes(question.text || question.question_text || '\u0000'));
      const contextualRole = directDateAnswer && question && questionStillCurrent ? (typeof question === 'string' ? question : question.key) : null;
      const role = dateRole(clause) || matchedExistingDateKey || contextualRole;
      // With multiple dates, a local role is mandatory. Do not use the first
      // event date as receipt just because another clause mentions pickup.
      if (!resolved || (tokens.length > 1 && !role)
          || (/使用|利用|式|誕生日|イベント/u.test(clause) && /受取|受け取|配達|届|引取|引き取/u.test(clause))
          || ambiguousDateWording(clause)) facts.dateAmbiguities.push(clause.trim());
      // A bare date in an occasion-led consultation is the event/use date;
      // otherwise it remains the ordinary pickup date. This prevents a
      // birthday or anniversary date from being silently stored as pickup.
      // The purpose from an earlier turn is not enough to reinterpret a bare
      // date. A reply such as「明日でも大丈夫ですか」may answer a pickup
      // question even when the order is for a birthday. Only an explicit
      // occasion in this turn can make an unlabelled date a use date.
      const occasionDate = /誕生日|周年|開店|開業|移転|結婚|発表会|退職|還暦|喜寿|米寿|卒業|卒団|卒部|プロポーズ|葬儀|告別式|法要|追悼|お悔やみ|お供え|受付飾り/u.test(text);
      // A bare date is not sufficient evidence for either business date. Even
      // if the previous assistant question happened to mention one of them,
      // customers commonly mean the other date (for example, “明日でも大丈夫
      // ですか？” after a birthday consultation). Require an explicit role
      // such as 使用日/受取日, or ask a short clarification instead of
      // silently carrying a date into the wrong field.
      const receiptContext = wholeReceiptContext || /受取|受け取|配達|発送|届|引取|引き取|取りに/u.test(clause);
      if (!role && !occasionDate && !receiptContext) {
        facts.dateAmbiguities.push(clause.trim());
        continue;
      }
      candidates.push({ key: role || (receiptContext ? 'receive_date' : 'use_date'), value: resolved, evidence: clause.trim() });
    }
    if (candidates.some((candidate, index) => candidates.some((other, otherIndex) => otherIndex !== index && other.key === candidate.key && other.value !== candidate.value))) facts.dateAmbiguities.push(text);
    if (!facts.dateAmbiguities.length) for (const candidate of candidates) add(candidate.key, candidate.value, 0.95, candidate.evidence);
  } else if (!hasLabeledDate && /来週|来月|週末/u.test(text)) facts.dateAmbiguities.push(text);
  const timePattern = /(午前|午後)?\s*(\d{1,2})(?:時(?:(\d{1,2})分?|半)?|:(\d{2}))/gu;
  if(/\d{1,2}(?:時)?\s*[〜~～-]\s*\d{1,2}時/u.test(text)) {
    facts.dateAmbiguities.push('お受け取りの時間に幅があります');
    facts.items.push({specification:rawText,evidence:rawText});
  }
  const timeCandidates = text.split(/[、,。\n；;]/u).filter(clause => dateRole(clause) !== 'use_date').flatMap(clause => [...clause.matchAll(timePattern)]);
  if(timeCandidates.length&&/無理なら|難しければ|かも|なりそう|どちら|または/u.test(text))facts.dateAmbiguities.push('お受け取り時間は候補として確認が必要です');
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
  const { updates, facts } = extractConversationFacts({ text, fields, sourceTimestamp, lastQuestions, hasImage, history });
  const merged = { ...fields };
  const intent = facts.intent;
  if (intent.suppressFacts) {
    for (const update of updates) merged[update.key] = { value_text:update.value,status:update.status };
    const colorChoice=intent.kind==='color_consultation'&&facts.choiceAmbiguities.some(item=>item.key==='color_vibe');
    const questions=colorChoice?[{key:'color_vibe',text:'華やかな印象とやわらかな印象など、どのような雰囲気に近づけたいでしょうか？'}]:[];
    const ownerReasons=intent.reason?[intent.reason]:[];
    if(colorChoice)ownerReasons.push('order_exception');
    const colors=colorChoice?[...new Set(normalize(text).match(/ピンク|赤|青|白|黒|緑|黄色|紫/g)||[])]:[];
    const message=colorChoice?`${colors.length?colors.join('と')+'で迷われているのですね。':'お色で迷われているのですね。'}まだ決定せず、候補として確認いたします。\n\n${questions[0].text}`:intent.message;
    return { updates, fields: merged, facts, intent, questions, message, requiresOwner: intent.requiresOwner, ownerReasons, evidence: updates.map(({key,evidence,sourceTimestamp})=>({key,text:evidence,sourceTimestamp})), clarificationNeeded: colorChoice, approvalRequired: intent.requiresOwner };
  }
  // Do not reinterpret a bare date based on the earlier question. The date
  // role must be present in the customer's own message; otherwise the
  // clarification branch below is the only safe path.
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
  if (/\d+\s*(?:個|つ|束|基|台|本)(?:から|→)\s*\d+\s*(?:個|つ|束|基|台|本)/u.test(text)) ownerReasons.push('order_exception');
  if (facts.choiceAmbiguities.length) ownerReasons.push('order_exception');
  if (facts.items.length > 1) ownerReasons.push('per_item_specifications');
  if(facts.items.some(item=>/出演者\d+名|[ABCＡＢＣ]は|[1-9１-９](?:人|点)目/u.test(item.specification)))ownerReasons.push('per_item_specifications');
  // Old unanswered questions remain unresolved. Suppress only the immediate
  // repetition; when all other questions are exhausted, clarify them again.
  const asked = new Set(lastQuestions.map(item => typeof item === 'string' ? item : item.key));
  const questions = [];
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
  // For occasion-led orders the date that matters first is the event/use
  // date. Asking only for pickup can make a birthday, anniversary, or
  // ceremony consultation feel like a generic delivery intake. Once the use
  // date is known, the next turn may ask for pickup/delivery timing as needed.
  const occasion = /誕生日|周年|開店|開業|移転|結婚|発表会|退職|還暦|喜寿|米寿|卒業|卒団|卒部|プロポーズ|葬儀|告別式|法要|追悼|お悔やみ|お供え|受付飾り/u.test(`${text} ${valueOf(merged.purpose)}`);
  if (!known(merged.use_date)) ask(occasion ? 'use_date' : 'receive_date');
  if (!known(merged.product_source) && !facts.items.some(item=>/出演者|[ABCＡＢＣ]は|[1-9１-９](?:人|点)目/u.test(item.specification))) ask('product_type');
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
  const message = [intent.kind === 'bereavement' ? intent.message : updates.length ? `ご回答ありがとうございます${restrained ? '。' : '😊'}` : `ご連絡ありがとうございます${restrained ? '。' : '😊'}`, historyCheck, ...selectedQuestions.map(question => question.text), ownerReasons.length && intent.kind !== 'bereavement' ? 'いただいた内容で対応できるか確認いたします。' : ''].filter(Boolean).join('\n\n');
  return { updates, fields: merged, facts, intent, questions: selectedQuestions, message, requiresOwner: ownerReasons.length > 0, ownerReasons, evidence: updates.map(({ key, evidence, sourceTimestamp: timestamp }) => ({ key, text: evidence, sourceTimestamp: timestamp })), clarificationNeeded: facts.dateAmbiguities.length > 0 || facts.choiceAmbiguities.length > 0, approvalRequired: true };
}
