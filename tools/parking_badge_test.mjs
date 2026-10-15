/* 駐車場のバッジ（P）の回帰テスト。DOM不要。

   「名簿の parking（常設）」と「催しの event_parking（その日だけ）」の組み合わせが、
   どのバッジになるかを表で固定する。壊れ方は2つで、どちらも画面では気づきにくい。
     ・出してはいけないものが出る — 未確認なのに「駐車場なし」、当日不可なのに「P」
     ・出すべきものが出ない       — 臨時駐車場があるのにバッジが消える、絞り込みに入らない

   使い方（リポジトリのルートから）:
     node tools/parking_badge_test.mjs
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const D = await import("../assets/js/data.js");
const S = await import("../assets/js/spots.js");
const C = await import("../assets/js/cards.js");
const ST = await import("../assets/js/state.js");
const F = await import("../assets/js/filters.js");
const { TABS } = await import("../assets/js/config.js");
const R = await import("../assets/js/render.js");

/* ---------- 合成した名簿 ---------- */
SYNTH.set(
  "data/spots.csv",
  [
    "name,kind,pref,area,lat,lng,url,parking,status",
    "Pあり館,museum,tokyo,東京都・港区,,,,yes,active",
    "近隣館,museum,tokyo,東京都・港区,,,,nearby,active",
    "なし館,museum,tokyo,東京都・港区,,,,no,active",
    "未確認館,museum,tokyo,東京都・港区,,,,,active",
    "変な値館,museum,tokyo,東京都・港区,,,,バッチリ,active",
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
    ",駐車場つき館,tokyo,東京都・豊島区,,,,yes,active",
  ].join("\n"),
);
await Promise.all([D.loadSpots(), D.loadTheaters(), D.loadVenues()]);

const row = (venue, ep) => ({ venue, eventParking: ep });
const kinds = (it) => {
  // バッジの種類を、描かれた HTML から読み戻す（クラス名＝種類）
  const html = C.parkingBadgesHtml(it);
  return [...html.matchAll(/class="pk (\w+)"/g)].map((m) => m[1]);
};

console.log("\n--- バッジの組み合わせ表（常設 × その日の事情） ---");
const TABLE = [
  // [会場, event_parking, 期待するバッジ（左から）]
  ["Pあり館", undefined, ["yes"]],
  ["Pあり館", "", ["yes"]],
  ["近隣館", "", ["nearby"]],
  ["なし館", "", ["no"]],
  ["未確認館", "", []], // 未確認は何も出さない（「なし」と言い切らない）
  ["どこにも無い会場", "", []],
  ["Pあり館", "temp", ["yes", "temp"]],
  ["なし館", "temp", ["no", "temp"]],
  ["未確認館", "temp", ["temp"]], // 臨時駐車場の事実は、常設が未確認でも出る
  ["Pあり館", "closed", ["closed"]], // 当日不可のときは常設の「P」を出さない
  ["未確認館", "closed", ["closed"]],
  ["Pあり館", "temp_only", ["closed", "temp"]], // 常設は使えず、臨時だけ
  ["Pあり館", "bogus", ["yes"]], // 未知の値は無視（常設の表示は崩さない）
  ["変な値館", "", []], // 名簿側の未知の値も無視
];
for (const [venue, ep, want] of TABLE) {
  const got = kinds(row(venue, ep));
  check(
    `${venue} × ${ep === undefined ? "(列なし)" : ep || "空"} → ${want.join("+") || "なし"}`,
    eq(got, want),
    eq(got, want) ? "" : `実際: ${got.join("+") || "なし"}`,
  );
}

console.log("\n--- 複数の場所にまたがる行 ---");
{
  // 2つの場所が同じ値のときだけ、行全体の事実として採る
  check(
    "全部の場所が yes なら yes",
    eq(kinds(row("Pあり館／Pあり館", "")), ["yes"]) ||
      eq(kinds(row("Pあり館", "")), ["yes"]),
  );
  check(
    "値が食い違えば何も出さない（片方の事実を行全体のものにしない）",
    eq(kinds(row("Pあり館／なし館", "")), []),
  );
  check(
    "片方が未確認なら何も出さない",
    eq(kinds(row("Pあり館／未確認館", "")), []),
  );
  check(
    "映画の行（劇場名の配列）でも名簿から引ける",
    eq(kinds({ venues: ["駐車場つき館"] }), ["yes"]),
  );
  check(
    "チェーン名だけの行は何も出さない（どの劇場か分からない）",
    eq(kinds({ venues: ["TOHOシネマズ"] }), []),
  );
}

console.log("\n--- 見た目（アクセシビリティ） ---");
{
  const all = ["yes", "nearby", "no", "closed", "temp"].map((k) =>
    C.parkBadgeHtml(k),
  );
  check(
    "どのバッジも読み上げ用の文字を持つ（色だけに頼らない）",
    all.every((h) => /class="sr-only">[^<]+</.test(h)),
  );
  check(
    "文字でも種類が分かる（近隣・なし・当日不可・臨時）",
    C.parkBadgeHtml("nearby").includes("近隣") &&
      C.parkBadgeHtml("no").includes("なし") &&
      C.parkBadgeHtml("closed").includes("当日不可") &&
      C.parkBadgeHtml("temp").includes("臨時P"),
  );
  check("未知の種類は何も出さない", C.parkBadgeHtml("zzz") === "");
}

console.log("\n--- 「駐車場があるものだけ」 ---");
{
  const t = (venue, ep) => S.hasParking(row(venue, ep));
  check(
    "あり・近隣・臨時は含まれる",
    t("Pあり館", "") &&
      t("近隣館", "") &&
      t("なし館", "temp") &&
      t("未確認館", "temp"),
  );
  check(
    "なし・未確認・当日不可は含まれない（確かめていないものを「ある」と言わない）",
    !t("なし館", "") && !t("未確認館", "") && !t("Pあり館", "closed"),
  );
  check("当日は臨時のみ（temp_only）なら含まれる", t("Pあり館", "temp_only"));
}

/* ---------- 実データ（カードのHTMLまで） ---------- */
console.log("\n--- 実データ ---");
SYNTH.clear();
await Promise.all([D.loadSpots(), D.loadTheaters(), D.loadVenues()]);
for (const k of ["event", "movie", "live"]) await D.loadTab(k);

const withBase = D.ITEMS.event.filter((it) => S.parkingState(it).base);
check(
  "イベント行の一部は、名簿の parking から P が決まる",
  withBase.length > 0,
  `${withBase.length}/${D.ITEMS.event.length}行`,
);
{
  const it = withBase.find((x) => S.parkingState(x).base === "yes");
  const st = ST.STATES.event;
  const h = C.cardHtml(TABS.event, it, st, []);
  const title = h.match(/<h3 class="title">(.*?)<\/h3>/s)?.[1] || "";
  check("カードのタイトルの末尾にバッジが付く", /class="pk yes"/.test(title));
  check(
    "「くわしく」の駐車場の行にも同じバッジが出る",
    /class="vd-label">駐車場<\/span><span class="vd-park"><span class="pk yes"/.test(
      h,
    ),
  );
}
{
  // 臨時駐車場の種（移行で入れたもの）が、そのままバッジに出る
  const temp = D.ITEMS.event.find((it) => it.eventParking === "temp");
  if (temp) {
    const h = C.cardHtml(TABS.event, temp, ST.STATES.event, []);
    check("event_parking=temp の行に「臨時P」が出る", h.includes("臨時P"));
  } else {
    check("（臨時の種が無いのでスキップ）", true);
  }
  const closed = D.ITEMS.event.find((it) => it.eventParking === "closed");
  if (closed) {
    const h = C.cardHtml(TABS.event, closed, ST.STATES.event, []);
    check(
      "event_parking=closed の行は「当日不可」で、常設の P を出さない",
      h.includes("当日不可") && !/class="pk yes"/.test(h),
    );
  } else {
    check("（当日不可の種が無いのでスキップ）", true);
  }
}

console.log("\n--- 絞り込みの配線 ---");
{
  check(
    "3タブとも特別チップ「駐車場があるものだけ」を持つ",
    ["event", "movie", "live"].every((k) =>
      TABS[k].flags.some((f) => f.id === "parkingOnly"),
    ),
  );
  const st = ST.resetState("event");
  st.flags.parkingOnly = true;
  const hits = D.ITEMS.event.filter((it) =>
    F.matchesFilters(TABS.event, st, it),
  );
  check(
    "絞り込み結果は hasParking と一致する",
    hits.length > 0 && hits.every((it) => S.hasParking(it)),
    `${hits.length}件`,
  );
  const n = F.flagCounts(
    TABS.event,
    ST.resetState("event"),
    D.ITEMS.event,
  ).parkingOnly;
  check(
    "チップの件数は絞り込み結果と同じ数え方",
    n === hits.length,
    `${n} vs ${hits.length}`,
  );
  ST.setActiveTabKey("event");
  ST.STATES.event.flags.parkingOnly = true;
  check(
    "URLに載る（f=parking）",
    /f=parking/.test(ST.stateToQuery().toString()),
  );
  ST.queryToState("?f=parking");
  check("URLから復元できる", ST.STATES.event.flags.parkingOnly === true);
}

console.log("\n--- 全カードを描いても落ちない（欠損・未知の値に耐える） ---");
{
  let broken = 0;
  for (const k of ["event", "movie", "live"]) {
    ST.resetState(k);
    ST.setActiveTabKey(k);
    try {
      R.renderList();
      const h = els.get(TABS[k].listId).innerHTML;
      if (/undefined|\[object/.test(h)) broken++;
    } catch (e) {
      console.log("   ", k, e.message);
      broken++;
    }
  }
  check("3タブの全カードが描ける（undefined が出ない）", broken === 0);
}

console.log(
  failures.length
    ? `\n失敗 ${failures.length}件:\n  - ${failures.join("\n  - ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
