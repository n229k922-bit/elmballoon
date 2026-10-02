// Read-only, aggregate observations. These are not profitability or capacity guarantees.
export async function getOperationalMetrics(env,{since,until=new Date().toISOString()}={}) {
  const end=Date.parse(until), start=Date.parse(since);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end) throw new Error('有効な集計期間が必要です');
  const from=new Date(start).toISOString(), to=new Date(end).toISOString();
  const count=async(sql)=>Number((await env.DB.prepare(sql).bind(from,to).first())?.n||0);
  const customerMessages=await count("SELECT COUNT(*) n FROM manager_events WHERE direction='customer' AND received_at>=? AND received_at<?");
  const approvedReplies=await count("SELECT COUNT(*) n FROM manager_audit WHERE action='reply.approved' AND created_at>=? AND created_at<?");
  const sentQuestions=await count('SELECT COUNT(*) n FROM manager_questions WHERE sent_at>=? AND sent_at<?');
  const editedReplies=await count("SELECT COUNT(*) n FROM manager_events WHERE direction='owner' AND text LIKE '返信作成 %' AND received_at>=? AND received_at<?");
  const sendFailures=await count("SELECT COUNT(*) n FROM manager_outbox WHERE channel='customer' AND status IN ('failed','uncertain') AND created_at>=? AND created_at<?");
  const sample=await env.DB.prepare(`SELECT COUNT(*) n, AVG((julianday(x.sent_at)-julianday(e.received_at))*86400) seconds
    FROM manager_outbox x JOIN manager_drafts d ON d.id=x.draft_id JOIN manager_events e ON e.id=d.source_event_id
    WHERE x.channel='customer' AND x.status='sent' AND x.sent_at IS NOT NULL AND x.sent_at>=e.received_at
      AND e.received_at>=? AND e.received_at<?`).bind(from,to).first();
  return {period:{since:from,until:to},coverage:'システムに保存された記録のみ。電話・店頭・外部LINEの未登録対応は含みません。',
    customerMessages,approvedReplies,sentQuestions,editedReplies,sendFailures,
    responseSeconds:{value:Number(sample?.n)>0?Number(sample.seconds):null,samples:Number(sample?.n||0)},
    orderConversion:null,customerEffort:null,lostOrders:null,
    limitations:['受注率・お客様の負担・取りこぼしは未計測です。ゼロ件とは判断できません。','送信失敗は現在失敗・結果不明の件数であり、復旧済みの過去失敗全数ではありません。','修正文の件数は「返信作成」形式の記録のみで、全編集回数ではありません。']};
}

export function formatOperationalMetrics(m) {
  const date=value=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
  return `【運用確認】\n${date(m.period.since)} ～ ${date(m.period.until)}（日本時間）\n${m.coverage}\n受信：${m.customerMessages}件／返信承認：${m.approvedReplies}回\n送信済み質問：${m.sentQuestions}項目／返信作成記録：${m.editedReplies}件\n送信失敗・結果不明：${m.sendFailures}件\n平均返信時間：${m.responseSeconds.value===null?'集計できる記録なし':Math.round(m.responseSeconds.value)+'秒（'+m.responseSeconds.samples+'件）'}\n${m.limitations.join('\n')}`;
}
