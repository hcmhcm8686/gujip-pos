/* 오프라인 동작용 서비스 워커
 * - 앱 파일: 캐시를 먼저 보여주고, 뒤에서 새 파일을 받아 둡니다.
 * - Firebase SDK(gstatic): 버전이 주소에 들어 있어 바뀌지 않으므로 한 번 받으면 캐시에서 씁니다.
 * - Firestore·로그인 통신은 건드리지 않습니다.
 * - 새 버전 적용: 배포할 때마다 아래 CACHE 번호를 올립니다. 그러면 앱을 열 때 새 워커가 설치되고,
 *   열려 있는 화면에 알려서(app.js가 한가할 때 스스로 새로고침) 새 버전이 바로 적용됩니다.
 *   예전 앱(알림을 못 받는 버전)은 2.5초 뒤 워커가 직접 새로고침합니다. */
const CACHE = 'gujip-pos-v11';
const SDK_CACHE = 'gujip-firebase-sdk';
const ASSETS = ['./', './index.html', './style.css', './firebase-config.js', './cloud.js', './app.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];
const ackWaiters = new Map();   // 새 버전 알림에 답한 화면 (clientId → resolve)

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS.map(a => new Request(a, { cache: 'no-cache' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE && k !== SDK_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(clients.map(c => new Promise(resolve => {
      const timer = setTimeout(() => {
        ackWaiters.delete(c.id);
        // 새로고침 완료를 기다리면 안 됩니다: 그 요청은 이 활성화가 끝나야 처리되므로 서로 기다리다 멈춥니다.
        try { c.navigate(c.url).catch(() => {}); } catch (err) { /* 새로고침 못 하면 다음에 열 때 적용 */ }
        resolve();
      }, 2500);
      ackWaiters.set(c.id, () => { clearTimeout(timer); ackWaiters.delete(c.id); resolve(); });
      c.postMessage({ type: 'sw-activated', cache: CACHE });
    })));
  })());
});

self.addEventListener('message', e => {
  if (!e.data || !e.source) return;
  if (e.data.type === 'ack') { const done = ackWaiters.get(e.source.id); if (done) done(); }
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(caches.open(SDK_CACHE).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // 브라우저 자체 캐시를 건너뛰고 서버에 새 파일이 있는지 확인하며 받습니다.
  const fresh = () => fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }));

  // 앱 이름·아이콘이 담긴 manifest는 항상 새로 받아야 홈 화면 이름이 갱신됩니다(인터넷이 없을 때만 캐시).
  if (url.pathname.endsWith('/manifest.json')) {
    e.respondWith(fresh().then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }

  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fresh().then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) return cached;
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') return cache.match('./index.html');
    return new Response('', { status: 504, statusText: 'offline' });
  }));
});
