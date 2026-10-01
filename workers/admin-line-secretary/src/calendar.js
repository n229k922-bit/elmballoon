// Calendar access is private. Availability exposes busy intervals, never event content.
const STATE_COOKIE = '__Host-calendar-oauth';
const TOKEN_KEY = 'google-calendar-refresh-token';
const STATE_TTL = 600;
const enc = new TextEncoder();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
async function digest(value) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))); }
async function equal(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
export async function authorizeCalendarAdmin(request, env) {
  if (!env.ADMIN_API_TOKEN) return json({ error: 'admin_auth_not_configured' }, 503);
  const supplied = request.headers.get('Authorization') || '';
  if (!supplied.startsWith('Bearer ') || !(await equal(supplied.slice(7), env.ADMIN_API_TOKEN))) return json({ error: 'unauthorized' }, 401);
  return null;
}
function config(request, env) {
  let redirect;
  try { redirect = new URL(env.GOOGLE_REDIRECT_URI); } catch { return null; }
  const current = new URL(request.url);
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
  // Explicit callback origin prevents test Workers linking the production token store.
  if (!clientId || !clientSecret || !env.SECRETARY_KV || redirect.protocol !== 'https:' || redirect.origin !== current.origin || redirect.pathname !== '/oauth/google/callback' || redirect.search || redirect.hash || redirect.username || redirect.password) return null;
  return { clientId, clientSecret, redirectUri: redirect.href };
}
export async function googleOAuthStart(request, env) {
  const denied = await authorizeCalendarAdmin(request, env);
  if (denied) return denied;
  const cfg = config(request, env);
  if (!cfg) return json({ error: 'calendar_oauth_not_configured' }, 503);
  const state = random(), binding = random(), verifier = random();
  const challenge = btoa(String.fromCharCode(...await digest(verifier))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await env.SECRETARY_KV.put(`calendar-oauth-state:${state}`, JSON.stringify({ binding, verifier, redirectUri: cfg.redirectUri, expiresAt: Date.now() + STATE_TTL * 1000 }), { expirationTtl: STATE_TTL });
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: 'https://www.googleapis.com/auth/calendar.freebusy', state, code_challenge: challenge, code_challenge_method: 'S256' });
  return new Response(null, { status: 302, headers: { Location: auth.href, 'Cache-Control': 'no-store', 'Set-Cookie': `${STATE_COOKIE}=${binding}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL}` } });
}
export async function googleOAuthCallback(request, env) {
  const cfg = config(request, env);
  if (!cfg) return json({ error: 'calendar_oauth_not_configured' }, 503);
  const url = new URL(request.url), state = url.searchParams.get('state');
  if (!/^[a-f0-9]{64}$/.test(state || '')) return json({ error: 'invalid_oauth_state' }, 400);
  const binding = (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${STATE_COOKIE}=`))?.slice(STATE_COOKIE.length + 1);
  let saved;
  try { saved = JSON.parse(await env.SECRETARY_KV.get(`calendar-oauth-state:${state}`)); } catch { /* invalid state is rejected */ }
  if (!binding || !saved || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= Date.now() || !/^[a-f0-9]{64}$/.test(saved.verifier || '') || typeof saved.binding !== 'string' || saved.redirectUri !== cfg.redirectUri || !(await equal(binding, saved.binding))) return json({ error: 'invalid_oauth_state' }, 400);
  await env.SECRETARY_KV.delete(`calendar-oauth-state:${state}`);
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.has('error')) return json({ error: 'oauth_cancelled' }, 400);
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, code_verifier: saved.verifier, grant_type: 'authorization_code' }) });
    const token = await response.json();
    if (!response.ok || !token.refresh_token) return json({ error: 'calendar_token_exchange_failed' }, 502);
    await env.SECRETARY_KV.put(TOKEN_KEY, token.refresh_token);
    return new Response('Googleカレンダーの空き時間確認を接続しました。', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `${STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` } });
  } catch { return json({ error: 'calendar_connection_failed' }, 502); }
}
export async function calendarAvailability(request, env) {
  const denied = await authorizeCalendarAdmin(request, env);
  if (denied) return denied;
  const cfg = config(request, env);
  const calendarIds = [...new Set((env.GOOGLE_CALENDAR_IDS || '').split(',').map(v => v.trim()).filter(Boolean))];
  if (!cfg || !calendarIds.length || calendarIds.length > 50) return json({ error: 'calendar_not_configured' }, 503);
  const url = new URL(request.url), date = url.searchParams.get('date');
  const start = url.searchParams.get('start') || '00:00', end = url.searchParams.get('end') || '23:59';
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date || !timePattern.test(start) || !timePattern.test(end) || start >= end) return json({ error: 'invalid_date_or_time_range' }, 400);
  try {
    const refreshToken = await env.SECRETARY_KV.get(TOKEN_KEY);
    if (!refreshToken) return json({ error: 'calendar_not_connected' }, 503);
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }) });
    const token = await tokenRes.json();
    if (!tokenRes.ok || !token.access_token) return json({ error: 'calendar_token_refresh_failed' }, 502);
    const timeMin = `${date}T${start}:00+09:00`, timeMax = `${date}T${end}:00+09:00`;
    const response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ timeMin, timeMax, timeZone: 'Asia/Tokyo', items: calendarIds.map(id => ({ id })) }) });
    const data = await response.json();
    if (!response.ok || calendarIds.some(id => !Array.isArray(data.calendars?.[id]?.busy) || data.calendars[id].errors?.length)) return json({ error: 'calendar_availability_unavailable', availability: 'unknown' }, 502);
    const busy = [];
    for (const id of calendarIds) for (const interval of data.calendars[id].busy) {
      const from = Date.parse(interval.start), to = Date.parse(interval.end);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return json({ error: 'calendar_availability_unavailable', availability: 'unknown' }, 502);
      busy.push({ start: interval.start, end: interval.end });
    }
    busy.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return json({ date, timeMin, timeMax, busy, availability: busy.length ? 'busy' : 'free', requires_manager_confirmation: true, notice: '予定の重複のみを確認しています。制作・移動・在庫を含む受注可否は店長確認が必要です。' });
  } catch { return json({ error: 'calendar_availability_unavailable', availability: 'unknown' }, 502); }
}
