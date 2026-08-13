/* Service Worker。
   このサイトの信頼性は「最終更新日」の正しさに乗っているので、
   古いデータを黙って見せないことを最優先にする。

     - データCSV/JSON … ネットワーク優先。取れたら必ずそれを使い、キャッシュも更新する。
                         取れなかったときだけキャッシュを返し、ページ側に
                         「オフライン表示中」を出すためのヘッダーを付ける。
     - アプリ本体      … キャッシュ優先＋裏で更新。新しい版ができても勝手に
                         入れ替えず、ページ側で再読み込みを促す。

   バージョンを上げると古いキャッシュを捨てる。本体ファイルを変えたら上げること。 */

/* 本体（SHELL）を変えたらこの値を上げること。**上げ忘れると更新が届かない。**
   ブラウザが新しい Service Worker に気づくのは sw.js 自身のバイト列が変わったときだけで、
   VERSION が据え置きのままだと `updatefound` が発火せず、main.js の自動入れ替え
   （設計書 第15.14節）が動かない。SHELL はキャッシュ優先なので、開き直した人には
   前回のキャッシュがそのまま返り、新しいJSは「次の次の訪問」まで反映されない。 */
const VERSION = "v11";
const SHELL_CACHE = `eventboard-shell-${VERSION}`;
const DATA_CACHE = `eventboard-data-${VERSION}`;

const SHELL = [
  "./",
  "./index.html",
  "./terms.html",
  "./privacy.html",
  "./manifest.webmanifest",
  "./assets/app.css",
  "./assets/js/main.js",
  "./assets/js/util.js",
  "./assets/js/csv.js",
  "./assets/js/config.js",
  "./assets/js/schedule.js",
  "./assets/js/data.js",
  "./assets/js/state.js",
  "./assets/js/filters.js",
  "./assets/js/cards.js",
  "./assets/js/render.js",
  "./assets/js/ui-popover.js",
  "./assets/js/ui-calendar.js",
  "./assets/js/ui-area.js",
  "./assets/js/ui-map.js",
  "./assets/js/ui-lineup.js",
  "./assets/js/ui-controls.js",
  "./assets/vendor/leaflet/leaflet.js",
  "./assets/vendor/leaflet/leaflet.css",
  "./assets/favicon.svg",
  "./assets/favicon-32.png",
  "./assets/apple-touch-icon.png",
];

const isData = (url) => /\/data\/[^/]+\.(csv|json)$/.test(url.pathname);

self.addEventListener("install", (e) => {
  // 1つでも欠けると install ごと失敗するので、個別に入れて落とさない
  e.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.all(SHELL.map((u) => cache.add(u).catch(() => null))),
      ),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (k) =>
              k.startsWith("eventboard-") &&
              k !== SHELL_CACHE &&
              k !== DATA_CACHE,
          )
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

/** キャッシュから返すときに、ページ側が「オフライン表示中」と気づけるようにする。 */
function markFromCache(res) {
  const headers = new Headers(res.headers);
  headers.set("X-From-Cache", "1");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: false });
    if (hit) return markFromCache(hit);
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const fetching = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return (
    hit || fetching.then((res) => res || Promise.reject(new Error("offline")))
  );
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // 別オリジン（フォント・地図タイル）はそのまま通す。
  // OpenStreetMap のタイル利用ポリシー上、タイルをまとめて溜め込むことはしない。
  if (url.origin !== self.location.origin) return;

  if (isData(url)) {
    e.respondWith(networkFirst(req));
    return;
  }
  e.respondWith(staleWhileRevalidate(req));
});
