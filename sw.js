// 快取名稱刻意不含版號 —— 用 stale-while-revalidate，每次開啟都會在背景抓新版，
// 所以不必再手動改這裡。改動 app.js / index.html 之後直接部署即可，
// 使用者在「下一次」開啟時就會拿到新版（當次仍是舊的，這是 SWR 的取捨）。
const CACHE_NAME = 'teaching-progress-static';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './apple-touch-icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Gist API 一定要走網路，絕不快取
  if (req.url.includes('api.github.com')) return;
  // 只處理同源的靜態資源
  if (new URL(req.url).origin !== self.location.origin) return;

  // 網路請求要在這裡同步啟動，e.waitUntil() 也必須同步呼叫 ——
  // 少了 waitUntil，瀏覽器可能在寫入快取前就把 SW 關掉，那就永遠更新不了。
  const network = fetch(req);

  const cachePut = network.then(res => {
    if (!res || !res.ok) return;
    return caches.open(CACHE_NAME)
      .then(cache => cache.put(req, res.clone()))
      .catch(() => {});
  }).catch(() => {});
  e.waitUntil(cachePut);

  e.respondWith(
    caches.open(CACHE_NAME)
      .then(cache => cache.match(req))
      .then(cached => cached || network)   // 有快取就先回，沒快取才等網路
      .catch(() => Response.error())        // 離線又沒快取
  );
});
