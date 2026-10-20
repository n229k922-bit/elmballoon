import fs from 'node:fs';
import path from 'node:path';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { receiveManagerEvents, drainManagerInbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

// Private local inputs/outputs only. Historical store messages are evidence,
// never owner approvals, customer budgets, confirmed dates or send permission.
const [input, output, mode='on', anchor='2026-10-19'] = process.argv.slice(2);
if(!input||!output)throw Error('Usage: node tools/test-real-history-contextual.mjs PRIVATE_INPUT PRIVATE_OUTPUT [on|off] [capture-date]');
globalThis.fetch=async()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):e.name.endsWith('.json')?[path.join(dir,e.name)]:[]);
const threads=new Map();
for(const file of walk(input)){
  const key=file.match(/AUDIT-\d+/)?.[0];if(!key)continue;
  const d=JSON.parse(fs.readFileSync(file,'utf8'));const pages=d.pages||(d.groups?[d]:[]);if(!pages.length)continue;
  if(!threads.has(key))threads.set(key,{id:key,messages:new Map(),files:[],complete:false});
  const t=threads.get(key);t.files.push(file);t.complete ||=d.complete===true;
  for(const p of pages)for(const g of p.groups||[])for(const m of g.messages||[]){
    const identity=m.id||JSON.stringify([g.date,m.side,m.renderedText]);
    if(!t.messages.has(identity))t.messages.set(identity,{identity,ordinal:t.messages.size,variants:[]});
    const entry=t.messages.get(identity),v={...m,date:g.date,sourceFile:file};
    if(!entry.variants.some(x=>JSON.stringify([x.date,x.side,x.text,x.renderedText])===JSON.stringify([v.date,v.side,v.text,v.renderedText])))entry.variants.push(v);
  }
}
function clean(m){return String(m.renderedText||m.text||'').split('\n').filter(l=>!/^\s*(?:あっこ|応答メッセージ|既読|ダウンロード|\d{1,2}:\d{2})\s*$/u.test(l)).join('\n').trim();}
function time(m){
  const clocks=[...String(m.renderedText||'').matchAll(/(?:^|\n)\s*(\d{1,2}):(\d{2})\s*(?=\n|$)/gu)];
  const clock=clocks.at(-1),date=String(m.date||'');let day,provenance;
  const explicit=date.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/u),md=date.match(/(\d{1,2})\/(\d{1,2})/u);
  if(explicit){day=`${explicit[1]}-${explicit[2].padStart(2,'0')}-${explicit[3].padStart(2,'0')}`;provenance='source_explicit_year';}
  else if(md){
    const year=Number(anchor.slice(0,4)),weekday=date.match(/([日月火水木金土])曜/u)?.[1];
    const candidates=[year-1,year].map(y=>`${y}-${md[1].padStart(2,'0')}-${md[2].padStart(2,'0')}`).filter(s=>s<=anchor&&(!weekday||'日月火水木金土'[new Date(`${s}T00:00:00Z`).getUTCDay()]===weekday));
    day=candidates.sort().at(-1)||`${year}-${md[1].padStart(2,'0')}-${md[2].padStart(2,'0')}`;provenance=weekday?'year_inferred_from_capture_and_weekday':'year_inferred_from_capture';
  }else {const offset=/昨日/u.test(date)?1:0;day=new Date(Date.parse(anchor)-offset*86400000).toISOString().slice(0,10);provenance=/今日|昨日/u.test(date)?'relative_group_inferred_from_capture':'missing_date_capture_fallback';}
  return {at:new Date(`${day}T${clock?clock[1].padStart(2,'0'):'12'}:${clock?clock[2]:'00'}:00+09:00`).toISOString(),provenance,sourceDateLabel:date,clock:clock?`${clock[1]}:${clock[2]}`:null,clockProvenance:clock?'source_rendered_clock':'missing_clock_noon_fallback',explicitYear:Boolean(explicit)};
}
fs.mkdirSync(output,{recursive:true});const summaries=[];
for(const t of threads.values()){
  const f=createManagerFixture();f.env.MANAGER_RELEASE_STAGE='live';f.env.MANAGER_AUTO_INTAKE_ENABLED=mode==='on'?'true':'false';f.env.AI_DISCLOSURE_ENABLED='false';
  const messages=[...t.messages.values()].map(e=>{
    // Select the most complete variant for replay while retaining every variant
    // and marking semantic differences as unresolved, never as a semantic pass.
    const variants=e.variants;const m=[...variants].sort((a,b)=>clean(b).length-clean(a).length)[0];
    const semanticVariants=[...new Set(variants.map(v=>JSON.stringify([v.side,v.date,clean(v)])))];
    return {...e,source:m,timestamp:time(m),text:clean(m),semanticConflict:semanticVariants.length>1,selectionRule:'longest captured cleaned text for replay only; all variants retained; conflict requires review'};
  }).sort((a,b)=>a.timestamp.at.localeCompare(b.timestamp.at)||(/^\d+$/.test(a.identity)&&/^\d+$/.test(b.identity)?BigInt(a.identity)<BigInt(b.identity)?-1:1:a.ordinal-b.ordinal));
  const all=sql=>f.db.prepare(sql).all();const turns=[];let previousStore=null;
  // This is a fixture-only inferred conversation shell, not an imported order
  // or production behavior. It permits initial historic store replies to supply
  // context without attaching real unlinked production messages to a customer.
  const bootstrapId=`M${t.id.replace(/\D/gu,'').padStart(16,'0')}`;
  const bootstrapAt=messages[0]?.timestamp.at||`${anchor}T00:00:00.000Z`;
  f.db.prepare('INSERT INTO manager_orders(id,customer_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(bootstrapId,'CUSTOMER','履歴再生用の仮相談',bootstrapAt,bootstrapAt);
  let contextOrderId=bootstrapId;
  for(const [i,m] of messages.entries()){
    const at=m.timestamp.at,source=m.source,isImage=Boolean(source.imageLinks?.length),isText=Boolean(source.text?.trim());
    const kind=isImage?'image':isText?'text':'sticker_or_unparsed';
    let error=null;const before=all('SELECT * FROM manager_drafts').length;
    if(source.side==='store'){
      const orderId=contextOrderId;
      f.db.prepare("INSERT INTO manager_events(id,customer_id,order_id,direction,text,media_message_id,occurred_at,received_at,processed_at) VALUES (?,?,?,'assistant',?,?,?,?,?)").run(`HIST-${t.id}-${i}`,'CUSTOMER',orderId,isText?m.text:'[過去店舗画像・スタンプ：内容未確認]',isImage?`HISTMEDIA-${i}`:null,at,at,at);
      previousStore={sourceMessageId:m.identity,text:isText?m.text:null,kind,at,timestampProvenance:m.timestamp,linkedOrderId:orderId,orderAssociationProvenance:orderId===bootstrapId?'fixture_only_bootstrap_conversation_shell':orderId?'fixture_only_latest_routed_customer_context':'unresolved_routing_no_association'};
    }else if(isText||isImage){
      const id=`REPLAY-${t.id}-${i}`;
      try{await receiveManagerEvents([{type:'message',webhookEventId:id,timestamp:Date.parse(at),source:{userId:'CUSTOMER'},message:{id,type:isImage?'image':'text',...(isImage?{}:{text:m.text})}}],f.env,at);await drainManagerInbox(f.env,new Date(Date.parse(at)+30000).toISOString());contextOrderId=f.db.prepare('SELECT order_id FROM manager_events WHERE id=?').get(id)?.order_id||null;}catch(e){error=String(e.stack||e);}
    }
    const drafts=all('SELECT * FROM manager_drafts ORDER BY rowid').slice(before).map(d=>({...d,reasons:JSON.parse(d.reasons_json||'[]')}));
    turns.push({index:i+1,sourceMessageId:m.identity,side:source.side,kind,text:m.text,timestamp:m.timestamp,sourceVariants:m.variants,semanticConflict:m.semanticConflict,selectionRule:m.selectionRule,previousStoreResponse:source.side==='customer'?previousStore:null,replayed:isText||isImage||source.side==='store',error,drafts,fields:all('SELECT * FROM manager_fields'),items:all('SELECT * FROM manager_order_items'),tasks:all('SELECT * FROM manager_tasks'),outbox:all('SELECT * FROM manager_outbox'),changes:all('SELECT * FROM manager_changes'),orders:all('SELECT * FROM manager_orders'),evidence:all('SELECT id,order_id,direction,text,media_message_id,occurred_at FROM manager_events ORDER BY occurred_at,rowid'),semanticVerdict:'requires_human_agent_turn_review'});
  }
  const summary={id:t.id,uniqueMessages:messages.length,customerTextTurns:turns.filter(x=>x.side==='customer'&&x.kind==='text').length,customerImages:turns.filter(x=>x.side==='customer'&&x.kind==='image').length,customerStickersOrUnparsed:turns.filter(x=>x.side==='customer'&&x.kind==='sticker_or_unparsed').length,storeTextTurns:turns.filter(x=>x.side==='store'&&x.kind==='text').length,storeImages:turns.filter(x=>x.side==='store'&&x.kind==='image').length,storeStickersOrUnparsed:turns.filter(x=>x.side==='store'&&x.kind==='sticker_or_unparsed').length,semanticVariantConflicts:turns.filter(x=>x.semanticConflict).length,errors:turns.filter(x=>x.error).length,sourceComplete:t.complete};
  fs.writeFileSync(path.join(output,`${t.id}.contextual.private.json`),JSON.stringify({summary,bootstrap:{orderId:bootstrapId,provenance:'fixture_only_inferred_conversation_shell_not_real_confirmed_order',productionSideEffects:false},sourceFiles:t.files,turns},null,2));summaries.push(summary);f.db.close();
}
const summary={mode:'offline_historic_store_evidence_and_customer_runtime_replay',autoIntake:mode,network:'forbidden',anchor,threads:summaries,limits:['Year is inferred where the captured screen omits year; provenance is recorded per turn.','Same-minute ordering uses numeric message ids or capture order, not guaranteed second-level chronology.','Variants remain review-required; selecting longer text is not acceptance.','Historical store events are evidence only; no owner approvals or confirmed prices are imported.','No actual LINE delivery, deployed environment or full-resolution image understanding is tested.','Unknown image/sticker types remain unparsed; all source variants are retained.','Actual store responses replace counterfactual AI messages as historic context; this is an offline contextual regression, not a reproduction of historic engine state.','A fixture-only initial conversation shell links leading store evidence; later store evidence follows latest resolved customer context. This inferred association is not proof of historic order boundaries or production permission to attach unlinked messages.']};
fs.writeFileSync(path.join(output,'contextual-summary.private.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
