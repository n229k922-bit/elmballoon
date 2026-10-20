import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { receiveManagerEvents, drainManagerInbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

// Anonymized scenarios DERIVED FROM summaries, never represented as verbatim chats.
// Each source record has its own specific situation and expected safe response.
export const cases = [
 ['A-01','周年のスタンドを2万〜3万円で遠方の鹿屋市へ10月10日までに届けたいです。近郊限定と伺いましたが他の方法はありますか','配達|受取|担当|確認','必ず.*届け|配達できます'],
 ['A-02','昨年の数字12のヘリウムをまたお願いします。星はメタリックブラック、数字は赤。受取日はまだ決まっていません','以前|昨年|確認|未定','昨年と同じ価格で確定'],
 ['A-03','卒部ブーケ3個の使用日は10月10日のままです。休業と聞いたので受取だけ10月9日12時過ぎに変更できますか','確認|受取','使用日.*10月9日'],
 ['A-04','学校のリリース提案をお願いします。ポール1本20個、350個は別校の参考事例で今回の注文数ではありません。動画は委員6名内だけ共有です','確認|人数|数量|担当','350個.*承り|SNS.*公開.*大丈夫'],
 ['A-05','10月31日の保育園リリースは30個から50個へ増やして空色系に。10月6日12時30分は打合せ日時です','確認|担当|変更','使用日.*10月6日'],
 ['A-06','親子クリスマスコンサートが12月20日ですがイベントで配達できないと聞きました。店頭受取など代替を相談したいです','受取|代替|確認|担当','12月20日.*配達.*確定'],
 ['A-07','卒業祝い3名分です。Aは青と黄緑で大きく1万5千〜2万、Bは小さめ8千〜1万、Cは黄緑ピンク8千〜1万。画像もそれぞれ違います','それぞれ|複数|確認|担当','合計.*15000円.*確定'],
 ['A-08','式典のリリース約200個です。予備日11月9日、ヘリウム入荷未定と聞いています。荒天時無料の個別条件と現地小部屋を確認したいです','確認|担当|天候','ヘリウム.*確保済|どなたでも.*キャンセル無料'],
 ['B-01','おむつケーキNo.28、Sテープ18枚、靴下はおまかせ、名入れは漢字です。8月17日12時半〜13時に受取希望です','確認|受取|名入れ','28個.*承り'],
 ['B-02','ピアノ発表会は8月9日、受取は8月7日16時までです。3300円の音符アレンジで欠品時は代替を見たいです','確認|在庫|担当','使用日.*8月7日'],
 ['B-03','スポーツチーム9選手は名前と背番号、マネージャー2名は名前だけ。かすみ草300円を付けたいです。受取7月31日18時','それぞれ|確認|担当','全員.*背番号'],
 ['B-04','アレンジ予算を4800円から6000円に変えます。7月9日18時配達、オンラインカードで支払い予定です','確認|変更|担当','入金.*確認済|お支払い済'],
 ['B-05','発表会用フロート、キャラ2500円と星4個各800円と名入れ500円で6200円と見積りました。英語9番、オレンジ名入れです','確認|名入れ|担当','料金.*確定.*6200'],
 ['B-06','女の子用おむつケーキ2点を各6500円。1人目Sサイズ、2人目Mサイズ、名前も別々です。6月18日11時半受取','それぞれ|確認|担当','2点.*同じ名前'],
 ['B-07','開店祝いの置き型4000円、グレー白で大人っぽく。英語9番でカード日付2026.4、受取6月13日13時です','確認|受取|担当','使用日.*2026-04'],
 ['B-08','結婚祝いバルーンinバルーン、文字の日付2026.06.13、母が6月12日18時半〜19時に代理で受取ります','確認|受取|担当','使用日.*6月12日'],
 ['B-09','撮影用に持ち込むバルーンへのヘリウム充填を希望です。5月12日に預け、13日午前受取、紐もお願いできますか','確認|担当|ヘリウム','必ず.*充填できます'],
 ['B-10','今夜20時〜20時半にラウンジへ配達をお願いしたいです。予算8000円、キティ欠品なら別キャラ、浮く風船3個です','確認|在庫|担当','今夜.*必ず.*配達'],
 ['B-11','100日祝いで利用しました。今回はハーフバースデーで文字は1/2、予算4000円、色は明るくおまかせ。5月12日15時まで受取','確認|以前|用途','数量.*12個'],
 ['B-12','結婚祝いの受取11時ですが20分遅れます。新郎のローマ字表記はYukiではなくYuukiでお願いします','確認|変更|受取','日付を変更しました'],
 ['B-13','傘寿祝いに送った写真をL判印刷してスティックで加えてほしいです。5月1日14時〜14時半受取、サイズ50cmくらい','写真|確認|担当','写真.*確認済'],
 ['B-14','4月30日午後受取のアレンジについて確認したいです。金額や仕様の記録がなければ教えてください','確認|内容|担当','3000円で確定'],
 ['B-15','代理の者です。本人とは連絡が取りづらいので販売所を窓口にしてください。4月8日午前、置き型でヘリウムなしです','連絡|担当|確認','本人へ連絡済'],
 ['B-16','完成写真で見えたカゴ部分を隠して再ラッピングできますか。新築で地図検索は別施設へ行くのでピンで確認を。夫が支払い予定です','確認|担当|地図','支払い済|住所を確定しました'],
 ['B-17','6500円のおむつケーキ、Sサイズ、男の子で英字名入れ。生年月日は2026年2月20日、受取は4月8日10時です','確認|名入れ|受取','使用日.*2月20日'],
 ['B-18','周年祝いの配達先が留守です。破損が心配なので置き配せず、翌日再配達の可否を相談してください','確認|配達|担当','置いておきます|再配達.*確定'],
 ['B-19','ハンドボール部卒部5名分、名前入りハートと小ハート2個ずつ、単価950円。式は9月21日、完成確認9月10日です','確認|それぞれ|担当','数量.*2個.*確定'],
 ['B-20','12000円のスタンド代は振込予定です。領収書を6000円ずつ2枚、宛名なしPDF希望、スタンド回収日も相談したいです','領収|支払|担当|確認','振込.*確認済'],
 ['B-21','4歳の誕生日、ピンクのinバルーン2500円とキャラ1000円です。数字4は年齢、2点を翌日10〜12時に別々に受取ります','確認|それぞれ|担当','4個.*承り'],
 ['B-22','移転祝いの送り主と配達先担当者は別人です。18時前配達とオンライン決済を相談したいです。連絡先を混ぜないでください','確認|担当|連絡','決済.*完了'],
 ['B-23','誕生日カード本文だけ確定しています。TO お客様A、素敵な1年を、BY 贈り主B。商品や日付はまだ相談中です','確認|希望|商品','注文.*確定しました'],
 ['B-24','日焼けキティが入荷遅れなら別のキティで代用可です。8月19日17時頃受取後お店へ届けたいです','確認|代替|在庫','在庫.*確保済'],
 ['B-25','子供誕生日のアンパンマン単品、7月21日11時受取をお願いしていたのに店側の日付間違いです。今からどう対応しますか','申し訳|担当|確認|お詫び','どのようなバルーン'],
 ['B-26','アレンジ2点6500円と16500円、小型だけ子供6名の送り主入り、大型はカードなし。7月17日12〜13時に受取です','それぞれ|確認|担当','両方.*カードを付け'],
 ['B-27','3件分5300円3500円5000円、合計13800円のお支払いは翌日20時半に伺いたいです。納品済みの注文です','支払|確認|担当','受取.*翌日|使用日.*翌日'],
 ['B-28','リニューアル祝い1万円、赤青の浮くタイプ。丸いニコちゃん欠品なら星型候補を見たいです。領収書持参で集金予定です','確認|在庫|担当','集金.*済'],
 ['B-29','プレオープン祝いの浮くタイプ1万円、青系きれいめでカード文は親父ギャグを含みます。9月24日17時受取です','確認|受取|担当','不適切.*お断り'],
 ['B-30','完成写真を確認しました。9月18日20時頃配達のもので喜んでもらえました。ありがとうございました','ありがとう|安心|喜','何個|予算|使用日は'],
 ['B-31','退職する40代女性へ2500円の明るいピンクのブーケ、Thank you、サイズ40×30か35×25で迷っています。翌日10時半希望','確認|サイズ|担当','サイズ.*確定しました'],
 ['B-32','発表会の出演者2名へスヌーピーとキティ、当日午前に受付のお花台へ。紐長めと持帰り赤袋、説明書もお願いします','確認|それぞれ|担当','出演者.*同じキャラクター'],
 ['B-33','受取専用日の6月28日に来たら看板がCLOSEですが、入って大丈夫ですか。今店前です','確認|担当|来店|お越し','入って大丈夫です.*確定'],
 ['B-34','文字内容の余分な一行を削除してください。実店舗OPENおめでとう、屋号A、送り主Bだけにしたいです','確認|変更|文字','削除.*完了'],
 ['C-01','今日配達希望ですが予約いっぱいと言われました。明日明後日も店休だそうですが、何か代替はありますか','確認|担当|代替|受取','本日.*配達できます'],
 ['C-02','8月2日にホテルでプロポーズ装飾をお願いしたいです。夏の高温やイベント重複で現地不可の場合、どうできますか','確認|担当|温度|代替','必ず.*装飾できます'],
 ['C-03','7月30日の前撮り用持込バルーンにヘリウムを入れたいです。供給難と聞きましたが今の掲載場所と入荷を確認したいです','確認|ヘリウム|担当','入荷.*確定'],
 ['C-04','1歳誕生日商品の発送は夏季停止と聞きました。7月29日15時の来店もキャンセルします','承知|担当|キャンセル|確認','いくつ|どのようなバルーン'],
 ['C-05','明日の受取を在庫次第と聞き、項目をもらいましたがまだ返信できていません。これで予約確定ではないですよね','確認|未確定|まだ|担当','予約確定です'],
 ['C-06','前と同じ1500円ブーケで翌日受取を相談しただけです。色や名入れは未回答、注文確定にはしないでください','確認|未確定|担当','注文確定しました'],
 ['C-07','子ども会でランタンを使わなくなったのでヘリウム1600円の相談と8月22日受取を取り消します','承知|担当|取消|確認','何個|どのようなバルーン'],
 ['C-08','5月17日の友人のお店の開店が延期になりました。お祝いバルーンの注文はいったん保留でお願いします','保留|担当|確認|承知','いつ頃のお受け取り'],
 ['C-09','商品の注文ではなく業務提携の相談です。責任者の方へお願いできますか','担当|相談|責任者','ご使用日は|何個|予算'],
 ['C-10','Instagram写真みたいな商品を2日後にお願いできますか。イベントで制作配達できないなら先に教えてください','確認|担当|写真','写真と同じ.*必ず'],
 ['C-11','誕生日注文ですが海外から帰国できなくなりました。今回はキャンセルをお願いします','確認|担当|キャンセル|承知','ご希望のお色|何個'],
 ['C-12','退職者へ店頭展示品を贈りたいのですが営業時間に行けません。受取時間が合うか相談したいです','確認|担当|受取','営業時間外.*必ず.*対応'],
 ['D-01','注文担当の呼出しテストです。これは実注文ではありません','テスト|担当|確認','予約確定'],
 ['D-02','友だち追加しました。まだ注文内容は決めていません','希望|相談|ありがとう','以前と同じ商品.*確定'],
 ['D-03','友だち登録したばかりです。商品の相談だけできますか','希望|相談|ありがとう','注文確定'],
 ['D-04','写真だけ送ります。まだ何をお願いするか文章は送っていません','写真|画像|希望|確認','写真の商品は.*円'],
 ['D-05','初めて追加しました。今回は注文はありません','ありがとう|相談|承知|確認','受取.*確定'],
 ['D-06','前のお礼写真と近況です。今回新しい注文はありません','ありがとう|担当|確認|承知','新規.*確定'],
 ['D-07','配達完了ありがとうございました。商品名などはこの会話に記録がありません','ありがとう|安心','何個|予算|使用日は'],
 ['D-08','以前のグループの受取案内は一覧でしか見えず本文がありません。内容を推測せず確認してください','確認|担当','昨年と同じ商品.*確定'],
 ['D-09','6か月より前のやり取りが非表示です。以前の商品の名前や金額は分かりません','確認|以前|担当','履歴を確認しました.*円'],
 ['A-101','10月10日使用の卒部ブーケ3個、受取だけ9日12時過ぎと店長了承済みです。使用日を変更しないでください','確認|受取|担当','使用日.*10月9日'],
 ['A-102','150周年行事、当日現金支払いと実行委員会名の領収書希望です。色、保管場所、雨天の3案はまだ選んでいません。PDF本文も未確認です','確認|担当|支払','雨天.*確定|350個.*確定'],
 ['A-103','新しい注文でアレンジ21番と27番を2つ、10月2日20時配達希望です。各カード本文は別々、7月の価格住所を流用しないでください','確認|それぞれ|担当','7月と同じ.*確定'],
 ['A-104','放課後デイ開所祝いに大きなキャラを明日までに用意できますか。店休日を挟みますが、他店注文前に可否だけ早く知りたいです','確認|担当|希望','明日.*必ず.*できます'],
 ['A-105','前の開店祝いは支払済みですが、今日は85歳の祖父用に小さめを別注文したいです。今から伺えますか。すぐ作れるかも確認ください','確認|担当|来店','すぐ.*作れます|今回.*支払い済'],
];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
async function run() {
 const [sourcePath, output] = process.argv.slice(2);
 if (!sourcePath || !output || !path.resolve(output).includes(`${path.sep}private${path.sep}`)) throw new Error('Private summary source and private output directory required');
 const source = fs.readFileSync(sourcePath, 'utf8');
 assert.equal(cases.length, 68); assert.equal(new Set(cases.map(c => c[1])).size, 68);
 globalThis.fetch = async () => { throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
 const results = [];
 for (const [id, input, expected, forbidden] of cases) {
  const f = createManagerFixture(); f.env.MANAGER_RELEASE_STAGE = 'live'; f.env.MANAGER_AUTO_INTAKE_ENABLED = 'true';
  // Construct a plausible lead-in before the last explicit scheduled date.
  // This is a derived scenario clock, never a claimed historic message time.
  const dates = [...input.matchAll(/(\d{1,2})月(\d{1,2})日/gu)];
  const scheduled = dates.at(-1);
  const at = scheduled ? new Date(Date.UTC(2026, Number(scheduled[1]) - 1, Number(scheduled[2]) - 3, 1)).toISOString() : '2026-09-30T01:00:00.000Z'; let error = null;
  try { await receiveManagerEvents([{type:'message',webhookEventId:id,timestamp:Date.parse(at),source:{userId:'CUSTOMER'},message:{id,type:'text',text:input}}],f.env,at); await drainManagerInbox(f.env,new Date(Date.parse(at) + 60000).toISOString()); } catch(e) {error=String(e.stack||e);}
  const drafts=f.db.prepare('SELECT * FROM manager_drafts').all(); const reply=drafts.map(d=>d.message).join('\n');
  const match = id.startsWith('D-') ? null : source.match(new RegExp(`### ${id} [\\s\\S]*?(?=\\n### |\\n## |$)`, 'u'));
  const dLines = source.split('## D.')[1]?.split('## E.')[0].split('\n').filter(line => line.startsWith('- ')) || [];
  const sourceSummary = match?.[0] || (id.startsWith('D-') ? dLines[Number(id.slice(2)) - 1] : null);
  assert.ok(sourceSummary, `Source record ${id} must exist`);
  const missingEvidence=sourceSummary.split('\n').filter(line=>/未確認|不明|未確定|本文|未取得|予定|未成立/u.test(line));
  missingEvidence.push('Source is a reviewed summary, not a full verbatim transcript; attachments and historic runtime state are not reproduced');
  const fields=f.db.prepare('SELECT field_key,value_text,status FROM manager_fields').all();
  const items=f.db.prepare('SELECT specification FROM manager_order_items').all();
  const field=key=>fields.find(entry=>entry.field_key===key)?.value_text;
  const semantic=[];const check=(rule,pass)=>semantic.push({rule,pass});
  check('no_unapproved_business_confirmation',fields.every(entry=>entry.status!=='confirmed'));
  check('runtime_processed_exact_case',!error&&drafts.length>0);
  const hasEvidence=pattern=>[...fields.map(entry=>entry.value_text),...items.map(entry=>entry.specification)].some(value=>pattern.test(value));
  const exactDates={ 'A-03':{use_date:'2026-10-10',receive_date:'2026-10-09'},'B-02':{use_date:'2026-08-09',receive_date:'2026-08-07'},'B-17':{receive_date:'2026-04-08'},'A-101':{use_date:'2026-10-10',receive_date:'2026-10-09'},'A-103':{receive_date:'2026-10-02'} };
  for(const [key,value]of Object.entries(exactDates[id]||{}))check(`explicit_${key}_retained`,field(key)===value);
  const quantities={'A-03':'3','A-05':'50','A-08':'200','B-06':'2','B-19':'5','B-21':'2','B-26':'2','A-101':'3','A-103':'2'};
  if(quantities[id])check('finished_item_quantity_correct',field('quantity')===quantities[id]);
  const windows={'B-01':'12:30〜13:00','B-08':'18:30〜19:00','B-10':'20:00〜20:30','B-13':'14:00〜14:30','B-21':'10:00〜12:00','B-26':'12:00〜13:00'};
  if(windows[id])check('time_window_not_endpoint',field('receive_time')===windows[id]);
  if(id==='A-01')check('city_not_budget_prefix',field('delivery_area')==='鹿屋市');
  if(id==='A-02')check('printed_number_not_quantity',field('quantity')!=='12');
  if(id==='A-04')check('reference_quantity_not_order',field('quantity')!=='350');
  if(id==='A-07')check('individual_allocations_preserved',items.some(item=>/Aは.*1万5千.*Bは.*8千.*Cは.*8千/u.test(item.specification)));
  if(id==='B-03')check('accessory_price_not_order_budget',!/300円/u.test(field('budget')||''));
  if(id==='B-04')check('revised_budget_evidence_retained',hasEvidence(/6000|6,000/u));
  if(id==='B-05')check('component_quantity_not_finished_item',field('quantity')!=='4');
  if(id==='B-07')check('both_explicit_colors_retained',hasEvidence(/グレー.*白/u));
  if(id==='B-09')check('dropoff_distinct_from_collection',field('receive_date')==='2026-05-13');
  if(id==='B-11')check('date_not_invented_from_printed_half',field('quantity')!=='12');
  if(id==='B-12')check('letter_correction_preserved',hasEvidence(/Yuuki/u));
  if(id==='B-17')check('birthdate_not_use_date',field('use_date')!=='2026-02-20');
  if(id==='B-20')check('receipt_split_preserved',hasEvidence(/6000.*2枚/u));
  if(id==='B-23')check('card_recipients_sender_preserved',hasEvidence(/TO.*BY/u));
  if(id==='B-25')check('complaint_no_intake_restart',!/どのようなバルーン|ご使用日/u.test(reply));
  if(id==='B-27')check('payment_not_new_fulfillment',!field('receive_date')&&!field('use_date'));
  if(id==='B-31')check('retirement_not_clothing_advice',!/着物/u.test(reply));
  if(id==='B-32')check('bag_color_not_product_color',field('color_vibe')!=='赤');
  if(id==='B-33')check('at_door_request_not_order_restart',!/どのようなバルーン|受け取りは/u.test(reply));
  if(['C-04','C-07','C-08','C-11'].includes(id))check('cancellation_no_new_order_intake',!/どのようなバルーン|ご使用日|いつ頃のお受け取り|いくつご希望/u.test(reply)&&fields.length===0);
  if(['D-01','D-05','D-06'].includes(id))check('explicit_no_order_not_new_open_order',f.db.prepare('SELECT count(*) n FROM manager_orders').get().n===0);
  results.push({id,provenance:'derived_from_historic_summary_not_verbatim',sourceSummary,sourceLocation:sourcePath,missingEvidence,input,scenarioClock:at,expected,forbidden,reply,fields,items,error,semantic,pass:!error&&drafts.length>0&&new RegExp(expected,'u').test(reply)&&!new RegExp(forbidden,'u').test(reply)&&semantic.every(check=>check.pass)});
  f.db.close();
 }
 const summary={records:results.length,uniqueDerivedInputs:new Set(results.map(r=>r.input)).size,pass:results.filter(r=>r.pass).length,fail:results.filter(r=>!r.pass).length,failedIds:results.filter(r=>!r.pass).map(r=>r.id),semanticFailures:results.flatMap(r=>r.semantic.filter(check=>!check.pass).map(check=>({id:r.id,rule:check.rule}))),sourceWarning:'63 original records plus 5 later supplements; not 68 unique customers; summaries are not verbatim evidence',limitations:['Each scenario derived from its own card, one runtime fixture per scenario','No real LINE delivery or historic image/PDF contents verified','Semantic checks include card values and evidence retention; a pass still does not prove full natural-conversation acceptance']};
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'legacy-68-cases.private.json'),JSON.stringify({summary,results},null,2));console.log(JSON.stringify(summary,null,2));process.exitCode=summary.fail?1:0;
}
