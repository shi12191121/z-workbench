/* =========================================================
 * Service Worker（z的工作台）
 * 用途：仅用于把网页「安装」成手机桌面 App（图标封装）。
 * 策略：网络优先（network-first）——永远先请求云端最新页面/数据，
 *      断网时才回退到缓存，绝不把旧页面/旧数据锁死在本地。
 * ========================================================= */
const CACHE = 'z-workbench-v4';
const ASSETS = [
  './', './index.html', './manifest.json',
  './styles.css', './app.js', './firebase-config.js', './avatar.jpg'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;            // POST 等一律走网络（含 Firebase 写操作）
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return; // 同步接口：完全交给网络，不经过缓存
  // 网络优先：拿不到才用缓存兜底，保证永远是最新内容
  e.respondWith(
    fetch(req)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
