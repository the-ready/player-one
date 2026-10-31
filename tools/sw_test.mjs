/* Service Worker（sw.js）の取得のしかたの回帰テスト。ブラウザ不要。

   固定するのは1点：本体（SHELL）を取りに行くとき、ブラウザの HTTP キャッシュに答えさせないこと。
   GitHub Pages の応答は max-age=600 なので、デプロイから10分以内に開いた人は、fetch が HTTP キャッシュに
   残った古い HTML・JS を返す。それを新しい版のキャッシュに入れると、index.html と main.js の版が
   食い違って起動に失敗する（VERSION を上げても直らない）。画面では「たまに起動しない」としか見えない。
     install       … cache: "reload"（新しい版の最初の中身なので、必ず取り直す）
     裏の再取得     … cache: "no-cache"（毎回サーバーに確かめる。変わっていなければ 304 で軽い）
   データ（CSV/JSON）は元のリクエストをそのまま渡す（ページ側が cache: "no-cache" を指定している）。

   sw.js を最小の偽の self で読み込み、install と fetch のイベントを流して、渡されたリクエストを見る。
   ナビゲーション（navigate）のリクエストを作り直しても落ちないことは、ブラウザでしか確かめられない
   ので、ここでは Request の作り直しが失敗したときに元のリクエストで取ること（起動できることを優先）を見る。

   使い方（リポジトリのルートから）:
     node tools/sw_test.mjs
*/

import fs from "node:fs";
import vm from "node:vm";

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}${detail ? "  — " + detail : ""}`,
  );
  if (!ok) failures.push(name);
};

const ORIGIN = "https://example.test";
const src = fs.readFileSync("sw.js", "utf8");

/* Service Worker の中では、new Request("./x") の相対パスは sw.js の位置で解決される。Node の Request は
   絶対 URL しか受け付けないので、その解決だけを足した Request で試す。 */
class SwRequest extends Request {
  constructor(input, init) {
    super(
      typeof input === "string"
        ? new URL(input, `${ORIGIN}/sw.js`).href
        : input,
      init,
    );
  }
}

/* 偽のブラウザ環境。cache.add / cache.put / fetch に渡されたものを記録する。 */
function boot({ RequestImpl = SwRequest } = {}) {
  const handlers = {};
  const added = [];
  const put = [];
  const fetched = [];
  const store = new Map();
  const cache = {
    add: async (r) => {
      added.push(r);
    },
    put: async (r, res) => {
      put.push([r, res]);
    },
    match: async (r) => store.get(typeof r === "string" ? r : r.url),
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
    clients: { claim: async () => {} },
    skipWaiting() {},
  };
  const ctx = vm.createContext({
    self,
    URL,
    Headers,
    Response,
    Request: RequestImpl,
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async (r) => {
      fetched.push(r);
      return new Response("body", { status: 200 });
    },
    Promise,
  });
  vm.runInContext(src, ctx);
  return { handlers, added, put, fetched, store };
}

async function dispatchInstall(h) {
  let waited;
  h.handlers.install({ waitUntil: (p) => (waited = p) });
  await waited;
}
async function dispatchFetch(h, req) {
  let responded;
  h.handlers.fetch({ request: req, respondWith: (p) => (responded = p) });
  const res = await responded;
  // 裏の再取得（キャッシュへの put）が済むまで待つ
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

/* ---------- install ---------- */
console.log("\n--- install ---");
{
  const h = boot();
  await dispatchInstall(h);
  const shell = [...src.matchAll(/^\s+"(\.\/[^"]*)",$/gm)].map((m) => m[1]);
  check("SHELL を読み取れる", shell.length > 30, String(shell.length));
  check(
    "SHELL の全ファイルを cache.add に渡す",
    h.added.length === shell.length,
    `${h.added.length} / ${shell.length}`,
  );
  check(
    "どれも Request で、HTTP キャッシュを使わない（cache: reload）",
    h.added.every((r) => typeof r !== "string" && r.cache === "reload"),
    [...new Set(h.added.map((r) => r.cache))].join(),
  );
  check(
    "取りに行く先は SHELL と同じ（相対パスが sw.js の位置で解決される）",
    h.added.every((r) => r.url.startsWith(ORIGIN + "/")),
    h.added[0]?.url,
  );
}

/* ---------- 裏の再取得 ---------- */
console.log("\n--- 本体の裏の再取得（キャッシュ優先＋裏で更新） ---");
{
  const h = boot();
  const req = new Request(`${ORIGIN}/assets/js/main.js`);
  await dispatchFetch(h, req);
  check("本体は fetch を1回行う", h.fetched.length === 1);
  check(
    "HTTP キャッシュに答えさせない（cache: no-cache）",
    h.fetched[0]?.cache === "no-cache",
    h.fetched[0]?.cache,
  );
  check("同じ URL を取りに行く", h.fetched[0]?.url === req.url);
  check(
    "キャッシュへ入れるキーは元のリクエスト（作り直したものではない）",
    h.put.length === 1 && h.put[0][0] === req,
  );
}

/* ---------- データ（CSV/JSON）は触らない ---------- */
console.log("\n--- データはネットワーク優先で、リクエストを作り直さない ---");
{
  const h = boot();
  const req = new Request(`${ORIGIN}/data/events.csv`, { cache: "no-cache" });
  await dispatchFetch(h, req);
  check("データは元のリクエストをそのまま渡す", h.fetched[0] === req);
}

/* ---------- Request を作り直せないとき ---------- */
console.log("\n--- Request を作り直せない環境 ---");
{
  // 作り直し（new Request(req, init)）だけが投げる偽の Request。単独の生成は通る
  class StrictRequest extends SwRequest {
    constructor(input, init) {
      if (input instanceof Request && init) throw new TypeError("unsupported");
      super(input, init);
    }
  }
  const h = boot({ RequestImpl: StrictRequest });
  const req = new StrictRequest(`${ORIGIN}/index.html`);
  let threw = null;
  try {
    await dispatchFetch(h, req);
  } catch (e) {
    threw = e;
  }
  check("落ちずに応答する", !threw, String(threw));
  check("元のリクエストで取る（鮮度より起動を優先）", h.fetched[0] === req);
}

console.log(
  failures.length
    ? `\n${failures.length} 件が失敗しました: ${failures.join(" / ")}`
    : "\nすべて通りました",
);
process.exit(failures.length ? 1 : 0);
