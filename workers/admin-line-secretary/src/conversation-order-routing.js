// Conservative conversational boundaries. This suggests routing only; it never
// edits a card or treats historic shop text as a confirmed fulfillment status.
const normalize=value=>String(value||'').normalize('NFKC');
const fieldValue=value=>String(value?.value_text??value?.value??value??'');
const PRODUCT=/(?:バルーン|ブーケ|スタンド|アレンジ|おむつケーキ)/u;
const REQUEST=/(?:注文(?:したい|を|です|お願い)|お願い(?:したい|します|したく)|届けて(?:ほし|欲し|ください|下さい)|配達(?:で|って|は|を|に|可能)|(?:いくら|料金|値段|価格).*(?:か|教え)|(?:可能|大丈夫|できます|出来ます)(?:です)?か)/u;
const DATE=/(?:\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2}|(?<!\d)\d{1,2}日|明日|明後日|来週)/u;
function businessPart(text){
  // Dates and recipient names in lettering are product content, not a new job.
  return normalize(text).split(/(?:メッセージ(?:は|[：:→])|文字入れ(?:は|[：:→])|カード(?:の文面|は|[：:→]))/u)[0];
}
function request(text){const value=businessPart(text);return PRODUCT.test(value)&&REQUEST.test(value);}
function fieldSet(fieldsByOrder,id){
  const raw=fieldsByOrder instanceof Map?fieldsByOrder.get(id):fieldsByOrder?.[id];
  return Array.isArray(raw)?Object.fromEntries(raw.map(f=>[f.field_key,f])):raw||{};
}
function monthDay(text){
  const value=normalize(text),full=value.match(/(?:\d{4}[-/])?(\d{1,2})[-/](\d{1,2})(?!\d)|(?:(\d{1,2})月)?(\d{1,2})日/u);
  if(!full)return null;return {month:full[1]||full[3]||null,day:full[2]||full[4]};
}
export function inferOrderBoundary(text,activeOrders=[],previousEvents=[],fieldsByOrder={}){
  const body=businessPart(text).trim();
  if(!activeOrders.length)return {kind:'new',reason:'no_active_order'};
  const explicitNew=/^(?:別件(?:で|の|です|[\s：:。、,]|$)|(?:別の(?:ご)?注文|新しい(?:ご)?注文|新規注文|もう(?:一つ|ひとつ|1つ)(?:の注文|注文)?)(?=[\s：:。、,]|$|お願い|を|は|で))/u.test(body);
  if(explicitNew)return {kind:'new',reason:'explicit_new_order'};
  const newRequest=request(body);
  const linked=[...previousEvents].reverse().find(e=>e.order_id&&activeOrders.some(o=>o.id===e.order_id));
  const latestOrder=activeOrders.length===1?activeOrders[0]:activeOrders.find(o=>o.id===linked?.order_id)||null;
  const continued=(reason)=>({kind:'continue',reason,...(latestOrder?{orderId:latestOrder.id}:{})});
  // Operational messages can mention old products and multiple dates. They
  // remain follow-ups unless there is a separate, explicit new product request.
  const operational=/(?:支払|入金|振込|PayPay|領収書|請求書|電話|連絡先|お届け(?:ありがとう|有難)|配達(?:ありがとう|有難)|(?:配達|受取|受け取り|お届け).{0,6}(?:時間|時刻)|(?:日時|日程).{0,8}(?:変更|調整)|時間.{0,6}(?:配達|受取)|(?:今日|明日|明後日)?[、,\s]*(?:配達|配送|お届け)(?:時間)?[はで]?\s*\d{1,2}時)/u.test(body);
  const modification=/(?:変更|キャンセル|取消|取り消|訂正|ではなく|じゃなく)/u.test(body);
  if(modification&&/(?:別の(?:ご)?注文|追加(?:で|の注文)|新規注文)/u.test(body))return {kind:'ambiguous',reason:'mixed_existing_change_and_new_order',candidateOrderIds:activeOrders.map(o=>o.id)};
  if(modification&&activeOrders.length===1)return continued('existing_order_change');
  const additional=newRequest&&/(?:^|[\n。！!、\s])(?:後|あと|それと|追加で|もう一件|もう1件|別の日|別のお店|別の方)/u.test(body);
  if(additional&&(DATE.test(body)||/別のお店|別の方|もう一件|もう1件/u.test(body)))return {kind:'new',reason:'explicit_additional_product_request'};
  if(additional)return {kind:'ambiguous',reason:'additional_item_or_separate_order',candidateOrderIds:activeOrders.map(o=>o.id)};
  // Appointment dates are not order-date selectors. Only an actual product or
  // delivery-date statement may disambiguate among separately dated jobs.
  const dateCanSelect=!/(?:支払|入金|振込|PayPay|領収書|請求書|電話|連絡先)/u.test(body)&&!/(?:文字|メッセージ|カード)/u.test(body)&&DATE.test(body);
  // A replacement date cannot identify the order being changed. Only the
  // old date ("24日から30日へ") or an explicit order reference ("24日の注文")
  // supplies scope when more than one consultation is open.
  const dateReplacement=modification&&new RegExp(`${DATE.source}の[^、。\n]{0,18}(?:に|へ)変更`,'u').test(body);
  const dateAnchor=modification ? !dateReplacement&&body.match(new RegExp(`(${DATE.source})(?=から|の(?:ご?注文|件|ブーケ|スタンド|アレンジ|バルーン))`,'u'))?.[1] : body;
  const suppliedDate=dateCanSelect&&dateAnchor?monthDay(dateAnchor):null;
  if(activeOrders.length>1&&suppliedDate){
    const matches=activeOrders.filter(order=>{
      const fields=fieldSet(fieldsByOrder,order.id);
      return ['receive_date','use_date'].some(key=>{
        const old=monthDay(fieldValue(fields[key]));return old&&Number(old.day)===Number(suppliedDate.day)
          &&(!old.month||!suppliedDate.month||Number(old.month)===Number(suppliedDate.month));
      });
    });
    if(matches.length===1)return {kind:'continue',reason:'unique_existing_order_date',orderId:matches[0].id};
    if(matches.length>1)return {kind:'ambiguous',reason:'date_matches_multiple_orders',candidateOrderIds:matches.map(o=>o.id)};
  }
  if(modification&&activeOrders.length>1){
    const previous=[...previousEvents].reverse().find(event=>event.text?.trim());
    const fieldPrompts=[
      [/(?:数量|個数|[\d一二ひふとたつ]+(?:個|つ|台|束|本))/u,/(?:数量|個数|いくつ|何個|何台|何束|何本)/u],
      [/(?:色|赤|青|白|黒|ピンク|緑|黄色|紫)/u,/(?:お色|色味|ご希望の色|配色)/u],
      [/(?:予算|金額|円)/u,/(?:ご予算|予算|金額)/u],
      [/(?:受取|受け取り|配達|日時|日程|時間)/u,/(?:いつ|何時|受取日|配達日|希望日|希望時間)/u],
    ];
    const hasScopedQuestion=previous?.direction==='assistant'&&latestOrder?.id===previous.order_id
      &&/[？?]|教えて|ご希望|でしょうか|変更しますか/u.test(previous.text)
      &&fieldPrompts.some(([answer,prompt])=>answer.test(body)&&prompt.test(previous.text));
    if(hasScopedQuestion)return continued('change_answers_scoped_store_question');
    return {kind:'ambiguous',reason:'change_needs_order_scope',candidateOrderIds:activeOrders.map(o=>o.id)};
  }
  if(!newRequest){
    // A recent customer message only says which order it belongs to when a
    // store-side prompt established that scope. Otherwise, a short follow-up
    // such as a color or budget can belong to any of the open orders.
    const lastConversationEvent=[...previousEvents].reverse().find(e=>e.text?.trim());
    // A time-only delivery change is especially easy to attach to the wrong
    // job. A specific written order date above can select one; relative dates
    // or no date need the manager to ask which open order is meant.
    if(activeOrders.length>1&&operational&&!suppliedDate)
      return {kind:'ambiguous',reason:'operational_followup_needs_order_scope',candidateOrderIds:activeOrders.map(o=>o.id)};
    const scopedQuestion=lastConversationEvent?.direction==='assistant'&&/[?？]|教えて|ご希望|でしょうか|ますか/u.test(lastConversationEvent.text);
    if(activeOrders.length>1&&(!latestOrder||!scopedQuestion))
      return {kind:'ambiguous',reason:'no_resolved_conversational_scope',candidateOrderIds:activeOrders.map(o=>o.id)};
    return continued(operational?'operational_followup':linked?.direction==='assistant'?'latest_store_order_continuation':'latest_resolved_order_continuation');
  }
  if(operational)return {kind:'ambiguous',reason:'mixed_new_request_and_operations',candidateOrderIds:activeOrders.map(o=>o.id)};
  // Use only matching-order (or as-yet unlinked) evidence. A delivery mentioned
  // before a more recent new request is not proof that the current job ended.
  const context=previousEvents.filter(e=>!latestOrder||!e.order_id||e.order_id===latestOrder.id);
  let lastDelivery=-1,lastRequest=-1;
  context.forEach((e,i)=>{
    if(e.direction==='assistant'&&/(?:お届け|配達|配送|お渡し)(?:が|は|を)?(?:完了|済み|しました|いたしました|させて頂きました|させていただきました)/u.test(normalize(e.text)))lastDelivery=i;
    if(e.direction==='customer'&&request(e.text))lastRequest=i;
  });
  const completed=latestOrder&&(['fulfilled','collected'].includes(latestOrder.fulfillment_status)||latestOrder.status==='closed'||lastDelivery>lastRequest);
  if(completed)return {kind:'new',reason:'new_product_request_after_delivery'};
  // A new dated request against a different dated job may be an additional
  // order or a change. Ask which; date difference alone never creates a card.
  if(latestOrder&&DATE.test(body)){
    const fields=fieldSet(fieldsByOrder,latestOrder.id),oldDate=fieldValue(fields.receive_date)||fieldValue(fields.use_date),old=monthDay(oldDate),current=monthDay(body);
    if(old&&current&&(Number(old.day)!==Number(current.day)||(old.month&&current.month&&Number(old.month)!==Number(current.month))))return {kind:'ambiguous',reason:'dated_product_request_needs_order_scope',candidateOrderIds:[latestOrder.id]};
  }
  if(activeOrders.length>1){
    const previous=[...previousEvents].reverse().find(event=>event.text?.trim());
    if(latestOrder&&!suppliedDate&&previous?.direction==='assistant'&&/[?？]|教えて|ご希望|でしょうか|ますか/u.test(previous.text))return {kind:'continue',reason:'answers_scoped_store_product_question',orderId:latestOrder.id};
    return {kind:'ambiguous',reason:'multiple_active_orders',candidateOrderIds:activeOrders.map(o=>o.id)};
  }
  return {kind:'continue',reason:'current_order_continuation',...(latestOrder?{orderId:latestOrder.id}:{})};
}
