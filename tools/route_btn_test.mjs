/* 道案内ボタン（カードの右端の青い丸。Googleマップの経路へ）の回帰テスト。DOM不要。

   壊れ方は3つあり、どれも画面では「たまたま出ない／たまたま違う場所へ案内する」としか見えない。
     1. 出してはいけないところに出る — 行き先が1か所に決まらないカード（複数会場・チェーン名・
        同時開催のまとめカード）や、座標が分からない会場。別の場所へ案内すると実害がある
     2. 出すべきところに出ない       — 名簿にだけ座標がある会場、館内の表記ゆれ
     3. リンクが壊れている           — 座標が不正、新しいタブで開かない、タイトルの引用符でHTMLが崩れる

   前半は合成した名簿で規則そのものを、後半は実データの全カードで「描ける・URLが正しい」を見る。

   使い方（リポジトリのルートから）:
     node tools/route_btn_test.mjs
*/

import fs from "node:fs";

const SYNTH = new Map();
globalThis.fetch = async (p) => {
  const path = String(p).replace(/^\.\//, "");
  const text = SYNTH.has(path)
    ? SYNTH.get(path)
    : fs.existsSync(path)
      ? fs.readFileSync(path, "utf8")
      : null;
  if (text == null)
    return { ok: false, status: 404, headers: { get: () => null } };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const els = new Map();
const el = (k) => {
  if (!els.has(k))
    els.set(k, {
      hidden: true,
      textContent: "",
      innerHTML: "",
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute() {},
    });
  return els.get(k);
};
globalThis.document = {
  getElementById: el,
  querySelector: el,
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.window = {
  matchMedia: () => ({ matches: true }),
  addEventListener() {},
};

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}${detail ? "  — " + detail : ""}`,
  );
  if (!ok) failures.push(name);
};

const D = await import("../assets/js/data.js");
const C = await import("../assets/js/cards.js");
const ST = await import("../assets/js/state.js");
const { TABS } = await import("../assets/js/config.js");

/* ---------- 合成した名簿 ---------- */
SYNTH.set(
  "data/spots.csv",
  [
    "name,kind,pref,area,lat,lng,url,parking,status",
    "座標あり館,museum,tokyo,東京都・港区,35.6,139.7,,,active",
    "座標なし館,museum,tokyo,東京都・港区,,,,,active",
    "別の館,museum,tokyo,東京都・港区,35.7,139.8,,,active",
  ].join("\n"),
);
SYNTH.set(
  "data/venues.csv",
  "venue,kind,pref,area,capacity,lat,lng,url,parking,status\n",
);
SYNTH.set(
  "data/theaters.csv",
  [
    "chain,name,pref,area,lat,lng,url,parking,status",
    "チェーン劇場,チェーン劇場A店,tokyo,東京都・豊島区,35.1,139.1,,,active",
    "チェーン劇場,チェーン劇場B店,tokyo,東京都・新宿区,35.2,139.2,,,active",
    ",単館座,tokyo,東京都・豊島区,35.3,139.3,,,active",
  ].join("\n"),
);
await Promise.all([D.loadSpots(), D.loadTheaters(), D.loadVenues()]);

console.log("\n--- 行き先の決まり方（合成した名簿） ---");
const url = (it, merged) => C.routeUrl(it, merged);
const dest = (lat, lng) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
check(
  "行自身の座標があればそれを使う（名簿より優先）",
  url({ venue: "座標あり館", lat: 35.1234, lng: 139.5678 }) ===
    dest(35.1234, 139.5678),
);
check(
  "行に座標が無くても、名簿の座標で出る（イベント施設）",
  url({ venue: "座標あり館" }) === dest(35.6, 139.7),
);
check(
  "館内の表記ゆれ（区切り＋部屋名）も名簿の座標に寄る",
  url({ venue: "座標あり館 ホールA" }) === dest(35.6, 139.7),
);
check(
  "単館の映画館は名簿の座標で出る",
  url({ venues: ["単館座"] }) === dest(35.3, 139.3),
);
check(
  "名簿に座標が無い会場には出さない",
  url({ venue: "座標なし館" }) === null,
);
check(
  "名簿に無い会場には出さない",
  url({ venue: "どこにもない会場" }) === null,
);
check(
  "会場が空・「-」なら出さない",
  url({ venue: "" }) === null &&
    url({ venue: "-" }) === null &&
    url({}) === null,
);
check(
  "複数会場の行は、座標があっても出さない（どちらへ案内するか決められない）",
  url({ venues: ["座標あり館", "別の館"], lat: 35.6, lng: 139.7 }) === null,
);
check(
  "チェーン名の行は出さない（どの店舗か決められない）",
  url({ venues: ["チェーン劇場"] }) === null,
);
check(
  "同時開催でまとめたカードには出さない",
  url({ venue: "座標あり館", lat: 35.6, lng: 139.7 }, true) === null,
);
check(
  "不正な座標（範囲外・数でない）は出さない",
  url({ venue: "座標なし館", lat: 999, lng: 139 }) === null &&
    url({ venue: "座標なし館", lat: NaN, lng: 139 }) === null &&
    url({ venue: "座標なし館", lat: 35, lng: 999 }) === null,
);
check(
  "座標が片方だけの行は、名簿で補えなければ出さない",
  url({ venue: "座標なし館", lat: 35.6 }) === null,
);

console.log("\n--- カードの描画（合成した行） ---");
{
  const tab = TABS.event;
  const st = ST.STATES.event;
  const base = {
    key: "k1",
    title: "ふつうの催し",
    venue: "座標あり館",
    area: "東京都・港区",
    cats: [],
  };
  const h = C.cardHtml(tab, base, st, []);
  const a = h.match(/<a class="act-btn route-btn"[^>]*>/)?.[0] || "";
  check("道案内ボタンが出る", a !== "");
  check(
    "リンク先は Google マップの経路（出発地なし＝現在地）",
    a.includes(
      'href="https://www.google.com/maps/dir/?api=1&amp;destination=35.6,139.7"',
    ) ||
      a.includes(
        'href="https://www.google.com/maps/dir/?api=1&destination=35.6,139.7"',
      ),
    a,
  );
  check(
    "新しいタブで開き、opener を渡さない",
    /target="_blank"/.test(a) && /rel="noopener noreferrer"/.test(a),
  );
  check(
    "名前（aria-label）に催しの名前と行き先の種類が入る",
    /aria-label="ふつうの催しの会場への行き方をGoogleマップで見る/.test(a),
  );
  check(
    "操作の列の右端（カレンダーの後ろ）に置く",
    h.indexOf("route-btn") > h.indexOf('data-act="share"'),
  );
  check(
    "「公式サイトで確認する」など他のボタンを巻き込まない",
    (h.match(/class="act-btn/g) || []).length >= 3,
  );

  const quote = C.cardHtml(
    tab,
    { ...base, title: '"><img src=x onerror=alert(1)>' },
    st,
    [],
  );
  check(
    "タイトルに引用符・タグがあってもHTMLが崩れない（エスケープされる）",
    !/<img src=x/.test(quote) && /route-btn/.test(quote),
  );

  const none = C.cardHtml(tab, { ...base, venue: "座標なし館" }, st, []);
  check("行き先が分からないカードには出ない", !/route-btn/.test(none));

  const merged = C.cardHtml(
    tab,
    base,
    st,
    [],
    [base, { ...base, key: "k2", venue: "別の館" }],
  );
  check("同時開催のまとめカードには出ない", !/route-btn/.test(merged));
}

/* ---------- 実データ ---------- */
console.log("\n--- 実データ ---");
SYNTH.clear();
await Promise.all([D.loadSpots(), D.loadTheaters(), D.loadVenues()]);
for (const k of ["event", "movie", "live"]) await D.loadTab(k);

for (const k of ["event", "movie", "live"]) {
  const tab = TABS[k];
  const st = ST.STATES[k];
  let cards = 0;
  let withBtn = 0;
  let broken = 0;
  let mismatch = 0;
  const bad = [];
  for (const it of D.ITEMS[k]) {
    let h;
    try {
      h = C.cardHtml(tab, it, st, []);
    } catch (e) {
      broken++;
      bad.push(`${it.title}: ${e.message}`);
      continue;
    }
    cards++;
    const m = h.match(/<a class="act-btn route-btn" href="([^"]*)"/);
    const want = C.routeUrl(it);
    if (!!m !== !!want) mismatch++;
    if (!m) continue;
    withBtn++;
    const u = new URL(m[1].replaceAll("&amp;", "&"));
    const [lat, lng] = (u.searchParams.get("destination") || "").split(",");
    const ok =
      u.origin === "https://www.google.com" &&
      u.pathname === "/maps/dir/" &&
      u.searchParams.get("api") === "1" &&
      Number(lat) > 33 &&
      Number(lat) < 39 &&
      Number(lng) > 137 &&
      Number(lng) < 142;
    if (!ok) bad.push(`${it.title}: ${m[1]}`);
  }
  check(
    `${tab.label || k}: 全カードが描ける`,
    broken === 0 && cards === D.ITEMS[k].length,
    bad.slice(0, 3).join(" / "),
  );
  check(
    `${tab.label || k}: 道案内ボタンが出るカードがある`,
    withBtn > 0,
    `${withBtn}/${cards}件`,
  );
  check(
    `${tab.label || k}: URLがすべて関東の座標の Google マップ経路`,
    bad.length === 0,
    bad.slice(0, 3).join(" / "),
  );
  check(
    `${tab.label || k}: ボタンの有無が routeUrl と一致する`,
    mismatch === 0,
  );
}

console.log(
  failures.length
    ? `\n失敗 ${failures.length}件:\n  - ${failures.join("\n  - ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
