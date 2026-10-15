/* バーゲン（cats=sale）の表示規則の回帰テスト。DOM不要。

   セールは「予約して行く催し」とは違うので、次を固定する。
     1. 同じ series_id・同じ会期の施設は、描くとき1枚にまとめる（会期が1日でも違えばまとめない）
     2. まとめたあとも、絞り込み・★・並び順が正しく効く
     3. 言い回し（「セール情報を見る」「開催予定」）がカテゴリ単位で上書きされる
     4. 料金の空欄が「無料」に混ざらない

   実データには（収集がまだ載せていない）セールの行が無いので、合成したCSVで見る。

   使い方（リポジトリのルートから）:
     node tools/sale_group_test.mjs
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
const S = await import("../assets/js/spots.js");
const ST = await import("../assets/js/state.js");
const F = await import("../assets/js/filters.js");
const { TABS, CATS, catWording } = await import("../assets/js/config.js");
const R = await import("../assets/js/render.js");
const { parseCsvObjects } = await import("../assets/js/csv.js");

/* ---------- 合成データ ---------- */
const realHead = fs.readFileSync("data/events.csv", "utf8").split(/\r?\n/)[0];
const COLS = realHead.split(",").map((c) => c.replace(/"/g, ""));
const day = (n) => {
  const d = new Date(D.TODAY() + "T00:00:00");
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
let nextId = 1;
function evRow(o) {
  const r = {
    id: nextId++,
    cats: "sale",
    pref: "tokyo",
    source: "公式サイト",
    ...o,
  };
  return COLS.map((c) => q(r[c])).join(",");
}

const MOP = [
  ["三井アウトレットパーク 木更津", "chiba", "千葉県・木更津市"],
  ["三井アウトレットパーク 入間", "saitama", "埼玉県・入間市"],
  ["三井アウトレットパーク 幕張", "chiba", "千葉県・千葉市美浜区"],
  ["三井アウトレットパーク 多摩南大沢", "tokyo", "東京都・八王子市"],
  [
    "三井アウトレットパーク 横浜ベイサイド",
    "kanagawa",
    "神奈川県・横浜市金沢区",
  ],
];
const LALA = [
  ["ららぽーとTOKYO-BAY", "chiba", "千葉県・船橋市", 22, 30],
  ["ららぽーと海老名", "kanagawa", "神奈川県・海老名市", 23, 31], // 会期が1日ずつ違う
  ["ららぽーと新三郷", "saitama", "埼玉県・三郷市", 22, 30],
];

const rows = [];
MOP.forEach(([venue, pref, area], i) =>
  rows.push(
    evRow({
      title: "三井アウトレットパーク BLACK FRIDAY",
      venue,
      pref,
      area,
      series_id: "mop-bf-2026",
      start_date: day(20),
      end_date: day(36),
      lat: 35.5 + i * 0.1,
      lng: 139.5 + i * 0.1,
      url: `https://example.com/mop/${i}`,
      desc: "関東の三井アウトレットパーク全施設で行う全館セール。参加店舗と割引率は店舗ごとに異なる。",
    }),
  ),
);
LALA.forEach(([venue, pref, area, s, e], i) =>
  rows.push(
    evRow({
      title: "ららぽーと BLACK FRIDAY",
      venue,
      pref,
      area,
      series_id: "lala-bf-2026",
      start_date: day(s),
      end_date: day(e),
      lat: 35.6 + i * 0.1,
      lng: 139.6 + i * 0.1,
      url: `https://example.com/lala/${i}`,
      desc: "ららぽーとの全館セール。会期は施設ごとに異なる。",
    }),
  ),
);
// 開催中の、series_id が空のセール（まとめない）と、まとめない普通のイベント
rows.push(
  evRow({
    title: "ららぽーと 初売り（単独）",
    venue: "ららぽーと新三郷",
    pref: "saitama",
    area: "埼玉県・三郷市",
    start_date: day(-2),
    end_date: day(5),
    lat: 35.86,
    lng: 139.86,
    url: "https://example.com/solo",
    desc: "series_id を持たない単独のセール。",
  }),
);
rows.push(
  evRow({
    title: "同じ会期だが別のシリーズの展覧会",
    cats: "art",
    venue: "三井アウトレットパーク 入間",
    pref: "saitama",
    area: "埼玉県・入間市",
    series_id: "other-series",
    start_date: day(20),
    end_date: day(36),
    price: "入場無料",
    lat: 35.81,
    lng: 139.38,
    url: "https://example.com/other",
    desc: "セールではないので、同じ会期でもまとめない。",
  }),
);
SYNTH.set("data/events.csv", [realHead, ...rows].join("\r\n") + "\r\n");

const synthRoster = (header, lines) => [header, ...lines].join("\n");
SYNTH.set(
  "data/spots.csv",
  synthRoster("name,kind,pref,area,lat,lng,url,parking,status", [
    ...MOP.map(([n, p, a]) => `${n},mall,${p},${a},,,,yes,active`),
    ...LALA.map(
      ([n, p, a]) =>
        `${n},mall,${p},${a},,,,${n === "ららぽーと海老名" ? "" : "yes"},active`,
    ),
  ]),
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
await D.loadTab("event");

const html = () => els.get("list")?.innerHTML || "";
const draw = (reset = true) => {
  if (reset) ST.resetState("event");
  ST.setActiveTabKey("event");
};
const cardsIn = (h) =>
  [...h.matchAll(/<article class="card" data-key="([^"]+)"/g)].map((m) => m[1]);
const render = () => {
  ST.setActiveTabKey("event");
  R.renderList();
  return html();
};

/* ================= 1. 同時開催のまとめ ================= */
console.log("\n--- 同時開催のまとめ ---");
store.clear();
ST.loadFavSpots();
ST.loadFavView();
draw();
{
  const sale = D.ITEMS.event.filter((it) => it.cats.includes("sale"));
  check(
    "セールの行が cats=sale で読める",
    sale.length === 9,
    `${sale.length}行`,
  );
  const vis = R.visibleItems("event");
  const entries = F.mergeSimultaneous(vis);
  const mop = entries.find((e) => e.rep.seriesId === "mop-bf-2026");
  check(
    "同じ series_id・同じ会期の5施設が1枚にまとまる",
    mop && mop.members.length === 5,
    mop ? `${mop.members.length}施設` : "まとまらなかった",
  );
  check(
    "会期が1日でも違えば、同じ series_id でもまとめない（ららぽーと）",
    entries.filter((e) => e.rep.seriesId === "lala-bf-2026").length === 2 &&
      entries.some(
        (e) => e.rep.seriesId === "lala-bf-2026" && e.members.length === 2,
      ),
    "TOKYO-BAYと新三郷（同じ会期）は2施設、海老名は別",
  );
  check(
    "series_id が空なら、同じ会期でもまとめない",
    entries.some((e) => e.rep.title.includes("単独") && e.members.length === 1),
  );
  check(
    "セール以外は、同じ series_id・同じ会期でもまとめない",
    entries.filter((e) => e.rep.seriesId === "other-series").length === 1,
  );
  const total = entries.reduce((n, e) => n + e.members.length, 0);
  check(
    "まとめても行は欠けない（全員がどこかのカードに入る）",
    total === vis.length,
    `${total}/${vis.length}`,
  );
  check(
    "代表は並びの先頭の行（カードは先頭の位置に出る）",
    mop && mop.rep === vis.find((it) => it.seriesId === "mop-bf-2026"),
  );
}

console.log("\n--- 描かれたカード ---");
{
  const h = render();
  const ks = cardsIn(h);
  const vis = R.visibleItems("event");
  check(
    "カードの枚数 = 行数 −（まとめて減った枚数）",
    ks.length === vis.length - 4 - 1,
    `${ks.length}枚 / ${vis.length}行（アウトレット5→1、ららぽーと2→1）`,
  );
  check("「5施設で同時開催」の見出しが出る", h.includes("5施設で同時開催"));
  check(
    "「2施設で同時開催」（ららぽーと）も出る",
    h.includes("2施設で同時開催"),
  );
  check(
    "施設名は共通の先頭を落とした短い名前で並ぶ",
    h.includes(">木更津</button>") &&
      h.includes(">横浜ベイサイド</button>") &&
      !h.includes(">三井アウトレットパーク 木更津</button>"),
  );
  check(
    "各施設に★と、名簿が yes の施設には P バッジが出る",
    // 5施設のカードのほか、同じ入間の別カード（展覧会）の★も数に入るので「以上」で見る
    (h.match(/data-star="三井アウトレットパーク [^"]+"/g) || []).length >= 5 &&
      (h.match(/class="pk yes"/g) || []).length >= 5,
  );
  check(
    "まとめたカードのタイトルは1つ（施設の数だけ繰り返さない）",
    (h.match(/<h3 class="title">三井アウトレットパーク BLACK FRIDAY/g) || [])
      .length === 1,
  );
  check(
    "まとめたカードにはタイトル横の駐車場バッジが付かない（施設ごとに並ぶので）",
    !/<h3 class="title">三井アウトレットパーク BLACK FRIDAY<span class="pk/.test(
      h,
    ),
  );
}

/* ================= 2. 絞り込み・★・並び順との組み合わせ ================= */
console.log("\n--- 絞り込み・★ ---");
{
  draw();
  ST.STATES.event.pref = "chiba";
  let h = render();
  check(
    "千葉県で絞ると、アウトレットは木更津と幕張の2施設でまとまる",
    h.includes("2施設で同時開催") &&
      h.includes(">幕張</button>") &&
      !h.includes(">入間</button>"),
  );
  draw();
  ST.STATES.event.pref = "tokyo";
  h = render();
  check(
    "1施設だけが残ったら、まとめずに普通のカードで出す",
    !h.includes("施設で同時開催") || !h.includes("多摩南大沢</button></li>"),
  );
  check(
    "1施設のカードは通常の会場行（★・会場名・エリア）で出る",
    h.includes('data-star="三井アウトレットパーク 多摩南大沢"') &&
      h.includes("東京都・八王子市"),
  );

  // ★: アウトレットの1施設をお気に入りにすると、まとめたカードが先頭側に出る
  draw();
  ST.setFavSpot("三井アウトレットパーク 幕張", true);
  h = render();
  const favHead = h.indexOf("fav-head");
  const divider = h.indexOf("list-divider");
  const mopAt = h.indexOf("5施設で同時開催");
  check(
    "どれか1施設がお気に入りなら、まとめたカード全体が先頭セクションに出る",
    favHead >= 0 && mopAt > favHead && (divider === -1 || mopAt < divider),
  );
  check(
    "まとめたカードの中でも、お気に入りの施設が先頭に並ぶ",
    /<li class="is-fav">[^]*?幕張/.test(h.slice(mopAt, mopAt + 2500)),
  );
  check("見出しの件数は、まとめたカードを1件と数える", /1か所・1件/.test(h));
  check(
    "「★お気に入りスポットだけ」は、お気に入りの施設の行だけに絞る（まとめる相手が残らないので単独のカード）",
    (() => {
      ST.STATES.event.flags.favSpotOnly = true;
      const h2 = render();
      ST.STATES.event.flags.favSpotOnly = false;
      return (
        cardsIn(h2).length === 1 &&
        !h2.includes("施設で同時開催") &&
        h2.includes("幕張")
      );
    })(),
  );
  ST.setFavSpot("三井アウトレットパーク 幕張", false);
}

console.log("\n--- 並び順・日程 ---");
{
  draw();
  ST.STATES.event.rangeStart = day(20);
  ST.STATES.event.rangeEnd = day(22);
  let h = render();
  check(
    "日程で絞っても、会期が重なるアウトレットは1枚で出る",
    h.includes("5施設で同時開催") && cardsIn(h).length >= 1,
  );
  draw();
  ST.STATES.event.sortBy = "announced";
  h = render();
  check("新着順でも落ちずに描ける", h.includes("5施設で同時開催"));
}

/* ================= 3. 言い回し ================= */
console.log("\n--- 言い回し（カテゴリ単位の上書き） ---");
{
  draw();
  const sale = D.ITEMS.event.find((it) => it.seriesId === "mop-bf-2026");
  check(
    "まもなく始まる／まだ先のセールは「開催予定」（「発売中」と言わない）",
    sale.status === "開催予定",
    sale.status,
  );
  const ongoing = D.ITEMS.event.find((it) => it.title.includes("単独"));
  check(
    "開催中のセールは通常どおり「開催中」",
    ongoing.status === "開催中",
    ongoing.status,
  );
  const art = D.ITEMS.event.find((it) => it.seriesId === "other-series");
  check(
    "セール以外の「まだ先」は従来どおり「発売中」",
    art.status === "発売中" || art.status === "まもなく開催",
    art.status,
  );
  const h = render();
  check(
    "主ボタンは「公式サイトでセール情報を見る」（「予約する」と言わない）",
    h.includes("公式サイトでセール情報を見る") &&
      !/三井アウトレットパーク BLACK FRIDAY[^]*?公式サイトで予約する/.test(
        h
          .slice(0, h.indexOf("5施設で同時開催") + 4000)
          .split("</article>")[0] || "",
      ),
  );
  check(
    "セールのカテゴリバッジは「バーゲン・セール」",
    h.includes("バーゲン・セール"),
  );
  check(
    "CAT_WORDING は cats の先頭から引ける",
    catWording({ cats: ["sale", "ent"] }) && !catWording({ cats: ["ent"] }),
  );
  check(
    "「開催予定」は開催状況のチップにも出る（既知の値として扱われる）",
    TABS.event.facets
      .find((f) => f.id === "statuses")
      .keys(D.ITEMS.event)
      .includes("開催予定"),
  );
}

/* ================= 4. 料金・無料の絞り込み ================= */
console.log("\n--- 料金 ---");
{
  draw();
  ST.STATES.event.flags.freeOnly = true;
  const vis = R.visibleItems("event");
  check(
    "料金が空のセールは「無料のものだけ」に混ざらない（無料と書いたものだけが入る）",
    vis.length === 1 && vis[0].seriesId === "other-series",
    `${vis.length}件`,
  );
  const h = (() => {
    ST.resetState("event");
    return render();
  })();
  check(
    "セールのカードに料金の枠は出ない（空欄は何も出さない）",
    !/pc-label">料金<\/span>[^]{0,80}三井アウトレットパーク BLACK FRIDAY/.test(
      h,
    ),
  );
}

/* ================= 5. データ契約 ================= */
console.log("\n--- データ契約 ---");
{
  check(
    "CATS に sale がある",
    "sale" in CATS && CATS.sale.label === "バーゲン・セール",
  );
  const vd = fs.readFileSync("tools/validate_data.py", "utf8");
  check(
    "検証は config.js の CATS から許可集合を読む（sale は自動で許可される）",
    vd.includes('keys_of("CATS")'),
  );
  const parsed = parseCsvObjects(SYNTH.get("data/events.csv"));
  check(
    "合成CSVは実データと同じ列で、列数が揃っている",
    parsed.length === rows.length &&
      Object.keys(parsed[0]).length === COLS.length,
  );
}

console.log(
  failures.length
    ? `\n失敗 ${failures.length}件:\n  - ${failures.join("\n  - ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
