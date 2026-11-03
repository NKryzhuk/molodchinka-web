/* Трекер досягнень — service worker: офлайн-робота та фонові нагадування */
const CACHE = 'tracker-v2.2.1';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/badge-96.png', './firebase-bundle.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Мережа спершу (щоб оновлення приходили одразу), кеш — коли офлайн
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req, {ignoreSearch: true}).then(r => r || caches.match('./index.html')))
  );
});

/* ---- Фонові нагадування ---- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('tracker-bg', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function get(k) { const db = await idb(); return new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(undefined); }); }
async function set(k, v) { const db = await idb(); return new Promise(r => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = r; t.onerror = r; }); }

const DAILY_TITLE = 'Час прописати задачі, які були сьогодні виконані тобою';
const DAILY_BODY = 'Натисни, щоб відмітити зроблене ✨';
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

async function check() {
  const sched = (await get('schedule')) || [];
  const notified = (await get('notified')) || {};
  const daily = (await get('daily')) || {enabled: true, hour: 21};
  const now = Date.now(); const fresh = [];
  for (const it of sched) {
    if (it.at > now || notified[it.key]) continue;
    notified[it.key] = now;
    if (it.at < now - 3 * 86400e3 && it.key.endsWith('|over')) continue;
    fresh.push({...it, type: it.key.endsWith('|over') ? 'overdue' : 'reminder'});
  }
  if (daily.enabled) {
    const d = new Date(); const at = new Date(d); at.setHours(daily.hour, 0, 0, 0);
    const key = 'daily|' + ymd(d);
    if (now >= at.getTime() && !notified[key]) { notified[key] = now; fresh.push({key, at: at.getTime(), type: 'daily', title: DAILY_TITLE, body: DAILY_BODY, review: true}); }
  }
  await set('notified', notified);
  if (!fresh.length) return;
  // дописуємо у стрічку сповіщень застосунку
  let feed = (await get('feed')) || [];
  for (const it of fresh) if (!feed.some(f => f.key === it.key)) feed.unshift({key: it.key, type: it.type, title: it.title, body: it.body, goalId: it.goalId || null, at: Math.min(now, it.at), read: false});
  feed.sort((a, b) => b.at - a.at); await set('feed', feed.slice(0, 60));
  for (const it of fresh) await self.registration.showNotification(it.title, {body: it.body, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: it.key, data: {goalId: it.goalId, review: !!it.review, resched: !!it.resched}});
  (await self.clients.matchAll({type: 'window'})).forEach(c => c.postMessage({feedChanged: true}));
}
self.addEventListener('periodicsync', e => { if (e.tag === 'deadline-check') e.waitUntil(check()); });

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const goalId = data.goalId, review = data.review, resched = data.resched;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    if (all.length) {
      const c = all[0];
      await c.focus();
      if (review) c.postMessage({openReview: true});
      else if (goalId) c.postMessage({openGoal: goalId, resched: !!resched});
      return;
    }
    await self.clients.openWindow('./' + (review ? '?review=1' : goalId ? '?goal=' + encodeURIComponent(goalId) + (resched ? '&resched=1' : '') : ''));
  })());
});
