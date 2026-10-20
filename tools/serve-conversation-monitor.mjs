import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = fileURLToPath(new URL('../docs/simulations/live/', import.meta.url));
const htmlPath = fileURLToPath(new URL('../docs/simulations/viewer/conversation-monitor.html', import.meta.url));
const roles = new Set(['customer', 'clerk', 'coordinator', 'manager', 'delivery', 'verdict']);
const legacyPersonas = new Set(['short decisive','long careful','undecided color','urgent but polite','angry disappointed','typing errors','unfamiliar with terminology','casual abbreviated','proxy deciding with family','conversation detour','bereaved parent','repeat purchaser','price focused','receipt discrepancy','payment visit changes','delivery appreciation','conditional substitute','visit delay','alternative pickup dates','time-only updates','three personalized items','withdrawal then followup','safety incident','separate concurrent orders','one owner twelve overlapping customers']);
for (const name of ['短く即決する人','長文で慎重に確認する人','色を迷っている人','急ぎで丁寧に相談する人','強い不満を伝える人','入力の誤字が多い人','専門用語に不慣れな人','省略語を使う人','家族の代理で相談する人','相談中に話がそれる人','お別れの装飾を相談する人','以前と同じ注文を希望する人','まず価格を知りたい人','領収書の金額を確認する人','支払い来店日時を調整する人','配達のお礼を伝える人','欠品時の代替案を相談する人','来店相談に遅れそうな人','複数の受取候補を相談する人','受取時刻を変更する人','複数商品の名入れを訂正する人','注文を見送りたい人','安全上の問題を相談する人','別の注文も同時に相談する人','店長1人で12人の注文を確認']) legacyPersonas.add(name);
const clipped = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';

export async function readMonitorEvents() {
  let files;
  try { files = await fs.readdir(sourceDirectory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { events: [], skippedLines: 0 }; throw error; }
  const events = []; let skippedLines = 0;
  for (const file of files.filter(entry => entry.isFile() && !entry.isSymbolicLink() && /^[A-Za-z0-9_.-]+\.jsonl$/u.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(sourceDirectory, file.name);
    const metadata = await fs.lstat(fullPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 12 * 1024 * 1024) continue;
    const content = await fs.readFile(fullPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!roles.has(row.role) || typeof row.text !== 'string' || typeof row.caseId !== 'string') { skippedLines++; continue; }
        const legacySynthetic = row.sourceKind == null && file.name === 'persona-events.jsonl' && /^P(?:0[1-9]|1\d|2[0-5])$/u.test(row.caseId) && legacyPersonas.has(row.persona);
        if (row.sourceKind !== 'synthetic_persona' && !legacySynthetic) { skippedLines++; continue; }
        // Deliberate field allowlist; filenames and source paths never enter API.
        events.push({ runId: clipped(row.runId, 160), caseId: clipped(row.caseId, 160), persona: clipped(row.persona, 240), role: row.role, text: clipped(row.text, 16000), at: clipped(row.at, 80), status: clipped(row.status, 100), result: clipped(row.result, 100), pass: typeof row.pass === 'boolean' ? row.pass : undefined, sequence: typeof row.sequence === 'number' ? row.sequence : undefined, simulated: true, sourceKind: 'synthetic_persona' });
      } catch { skippedLines++; } // A writer may still be appending the last line.
    }
  }
  events.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || (a.sequence || 0) - (b.sequence || 0));
  return { events: events.slice(-15000), skippedLines };
}

export function createConversationMonitor() {
  return http.createServer(async (request, response) => {
    const common = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
    const send = (status, type, body) => { response.writeHead(status, { ...common, 'Content-Type': type }); response.end(body); };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return send(403, 'text/plain; charset=utf-8', 'この画面はこのPC内でのみ利用できます。');
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(request.headers.host || '')) return send(403, 'text/plain; charset=utf-8', 'Host not permitted');
    if (request.method !== 'GET') return send(405, 'text/plain; charset=utf-8', 'GET only');
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    try {
      if (pathname === '/') return send(200, 'text/html; charset=utf-8', await fs.readFile(htmlPath, 'utf8'));
      if (pathname === '/api/events') return send(200, 'application/json; charset=utf-8', JSON.stringify({ ...(await readMonitorEvents()), updatedAt: new Date().toISOString(), mode: 'fictional_simulation_only' }));
      return send(404, 'text/plain; charset=utf-8', 'Not found');
    } catch { return send(500, 'application/json; charset=utf-8', JSON.stringify({ error: '会話ログを読み込めませんでした。再試行しています。' })); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : process.argv[2];
  const port = Number(arg || 8789);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a local port between 1024 and 65535');
  const server = createConversationMonitor();
  server.on('error', error => { console.error(`会話モニターを起動できません: ${error.code || 'server error'}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`模擬会話モニター: http://127.0.0.1:${port}/ （架空データのみ・実送信なし）`));
}
