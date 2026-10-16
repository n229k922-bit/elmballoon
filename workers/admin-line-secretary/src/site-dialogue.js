const TTL = 600;
const menu = '【店休日・営業時間】\nホームページの営業案内を整えましょう😊\n\n1：お休みにする\n2：通常営業に戻す\n3：営業時間を変える\n\n番号で教えてください。お客様の受取日時は変更しません。';
const imageMenu = 'ホームページの写真を変更したいのですね😊\nどの写真ですか？\n\n1：トップページ\n2：商品の写真\n3：その他のページ\n\n番号で教えてください。まだ公開は変更しません。';
const number = value => String(value).trim().replace(/[１２３]/gu, c => String('１２３'.indexOf(c) + 1)).replace(/[①②③]/gu,c=>String('①②③'.indexOf(c)+1));
export function readableSiteDate(date) {
  return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'long',day:'numeric',weekday:'short'}).format(new Date(date+'T00:00:00+09:00'));
}
export function siteDate(text, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const parts = today.split('-').map(Number);
  if (/^(今日|明日|明後日)$/u.test(text)) return new Date(Date.UTC(parts[0],parts[1]-1,parts[2]+['今日','明日','明後日'].indexOf(text))).toISOString().slice(0,10);
  const m = text.match(/^(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})日?$/u);
  if (!m) return null;
  const year = Number(m[1] || parts[0]), month = Number(m[2]), day = Number(m[3]);
  const d = new Date(Date.UTC(year,month-1,day));
  if (d.getUTCFullYear()!==year || d.getUTCMonth()!==month-1 || d.getUTCDate()!==day) return null;
  const result = d.toISOString().slice(0,10);
  // Never silently interpret a yearless past date as next year.
  if (!m[1] && result < today) return null;
  return result;
}
export function siteHours(text) {
  const m = text.match(/^(\d{1,2})(?::(\d{2})|時(?:(\d{1,2})分)?)?\s*(?:から|[〜～~－-])\s*(\d{1,2})(?::(\d{2})|時(?:(\d{1,2})分)?)?$/u);
  if (!m) return null;
  const startH=Number(m[1]), startM=Number(m[2]||m[3]||0), endH=Number(m[4]), endM=Number(m[5]||m[6]||0);
  if (startH>23 || endH>23 || startM>59 || endM>59 || endH*60+endM<=startH*60+startM) return null;
  const fmt=(h,m)=>`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  return {openTime:fmt(startH,startM),closeTime:fmt(endH,endM)};
}
export async function siteDialogue(event, env, apply, proof, now = Date.now()) {
  if (!env.SECRETARY_KV) return null;
  const actor=event.source.userId, key='site-dialogue:'+actor;
  const text=event.message?.text?.trim() || '', value=number(text);
  const store=async state=>env.SECRETARY_KV.put(key,JSON.stringify({...state,expiresAt:now+TTL*1000}),{expirationTtl:TTL});
  const clearOrderSelection=async()=>{if(env.ORDER_ENGINE==='v2' && env.DB)await env.DB.prepare('DELETE FROM manager_reply_selection WHERE actor=?').bind(actor).run();};
  let state=await env.SECRETARY_KV.get(key,'json');
  if (state && state.expiresAt<=now) {await env.SECRETARY_KV.delete(key);state=null;if (/^[123]$/u.test(value)) return '先ほどのホームページ相談は時間が空いたため終了しました。変更したい内容をもう一度教えてください😊';}
  if (/^(?:日付変更依頼|店休日変更依頼|店休日|営業時間変更|営業日変更)$/u.test(text)) {await clearOrderSelection();await env.SECRETARY_KV.delete('pending:'+actor);await store({step:'kind'});return menu;}
  if (/^(?:画像変更|写真変更|画像差し替え|写真差し替え|ホームページの(?:画像|写真)(?:変更|を変更|差し替え|を差し替え))$/u.test(text)) {await clearOrderSelection();await store({step:'image-target'});return imageMenu;}
  if (!state) return null;
  if (/^(?:休業|休み|営業時間|休業解除)\s*\d{4}-/u.test(text) || /^(?:今日|明日|明後日|今週|来週|再来週|次|今度).*(?:休業|休み)(?:にして)?$/u.test(text)) {await env.SECRETARY_KV.delete(key);return null;}
  if (/^(?:取消|キャンセル|やめる)$/u.test(text)) {await store({step:'done'});return '変更せずに終了しました😊';}
  // Explicit navigation leaves this dialogue; its numbers cannot approve an old site request.
  if (/^(?:案件一覧|確認待ち一覧|受注判断|統括状況|返信待ち|カルテ|過去注文|統括アプリ|アプリ|注文管理|システム変更依頼)(?:\s|$)/u.test(text)) {await env.SECRETARY_KV.delete(key);return null;}
  if(state.step==='done') {
    if(/^[123]$/u.test(value))return '先ほどのホームページ相談は終了しています😊\n注文の確認に戻るときは「確認待ち一覧」と送ってください。';
    await env.SECRETARY_KV.delete(key);return null;
  }
  if (state.step==='kind') {
    if (!/^[123]$/u.test(value)) return menu;
    await store({step:'date',kind:value});return 'いつの営業案内を変更しますか？\n「明日」「10月10日」のように教えてください😊';
  }
  if (state.step==='date') {
    const date=siteDate(text,new Date(now));if(!date)return '日付をもう一度教えてください😊\n例：明日／10月10日。過去の日付の場合は年も付けてください。';
    state={...state,date};
    if(state.kind==='3'){await store({...state,step:'hours'});return `${readableSiteDate(date)}は何時から何時まで営業しますか？\n例：13時から16時`;}
    state.change={date,status:state.kind==='1'?'closed':'open',openTime:null,closeTime:null,summary:`${readableSiteDate(date)}を${state.kind==='1'?'お休み':'通常営業'}に変更`};
  } else if(state.step==='hours') {
    const hours=siteHours(text);if(!hours)return '営業時間をもう一度教えてください😊\n例：13時から16時。閉店時刻は開店時刻より後にしてください。';
    state.change={date:state.date,status:'special_hours',...hours,summary:`${readableSiteDate(state.date)}を${hours.openTime}〜${hours.closeTime}の営業に変更`};
  } else if(state.step==='confirm') {
    if(value==='2'){await store({step:'kind'});return menu;}
    if(value==='3'){await store({step:'done'});return '営業案内は変更せずに終了しました😊';}
    if(value!=='1' && !/^(?:確定|承認|はい)$/u.test(text))return confirmation(state.change);
    // Consume before mutation so the same number cannot execute twice.
    await store({step:'done'});
    try {await apply(state.change,actor,env);} catch {return '変更結果を確認できませんでした。自動で再実行せず、現在の営業案内を確認してください。';}
    return proof(state.change,env);
  } else if(state.step==='image-target') {
    if(!/^[123]$/u.test(value))return imageMenu;
    await store({step:'image-page',target:{1:'トップページ',2:'商品の写真',3:'その他のページ'}[value]});return '変更したい場所が分かるページのURLや商品名、スクリーンショットを送ってください😊';
  } else if(state.step==='image-page') {
    if(!text && event.message?.type!=='image')return '対象のページや商品名を教えてください😊';
    await store({...state,step:'image-file',page:text.slice(0,1000),targetMessageId:event.message?.type==='image'?event.message.id:null});return 'ありがとうございます😊\n次に、差し替えたい新しい写真を送ってください。';
  } else if(state.step==='image-file') {
    if(event.message?.type!=='image' || !event.message.id)return '差し替えたい新しい写真を、画像として送ってください😊';
    await store({...state,step:'image-confirm',imageMessageId:event.message.id});return `【写真変更の相談】\n場所：${state.target}\n${state.page?`対象：${state.page}\n`:''}新しい写真：受け取りました\n\nまず変更依頼として残します。まだホームページは変わりません。\n\n1：この内容で依頼を残す\n2：選び直す\n3：やめる`;
  } else if(state.step==='image-confirm') {
    if(value==='2'){await store({step:'image-target'});return imageMenu;}
    if(value==='3'){await store({step:'done'});return '写真の変更依頼は残さずに終了しました😊';}
    if(value!=='1')return '写真の変更依頼を残しますか？\n1：依頼を残す\n2：選び直す\n3：やめる';
    await env.SECRETARY_KV.put('site-image-request:'+crypto.randomUUID(),JSON.stringify({...state,actor,status:'needs_site_review',createdAt:new Date(now).toISOString()}),{expirationTtl:2592000});
    await store({step:'done'});return '写真の変更依頼を残しました😊\nホームページはまだ変更していません。画像の取得・変更案・公開の確認が必要です。依頼の画像参照は30日間保管します。';
  }
  await store({...state,step:'confirm'});return confirmation(state.change);
}
function confirmation(change){return `【営業案内の変更】\n${change.summary}\n\nホームページの営業案内を変更します。お客様の受取日時はそのままです。\n\n1：この内容で変更する\n2：選び直す\n3：やめる`;}
