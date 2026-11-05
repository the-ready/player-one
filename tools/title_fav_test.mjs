/* 行きたい（♡）をタイトルの行頭（左端）へ、駐車場（P）を会場名の右へ置いた配置の回帰テスト。DOM不要。

   壊れ方は3つあり、どれも見た目か押し間違いにしか現れない。
     1. ♡が操作の列に戻る／タイトルの外に出る／行頭から外れる — ★・人のボタンと同じ「名前の隣」の並びと、
        どのカードでも同じ場所（左端）にある、が崩れる
     2. P がタイトルに残る／会場名から離れる   — 車で行けるかは場所の事実なので会場の隣に置く
     3. ♡が行頭の箱（.title-fav）から外れる   — 折り返した行が♡の下へ回り込まなくなる／枠だけが行をまたぐ
        （CSS の .title-fav / .fav-btn と cards.js の favBtnHtml）
        ♡は四角い枠のミニボタン（.fav-btn）。枠の見た目は app.css とブラウザで確かめる

   前半は合成した行でHTMLの形を、後半は実データの全カードで「♡がちょうど1つ・Pの位置」を見る。
   見た目（折り返しの隙間・上下のずれ）はブラウザでしか確かめられないので、smoke_test.mjs と
   手元の確認に任せる。

   使い方（リポジトリのルートから）:
     node tools/title_fav_test.mjs
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

SYNTH.set(
  "data/spots.csv",
  [
    "name,kind,pref,area,lat,lng,url,parking,status",
    "Pあり館,museum,tokyo,東京都・港区,35.6,139.7,,yes,active",
    "近隣館,museum,tokyo,東京都・港区,35.7,139.8,,nearby,active",
    "未確認館,museum,tokyo,東京都・港区,35.8,139.9,,,active",
  ].join("\n"),
);
SYNTH.set(
  "data/venues.csv",
  "venue,kind,pref,area,capacity,lat,lng,url,parking,status\n",
);
SYNTH.set(
  "data/theaters.csv",
  "chain,name,pref,area,lat,lng,url,parking,status\n",
);
await Promise.all([D.loadSpots(), D.loadTheaters(), D.loadVenues()]);

const tab = TABS.event;
const st = ST.STATES.event;
const base = (o) => ({
  key: "k1",
  title: "ふつうの催し",
  venue: "Pあり館",
  area: "東京都・港区",
  cats: [],
  ...o,
});
const title = (h) => h.match(/<h3 class="title">(.*?)<\/h3>/s)?.[1] || "";
const meta = (h) => h.match(/<p class="meta">(.*?)<\/p>/s)?.[1] || "";

console.log("\n--- ♡の位置（合成した行） ---");
{
  const h = C.cardHtml(tab, base(), st, []);
  const t = title(h);
  check(
    "♡はタイトルの中の箱（.title-fav）に入る",
    /<span class="title-fav"><button type="button" class="fav-btn" data-act="fav"/.test(
      t,
    ),
    t.slice(-160),
  );
  check(
    "♡はタイトルの文字より前（行頭）にある",
    t.startsWith('<span class="title-fav">') &&
      t.indexOf("title-fav") < t.indexOf("ふつうの催し"),
  );
  check(
    "操作の列（.card-actions）には♡が無い",
    !/<div class="card-actions">[^]*data-act="fav"[^]*<\/div>/.test(
      h.match(/<div class="card-actions">.*?<\/div>/s)?.[0] || "",
    ),
  );
  check(
    "♡は文字を持たず（アイコンだけ）、名前は aria-label で伝える",
    />\s*<svg[^]*<\/svg>\s*<\/button>/.test(t) &&
      /aria-label="ふつうの催しを行きたいリストに追加する"/.test(t),
  );
  check("未登録は aria-pressed=false", /aria-pressed="false"/.test(t));
  check(
    "♡の箱は幅を持つ箱のまま（幅ゼロ用の ZWSP を残していない）",
    !/&#8203;/.test(t) && /<\/button><\/span>/.test(t),
  );

  check(
    "♡はタイトルの1か所だけ（カード全体で1つ）",
    (h.match(/data-act="fav"/g) || []).length === 1,
  );
}
{
  ST.toggleFav(base());
  const t = title(C.cardHtml(tab, base(), st, []));
  check(
    "登録済みは aria-pressed=true・外す名前になる",
    /aria-pressed="true"/.test(t) && /登録済み。外す/.test(t),
  );
  ST.toggleFav(base());
}
{
  // タイトルが記号・タグ風の文字を含んでも、♡のHTMLが崩れない
  const t = title(
    C.cardHtml(tab, base({ title: '"><b>強調</b> & 検索' }), st, []),
  );
  check(
    "タイトルのHTML特殊文字はエスケープされ、♡は残る",
    !/<b>強調/.test(t) && /class="fav-btn"/.test(t),
  );
}

console.log("\n--- P の位置（合成した行） ---");
{
  const h = C.cardHtml(tab, base(), st, []);
  check("タイトルには P を付けない", !/class="pk/.test(title(h)));
  const m = meta(h);
  check("P は会場の行（.meta）にある", /class="pk yes"/.test(m));
  check(
    "P は会場名のすぐ右・エリアの前にある",
    m.indexOf("Pあり館") < m.indexOf("pk yes") &&
      m.indexOf("pk yes") < m.indexOf("／東京都・港区"),
    m,
  );
  const near = meta(C.cardHtml(tab, base({ venue: "近隣館" }), st, []));
  check("近隣は P 近隣として会場の行に出る", /class="pk nearby"/.test(near));
  const none = C.cardHtml(tab, base({ venue: "未確認館" }), st, []);
  check(
    "駐車場が未確認の会場には何も出さない",
    !/class="pk/.test(meta(none)) && !/class="pk/.test(title(none)),
  );
  const temp = C.cardHtml(
    tab,
    base({ venue: "未確認館", eventParking: "temp" }),
    st,
    [],
  );
  check(
    "臨時駐車場（その日の事情）も会場の行に出る",
    /class="pk temp"/.test(meta(temp)),
  );
  const noVenue = C.cardHtml(
    tab,
    base({ venue: "", eventParking: "temp" }),
    st,
    [],
  );
  check(
    "会場が空でも、臨時駐車場があれば行に出る（エリアの隣）",
    /class="pk temp"/.test(meta(noVenue)),
  );
}

console.log("\n--- 同時開催のまとめカード ---");
{
  const a = base({ key: "m1", venue: "Pあり館" });
  const b = base({ key: "m2", venue: "近隣館" });
  const h = C.cardHtml(tab, a, st, [], [a, b]);
  check("♡はまとめたカードのタイトルにも1つ出る", /title-fav/.test(title(h)));
  check("タイトルには P を付けない", !/class="pk/.test(title(h)));
  check(
    "施設ごとの P は施設の並びに出る（2つ）",
    (h.match(/<ul class="fac-list">.*?<\/ul>/s)?.[0].match(/class="pk /g) || [])
      .length === 2,
  );
}

console.log("\n--- 実データ ---");
SYNTH.clear();
await Promise.all([D.loadSpots(), D.loadTheaters(), D.loadVenues()]);
for (const k of ["event", "movie", "live"]) await D.loadTab(k);
for (const k of ["event", "movie", "live"]) {
  const tb = TABS[k];
  const s = ST.STATES[k];
  let cards = 0;
  const bad = [];
  let pInTitle = 0;
  let pCards = 0;
  let pOutsideMeta = 0;
  for (const it of D.ITEMS[k]) {
    const h = C.cardHtml(tb, it, s, []);
    cards++;
    const t = title(h);
    const favInTitle = (t.match(/data-act="fav"/g) || []).length;
    const favTotal = (h.match(/data-act="fav"/g) || []).length;
    if (favInTitle !== 1 || favTotal !== 1) bad.push(it.title);
    if (/class="pk/.test(t)) pInTitle++;
    if (/class="pk/.test(meta(h))) pCards++;
    if (/class="pk/.test(h) && !/class="pk/.test(meta(h)) && !/vd-park/.test(h))
      pOutsideMeta++;
  }
  const label = tb.label || k;
  check(
    `${label}: 全カードで ♡ がタイトルの中にちょうど1つ`,
    bad.length === 0 && cards === D.ITEMS[k].length,
    bad.slice(0, 3).join(" / "),
  );
  check(`${label}: タイトルに P が残っていない`, pInTitle === 0);
  check(
    `${label}: P は会場の行に出ている`,
    k === "live" || pCards > 0,
    `${pCards}枚`,
  );
  check(`${label}: P が会場の行の外に単独で出ない`, pOutsideMeta === 0);
}

console.log(
  failures.length
    ? `\n失敗 ${failures.length}件:\n  - ${failures.join("\n  - ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
