/* タブ切替での絞り込みの引き継ぎ（設計書 第4.2.2節）の回帰テスト。DOM不要。

   「日程・エリア・特別チップは持ち越す／カテゴリ・会場など固有のものは持ち越さず、
   元のタブへ戻れば復元される」を、状態層（state.js）と件数バッジ（render.js）で固定する。
   壊れ方は2種類——持ち越し漏れ（切り替えたら条件が消える）と、持ち越しすぎ
   （行き先に無い値が残って必ず0件になる）。どちらも画面では原因が見えにくい。

   使い方（リポジトリのルートから）:
     node tools/tab_carry_test.mjs
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const { TABS, TAB_ORDER } = await import("../assets/js/config.js");
const { loadTab, ITEMS, LOAD } = await import("../assets/js/data.js");
const { matchesFilters } = await import("../assets/js/filters.js");
const S = await import("../assets/js/state.js");
const { STATES, carryFilters, carryPlan, resetAllStates, clearSharedFilters } =
  S;
const { syncTabCounts } = await import("../assets/js/render.js");

for (const k of TAB_ORDER) await loadTab(k);

const fresh = () => resetAllStates();
const facetSizes = (k) =>
  Object.fromEntries(
    Object.entries(STATES[k].sets).map(([id, s]) => [id, [...s].sort()]),
  );

console.log("\n--- 引き継ぐもの ---");
fresh();
Object.assign(STATES.event, {
  rangeStart: "2026-11-01",
  rangeEnd: "2026-11-03",
  sortBy: "announced",
});
STATES.event.pref = "tokyo";
STATES.event.flags.onsaleOnly = true;
STATES.event.sets.cats.add("art");
STATES.event.q = "花火";
let dropped = carryFilters("event", "movie");
check(
  "日程が movie に移る",
  STATES.movie.rangeStart === "2026-11-01" &&
    STATES.movie.rangeEnd === "2026-11-03",
);
check("都県が movie に移る", STATES.movie.pref === "tokyo");
check("受付中チップが movie に移る", STATES.movie.flags.onsaleOnly === true);
check("並び順（新着順）が移る", STATES.movie.sortBy === "announced");
check("検索語は共有のまま", STATES.movie.q === "花火");
check("落としたものは無い（通知なし）", dropped.length === 0);
check(
  "event のカテゴリは movie に移らない",
  STATES.movie.sets.genres.size === 0 &&
    STATES.movie.sets.screeningTypes.size === 0,
);
check(
  "出発側の状態は変わらない",
  STATES.event.pref === "tokyo" && STATES.event.sets.cats.has("art"),
);

console.log("\n--- 固有値は元のタブで復元される ---");
STATES.movie.sets.genres.add("action");
carryFilters("movie", "live");
const movieBefore = facetSizes("movie");
carryFilters("live", "event");
check("event に戻ると cats が残っている", STATES.event.sets.cats.has("art"));
carryFilters("event", "movie");
check(
  "movie に戻ると genres が残っている",
  same(facetSizes("movie"), movieBefore) &&
    STATES.movie.sets.genres.has("action"),
);
check("live に genres は漏れていない", STATES.live.sets.genres.size === 0);

console.log("\n--- 行き先に無い条件は落として知らせる ---");
fresh();
STATES.movie.pref = "tochigi";
dropped = carryFilters("movie", "event");
check("栃木県はイベントの都県に無いので落ちる", STATES.event.pref === null);
check("通知に「栃木県」が入る", same(dropped, ["栃木県"]));
check("映画側の栃木県は残る", STATES.movie.pref === "tochigi");
carryFilters("event", "live");
check(
  "栃木県を落としたあと live にも伝わらない（出発側が最新）",
  STATES.live.pref === null,
);
fresh();
STATES.event.flags.dealsOnly = true;
dropped = carryFilters("event", "live");
check(
  "割引チップは live に無いので通知される",
  dropped.length === 1 && dropped[0].includes("割引"),
);
check(
  "live の flags に未知のキーが生えない",
  !("dealsOnly" in STATES.live.flags),
);
fresh();
STATES.event.flags.dealsOnly = true;
STATES.live.flags.favOnly = true;
carryFilters("live", "event");
check(
  "live→event で event の割引チップは触られない",
  STATES.event.flags.dealsOnly === true,
);
check(
  "live→event で共通チップは出発側に揃う（お気に入りが移る）",
  STATES.event.flags.favOnly === true,
);

fresh();
STATES.event.flags.dealsOnly = true;
carryFilters("event", "live");
carryFilters("live", "movie");
check(
  "チップを持たないタブを経由すると、その先へは運ばれない（ホップごとの持ち越し）",
  STATES.movie.flags.dealsOnly === false,
);
fresh();
STATES.event.flags.dealsOnly = true;
carryFilters("event", "movie");
carryFilters("movie", "live");
carryFilters("live", "movie");
check(
  "行き先自身が持っているチップは、チップの無いタブを往復しても残る",
  STATES.movie.flags.dealsOnly === true,
);

console.log("\n--- 場所の排他 ---");
fresh();
STATES.event.venue = "どこかの会場";
STATES.movie.pref = "kanagawa";
carryFilters("movie", "event");
check(
  "都県が来たら行き先の会場は外れる",
  STATES.event.venue === null && STATES.event.pref === "kanagawa",
);
fresh();
STATES.event.pref = "tokyo";
STATES.movie.venue = "どこかの映画館";
carryFilters("movie", "event");
check(
  "出発側が会場なら行き先の都県は空になる（最新の選択が勝つ）",
  STATES.event.pref === null,
);
fresh();
STATES.event.venue = "イベント会場";
carryFilters("movie", "event");
check(
  "出発側に場所が無くても行き先の会場は残る",
  STATES.event.venue === "イベント会場",
);
fresh();
STATES.event.mapArea = { lat: 35.7, lng: 139.7, radiusKm: 3 };
carryFilters("event", "live");
check("地図の範囲が移る", same(STATES.live.mapArea, STATES.event.mapArea));
check(
  "地図の範囲は別オブジェクトに複製される",
  STATES.live.mapArea !== STATES.event.mapArea,
);
check(
  "地図の範囲が来たら都県・会場は空",
  STATES.live.pref === null && STATES.live.venue === null,
);

console.log("\n--- 並び順と現在地 ---");
fresh();
STATES.event.sortBy = "location";
dropped = carryFilters("event", "movie");
check(
  "現在地が無いまま「現在地順」だけが移らない",
  STATES.movie.sortBy === "date",
);
fresh();
STATES.event.sortBy = "location";
STATES.event.userLoc = { lat: 35.6, lng: 139.7 };
carryFilters("event", "movie");
check(
  "現在地があれば「現在地順」と現在地が移る",
  STATES.movie.sortBy === "location" && STATES.movie.userLoc.lat === 35.6,
);
fresh();
STATES.movie.userLoc = { lat: 35.1, lng: 139.1 };
carryFilters("event", "movie");
check(
  "出発側に現在地が無いとき、行き先の現在地は消さない",
  STATES.movie.userLoc?.lat === 35.1,
);

console.log("\n--- 何もしないケースと副作用 ---");
fresh();
STATES.event.pref = "tokyo";
const snap = JSON.stringify(STATES.movie, (k, v) =>
  v instanceof Set ? [...v] : v,
);
carryPlan("event", "movie");
check(
  "carryPlan は state を書き換えない",
  snap ===
    JSON.stringify(STATES.movie, (k, v) => (v instanceof Set ? [...v] : v)),
);
check(
  "同じタブへの引き継ぎは何もしない",
  carryFilters("event", "event").length === 0 && STATES.event.pref === "tokyo",
);
check("知らないタブでも落ちない", carryFilters("event", "nope").length === 0);

console.log("\n--- 解除 ---");
fresh();
STATES.event.q = "ライブ";
STATES.event.sets.cats.add("art");
STATES.movie.sets.genres.add("action");
STATES.live.pref = "tokyo";
STATES.live.flags.favOnly = true;
resetAllStates();
check(
  "すべて解除は全タブの固有の絞り込みも消す",
  TAB_ORDER.every((k) =>
    Object.values(STATES[k].sets).every((s) => s.size === 0),
  ),
);
check(
  "すべて解除は検索語・都県・チップも消す",
  STATES.event.q === "" &&
    STATES.live.pref === null &&
    !STATES.live.flags.favOnly,
);
fresh();
STATES.event.q = "花火";
STATES.event.sets.cats.add("art");
STATES.event.venue = "会場A";
STATES.event.rangeStart = "2026-11-01";
STATES.event.rangeEnd = "2026-11-02";
STATES.event.flags.newOnly = true;
clearSharedFilters("event");
check(
  "共通の条件だけ外す: 日程・チップが消える",
  STATES.event.rangeStart === null && !STATES.event.flags.newOnly,
);
check(
  "共通の条件だけ外す: 検索語・カテゴリ・会場は残る",
  STATES.event.q === "花火" &&
    STATES.event.sets.cats.has("art") &&
    STATES.event.venue === "会場A",
);
check(
  "外した状態は次の切替で他タブにも伝わる",
  (carryFilters("event", "movie"), STATES.movie.rangeStart === null),
);

console.log("\n--- 件数バッジ = 切り替えた後に見える件数 ---");
const countOf = (k, st) =>
  ITEMS[k].filter((it) => matchesFilters(TABS[k], st, it)).length;
const scenarios = [
  {
    name: "日程のみ",
    f: (s) => {
      s.rangeStart = "2026-11-01";
      s.rangeEnd = "2026-11-07";
    },
  },
  {
    name: "東京都",
    f: (s) => {
      s.pref = "tokyo";
    },
  },
  {
    name: "栃木県",
    f: (s) => {
      s.pref = "tochigi";
    },
  },
  {
    name: "受付中",
    f: (s) => {
      s.flags.onsaleOnly = true;
    },
  },
  {
    name: "お気に入り",
    f: (s) => {
      s.flags.favOnly = true;
    },
  },
  {
    name: "新着",
    f: (s) => {
      s.flags.newOnly = true;
    },
  },
  {
    name: "地図",
    f: (s) => {
      s.mapArea = { lat: 35.68, lng: 139.76, radiusKm: 10 };
    },
  },
  {
    name: "検索語",
    f: (s) => {
      s.q = "東京";
    },
  },
  {
    name: "全部入り",
    f: (s) => {
      s.rangeStart = "2026-10-20";
      s.rangeEnd = "2026-12-20";
      s.pref = "kanagawa";
      s.flags.newOnly = true;
      s.q = "横浜";
    },
  },
];
let combos = 0,
  mismatches = [];
for (const sc of scenarios)
  for (const from of TAB_ORDER)
    for (const to of TAB_ORDER) {
      if (from === to) continue;
      fresh();
      sc.f(STATES[from]);
      // 行き先にも固有の絞り込みを入れておく（持ち越しで上書きされないことも見る）
      if (to === "event") STATES.event.sets.cats.add("art");
      const predicted = countOf(to, carryPlan(from, to).next);
      const toSets = facetSizes(to);
      carryFilters(from, to);
      const actual = countOf(to, STATES[to]);
      combos++;
      if (predicted !== actual)
        mismatches.push(`${sc.name}:${from}→${to} ${predicted}≠${actual}`);
      if (!same(toSets, facetSizes(to)))
        mismatches.push(`${sc.name}:${from}→${to} 固有値が変わった`);
    }
check(
  `バッジの予測と実際の件数が一致（${combos}通り）`,
  mismatches.length === 0,
  mismatches.slice(0, 3).join(" / "),
);

console.log("\n--- 件数バッジの出し分け ---");
const badge = (k) =>
  el(
    { event: "tabEventCount", movie: "tabMovieCount", live: "tabLiveCount" }[k],
  );
const withActive = (tab, setup) => {
  fresh();
  S.setActiveTabKey(tab);
  setup(STATES[tab]);
  syncTabCounts();
};
check(
  "全タブ読み込み済み",
  TAB_ORDER.every((k) => LOAD[k].state === "done"),
);
withActive("event", () => {});
check(
  "条件なしならバッジは出ない",
  TAB_ORDER.every((k) => badge(k).hidden),
);
withActive("event", (s) => {
  s.rangeStart = "2026-11-01";
  s.rangeEnd = "2026-11-07";
});
check(
  "日程だけでもバッジが出る",
  TAB_ORDER.every((k) => !badge(k).hidden),
);
withActive("event", (s) => {
  s.sets.cats.add("art");
  s.venue = "会場A";
});
check(
  "固有の絞り込みだけならバッジは出ない（他タブの件数は変わらないため）",
  TAB_ORDER.every((k) => badge(k).hidden),
);
withActive("event", (s) => {
  s.flags.newOnly = true;
});
check(
  "チップだけでもバッジが出る",
  TAB_ORDER.every((k) => !badge(k).hidden),
);
withActive("event", (s) => {
  s.pref = "tokyo";
});
check(
  "バッジの数字は carryPlan の件数と一致",
  TAB_ORDER.every(
    (k) =>
      badge(k).textContent ===
      String(
        k === "event"
          ? countOf(k, STATES[k])
          : countOf(k, carryPlan("event", k).next),
      ),
  ),
);
S.setActiveTabKey("event");

console.log(
  failures.length
    ? `\nNG ${failures.length}件: ${failures.join(", ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
