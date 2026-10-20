import fs from 'node:fs';
import path from 'node:path';
import { createManagerFixture } from './helpers/manager-fixture.mjs';
import { receiveManagerEvents, drainManagerInbox } from '../workers/admin-line-secretary/src/manager-runtime.js';

// Explicit private input/output paths only. No remote services, source changes, or sends.
const [input, output, autoMode = 'off'] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node tools/test-real-history-offline.mjs PRIVATE_INPUT PRIVATE_OUTPUT');
globalThis.fetch = async () => { throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir,e.name)) : e.name.endsWith('.json') ? [path.join(dir,e.name)] : []); }
const threads = new Map();
for (const file of files(input)) {
  const data = JSON.parse(fs.readFileSync(file,'utf8'));
  const match = file.match(/AUDIT-\d+/);
  if (!match) continue;
  const key = match[0];
  if (!threads.has(key)) threads.set(key,{ id:key, messages:new Map(), sources:[], conflicts:[], complete:false });
  const thread=threads.get(key); thread.sources.push(file); thread.complete ||= data.complete === true;
  for (const page of data.pages || [data]) for (const group of page.groups || []) for (const m of group.messages || []) {
    const identity=m.id || JSON.stringify([group.date,m.side,m.renderedText]);
    const previous=thread.messages.get(identity);
    if(previous && (previous.renderedText!==m.renderedText || previous.text!==m.text)) thread.conflicts.push({identity,previous,current:m});
    if (!previous || (m.renderedText||'').length>(previous.renderedText||'').length) thread.messages.set(identity,{...m,date:group.date});
  }
}
fs.mkdirSync(output,{recursive:true});
const results=[];
for(const thread of threads.values()) {
  const f=createManagerFixture();f.env.MANAGER_RELEASE_STAGE='live';
  f.env.MANAGER_AUTO_INTAKE_ENABLED=autoMode==='on'?'true':'false';
  f.env.AI_DISCLOSURE_ENABLED=autoMode==='on'?'true':'false';
  const all=sql=>f.db.prepare(sql).all();
  const messages=[...thread.messages.values()].sort((a,b)=>a.id && b.id && /^\d+$/.test(a.id) && /^\d+$/.test(b.id) ? (BigInt(a.id)<BigInt(b.id)?-1:1) : 0);
  const turns=[];let tick=0;
  for(const m of messages.filter(m=>m.side==='customer'&&m.text?.trim())) {
    // The captured .text may contain only the first text block. Retain all rendered
    // text, removing only the UI's final clock line; keep source unchanged.
    const inputText=(m.renderedText||m.text).replace(/\n\s*\d{1,2}:\d{2}\s*$/u,'').trim();
    const at=Date.parse('2026-10-19T01:00:00Z')+tick*120000;
    const before=f.db.prepare('SELECT COUNT(*) n FROM manager_drafts').get().n;
    const beforeOutbox=f.db.prepare('SELECT COUNT(*) n FROM manager_outbox').get().n;
    const eventId=`OFFLINE-${thread.id}-${++tick}`;
    let error=null;
    try {
      await receiveManagerEvents([{type:'message',webhookEventId:eventId,timestamp:at,source:{userId:`OFFLINE-${thread.id}`},message:{id:eventId,type:'text',text:inputText}}],f.env,new Date(at).toISOString());
      await drainManagerInbox(f.env,new Date(at+30000).toISOString());
    } catch(e) { error=String(e.stack||e); }
    const drafts=all('SELECT * FROM manager_drafts ORDER BY rowid').slice(before);
    const outbox=all('SELECT * FROM manager_outbox ORDER BY rowid').slice(beforeOutbox);
    const flags=[];
    if(error) flags.push('runtime_error');
    for(const d of drafts) {
      if(/M[A-F0-9]{12}|D[A-F0-9]{12}|review_collected_details/.test(d.message)) flags.push('internal_identifier_in_reply');
      if(/葬儀|亡くな|お悔やみ/.test(m.text)&&/😊|お祝い/.test(d.message)) flags.push('sensitive_tone_review');
      if(/今回は.*(?:見送|やめ)|キャンセル/.test(m.text)&&/いつ頃|いくつ|どのような|ご希望のお色/.test(d.message)) flags.push('withdrawal_intake_review');
      if(/はい|それで|お願いします/.test(m.text)&&/どのようなバルーン/.test(d.message)) flags.push('context_loss_review');
    }
    turns.push({sourceMessage:m,inputText,inputDiffersFromFirstText:inputText!==m.text.trim(),inputRule:'full renderedText minus final UI clock line; original unchanged',inputTimestamp:new Date(at).toISOString(),error,flags:[...new Set(flags)],drafts,outbox,fields:all('SELECT * FROM manager_fields'),orders:all('SELECT * FROM manager_orders')});
  }
  const result={id:thread.id,sourceFiles:thread.sources,sourceComplete:thread.complete,conflicts:thread.conflicts,uniqueMessages:messages.length,customerTextTurns:turns.length,storeMessages:messages.filter(m=>m.side==='store').length,excludedNonTextCustomerMessages:messages.filter(m=>m.side==='customer'&&!m.text?.trim()).map(m=>({sourceMessage:m,reason:'no captured text block; image or sticker not interpreted'})),turns};
  fs.writeFileSync(path.join(output,`${thread.id}.runtime.private.json`),JSON.stringify(result,null,2));
  results.push({id:thread.id,uniqueMessages:messages.length,customerTextTurns:turns.length,sourceComplete:thread.complete,conflictingSnapshotVariants:thread.conflicts.length,expandedTextTurns:turns.filter(t=>t.inputDiffersFromFirstText).length,excludedNonTextCustomerMessages:result.excludedNonTextCustomerMessages.length,outboxChannels:turns.flatMap(t=>t.outbox).reduce((a,r)=>(a[r.channel]=(a[r.channel]||0)+1,a),{}),errors:turns.filter(t=>t.error).length,flaggedTurns:turns.filter(t=>t.flags.length).length,flagCounts:turns.flatMap(t=>t.flags).reduce((a,k)=>(a[k]=(a[k]||0)+1,a),{})});
  f.db.close();
}
const summary={mode:'offline_actual_runtime_customer_sequence_replay',network:'forbidden',synthetic:false,generatedAt:new Date().toISOString(),limitations:['Actual store replies are retained as evidence but not injected as AI replies. This is counterfactual sequential replay, not a reproduction of the historic full runtime state.','Image-only inputs are counted but not interpreted.','Replay timestamps are fixed to the audit anchor; historic relative-date resolution is not a historical-date acceptance test.','Message numeric ID ordering is used as a chronology assumption.','Automated flags are review candidates, not semantic acceptance verdicts.','Only structured acquired DOM files are covered; curated-only or unacquired conversations are not claimed as replayed.','Default fixture auto-intake is not enabled. Drafts and queued owner notices are evaluated; no customer delivery or real LINE acceptance is proven.'],threads:results,totalCustomerTextTurns:results.reduce((n,r)=>n+r.customerTextTurns,0),totalUniqueMessages:results.reduce((n,r)=>n+r.uniqueMessages,0)};
summary.autoIntakeMode=autoMode;
summary.limitations[summary.limitations.length-1]=`Fixture auto-intake ${autoMode}; this is not the deployed configuration. Queued candidates only; no customer delivery or real LINE acceptance is proven.`;
fs.writeFileSync(path.join(output,'runtime-summary.private.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
