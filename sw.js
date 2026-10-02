// Network-first: every request goes to the network with the HTTP cache bypassed.
// The cache is only an offline fallback, never served while the network answers.
// Bump VERSION whenever this file changes so installed copies pick it up and reload once.
const VERSION=1;
// Cache name is unique to this app (reversi-offline): GitHub Pages shares one origin across repos.
const CACHE='reversi-offline';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(
  caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('reversi-')&&k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())
));
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET'||!r.url.startsWith(self.location.origin))return;
  e.respondWith(
    fetch(r,{cache:'no-store'}).then(res=>{
      if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(r,copy))}
      return res;
    }).catch(()=>caches.match(r).then(m=>m||Response.error()))
  );
});
