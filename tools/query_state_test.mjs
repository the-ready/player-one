/* URL → 絞り込み状態（state.js の queryToState）の堅さの回帰テスト。DOM不要。

   URL は誰でも書き換えられる。読んだ値は検索の索引・チップの文言・地図の初期位置にそのまま使われるので、
   壊れた値は「効かない」ではなく「画面が壊れる」になる。壊れ方は3種類。
     1. 継承したプロパティに当たる — ?f=constructor / ?cats=constructor,__proto__ は、{} のリテラルで作った
                                     表や状態の「Object.prototype の持ち物」を引き、ラベルが空のチップが出る
     2. 日付が実在しない           — 2026-13-45 は形だけ合っていて、カレンダーの月がずれる
     3. 地図の範囲が地球上にない   — 緯度・経度・半径の範囲外は、地図の初期位置が壊れる

   使い方（リポジトリのルートから）:
     node tools/query_state_test.mjs
*/

import fs from "node:fs";

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

const S = await import("../assets/js/state.js");
const C = await import("../assets/js/config.js");
const R = await import("../assets/js/render.js");
const { TABS, TAB_ORDER } = C;

const q = (search) => {
  const key = S.queryToState(search);
  return key ? { key, st: S.STATES[key] } : null;
};
const throwsNot = (name, fn) => {
  try {
    fn();
    return true;
  } catch (e) {
    check(name, false, String(e));
    return false;
  }
};

/* ---------- 1. 継承したプロパティ ---------- */
console.log("\n--- 継承したプロパティ（constructor など） ---");
const PROTO_NAMES = [
  "constructor",
  "__proto__",
  "hasOwnProperty",
  "toString",
  "valueOf",
  "isPrototypeOf",
];

for (const name of PROTO_NAMES) {
  const r = q(`?f=${name}`);
  check(
    `?f=${name} は特別チップを何も立てない`,
    r && Object.values(r.st.flags).every((v) => v === false),
    r && JSON.stringify(r.st.flags),
  );
}
{
  const r = q("?f=constructor,free,__proto__");
  check(
    "?f に正しい名前が混ざっていれば、それだけが立つ",
    r && r.st.flags.freeOnly === true,
    r && JSON.stringify(r.st.flags),
  );
}

// ファセットの値（カテゴリ・開催状況・ジャンル・上映形態・公演形態）
const FACET_PARAMS = {
  event: ["cats", "status"],
  movie: ["genre", "screen", "fmt", "status"],
  live: ["genre", "ltype", "status"],
};
for (const tab of TAB_ORDER) {
  for (const param of FACET_PARAMS[tab]) {
    const r = q(`?tab=${tab}&${param}=${PROTO_NAMES.join(",")}`);
    const picked = r
      ? TABS[tab].facets.flatMap((f) => [...r.st.sets[f.id]])
      : ["?"];
    check(
      `?tab=${tab}&${param}=constructor,__proto__,… は値を1つも受け付けない`,
      picked.length === 0,
      picked.join(),
    );
  }
}
{
  const r = q("?cats=constructor,exhibition,__proto__");
  check(
    "正しい値が混ざっていれば、それだけが残る",
    r && [...r.st.sets.cats].join() === "exhibition",
    r && [...r.st.sets.cats].join(),
  );
}

// 表引き：URL を通らない経路（CSV の値）でも、継承したものに当たらない
for (const tab of TAB_ORDER) {
  const t = TABS[tab];
  t.facets.forEach((f) => {
    PROTO_NAMES.forEach((n) => {
      const text = f.meta(n).text;
      check(
        `${tab}の「${f.label}」に ${n} を渡しても、ラベルは文字列の ${n} になる`,
        text === n,
        String(text),
      );
    });
  });
}
check(
  "tableMeta は表に無いキーを、そのキーをラベルにして返す",
  C.tableMeta({ a: { label: "A", c: "x" } }, "constructor").label ===
    "constructor",
);
check(
  "statusMeta は表に無いキーに、中立のバッジを返す",
  C.statusMeta({}, "constructor") === C.NEUTRAL_BADGE &&
    C.statusMeta({}, "__proto__") === C.NEUTRAL_BADGE,
);

// 画面に出る「適用中」のチップ：空のラベル（「×」だけ）を出さない
{
  const ugly = [
    "?f=constructor,__proto__&cats=constructor,__proto__,hasOwnProperty",
    "?tab=movie&genre=constructor&screen=__proto__&fmt=toString&status=valueOf",
    "?tab=live&genre=hasOwnProperty&ltype=constructor&status=__proto__",
    "?pref=constructor&venue=__proto__",
  ];
  for (const search of ugly) {
    const r = q(search);
    S.setActiveTabKey(r.key);
    let labels = [];
    const ok = throwsNot(
      `適用中チップの組み立てが落ちない（${search}）`,
      () => {
        labels = R.appliedFilters().map((a) => a.label);
      },
    );
    check(
      `適用中チップに空のラベルが無い（${search}）`,
      ok && labels.every((l) => typeof l === "string" && l.trim() !== ""),
      JSON.stringify(labels),
    );
  }
  S.setActiveTabKey("event");
}

/* ---------- 2. 日付 ---------- */
console.log("\n--- from / to（実在する日付だけ） ---");
{
  let r = q("?from=2026-11-01&to=2026-11-03");
  check(
    "正しい日付は受け付ける",
    r && r.st.rangeStart === "2026-11-01" && r.st.rangeEnd === "2026-11-03",
  );
  r = q("?from=2026-11-03&to=2026-11-01");
  check(
    "逆順は入れ替える",
    r && r.st.rangeStart === "2026-11-01" && r.st.rangeEnd === "2026-11-03",
  );
  r = q("?from=2028-02-29&to=2028-03-01");
  check("うるう日は受け付ける", r && r.st.rangeStart === "2028-02-29");
  const BAD = [
    "2026-13-45",
    "2026-00-10",
    "2026-02-30",
    "2026-04-31",
    "2027-02-29",
    "2026-11-00",
    "2026-1-1",
    "20261101",
    "2026-11-01T00:00",
    "abc",
    "",
  ];
  for (const bad of BAD) {
    r = q(`?from=${bad}&to=2026-11-03`);
    check(
      `from=${bad || "（空）"} は捨てる（日程を立てない）`,
      r && r.st.rangeStart === null && r.st.rangeEnd === null,
      r && `${r.st.rangeStart}〜${r.st.rangeEnd}`,
    );
    r = q(`?from=2026-11-01&to=${bad}`);
    check(
      `to=${bad || "（空）"} は捨てる（日程を立てない）`,
      r && r.st.rangeStart === null && r.st.rangeEnd === null,
    );
  }
}

/* ---------- 3. 地図の範囲 ---------- */
console.log("\n--- map（緯度・経度・半径） ---");
{
  let r = q("?map=35.68100,139.76700,3.50");
  check(
    "地図で作れる範囲は受け付ける",
    r &&
      r.st.mapArea &&
      r.st.mapArea.lat === 35.681 &&
      r.st.mapArea.lng === 139.767 &&
      r.st.mapArea.radiusKm === 3.5,
    r && JSON.stringify(r.st.mapArea),
  );
  // 書き出した URL をそのまま読み戻せる（stateToQuery と対）
  S.STATES.event.mapArea = { lat: 35.6812, lng: 139.7671, radiusKm: 12.3456 };
  S.setActiveTabKey("event");
  const written = S.stateToQuery().toString();
  r = q(`?${written}`);
  check(
    "stateToQuery が書いた地図の範囲を読み戻せる",
    r && r.st.mapArea && Math.abs(r.st.mapArea.radiusKm - 12.35) < 1e-9,
    written,
  );

  const edge = (la, ln, rad) => q(`?map=${la},${ln},${rad}`)?.st.mapArea;
  check("緯度 90・経度 180 の端は受け付ける", !!edge(90, 180, 5));
  check("緯度 -90・経度 -180 の端は受け付ける", !!edge(-90, -180, 5));
  check(
    "半径が選べる上限ちょうどは受け付ける",
    !!edge(35, 139, C.MAP_RADIUS_MAX_KM),
  );
  const BAD = {
    "緯度 90.1": [90.1, 139, 5],
    "緯度 -90.1": [-90.1, 139, 5],
    "緯度 1000": [1000, 139, 5],
    "経度 180.1": [35, 180.1, 5],
    "経度 -181": [35, -181, 5],
    "半径 0": [35, 139, 0],
    半径が負: [35, 139, -3],
    半径が上限超え: [35, 139, C.MAP_RADIUS_MAX_KM + 1],
    半径が極端に大きい: [35, 139, 99999999],
    "半径 1e9": [35, 139, "1e9"],
    文字が混ざる: ["abc", 139, 5],
    "16進": ["0x10", 139, 5],
    空欄: ["", 139, 5],
  };
  for (const [name, [la, ln, rad]] of Object.entries(BAD)) {
    check(`地図の範囲（${name}）は捨てる`, !edge(la, ln, rad));
  }
  for (const raw of ["35,139", "35,139,5,9", "NaN,139,5", "Infinity,139,5"]) {
    check(`地図の範囲（${raw}）は捨てる`, !q(`?map=${raw}`)?.st.mapArea);
  }
  // 捨てた分は、ほかの場所の指定に道を譲る（地図が無効なら会場が効く）
  r = q("?map=999,139,5&venue=Kアリーナ横浜");
  check(
    "地図の範囲を捨てたときは、会場の指定が効く",
    r && r.st.mapArea === null && r.st.venue === "Kアリーナ横浜",
  );
}

/* ---------- 4. 地図の半径の上限が、ui-map.js の作れる最大を覆っている ---------- */
console.log("\n--- 半径の上限と ui-map.js ---");
{
  const src = fs.readFileSync("assets/js/ui-map.js", "utf8");
  const minZoom = Number(/MAP_MIN_ZOOM\s*=\s*(\d+)/.exec(src)?.[1]);
  const ring = Number(/RING_RATIO\s*=\s*([\d.]+)/.exec(src)?.[1]);
  const m0 = Number(/M_PER_PX_Z0\s*=\s*([\d.]+)/.exec(src)?.[1]);
  const css = fs.readFileSync("assets/app.css", "utf8");
  // 地図のシートの高さの上限。短辺はこれを超えない（幅の上限 880px より小さい）
  const sheetMax = Number(
    /\.map-sheet-inner\s*\{[^}]*height:\s*min\(\s*\d+vh\s*,\s*(\d+)px\s*\)/.exec(
      css,
    )?.[1],
  );
  check(
    "ui-map.js の定数と地図シートの高さを読み取れる",
    [minZoom, ring, m0, sheetMax].every(Number.isFinite),
    [minZoom, ring, m0, sheetMax].join(),
  );
  if ([minZoom, ring, m0, sheetMax].every(Number.isFinite)) {
    // 最も引いて（minZoom）、最も大きい円（短辺 × ring / 2）を、縮尺が最大になる赤道で作ったときの半径
    const widest = ((m0 / 2 ** minZoom) * ((sheetMax * ring) / 2)) / 1000;
    check(
      "上限は、地図で作れる最大の半径を覆う（作った範囲が URL で復元できなくならない）",
      C.MAP_RADIUS_MAX_KM >= widest,
      `上限 ${C.MAP_RADIUS_MAX_KM}km / 最大 ${widest.toFixed(0)}km`,
    );
    check(
      "上限は最大の2倍以下（桁違いの値を通さない）",
      C.MAP_RADIUS_MAX_KM <= widest * 2,
      `上限 ${C.MAP_RADIUS_MAX_KM}km / 最大 ${widest.toFixed(0)}km`,
    );
  }
}

console.log(
  failures.length
    ? `\n${failures.length} 件が失敗しました: ${failures.join(" / ")}`
    : "\nすべて通りました",
);
process.exit(failures.length ? 1 : 0);
