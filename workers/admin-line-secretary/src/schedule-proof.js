// Only public calendar content is captured. Credentials never enter page URLs.
export async function captureScheduleProof(change, env, fetcher = fetch) {
  if (!env.SCHEDULE_PROOF_PAGE_URL || !env.BROWSER_RENDERING_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) throw new Error('not_configured');
  const page = new URL(env.SCHEDULE_PROOF_PAGE_URL);
  const origin = new URL(env.MANAGER_APP_ORIGIN);
  if (page.protocol !== 'https:' || page.username || page.password || origin.protocol !== 'https:') throw new Error('invalid_configuration');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(change.date)) throw new Error('invalid_date');
  page.searchParams.set('schedule_date',change.date);
  const api = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/`;
  const headers = {'Content-Type':'application/json',Authorization:`Bearer ${env.BROWSER_RENDERING_TOKEN}`};
  const day = `.elm-calendar [data-date="${change.date}"]`;
  const common = {url:page.href,viewport:{width:900,height:1000},gotoOptions:{waitUntil:'networkidle0'},waitForSelector:{selector:day,visible:true,timeout:15000}};
  const scraped = await fetcher(api+'scrape',{method:'POST',headers,signal:AbortSignal.timeout(22000),body:JSON.stringify({...common,elements:[{selector:day},{selector:'.elm-calendar'}]})});
  if (!scraped.ok) throw new Error('capture_failed');
  const data = await scraped.json();
  const entry = data.result?.find(x=>x.selector===day)?.results?.[0];
  const box = data.result?.find(x=>x.selector==='.elm-calendar')?.results?.[0];
  if (box?.attributes?.find(a=>a.name==='data-schedule-source')?.value !== `${origin.origin}/api/business-schedule`) throw new Error('wrong_schedule_source');
  const attr = name => entry?.attributes?.find(a=>a.name===name)?.value || '';
  const label = attr('data-label');
  const closed = /(?:^|\s)is-closed(?:\s|$)/u.test(attr('class'));
  const matches = attr('data-date') === change.date && (change.status==='closed' ? closed : change.status==='open' ? !closed && !/has-special-hours/u.test(attr('class')) : !closed && label.includes(change.openTime) && label.includes(change.closeTime));
  if (!matches) throw new Error('page_not_updated');
  if (!box || ![box.left,box.top,box.width,box.height].every(Number.isFinite) || box.width<=0 || box.height<=0 || box.width>2000 || box.height>2000) throw new Error('invalid_crop');
  // Wait for the verified label on the screenshot navigation as well.
  const verifiedSelector = `${day}[data-label=${JSON.stringify(label)}]`;
  const screenshot = await fetcher(api+'screenshot',{method:'POST',headers,signal:AbortSignal.timeout(22000),body:JSON.stringify({...common,waitForSelector:{selector:verifiedSelector,visible:true,timeout:15000},screenshotOptions:{type:'png',clip:{x:Math.max(0,box.left),y:Math.max(0,box.top),width:box.width,height:box.height}}})});
  if (!screenshot.ok) throw new Error('capture_failed');
  const bytes = new Uint8Array(await screenshot.arrayBuffer());
  if (bytes.length>900000 || bytes.length<8 || ![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)) throw new Error('invalid_image');
  const id = crypto.randomUUID();
  await env.SECRETARY_KV.put(`schedule-proof:${id}`,bytes.buffer,{expirationTtl:604800});
  return {imageUrl:`${origin.origin}/schedule-proof/${id}.png`,pageUrl:page.href};
}

export async function scheduleProofAsset(path,env) {
  const match=path.match(/^\/schedule-proof\/([a-f0-9-]{36})\.png$/u);
  if (!match) return null;
  const bytes=await env.SECRETARY_KV.get(`schedule-proof:${match[1]}`,'arrayBuffer');
  return bytes ? new Response(bytes,{headers:{'Content-Type':'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex'}}) : new Response('Image expired',{status:404});
}

export async function scheduleProofMessages(change,env,fetcher=fetch) {
  const summary=String(change.summary||'営業日の変更').replace(/(\d{4})-(\d{2})-(\d{2})/gu,(_,y,m,d)=>`${Number(m)}月${Number(d)}日`);
  try {
    const proof=await captureScheduleProof(change,env,fetcher);
    return [{type:'text',text:`ホームページの表示も確認できました😊\n${summary}\n\n変更した日のカレンダー画像をお送りします。`},{type:'image',originalContentUrl:proof.imageUrl,previewImageUrl:proof.imageUrl}];
  } catch {
    return [{type:'text',text:`営業日の変更を保存しました。\n${summary}\n\nホームページの表示・画像の確認は未完了です。表示を確認してから完了をご案内する必要があります。\nお客様との受取・配達のお約束は変更していません。`}];
  }
}
