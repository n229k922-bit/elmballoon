// Preserve customer-written specification evidence. No catalogue, historical
// price, recipient identity or image contents are inferred by these helpers.
const clean = value => String(value ?? '').trim();
const phonePattern = /(?:\+81[ -]?|0)\d(?:[ -]?\d){8,10}/gu;
const messageStart = /(?:バルーン(?:に|へ)(?:入れる|入れ|の)?文字|文字入れ|名入れ|メッセージカード|カード(?:の)?(?:本文|文面|メッセージ)?|メッセージ(?:の)?(?:本文|文面)?|文字)(?:(?:は|を|が)[ \t：:→]*|[\s：:→]+)/gu;
const operationalBoundary = /(?:\n|[、。]\s*)(?=(?:受取|受け取|お受け取|配達|お届け|発送|使用日|予算|合計|電話|連絡先|住所|支払|送り主(?:は|：|:)|商品番号|アレンジ\s*[0-9０-９]))/u;
function receivingRanges(text) {
  if (!/受取|受け取|配達|お届け/u.test(text) || /支払|来店相談/u.test(text)) return [];
  return [...text.matchAll(/(?<h1>\d{1,2})(?:時(?:(?<m1>\d{1,2})分?|(?<half1>半))?|:(?<colon1>\d{2}))?\s*(?:〜|～|~|から)\s*(?<h2>\d{1,2})(?:時(?:(?<m2>\d{1,2})分?|(?<half2>半))?|:(?<colon2>\d{2}))/gu)]
    .filter(({groups:g}) => Number(g.h1) < 24 && Number(g.h2) < 24 && Number(g.m1 || g.colon1 || 0) < 60 && Number(g.m2 || g.colon2 || 0) < 60);
}

function messageBlocks(text) {
  const starts = [...text.matchAll(messageStart)];
  return starts.map((match, i) => {
    const start = match.index + match[0].length;
    let end = starts[i + 1]?.index ?? text.length;
    const boundary = text.slice(start, end).search(operationalBoundary);
    if (boundary >= 0) end = start + boundary;
    const body = clean(text.slice(start, end));
    const key = /バルーン|文字入れ|名入れ/u.test(match[0]) ? 'balloon_message'
      : /カード/u.test(match[0]) ? 'card_message' : null;
    return { start: match.index, end, body, key, evidence: text.slice(match.index, end) };
  }).filter(block => block.body);
}

export function extractOrderSpecifications(value) {
  const text = clean(value);
  const updates = [], items = [];
  const add = (key, content, evidence) => {
    if (!clean(content)) return;
    updates.push({ key, value: clean(content), evidence: clean(evidence), status: 'answered' });
  };
  const preserve = evidence => {
    evidence = clean(evidence);
    if (evidence && !items.some(item => item.evidence === evidence)) items.push({ specification: evidence, evidence });
  };
  const phones = [...text.matchAll(phonePattern)].filter(match => {
    const before = text[match.index - 1] || '';
    const after = text[match.index + match[0].length] || '';
    const digits = match[0].replace(/\D/gu, '');
    return !/\d/u.test(before + after) && (digits.length === 10 || digits.length === 11 || match[0].startsWith('+81'));
  });
  if (phones.length === 1) {
    const match = phones[0];
    const line = text.slice(0, match.index).split('\n').at(-1) || '';
    if (/電話|連絡|折り返|依頼者/u.test(text) || clean(text) === match[0]) {
      const key = /(?:配達先|届け先|受取人|先方|お届け先|対応者)/u.test(line) ? 'delivery_phone' : 'phone';
      add(key, match[0], match[0]);
    }
  } else if (phones.length > 1) {
    // Multiple numbers may belong to applicant, recipient or intermediary.
    // Retain role-bearing lines rather than collapsing them into one contact.
    for (const line of text.split('\n')) if (/(?:\d[ -]?){9,}/u.test(line)) preserve(line);
  }
  const addressLines = text.split('\n').filter(line => /住所|所在地|(?:都|道|府|県|市|区|町|村).*(?:丁目|番地|\d[-－]\d)|\d+丁目/u.test(line));
  for (const line of addressLines) {
    if (/送り主|差出人|依頼者(?:の)?住所/u.test(line)) { preserve(line); continue; }
    const label = line.match(/(?:配達先(?:住所)?|お届け先(?:住所)?|住所|所在地)[：:\s]+([^\n]+)/u);
    const bare = line.match(/^\s*((?:[^\s、。]{1,14}(?:都|道|府|県))?[^\s、。]{1,20}(?:市|区|町|村)[^、。\n]*?\d(?:[^、。\n]*?))(?:です|になります)?[♪!！。\s]*$/u);
    const address = clean((label?.[1] || bare?.[1] || '').split(/(?:電話|連絡先|受取希望|配達日時)[：:\s]*/u)[0]);
    if (address && !/未確認|分から|わから|不明|変更.*相談/u.test(address)) add('delivery_address', address, line);
    else preserve(line);
  }
  const blocks = messageBlocks(text);
  // A message with multiple product rows must remain per-item. It must not be
  // reduced to a single shared card or a single shared balloon inscription.
  const multiple = /(?:[1-9１-９](?:人|点)目|商品[1-9１-９]|Aは|Bは|Cは|[ＡＢＣ]は)/u.test(text)
    || [...text.matchAll(/(?:アレンジ|商品(?:番号)?|品番)\s*[0-9０-９①-⑳]+/gu)].length > 1
    || /[2-9２-９](?:点|つ|個|名分|人分)|複数/u.test(text) && [...text.matchAll(/[0-9０-９,，]+(?:万|千)?円/gu)].length > 1
    || blocks.some((block, index) => blocks.slice(0, index).some(previous => previous.key === block.key));
  for (const block of blocks) {
    if (block.key && !multiple) add(block.key, block.body, block.evidence);
    preserve(block.evidence);
  }
  if (multiple) {
    // Entire original allocation preserves item boundaries, individual budgets,
    // sender lines and recipient names even when precise parsing is uncertain.
    preserve(text);
    for (const part of text.split(/\n|(?=(?:[A-CＡ-Ｃ]は|[1-9１-９](?:人|点)目))/u)) {
      if (/(?:[A-CＡ-Ｃ]は|[1-9１-９](?:人|点)目|アレンジ\s*[0-9０-９①-⑳]|商品[1-9１-９]|商品番号|品番)/u.test(part)) preserve(part);
    }
  }
  for (const line of text.split('\n')) {
    if (/背番号|フォント|ラッピング|包装|リボン|(?:持帰|持ち帰り).{0,4}袋|送り主|贈り主|差出人|宛名|受取人|届け先.*(?:店名|名称)|代理|仲介|生年月日|[生産]まれ|写真|ローマ字表記|折り返|再ラッピング|地図|(?:\d+)\s+[A-Za-z]{2,}/u.test(line)) preserve(line);
  }
  const ranges = receivingRanges(text);
  if (ranges.length === 1) {
    const range = ranges[0];
    const pad = value => String(value || 0).padStart(2, '0');
    const g = range.groups;
    add('receive_time', `${pad(g.h1)}:${pad(g.half1 ? 30 : g.m1 || g.colon1)}〜${pad(g.h2)}:${pad(g.half2 ? 30 : g.m2 || g.colon2)}`, range[0]);
    preserve(range[0]);
  } else if (ranges.length) for (const range of ranges) preserve(range[0]);
  return { updates, items };
}

// Mask only non-order-number/date/color evidence before generic extraction.
// Preserve raw text separately with extractOrderSpecifications for auditability.
export function specificationTextForFacts(value) {
  let text = String(value ?? '');
  for (const range of receivingRanges(text).reverse()) text = text.slice(0, range.index) + '（受取時間帯は別記）' + text.slice(range.index + range[0].length);
  const blocks = messageBlocks(text);
  for (const block of blocks.reverse()) text = text.slice(0, block.start) + '（印字内容は別記）' + text.slice(block.end);
  text = text.replace(/(?:生年月日|誕生日ではなく生年月日|生まれた日)[は：:\s]*[0-9０-９]{2,4}[年./-][0-9０-９]{1,2}[月./-][0-9０-９]{1,2}日?/gu, '（生年月日は別記）');
  text = text.replace(/[0-9０-９]{4}[年./-][0-9０-９]{1,2}[月./-][0-9０-９]{1,2}日?[生産まれ]/gu, '（生年月日は別記）');
  text = text.replace(/(?:カード|印字|文字)(?:の)?日付[は：:\s]*[0-9０-９]{2,4}[年./-][0-9０-９]{1,2}(?:[月./-][0-9０-９]{1,2}日?)?/gu, '（印字日付は別記）');
  const colors = '(?:メタリックブラック|ゴールド|シルバー|ラベンダー|ライム|ピンク|ブルー|赤|青|白|黒|黄|紫|緑)(?:色)?';
  text = text.replace(new RegExp(`(?:持ち帰り用|持帰り用|持ち帰り|持帰り)?${colors}(?:い|の)?(?:袋|リボン|ラッピング|包装)`, 'gu'), '（包材指定は別記）');
  text = text.replace(new RegExp(`(?:ラッピング|包装|袋|リボン)(?:は|：|:|を|が)?\\s*${colors}(?:(?:と|・|／)?${colors})*`, 'gu'), '（包材指定は別記）');
  return text;
}
