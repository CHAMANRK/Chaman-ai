// Chaman AI — service worker
// Kaam: pehli visit pe app-shell (HTML, manifest, logo, fonts, katex)
// cache mein rakh do, taaki dusri baar app kholte hi turant open ho —
// logo/icons/fonts dobara network se load na ho. Chat/API calls (jo
// dynamic hote hai) hamesha seedha network se jaate hai, kabhi cache
// nahi hote.

const CACHE_NAME = 'chaman-ai-shell-v1';

// Naya deploy karte waqt yahan version number badha dena
// (v1 -> v2) taaki purana cache clear ho ke naya shell load ho.

const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './logo.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll fail na ho isliye har URL individually try karte hai —
      // ek file (jaise koi missing asset) fail ho bhi jaaye to baaki
      // sab cache ho jaayein.
      return Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(url).catch((err) => console.warn('SW precache skip:', url, err))
        )
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

function isApiLike(url) {
  // Chat/streaming/backend calls ko kabhi cache mat karo — hamesha fresh
  // network response chahiye. Apni backend paths yahan adjust kar sakte ho.
  return (
    url.pathname.includes('/api/') ||
    url.pathname.includes('/chat') ||
    url.pathname.includes('/stream')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/streaming waghera untouched chhod do

  const url = new URL(req.url);
  if (isApiLike(url)) return; // network hi handle karega, SW beech mein nahi aayega

  // Same-origin shell files aur cross-origin static assets (fonts, katex CDN)
  // dono ke liye: cache-first, background mein refresh (stale-while-revalidate).
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached); // offline ho to purana cached jawab hi de do

      return cached || networkFetch;
    })
  );
});
