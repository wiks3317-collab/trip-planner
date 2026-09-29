// ============================================================
// v21p6：Service Worker —— 讓網站本身在沒有網路時也能打開
//
// 只負責「網站程式檔」的快取（HTML／JS／CSS／Firebase 模組／字型）。
// 行程資料的離線存取由 Firestore 自己的本機快取處理（見 firebase-config.js），這裡完全不碰。
//
// 快取策略：
//   - 帶 ?v= 版本號的檔案（boot.js?v=21p6 等）：快取優先（版本號一變就是新網址，不會拿到舊檔）
//   - 其他同網域檔案（index.html、style.css、firebase-*.js…）：網路優先，
//     超過 3 秒沒回應（訊號很差）或斷網就用快取
//   - gstatic 上固定版本的 Firebase 模組：快取優先
//   - Google Fonts：先用快取、背景更新
//   - 其他一律不攔截：Firestore／Auth 連線、使用者貼的圖片網址、管理後台（admin*）
//
// ⚠️ 每次發新版時，請同步修改下面的 VERSION（與 index.html／boot.js 的 ?v= 一致），
//    瀏覽器才會發現 sw.js 有更新、換上新的快取。
// ============================================================
const VERSION = "21p6";
const APP_CACHE = "trip-app-" + VERSION;
const LIB_CACHE = "trip-lib-1";
const NETWORK_TIMEOUT_MS = 3000;

const FIREBASE_BASE = "https://www.gstatic.com/firebasejs/10.13.0/";
const FIREBASE_ENTRIES = ["firebase-app.js", "firebase-firestore.js", "firebase-auth.js", "firebase-app-check.js"];
const APP_SHELL = [
  "./",
  "./index.html",
  "./boot.js?v=" + VERSION,
  "./app.js?v=" + VERSION,
  "./firebase-config.js",
  "./firebase-options.js",
  "./style.css",
  "./manifest.webmanifest",
  "./icon-192.png",
];

// 讀入一個 Firebase 模組，並順著它 import 的其他模組一路存下來（用正規表示式找 import 網址）
async function cacheModuleGraph(url, cache, seen) {
  if (seen.has(url) || seen.size > 80) return;
  seen.add(url);
  let res;
  try { res = await fetch(url, { mode: "cors" }); } catch (e) { return; }
  if (!res || !res.ok) return;
  await cache.put(url, res.clone());
  let text = "";
  try { text = await res.text(); } catch (e) { return; }
  const re = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+\.js)["']/g;
  const next = [];
  let m;
  while ((m = re.exec(text))) {
    let abs;
    try { abs = new URL(m[1], url).href; } catch (e) { continue; }
    if (abs.indexOf(FIREBASE_BASE) === 0) next.push(abs);
  }
  await Promise.all(next.map((u) => cacheModuleGraph(u, cache, seen)));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const app = await caches.open(APP_CACHE);
    await Promise.all(APP_SHELL.map((u) => app.add(new Request(u, { cache: "reload" })).catch(() => {})));
    const lib = await caches.open(LIB_CACHE);
    const seen = new Set();
    await Promise.all(FIREBASE_ENTRIES.map((f) => cacheModuleGraph(FIREBASE_BASE + f, lib, seen)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.indexOf("trip-app-") === 0 && k !== APP_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const update = fetch(req).then((res) => {
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  if (hit) { update.catch(() => {}); return hit; }
  return update;
}

async function networkFirst(req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  let cached = await cache.match(req);
  if (!cached && req.mode === "navigate") cached = await cache.match("./index.html");
  const network = fetch(req).then((res) => {
    if (res && res.ok) { cache.put(req, res.clone()).catch(() => {}); return res; }
    return cached || res;
  });
  if (!cached) return network; // 沒有快取可退，只能等網路
  network.catch(() => {});
  return Promise.race([
    network.catch(() => cached),
    new Promise((resolve) => setTimeout(() => resolve(cached), timeoutMs)),
  ]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (/\/admin[^/]*$/.test(url.pathname)) return; // 管理後台永遠走網路，不快取
    if (url.searchParams.has("v")) event.respondWith(cacheFirst(req, APP_CACHE));
    else event.respondWith(networkFirst(req, APP_CACHE, NETWORK_TIMEOUT_MS));
    return;
  }
  if (url.href.indexOf(FIREBASE_BASE) === 0) {
    event.respondWith(cacheFirst(req, LIB_CACHE));
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(req, LIB_CACHE));
  }
  // 其餘（Firestore、Auth、使用者圖片…）不攔截
});
