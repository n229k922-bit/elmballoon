const TTL = 7 * 24 * 60 * 60;
const PNG_SIGNATURE = [137,80,78,71,13,10,26,10];

// Does not expose tokens or contact/modify an account.
export function scheduleProofReadiness(env = {}) {
  const missing = ['SCHEDULE_PROOF_PAGE_URL','BROWSER_RENDERING_TOKEN','CLOUDFLARE_ACCOUNT_ID','MANAGER_APP_ORIGIN'].filter(key => !env[key]);
  if (!env.SECRETARY_KV?.put || !env.SECRETARY_KV?.get) missing.push('SECRETARY_KV');
  if (missing.length) return {ready:false,missing,reason:'not_configured'};
  try {
    const page = new URL(env.SCHEDULE_PROOF_PAGE_URL), origin = new URL(env.MANAGER_APP_ORIGIN);
    if (page.protocol !== 'https:' || page.username || page.password || page.hash ||
        !['/','/index.html','/elmballoon/','/elmballoon/index.html'].includes(page.pathname) ||
        [...page.searchParams].some(([key,value]) => key !== 'schedule' || value !== 'test') ||
        origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
        !/^[a-zA-Z0-9_-]+$/u.test(env.CLOUDFLARE_ACCOUNT_ID)) throw new Error();
    return {ready:true,missing:[],pageUrl:page.href,assetOrigin:origin.origin};
  } catch { return {ready:false,missing:[],reason:'invalid_configuration'}; }
}

function validChange(change) {
  if (!change || !/^\d{4}-\d{2}-\d{2}$/u.test(change.date) || Number.isNaN(Date.parse(change.date)) ||
      new Date(change.date).toISOString().slice(0,10) !== change.date || !['closed','open','special_hours'].includes(change.status)) return false;
  if (change.status !== 'special_hours') return true;
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
  return time.test(change.openTime) && time.test(change.closeTime) && change.openTime < change.closeTime;
}

function attributes(entry) { return name => entry?.attributes?.find(a => a.name === name)?.value || ''; }
function expectedEntry(attr, change) {
  const closed = /(?:^|\s)is-closed(?:\s|$)/u.test(attr('class'));
  const special = /(?:^|\s)has-special-hours(?:\s|$)/u.test(attr('class'));
  const times = attr('data-label').match(/\b\d{1,2}:\d{2}\b/gu) || [];
  return attr('data-date') === change.date && !!attr('data-label') &&
    (change.status === 'closed' ? closed : change.status === 'open' ? !closed && !special :
      !closed && special && times.length === 2 && times[0] === change.openTime && times[1] === change.closeTime);
}

// Recheck on the screenshot navigation, freeze that DOM, and crop by element.
// Reusing a scrape's coordinates on a second navigation could capture the wrong area.
export function scheduleProofCaptureScript(expected) {
  return `(() => {
    const expected = ${JSON.stringify(expected)};
    const verify = () => {
      if (location.href !== expected.pageUrl) return;
      const calendars = document.querySelectorAll('.elm-calendar');
      if (calendars.length !== 1) return;
      const calendar = calendars[0];
      if (calendar.getAttribute('data-schedule-source') !== expected.source) return;
      const days = calendar.querySelectorAll('[data-date="' + expected.date + '"]');
      if (days.length !== 1) return;
      const day = days[0];
      if (day.getAttribute('data-label') !== expected.label || day.getAttribute('class') !== expected.className) return;
      const copy = calendar.cloneNode(true);
      copy.querySelectorAll('script,iframe,object,embed,input,textarea,select,[contenteditable]').forEach(node => node.remove());
      const box = calendar.getBoundingClientRect();
      if (box.width < 200 || box.width > 2000 || box.height < 100 || box.height > 2000) return;
      copy.style.width = box.width + 'px';
      copy.style.margin = '0';
      copy.id = expected.marker;
      // Keep the public calendar's ancestor classes so existing scoped CSS still
      // renders identically, while dropping all unrelated page content.
      let isolated = copy;
      for (let parent = calendar.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const shell = parent.cloneNode(false);
        shell.appendChild(isolated);
        isolated = shell;
      }
      document.body.replaceChildren(isolated);
      document.body.style.margin = '0';
      document.body.style.background = 'white';
      observer.disconnect();
    };
    const observer = new MutationObserver(verify);
    observer.observe(document.documentElement, {subtree:true,childList:true,attributes:true});
    verify();
  })();`;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function validateScheduleProofPng(bytes) {
  if (bytes.length > 900000 || bytes.length < 57 || !PNG_SIGNATURE.every((v,i) => bytes[i] === v)) throw new Error('invalid_image');
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let position = 8, hasHeader = false, hasPixels = false, ended = false, rowBytes = 0, rows = 0, endedPixels = false;
  const pixelChunks = [];
  while (position + 12 <= bytes.length) {
    const length = view.getUint32(position), end = position + 12 + length;
    if (end > bytes.length) throw new Error('invalid_image');
    const type = String.fromCharCode(...bytes.subarray(position+4,position+8));
    if (!/^[A-Za-z]{4}$/u.test(type) || (type[0] === type[0].toUpperCase() && !['IHDR','PLTE','IDAT','IEND'].includes(type))) throw new Error('invalid_image');
    if (crc32(bytes.subarray(position+4,end-4)) !== view.getUint32(end-4)) throw new Error('invalid_image');
    if (!hasHeader && type !== 'IHDR') throw new Error('invalid_image');
    if (type === 'IHDR') {
      if (hasHeader || length !== 13) throw new Error('invalid_image');
      const width = view.getUint32(position+8), height = view.getUint32(position+12);
      if (width < 200 || width > 2000 || height < 100 || height > 2000) throw new Error('invalid_image');
      const depth = bytes[position+16], color = bytes[position+17];
      // Browser screenshots use 8-bit RGB/RGBA; do not accept exotic palette or
      // interlaced sources without a decoder that can validate those variants.
      const channels = {2:3,6:4}[color];
      if (!channels || depth !== 8 || bytes[position+18] !== 0 || bytes[position+19] !== 0 || bytes[position+20] !== 0) throw new Error('invalid_image');
      rowBytes = 1 + Math.ceil(width * channels * depth / 8);
      rows = height;
      hasHeader = true;
    }
    if (type === 'PLTE' && (hasPixels || length === 0 || length > 768 || length % 3 !== 0)) throw new Error('invalid_image');
    if (type !== 'IDAT' && hasPixels) endedPixels = true;
    if (type === 'IDAT') {
      if (endedPixels) throw new Error('invalid_image');
      if (length > 0) { hasPixels = true; pixelChunks.push(bytes.subarray(position+8,end-4)); }
    }
    position = end;
    if (type === 'IEND') { ended = length === 0 && position === bytes.length; break; }
  }
  if (!hasHeader || !hasPixels || !ended) throw new Error('invalid_image');
  const compressed = new Blob(pixelChunks).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  let expanded = 0;
  try {
    for (;;) {
      const {done,value} = await compressed.read();
      if (done) break;
      if (expanded + value.length > rowBytes * rows) throw new Error('invalid_image');
      for (let index = (rowBytes - expanded % rowBytes) % rowBytes; index < value.length; index += rowBytes) {
        if (value[index] > 4) throw new Error('invalid_image');
      }
      expanded += value.length;
    }
    if (expanded !== rowBytes * rows) throw new Error('invalid_image');
  } catch { await compressed.cancel().catch(() => {}); throw new Error('invalid_image'); }
}

export async function captureScheduleProof(change, env, fetcher = fetch) {
  const readiness = scheduleProofReadiness(env);
  if (!readiness.ready) throw new Error(readiness.reason);
  if (!validChange(change)) throw new Error('invalid_change');
  const page = new URL(readiness.pageUrl);
  page.searchParams.set('schedule_date',change.date);
  const api = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/`;
  const headers = {'Content-Type':'application/json',Authorization:`Bearer ${env.BROWSER_RENDERING_TOKEN}`};
  const day = `.elm-calendar [data-date="${change.date}"]`;
  const common = {url:page.href,viewport:{width:900,height:1000,deviceScaleFactor:1},gotoOptions:{waitUntil:'networkidle0'},waitForSelector:{selector:day,visible:true,timeout:15000}};
  const scraped = await fetcher(api+'scrape?cacheTTL=0',{method:'POST',headers,signal:AbortSignal.timeout(22000),body:JSON.stringify({...common,elements:[{selector:day},{selector:'.elm-calendar'}]})});
  if (!scraped.ok) throw new Error('capture_failed');
  const data = await scraped.json();
  if (data.success === false || !Array.isArray(data.result)) throw new Error('capture_failed');
  const entries = data.result.find(x => x.selector === day)?.results;
  const calendars = data.result.find(x => x.selector === '.elm-calendar')?.results;
  if (entries?.length !== 1 || calendars?.length !== 1) throw new Error('ambiguous_calendar');
  if (attributes(calendars[0])('data-schedule-source') !== `${readiness.assetOrigin}/api/business-schedule`) throw new Error('wrong_schedule_source');
  const attr = attributes(entries[0]);
  if (!expectedEntry(attr,change)) throw new Error('page_not_updated');
  const marker = `schedule-proof-${crypto.randomUUID()}`;
  const screenshot = await fetcher(api+'screenshot?cacheTTL=0',{method:'POST',headers,signal:AbortSignal.timeout(22000),body:JSON.stringify({
    ...common,
    addScriptTag:[{content:scheduleProofCaptureScript({pageUrl:page.href,source:`${readiness.assetOrigin}/api/business-schedule`,date:change.date,label:attr('data-label'),className:attr('class'),marker})}],
    waitForSelector:{selector:`#${marker}`,visible:true,timeout:15000},selector:`#${marker}`,screenshotOptions:{type:'png',encoding:'binary'}
  })});
  if (!screenshot.ok || !/^image\/png(?:;|$)/iu.test(screenshot.headers.get('Content-Type') || '')) throw new Error('capture_failed');
  const bytes = new Uint8Array(await screenshot.arrayBuffer());
  await validateScheduleProofPng(bytes);
  const id = crypto.randomUUID(), key = `schedule-proof:${id}`;
  await env.SECRETARY_KV.put(key,bytes.buffer,{expirationTtl:TTL});
  const stored = await env.SECRETARY_KV.get(key,'arrayBuffer');
  if (!stored || stored.byteLength !== bytes.byteLength || !new Uint8Array(stored).every((value,index) => value === bytes[index])) throw new Error('image_not_available');
  return {imageUrl:`${readiness.assetOrigin}/schedule-proof/${id}.png`,pageUrl:page.href};
}

export async function scheduleProofAsset(path,env) {
  const match = path.match(/^\/schedule-proof\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.png$/u);
  if (!match) return null;
  try {
    const bytes = await env.SECRETARY_KV.get(`schedule-proof:${match[1]}`,'arrayBuffer');
    if (!bytes) return new Response('Image expired',{status:404,headers:{'Cache-Control':'no-store'}});
    await validateScheduleProofPng(new Uint8Array(bytes));
    return new Response(bytes,{headers:{'Content-Type':'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex'}});
  } catch { return new Response('Image unavailable',{status:503,headers:{'Cache-Control':'no-store'}}); }
}

export async function scheduleProofMessages(change,env,fetcher=fetch) {
  const summary = String(change.summary || '営業日の変更').replace(/(\d{4})-(\d{2})-(\d{2})/gu,(_,y,m,d) => `${Number(m)}月${Number(d)}日`);
  try {
    const proof = await captureScheduleProof(change,env,fetcher);
    return [{type:'text',text:`ホームページの表示も確認できました😊\n${summary}\n\n変更した日のカレンダー画像をお送りします。`},{type:'image',originalContentUrl:proof.imageUrl,previewImageUrl:proof.imageUrl}];
  } catch {
    return [{type:'text',text:`営業日の変更を保存しました。\n${summary}\n\nホームページの表示・画像の確認は未完了です。表示を確認してから完了をご案内します。\nお客様との受取・配達のお約束は変更していません。`}];
  }
}
