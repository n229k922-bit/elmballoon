import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { receiveManagerEvents, drainManagerInbox, handleManagerCommand, flushManagerOutbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

// Anonymous, history-derived scenarios. Persona means wording/decision style,
// never a predicted personality based on age, gender or other identity.
globalThis.fetch = async () => { throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };
const liveFile = new URL('../docs/simulations/live/persona-events.jsonl', import.meta.url);
fs.mkdirSync(path.dirname(fileURLToPath(liveFile)), {recursive:true});
const runId = new Date().toISOString();
function live(caseId,persona,role,text,pass) {
  fs.appendFileSync(liveFile,JSON.stringify({runId,caseId,persona,role,text,at:new Date().toISOString(),sourceKind:'synthetic_persona',...(pass===undefined?{}:{pass})})+'\n');
}
const scenario = (id, persona, store, turns) => ({ id, persona, store, turns });
const t = (text, checks) => ({ text, checks });
const scenarios = [
  scenario('P01','short decisive','小さいハートと文字入れをこの構成でお作りするご提案です。よろしいでしょうか？',[t('それでお願いします',['no_intake','owner']),t('はい、よろしくお願いします',['no_intake'])]),
  scenario('P02','long careful','こちらの構成と文字入れでいかがでしょうか？',[t('いろいろ考えましたが、ご提案いただいた内容が一番よいと思います。今回はその内容でお願いします。',['no_intake','owner']),t('今後の流れだけ教えてください',['no_intake'])]),
  scenario('P03','undecided color','マカロンピンクとライトピンクの候補があります。',[t('ライトピンクもいいですね！でもまだ悩みます',['no_intake','no_color']),t('赤もかわいいけど、もう少し考えたいです',['no_intake','no_color'])]),
  scenario('P04','urgent but polite','ご希望をお知らせください。',[t('今日の夕方受け取りで、ブーケ1個できますか？',['owner']),t('急ですみません。無理なら明日受け取りでも大丈夫です',['owner'])]),
  scenario('P05','angry disappointed','ご相談内容を確認しております。',[t('話が違う！赤じゃないって言ったのに。責任者に代わって',['owner','no_intake','no_color']),t('明日3000円で解決してよ',['owner','no_intake','no_dates','not_budget'])]),
  scenario('P06','typing errors','キティとシナモンの組合せでお作りするご提案です。',[t('はいそれでおねがいさます',['no_intake']),t('まちがえました。それでお願いします',['no_intake','owner'])]),
  scenario('P07','unfamiliar with terminology','文字のフォントとローマ字をお知らせください。',[t('フォントって何のことでしょうか。文字の形のことですか？',['no_intake']),t('むずかしいことは分からないので前と同じ文字の形がいいです',['no_intake','owner'])]),
  scenario('P08','casual abbreviated','こちらの構成でいかがでしょうか？',[t('それでおねがい！',['no_intake']),t('おけですー',['no_intake'])]),
  scenario('P09','proxy deciding with family','この代替商品でいかがでしょうか？',[t('母に確認して明日連絡します。それまで待ってください',['no_intake','no_dates']),t('まだ本人と話せていません。もう少し待っていただけますか',['no_intake','no_dates'])]),
  scenario('P10','conversation detour','こちらのブーケと文字入れでいかがでしょうか？',[t('ところで今日の天気ってどうですか',['no_dates','not_budget']),t('それでお願いします。さっきのブーケです',['no_intake','owner'])]),
  scenario('P11','bereaved parent','ご事情に合わせて慎重にご相談を承ります。',[t('亡くなった子どものお別れの場に、淡い色の風船を少し飾りたいです',['owner','sensitive']),t('写真や名前は送りたくありません。小さめにしてください',['owner','sensitive','no_intake'])]),
  scenario('P12','repeat purchaser','前回の注文内容を記録から照合します。',[t('去年と同じお店へ、いつものスタンドをお願いします',['owner']),t('住所も去年と同じでいいはずです。いまも同じかは分かりません',['owner','no_intake'])]),
  scenario('P13','price focused','参考画像についてのご相談を承ります。',[t('このスタンドはいくらからですか？',['owner','not_budget']),t('これはいくらでしょうか？',['owner','not_budget','no_intake'])]),
  scenario('P14','receipt discrepancy','ご請求は合計17200円です。',[t('12000円と4000円で領収書お願いします',['owner','not_budget','no_intake']),t('金額が違いましたか？確認してください',['owner','not_budget','no_intake'])]),
  scenario('P15','payment visit changes','お支払いは明日の20時30分頃のご来店でご相談しています。',[t('明日行けなくなりました。明後日20時半は大丈夫ですか',['owner','no_dates','no_intake']),t('支払いはPayPayでお願いします',['owner','no_dates','no_paid'])]),
  scenario('P16','delivery appreciation','先ほどお届け完了しました。',[t('届けていただきありがとうございました！助かりました',['quiet','no_paid','no_intake']),t('また機会があればお願いします',['quiet','no_paid','no_intake'])]),
  scenario('P17','conditional substitute','プリキュアは入荷日未定、シナモンはご相談可能です。',[t('ピンクのプリキュアはありますか？なければキティとシナモンでお願いします',['owner','no_color','no_intake']),t('在庫がなければ無理に手配しなくて大丈夫です',['owner','no_color','no_intake'])]),
  scenario('P18','visit delay','15日の14時からご来店相談はいかがでしょうか？',[t('娘と相談に伺います。ありがとうございます',['no_intake','no_dates']),t('30分遅れそうです。予定時間は大丈夫でしょうか',['owner','no_intake','no_dates'])]),
  scenario('P19','alternative pickup dates','15日は18時以降のお渡しも可能です。',[t('祝日の月曜日がよければその日に。難しければ15日18時10分でお願いできたら助かります',['owner','no_dates','no_intake']),t('同行者に確認して、また連絡しますね',['no_intake','no_dates'])]),
  scenario('P20','time-only updates','12日のお受け取りは大体のお時間が決まりましたらお知らせください。',[t('14時ごろになりました！ありがとうございます',['owner','no_intake']),t('予定が変わって13時ごろになりそうです。無理なら木曜日で大丈夫です',['owner','no_intake'])]),
  scenario('P21','three personalized items','背番号と印字名をそれぞれお知らせください。',[t('背番号1 RINO\n背番号4 YUUNA\n背番号5 RION',['owner','no_customer_name']),t('4番だけYUUNAではなくYUNAに変えてください',['owner','no_customer_name'])]),
  scenario('P22','withdrawal then followup','ご注文内容についてご相談中です。',[t('今回は見送ります。注文しません',['owner','no_intake','no_dates']),t('明日なら3000円でできたのでしょうか',['owner','no_intake','no_dates','not_budget'])]),
  scenario('P23','safety incident','商品について何かございましたらお知らせください。',[t('子供が破れた風船を飲み込んだかもしれません',['owner','no_intake','sensitive']),t('とりあえず新しいのを2つもらえますか',['owner','no_intake'])]),
  scenario('P24','separate concurrent orders','現在のブーケのご相談を承っております。',[t('別の注文でスタンドもお願いします',['new_order_created']),t('それは赤にしてください',['asks_scope','no_color'])]),
];
const output = process.argv[2];
const personaNames = ['短く即決する人','長文で慎重に確認する人','色を迷っている人','急ぎで丁寧に相談する人','強い不満を伝える人','入力の誤字が多い人','専門用語に不慣れな人','省略語を使う人','家族の代理で相談する人','相談中に話がそれる人','お別れの装飾を相談する人','以前と同じ注文を希望する人','まず価格を知りたい人','領収書の金額を確認する人','支払い来店日時を調整する人','配達のお礼を伝える人','欠品時の代替案を相談する人','来店相談に遅れそうな人','複数の受取候補を相談する人','受取時刻を変更する人','複数商品の名入れを訂正する人','注文を見送りたい人','安全上の問題を相談する人','別の注文も同時に相談する人'];
scenarios.forEach((s,i)=>{s.persona=personaNames[i];});
const results = [];
let tick = 0;
async function receive(f, text, customer='CUSTOMER') {
  const at = new Date(Date.parse('2026-10-19T01:00:00Z') + (++tick)*60000).toISOString();
  const id = `PERSONA-${tick}`;
  const before = f.db.prepare('SELECT COUNT(*) n FROM manager_drafts').get().n;
  await receiveManagerEvents([{type:'message',webhookEventId:id,timestamp:Date.parse(at),source:{userId:customer},message:{type:'text',id,text}}],f.env,at);
  await drainManagerInbox(f.env,new Date(Date.parse(at)+30000).toISOString());
  return {at,id,drafts:f.db.prepare('SELECT * FROM manager_drafts ORDER BY rowid').all().slice(before)};
}
for(const s of scenarios) {
  const f=createManagerFixture();f.env.MANAGER_RELEASE_STAGE='live';f.env.MANAGER_AUTO_INTAKE_ENABLED='true';
  const oid=`ORDER-${s.id}`,at='2026-10-19T00:00:00Z';
  f.db.prepare('INSERT INTO manager_orders(id,customer_id,created_at,updated_at) VALUES (?,?,?,?)').run(oid,'CUSTOMER',at,at);
  f.db.prepare("INSERT INTO manager_events(id,customer_id,order_id,direction,text,occurred_at,received_at,processed_at) VALUES (?,? ,?,'assistant',?,?,?,?)").run(`STORE-${s.id}`,'CUSTOMER',oid,s.store,at,at,at);
  const turns=[];
  live(s.id,s.persona,'coordinator',`開始：${s.store}`);
  for(const turn of s.turns) {
    live(s.id,s.persona,'customer',turn.text);
    const ownerBefore=f.db.prepare("SELECT COUNT(*) n FROM manager_outbox WHERE channel='owner'").get().n;
    const result=await receive(f,turn.text);const reply=result.drafts.map(d=>d.message).join('\n');
    live(s.id,s.persona,'clerk',reply);
    for(const notice of f.db.prepare("SELECT text FROM manager_outbox WHERE channel='owner' ORDER BY rowid").all().slice(ownerBefore))live(s.id,s.persona,'coordinator',notice.text);
    const fields=f.db.prepare('SELECT * FROM manager_fields').all();
    const reasons=result.drafts.flatMap(d=>JSON.parse(d.reasons_json||'[]'));
    const predicates={no_intake:()=>!/どのようなバルーン|いつ頃のお受け取り|いくつご希望/u.test(reply),owner:()=>reasons.length>0,quiet:()=>reasons.length===0,no_dates:()=>!fields.some(v=>['use_date','receive_date','receive_time'].includes(v.field_key)),no_color:()=>!fields.some(v=>v.field_key==='color_vibe'),asks_scope:()=>/どちら|どの注文|ご注文について/u.test(reply),not_budget:()=>!fields.some(v=>v.field_key==='budget'),no_paid:()=>f.db.prepare("SELECT COUNT(*) n FROM manager_orders WHERE payment_status='paid'").get().n===0,no_customer_name:()=>!fields.some(v=>v.field_key==='customer_name'),new_order_created:()=>f.db.prepare('SELECT COUNT(*) n FROM manager_orders').get().n===2,color_only_latest_order:()=>fields.some(v=>v.field_key==='color_vibe'&&v.order_id!==oid&&v.value_text==='赤')&&!fields.some(v=>v.field_key==='color_vibe'&&v.order_id===oid),sensitive:()=>!/😊|🎉|おめでとう|お祝い/u.test(reply)};
    const checks=[{name:'reply_present',pass:reply.trim().length>0},{name:'no_internal_codes',pass:!/M[A-F0-9]{12}|D[A-F0-9]{12}|review_collected_details/u.test(reply)},...turn.checks.map(name=>({name,pass:predicates[name]()}))];
    turns.push({input:turn.text,reply,checks,fields,reasons});
    live(s.id,s.persona,'verdict',checks.every(c=>c.pass)?'期待した応対・情報保持を確認':`要改善：${checks.filter(c=>!c.pass).map(c=>c.name).join('、')}`,checks.every(c=>c.pass));
  }
  const latestDraft=f.db.prepare('SELECT * FROM manager_drafts ORDER BY rowid DESC LIMIT 1').get();
  const managerChecks=[];
  if(latestDraft&&['pending','held'].includes(latestDraft.status)) {
    const managerAt=new Date(Date.parse('2026-10-19T01:00:00Z')+(tick+1)*60000).toISOString();
    const command=async text=>{live(s.id,s.persona,'manager',`店長の入力：${text}`);const answer=await handleManagerCommand(text,'OWNER',f.env,managerAt);live(s.id,s.persona,'manager',`操作結果：${answer||'応答なし'}`);return answer;};
    await command('返信待ち');await command('1');
    if(['P05','P11','P22','P23'].includes(s.id)){
      await command('3');live(s.id,s.persona,'manager','保留・要確認：内容を確認してから個別に対応します。');
      managerChecks.push({name:'manager_hold_marks_selected_draft',pass:f.db.prepare('SELECT status FROM manager_drafts WHERE id=?').get(latestDraft.id)?.status==='held'});
      managerChecks.push({name:'manager_hold_does_not_enqueue_customer_delivery',pass:f.db.prepare("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer' AND draft_id=?").get(latestDraft.id).n===0});
    }else if(['P02','P07','P21'].includes(s.id)){
      const correction=s.id==='P07'?'文字の形のことです。以前の文字の形を確認してご案内します。':s.id==='P21'?'4番の印字名をYUNAへ変更するご希望ですね。制作前に内容を確認いたします。':'この後は仕様と受取日時を確認し、対応可否をお伝えしてから正式な注文内容を決めていきます。';
      await command(`2 ${correction}`);await command('1');
      managerChecks.push({name:'manager_edit_replaces_actual_draft',pass:f.db.prepare('SELECT message FROM manager_drafts WHERE id=?').get(latestDraft.id)?.message===correction});
      managerChecks.push({name:'manager_edit_approved_once',pass:f.db.prepare("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer' AND draft_id=?").get(latestDraft.id).n===1});
    }else {
      await command('1');
      managerChecks.push({name:'manager_number_approves_selected_reply_once',pass:f.db.prepare("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer' AND draft_id=?").get(latestDraft.id).n===1});
    }
  }else{
    live(s.id,s.persona,'manager','定型の受付・お礼のため確認待ちはありません。自動応答の内容を確認しました。');
  }
  const mockRequests=[];
  await flushManagerOutbox(f.env,new Date(Date.parse('2026-10-19T01:00:00Z')+(tick+1)*60000).toISOString(),async(url,init)=>{mockRequests.push(JSON.parse(init.body));return new Response('{}',{status:200});});
  for(const request of mockRequests)live(s.id,s.persona,request.to==='OWNER'?'coordinator':'delivery',(request.messages||[]).map(m=>m.text||'[画像]').join('\n'));
  const outbox=f.db.prepare("SELECT channel,status,text FROM manager_outbox WHERE channel='customer'").all();
  const allChecks=[...turns.flatMap(t=>t.checks),...managerChecks];
  results.push({id:s.id,persona:s.persona,history:s.store,turns,outbox,checks:allChecks,managerChecks,failures:allChecks.filter(c=>!c.pass).length});f.db.close();
}
// One owner, twelve simultaneous customers: bare number cannot mass-approve;
// chosen draft is revised, then duplicate approval must not create duplicates.
{
  const f=createManagerFixture();f.env.MANAGER_RELEASE_STAGE='live';f.env.MANAGER_AUTO_INTAKE_ENABLED='false';
  for(let i=0;i<12;i++){
    const text=`10月25日にブーケ${i+1}個、合計${3000+i*100}円で店頭受取を希望します`;
    live('P25','店長1人で12人の注文を確認','customer',`お客様${i+1}：${text}`);
    const result=await receive(f,text,`LOAD-CUSTOMER-${i}`);
    live('P25','店長1人で12人の注文を確認','clerk',result.drafts.map(d=>d.message).join('\n'));
  }
  const at=new Date(Date.parse('2026-10-19T01:00:00Z')+(tick+2)*60000).toISOString();
  const checks=[];const check=(name,pass)=>checks.push({name,pass});
  live('P25','店長1人で12人の注文を確認','manager','12件の重複受信から1件を選択・修正・重複承認して誤送信を確認します');
  const managerCommand=async text=>{live('P25','店長1人で12人の注文を確認','manager',`店長の入力：${text}`);const answer=await handleManagerCommand(text,'OWNER',f.env,at);live('P25','店長1人で12人の注文を確認','manager',`操作結果：${answer||'応答なし'}`);return answer;};
  await managerCommand('1');
  check('first_number_does_not_mass_send',f.db.prepare("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").get().n===0);
  await managerCommand('1');
  check('selection_does_not_send',f.db.prepare("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").get().n===0);
  const revision=await managerCommand('2 内容を確認して改めてご連絡します。');
  check('revision_is_reviewable_before_send',/まだ送信|送信せず|確認|番号/u.test(revision||'')&&f.db.prepare("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").get().n===0);
  await managerCommand('1');await managerCommand('1');
  check('exactly_one_customer_queue_after_duplicate_approval',f.db.prepare("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer'").get().n===1);
  const requests=[];await flushManagerOutbox(f.env,at,async(url,init)=>{requests.push(JSON.parse(init.body));return new Response('{}',{status:200});});
  for(const request of requests)live('P25','店長1人で12人の注文を確認',request.to==='OWNER'?'coordinator':'delivery',(request.messages||[]).map(m=>m.text||'[画像]').join('\n'));
  check('mock_delivers_to_one_selected_customer',requests.filter(r=>String(r.to).startsWith('LOAD-CUSTOMER-')).length===1);
  check('twelve_orders_remain_separate',f.db.prepare('SELECT COUNT(DISTINCT customer_id) n FROM manager_orders').get().n===12);
  live('P25','店長1人で12人の注文を確認','verdict',checks.every(c=>c.pass)?'12件を分離し選択した1件だけをモック送信':`要改善：${checks.filter(c=>!c.pass).map(c=>c.name).join('、')}`,checks.every(c=>c.pass));
  results.push({id:'P25',persona:'店長1人で12人の注文を確認',checks,failures:checks.filter(c=>!c.pass).length});f.db.close();
}
const summary={scenarioCount:results.length,customerTurns:scenarios.reduce((n,s)=>n+s.turns.length,0)+12,checks:results.reduce((n,r)=>n+(r.checks||r.turns.flatMap(t=>t.checks)).length,0),failures:results.reduce((n,r)=>n+r.failures,0),network:'forbidden except injected mock sender',results};
if(output){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(summary,null,2));}
console.log(JSON.stringify({scenarioCount:summary.scenarioCount,customerTurns:summary.customerTurns,checks:summary.checks,failures:summary.failures,failed:results.filter(r=>r.failures).map(r=>({id:r.id,persona:r.persona,checks:r.checks?.filter(c=>!c.pass),turns:r.turns?.filter(t=>t.checks.some(c=>!c.pass)).map(t=>({input:t.input,reply:t.reply,failed:t.checks.filter(c=>!c.pass)}))}))},null,2));
process.exitCode=summary.failures?1:0;
