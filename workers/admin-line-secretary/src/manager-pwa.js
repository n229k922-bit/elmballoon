const ICON='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="110" fill="#285c48"/><ellipse cx="256" cy="208" rx="108" ry="130" fill="#fff6df"/><path d="M256 334l-18 30h36zM256 364c-44 38 44 50 0 94" fill="none" stroke="#fff6df" stroke-width="12"/><text x="256" y="244" font-size="116" text-anchor="middle" font-family="Georgia,serif" fill="#285c48">e</text></svg>';
export function managerPwaAsset(path) {
  if(path==='/manager.webmanifest')return new Response(JSON.stringify({id:'/manager',name:'elm・balloon 統括ノート',short_name:'統括ノート',lang:'ja',start_url:'/manager?home=1',scope:'/manager',display:'standalone',background_color:'#f6f5f0',theme_color:'#285c48',icons:[{src:'/manager-icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any maskable'}]}),{headers:{'Content-Type':'application/manifest+json','Cache-Control':'public,max-age=3600'}});
  if(path==='/manager-icon.svg')return new Response(ICON,{headers:{'Content-Type':'image/svg+xml','Cache-Control':'public,max-age=86400'}});
  if(path==='/manager-sw.js')return new Response(SERVICE_WORKER,{headers:{'Content-Type':'application/javascript','Cache-Control':'no-cache','Service-Worker-Allowed':'/manager'}});
  return null;
}
const SERVICE_WORKER=String.raw`
const CACHE='elm-manager-shell-v1';
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['/manager','/manager-icon.svg','/manager.webmanifest']))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('elm-manager-shell-')&&key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(url.pathname==='/manager')event.respondWith(fetch(event.request).catch(()=>caches.match('/manager')));
});
`;
