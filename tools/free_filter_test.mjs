/* 「無料のものだけ」チップ（isFreePrice と FLAG_FREE の配線）の回帰テスト。DOM不要。

   price は自由記述なので、判定の誤りは「無料のはずが料金が要る」「無料なのに出てこない」の
   どちらかとして利用者にだけ見える。判定規則の表と、実データでの振り分けをここで固定する。

   使い方（リポジトリのルートから）:
     node tools/free_filter_test.mjs
*/

import fs from "node:fs";

globalThis.fetch = async (p) => {
  const path = String(p).replace(/^\.\//, "");
  if (!fs.existsSync(path))
    return { ok: false, status: 404, headers: { get: () => null } };
  const text = fs.readFileSync(path, "utf8");
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
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.window = { matchMedia: () => ({ matches: true }), addEventListener() {} };

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}${detail ? "  — " + detail : ""}`,
  );
  if (!ok) failures.push(name);
};

const { isFreePrice } = await import("../assets/js/util.js");
const { TABS } = await import("../assets/js/config.js");
const { loadTab, ITEMS } = await import("../assets/js/data.js");
const { flagCounts, matchesFilters } = await import("../assets/js/filters.js");
const { queryToState, STATES, setActiveTabKey, stateToQuery } = await import(
  "../assets/js/state.js"
);

console.log("\n--- 判定規則 ---");
const FREE = [
  "無料",
  "入場無料",
  "入館無料",
  "入園無料",
  "参加無料",
  "観覧無料（予約不要）",
  "観戦無料",
  "0円",
  "  無料  ",
  "無料　（全角空白）",
  "無料(拡張部は常時開放)",
  "参加無料・申込不要",
  "無料（要登録）",
  "入場無料（飲食代は有料）",
  "入場無料（飲食代別）",
  "入場無料（商品購入別途）",
  "入場無料（ラーメンは1杯800円から）",
  "入場無料（各コンテンツの利用は別料金）",
  "無料（当日館内2,000円以上の利用でサンマ半尾のふるまい）",
  "入場無料（有料観覧席は販売終了）",
  "無料（一部プログラムを除く）",
];
const NOT_FREE = [
  "",
  null,
  undefined,
  "   ",
  "要問合せ",
  "一般300円／中学生以下無料",
  "一般1,400円／65歳以上1,200円／未就学児無料",
  "大人1日券 5,370円〜（販売時期で変動）／中学生以下無料",
  "無料観覧エリアあり",
  "有料",
  "無料会員限定",
  "10円",
  "100円",
  "参加無料（入園料 大人450円は別途）",
  "参加無料（当日の常設展観覧券が必要：一般500円・大学生250円）",
  "参加無料（当日有効の観覧券が必要）",
  "無料（館内に入る場合は入館料が必要）",
  "無料（博物館本館は別途入場料が必要）",
  "代々木公園イベント広場は入場無料（LINE CUBE SHIBUYAは公演ごとに異なる）",
  "ムビチケ前売1,600円（公開日前日までの購入）",
];
for (const s of FREE) check(`無料: ${JSON.stringify(s)}`, isFreePrice(s) === true);
for (const s of NOT_FREE)
  check(`無料でない: ${JSON.stringify(s)}`, isFreePrice(s) === false);

console.log("\n--- 配線 ---");
for (const k of ["event", "movie"]) {
  const f = TABS[k].flags.find((x) => x.id === "freeOnly");
  check(`${k} に freeOnly がある`, !!f);
  check(`${k}: 割引チップと同じ「おトク」の行`, f?.group === "おトク");
}
check(
  "live には freeOnly を置かない（live_type=free の軸と重複するため）",
  !TABS.live.flags.some((x) => x.id === "freeOnly"),
);

console.log("\n--- 実データ ---");
await loadTab("event");
await loadTab("movie");
for (const k of ["event", "movie"]) {
  const tab = TABS[k];
  const items = ITEMS[k];
  const free = items.filter((it) => isFreePrice(it.price));
  check(`${k}: 無料の行がある`, free.length > 0, `${free.length}件`);
  // 割引バッジと無料は両立しない（無料に割引は付けない規則）。付いていたら判定かデータが怪しい
  check(
    `${k}: 無料の行に割引率が付いていない`,
    free.every((it) => !it.discountPct),
  );
  const st = STATES[k];
  st.flags.freeOnly = true;
  // 終了行は既定で隠れる。無料チップはそれを変えない
  const shown = items.filter((it) => matchesFilters(tab, st, it));
  check(
    `${k}: 絞り込み結果はすべて無料`,
    shown.every((it) => isFreePrice(it.price)),
    `${shown.length}件`,
  );
  st.flags.freeOnly = false;
  const counts = flagCounts(tab, st, items);
  check(
    `${k}: チップの件数 = 無料かつ表示対象の行数`,
    counts.freeOnly ===
      items.filter((it) => matchesFilters(tab, st, it) && isFreePrice(it.price))
        .length,
    `${counts.freeOnly}件`,
  );
  // 割引チップと同時に立てると、無料の行は割引を持たないので0件になるのが正しい
  st.flags.freeOnly = true;
  st.flags.dealsOnly = true;
  check(
    `${k}: 無料×割引は0件`,
    items.filter((it) => matchesFilters(tab, st, it)).length === 0,
  );
  st.flags.freeOnly = false;
  st.flags.dealsOnly = false;
}

console.log("\n--- URL往復 ---");
const q = queryToState("?f=free");
check("?f=free で event の freeOnly が立つ", q === "event" && STATES.event.flags.freeOnly);
setActiveTabKey("event");
check("URL に free が載る", stateToQuery().get("f") === "free");
const q2 = queryToState("?tab=movie&f=deals,free");
check(
  "?tab=movie&f=deals,free で両方立つ",
  q2 === "movie" && STATES.movie.flags.freeOnly && STATES.movie.flags.dealsOnly,
);
queryToState("?tab=live&f=free");
check("live に ?f=free を直打ちしても落ちない・立たない", !("freeOnly" in STATES.live.flags));

console.log(
  failures.length
    ? `\nNG ${failures.length}件: ${failures.join(", ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
