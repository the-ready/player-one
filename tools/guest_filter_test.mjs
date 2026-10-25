/* 「芸能人・著名人の出演あり」「舞台挨拶・ゲスト登壇あり」チップと、出演者の表示の回帰テスト。DOM不要。

   この機能の壊れ方は、どれも**利用者にだけ見える**。
     - 出演日を過ぎたのに「出演あり」に残る（行っても誰もいない）
     - 日程で絞ったのに、出演日が期間の外の行が混ざる（その週末には誰も来ない）
     - 件数のバッジと、押した後の一覧の件数が食い違う
     - 検索で名前を打つと出るのに、カードのどこにも名前が見えない
   時間を動かして判定を固定し、最後に乱数で作った行・日付・期間の総当たりを、
   テスト内に書いた別実装（仕様そのまま）と突き合わせる。

   使い方（リポジトリのルートから）:
     node tools/guest_filter_test.mjs
*/

import fs from "node:fs";

/* ---------- 時間を止める ----------
   schedule.js の「本日」も filters.js の hasEnded も `new Date()` から決まる。
   Date を差し替えて任意の日に固定し、その都度 refreshToday() で採り直す。 */
const RealDate = Date;
let frozen = null;
class FakeDate extends RealDate {
  constructor(...a) {
    if (a.length === 0 && frozen !== null) super(frozen);
    else super(...a);
  }
  static now() {
    return frozen !== null ? frozen : RealDate.now();
  }
}
globalThis.Date = FakeDate;
const freeze = (ymd) => {
  frozen = RealDate.parse(`${ymd}T12:00:00+09:00`);
};
freeze("2026-10-20");

/* ---------- 環境の差し替え ---------- */
const served = {}; // パス → CSV文字列（差し替え用）
globalThis.fetch = async (p) => {
  const path = String(p).replace(/^\.\//, "");
  const text =
    path in served
      ? served[path]
      : fs.existsSync(path)
        ? fs.readFileSync(path, "utf8")
        : null;
  if (text === null)
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
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
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

const { TABS, TAB_ORDER } = await import("../assets/js/config.js");
const D = await import("../assets/js/data.js");
const { loadTab, ITEMS, refreshToday } = D;
const F = await import("../assets/js/filters.js");
const { flagCounts, matchesFilters } = F;
const Sch = await import("../assets/js/schedule.js");
const { activeGuests, upcomingGuestDates } = Sch;
const S = await import("../assets/js/state.js");
const {
  STATES,
  queryToState,
  stateToQuery,
  setActiveTabKey,
  carryPlan,
  carryFilters,
  resetAllStates,
} = S;
const { cardHtml } = await import("../assets/js/cards.js");
const { searchTerms } = await import("../assets/js/util.js");

const setToday = (ymd) => {
  freeze(ymd);
  refreshToday();
};

/* ---------- 合成データ ----------
   必要な列だけを持つCSV。列が足りなくても読める契約（設計書 第3.5節）の確認も兼ねる。 */
const COLS = [
  "id",
  "title",
  "cats",
  "area",
  "venue",
  "pref",
  "start_date",
  "end_date",
  "price",
  "source",
  "url",
  "desc",
  "guests",
  "guest_dates",
  "guest_note",
];
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const toCsv = (cols, rows) =>
  [cols.map(csvCell).join(",")]
    .concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")))
    .join("\n") + "\n";
const row = (o) => ({
  cats: "ent",
  area: "東京都",
  venue: "テスト会場",
  pref: "tokyo",
  price: "一般1,000円",
  source: "公式サイト",
  url: "https://example.com/",
  desc: "テスト用の行。説明文は30字以上ある必要はないが、空ではない。",
  ...o,
});
const load = async (tabKey, rows, cols = COLS) => {
  served[tabKey === "movie" ? "data/movies.csv" : "data/events.csv"] = toCsv(
    cols,
    rows,
  );
  await loadTab(tabKey);
  return ITEMS[tabKey];
};
const byTitle = (items) => Object.fromEntries(items.map((i) => [i.title, i]));
const titles = (items) => items.map((i) => i.title).sort();
const reset = () => resetAllStates();

/* ================================================================
   1. 判定規則（activeGuests / upcomingGuestDates）
   ================================================================ */
console.log("\n--- 判定規則 ---");
const REF = "2026-10-20";
const RULES = [
  ["出演者なし", {}, false],
  ["出演者なし（日付だけある）", { guestDates: ["2026-10-25"] }, false],
  ["出演日なし・会期の終了日なし → 生きている", { guests: ["A"] }, true],
  [
    "出演日なし・会期が未来まで → 生きている",
    { guests: ["A"], endDate: "2026-12-01" },
    true,
  ],
  [
    "出演日なし・会期が今日まで → 生きている（当日は残す）",
    { guests: ["A"], endDate: "2026-10-20" },
    true,
  ],
  [
    "出演日なし・会期が昨日で終わった → 終わり",
    { guests: ["A"], endDate: "2026-10-19" },
    false,
  ],
  [
    "出演日が未来 → 生きている",
    { guests: ["A"], guestDates: ["2026-10-25"] },
    true,
  ],
  [
    "出演日が今日 → 生きている（当日は残す）",
    { guests: ["A"], guestDates: ["2026-10-20"] },
    true,
  ],
  [
    "出演日が昨日だけ → 終わり（会期が続いていても）",
    { guests: ["A"], guestDates: ["2026-10-19"], endDate: "2026-12-01" },
    false,
  ],
  [
    "出演日が過去と未来 → 未来があるので生きている",
    { guests: ["A"], guestDates: ["2026-10-01", "2026-11-03"] },
    true,
  ],
  [
    "出演日が未来なら、会期末が過去でも残す（出演日が決める）",
    {
      guests: ["A"],
      guestDates: ["2026-10-25"],
      endDate: "2026-10-10",
    },
    true,
  ],
];
for (const [name, it, want] of RULES)
  check(name, activeGuests(it, REF).length > 0 === want);
check(
  "upcomingGuestDates は今日以降だけ",
  JSON.stringify(
    upcomingGuestDates(
      { guestDates: ["2026-10-01", "2026-10-20", "2026-11-03"] },
      REF,
    ),
  ) === JSON.stringify(["2026-10-20", "2026-11-03"]),
);
check(
  "読めない出演日（TBD・10/25）は無いものとして扱う（永久に残らない）",
  activeGuests(
    { guests: ["A"], guestDates: ["TBD"], endDate: "2026-10-01" },
    REF,
  ).length === 0 &&
    activeGuests(
      { guests: ["A"], guestDates: ["10/25", "TBD", "2026-10-25"] },
      REF,
    ).length === 1,
);
check(
  "読めない出演日だけなら「出演日不明」＝会期で判定（会期が続いていれば生きている）",
  activeGuests(
    { guests: ["A"], guestDates: ["TBD"], endDate: "2026-12-01" },
    REF,
  ).length === 1,
);
check(
  "順不同の出演日でも upcomingGuestDates は日付順（次の出演日が先頭）",
  JSON.stringify(
    upcomingGuestDates(
      { guestDates: ["2026-11-03", "2026-10-25", "2026-10-01"] },
      REF,
    ),
  ) === JSON.stringify(["2026-10-25", "2026-11-03"]),
);
check(
  "列が無い行（guests が undefined）でも落ちない",
  activeGuests({}, REF).length === 0 &&
    upcomingGuestDates({}, REF).length === 0,
);

/* ================================================================
   2. 配線（タブ宣言・URL）
   ================================================================ */
console.log("\n--- 配線 ---");
for (const k of ["event", "movie"]) {
  const f = TABS[k].flags.find((x) => x.id === "guestOnly");
  check(`${k} に guestOnly がある`, !!f);
  check(`${k}: 「注目」の行`, f?.group === "注目");
  check(
    `${k}: ラベルは guestWords から出る`,
    f?.label(TABS[k]) === TABS[k].guestWords.chip,
  );
  check(
    `${k}: 出演者の3列を読む`,
    ["guests", "guestDates", "guestNote"].every((c) => c in TABS[k].columns),
  );
}
check(
  "ラベルはタブごとに違う（イベントは芸能人・著名人、映画は舞台挨拶）",
  /芸能人・著名人/.test(TABS.event.guestWords.chip) &&
    /舞台挨拶/.test(TABS.movie.guestWords.chip),
);
check(
  "ラベルは適用中バーのチップ幅（最大16em≒14字）に収まる（切れると何で絞っているか読めない）",
  [TABS.event, TABS.movie].every((t) => [...t.guestWords.chip].length <= 14),
  [TABS.event, TABS.movie].map((t) => [...t.guestWords.chip].length).join("/"),
);
check(
  "live には guestOnly も guestWords も出演者の列も置かない",
  !TABS.live.flags.some((x) => x.id === "guestOnly") &&
    !TABS.live.guestWords &&
    !("guests" in TABS.live.columns),
);

console.log("\n--- URL往復 ---");
reset();
const q = queryToState("?f=guest");
check(
  "?f=guest で event の guestOnly が立つ",
  q === "event" && STATES.event.flags.guestOnly,
);
setActiveTabKey("event");
check("URL に guest が載る", stateToQuery().get("f") === "guest");
reset();
const q2 = queryToState("?tab=movie&f=guest,free");
check(
  "?tab=movie&f=guest,free で両方立つ",
  q2 === "movie" && STATES.movie.flags.guestOnly && STATES.movie.flags.freeOnly,
);
queryToState("?tab=live&f=guest");
check(
  "live に ?f=guest を直打ちしても落ちない・立たない",
  !("guestOnly" in STATES.live.flags),
);

/* ================================================================
   3. 時間を動かす（合成データ）
   ================================================================ */
console.log("\n--- 時間を動かす ---");
setToday("2026-10-20");
const FIX = [
  row({
    id: 1,
    title: "E1 展覧会（出演日2回）",
    start_date: "2026-10-01",
    end_date: "2026-11-30",
    guests: "青山龍|白石凛",
    guest_dates: "2026-10-25|2026-11-03",
    guest_note: "10/25 14:00 トーク／11/3 サイン会",
  }),
  row({
    id: 2,
    title: "E2 出演日不明",
    start_date: "2026-10-01",
    end_date: "2026-10-31",
    guests: "赤松蓮",
  }),
  row({
    id: 3,
    title: "E3 出演は過ぎた",
    start_date: "2026-10-01",
    end_date: "2026-11-30",
    guests: "黒田澪",
    guest_dates: "2026-10-10",
    guest_note: "10/10 トーク（終了）",
  }),
  row({
    id: 4,
    title: "E4 出演者なし",
    start_date: "2026-10-01",
    end_date: "2026-11-30",
  }),
  row({
    id: 5,
    title: "E5 会期が終わった",
    start_date: "2026-09-01",
    end_date: "2026-10-15",
    guests: "緑川蒼",
  }),
  row({
    id: 6,
    title: "E6 今日が出演日",
    start_date: "2026-10-20",
    end_date: "2026-10-20",
    guests: "金田夏",
    guest_dates: "2026-10-20",
  }),
  row({
    id: 7,
    title: "E7 名前にHTML",
    start_date: "2026-10-01",
    end_date: "2026-11-30",
    guests: `<img src=x onerror=alert(1)>|"引用符"|A&B|桃井風|紫野空`,
    guest_dates: "2026-10-30",
  }),
];
let ev = await load("event", FIX);
let T = byTitle(ev);
const tab = TABS.event;
const on = (st, v = true) => (st.flags.guestOnly = v);
const run = (st) => titles(ev.filter((it) => matchesFilters(tab, st, it)));
const st = () => STATES.event;

reset();
on(st());
check(
  "10/20: 出演あり = E1・E2・E6・E7（E3は過去・E5は終了・E4は出演者なし）",
  JSON.stringify(run(st())) ===
    JSON.stringify(
      titles([
        T["E1 展覧会（出演日2回）"],
        T["E2 出演日不明"],
        T["E6 今日が出演日"],
        T["E7 名前にHTML"],
      ]),
    ),
  run(st()).join(" / "),
);

// 日程で絞る: 出演日が期間の中にある行だけ（出演日が分からない行は会期で判定する）
const range = (a, b) => {
  st().rangeStart = a;
  st().rangeEnd = b;
};
range("2026-10-27", "2026-10-30");
check(
  "出演あり×10/27〜30: E1は期間と会期は重なるが出演日(10/25・11/3)は外れる → 出ない。E2(出演日不明)とE7(10/30)は出る",
  JSON.stringify(run(st())) ===
    JSON.stringify(titles([T["E2 出演日不明"], T["E7 名前にHTML"]])),
  run(st()).join(" / "),
);
on(st(), false);
check(
  "出演チップを外せば、同じ期間でE1は会期で出る（絞り込みが効くのはチップを立てたときだけ）",
  run(st()).includes("E1 展覧会（出演日2回）"),
);
on(st());
range("2026-10-24", "2026-10-26");
check(
  "出演あり×10/24〜26: E1(10/25)だけ（E2は会期が重なり出演日不明なので出る）",
  JSON.stringify(run(st())) ===
    JSON.stringify(titles([T["E1 展覧会（出演日2回）"], T["E2 出演日不明"]])),
  run(st()).join(" / "),
);
range("2026-11-02", "2026-11-04");
check(
  "出演あり×11/2〜4: E1(11/3)だけ",
  JSON.stringify(run(st())) === JSON.stringify(["E1 展覧会（出演日2回）"]),
  run(st()).join(" / "),
);

// 件数バッジ = 押した後の件数
const counts = (state) => flagCounts(tab, state, ev).guestOnly;
for (const [a, b] of [
  [null, null],
  ["2026-10-27", "2026-10-30"],
  ["2026-10-24", "2026-10-26"],
  ["2026-11-02", "2026-11-04"],
  ["2026-12-01", "2026-12-31"],
]) {
  on(st(), false);
  st().rangeStart = a;
  st().rangeEnd = b;
  const shown = counts(st()); // まだ立てていない状態で数えた「立てたら何件か」
  on(st(), true);
  const after = ev.filter((it) => matchesFilters(tab, st(), it)).length;
  check(
    `チップの件数と押した後の件数が一致（${a ?? "全期間"}〜${b ?? ""}）`,
    shown === after,
    `${shown} vs ${after}`,
  );
  const stillOn = counts(st()); // 立てた状態でも同じ数字になる
  check(
    `立てた後もバッジの数字は変わらない（${a ?? "全期間"}）`,
    stillOn === after,
    `${stillOn} vs ${after}`,
  );
}

// 日付をまたぐ
reset();
on(st());
setToday("2026-10-26");
check(
  "10/26: E6(10/20)は終わり、E1(11/3が未来)は残る",
  (() => {
    const r = run(st());
    return (
      !r.includes("E6 今日が出演日") && r.includes("E1 展覧会（出演日2回）")
    );
  })(),
  run(st()).join(" / "),
);
setToday("2026-11-03");
check("11/3（当日）: E1は残る", run(st()).includes("E1 展覧会（出演日2回）"));
setToday("2026-11-04");
check(
  "11/4: E1・E7の出演日はすべて過去 → 出演あり0件（E2も会期が10/31で終わっている）",
  run(st()).length === 0,
  run(st()).join(" / "),
);
setToday("2026-10-20");

console.log("\n--- 検索の索引 ---");
const hits = (qs) => {
  reset();
  st().q = qs;
  return run(st());
};
check(
  "出演者名で検索すると出る（青山龍）",
  JSON.stringify(hits("青山龍")) === JSON.stringify(["E1 展覧会（出演日2回）"]),
);
check(
  "出演が終わった人の名前では出ない（黒田澪・E3は出演日が過去）",
  hits("黒田澪").length === 0,
);
check(
  "会期が終わった行の出演者名では出ない（緑川蒼・E5）",
  hits("緑川蒼").length === 0,
);
setToday("2026-11-04");
check(
  "日付をまたぐと索引から外れる（11/4に青山龍で検索）",
  hits("青山龍").length === 0,
);
setToday("2026-10-20");
check("戻すとまた出る", hits("青山龍").length === 1);
reset();

/* ================================================================
   4. カードの表示
   ================================================================ */
console.log("\n--- カード ---");
const html = (it, terms = [], t = tab, s = st()) => cardHtml(t, it, s, terms);
const h1 = html(T["E1 展覧会（出演日2回）"]);
check(
  "出演行が出る（ラベル「出演」）",
  /class="guest-line"><span class="guest-label">出演<\/span>/.test(h1),
);
/* 出演行（guest-line）の文字だけを取り出す。人のボタンと名前のボタンを含むので、
   タグを外して文字として読む（「くわしく」の中の全員の一覧は含めない） */
const guestLine = (h) =>
  ((h.match(/<p class="guest-line">[\s\S]*?<\/p>/) || [""])[0] || "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, "");
check("名前が並ぶ（青山龍・白石凛）", guestLine(h1).includes("青山龍・白石凛"));
check(
  "これからの出演日が添えられる（10.25 と 11.3）",
  /10\.25\(日\).*11\.3\(火\)/s.test(h1),
  (h1.match(/guest-when">([^<]*)/) || [])[1],
);
check(
  "「くわしく」に guest_note が出る",
  h1.includes("出演の詳細") && h1.includes("10/25 14:00 トーク"),
);
check(
  "出演者のいない行には出演行が出ない",
  !html(T["E4 出演者なし"]).includes("guest-line"),
);
const h3 = html(T["E3 出演は過ぎた"]);
check(
  "出演が終わった行は、出演行も guest_note も出ない（終わった案内を現在形で出さない）",
  !h3.includes("guest-line") &&
    !h3.includes("出演の詳細") &&
    !h3.includes("黒田澪"),
);
setToday("2026-10-26");
const h1b = html(T["E1 展覧会（出演日2回）"]);
check(
  "10/26には過ぎた出演日(10/25)を出さず、11.3だけ",
  !/10\.25/.test((h1b.match(/guest-when">([^<]*)/) || [])[1] || "") &&
    /11\.3/.test(h1b),
);
setToday("2026-10-20");
const h7 = html(T["E7 名前にHTML"]);
check(
  "名前のHTMLは必ずエスケープされる（タグが生えない）",
  !h7.includes("<img src=x") &&
    h7.includes("&lt;img src=x onerror=alert(1)&gt;"),
);
check(
  "引用符・& もエスケープ",
  h7.includes("&quot;引用符&quot;") && h7.includes("A&amp;B"),
);
check(
  "4人目以降は「ほかN名」に畳む（5人 → 3人＋ほか2名）",
  guestLine(h7).includes("ほか2名") &&
    !guestLine(h7).includes("桃井風") &&
    !guestLine(h7).includes("紫野空"),
);
check(
  "畳んだ人も「くわしく」の中に全員並ぶ（人のボタンを届けるため）",
  /class="art-detail"/.test(h7) &&
    h7.slice(h7.indexOf('class="art-detail"')).includes("桃井風") &&
    h7.slice(h7.indexOf('class="art-detail"')).includes("紫野空"),
);
const h7q = html(T["E7 名前にHTML"], searchTerms("紫野空"));
check(
  "検索語に当たった名前は先頭へ繰り上がり、ハイライトされる（4人目でも手がかりが残る）",
  /<mark>紫野空<\/mark>/.test(h7q) &&
    !guestLine(h7q).includes("桃井風") &&
    guestLine(h7q).indexOf("紫野空") < guestLine(h7q).indexOf("ほか2名"),
);
check(
  "出演日が1つだけ（E7: 10/30）でも出る",
  /10\.30/.test((h7.match(/guest-when">([^<]*)/) || [])[1] || ""),
);
const h2 = html(T["E2 出演日不明"]);
check(
  "出演日不明の行は日付の括弧を出さない",
  h2.includes("赤松蓮") && !h2.includes("guest-when"),
);

console.log("\n--- 映画タブ ---");
const MCOLS = [
  "id",
  "title",
  "genre",
  "screening_type",
  "area",
  "theater",
  "pref",
  "release_date",
  "end_date",
  "price",
  "source",
  "url",
  "desc",
  "guests",
  "guest_dates",
  "guest_note",
];
const mrow = (o) => ({
  genre: "jp-live",
  screening_type: "new",
  area: "東京都",
  theater: "テスト劇場",
  pref: "tokyo",
  price: "一般1,900円",
  source: "公式サイト",
  url: "https://example.com/",
  desc: "テスト用の映画行。",
  ...o,
});
const mv = await load(
  "movie",
  [
    mrow({
      id: 1,
      title: "M1 舞台挨拶つき",
      release_date: "2026-10-10",
      end_date: "2026-11-10",
      guests: "監督太郎|主演花子",
      guest_dates: "2026-10-24",
      guest_note: "10/24 上映後 舞台挨拶（シアター1）",
    }),
    mrow({
      id: 2,
      title: "M2 普通の上映",
      release_date: "2026-10-10",
      end_date: "2026-11-10",
    }),
  ],
  MCOLS,
);
const MT = byTitle(mv);
const mtab = TABS.movie;
const mh = cardHtml(mtab, MT["M1 舞台挨拶つき"], STATES.movie, []);
check("映画の出演行のラベルは「登壇」", /guest-label">登壇</.test(mh));
check(
  "映画の「くわしく」は「登壇の詳細」",
  mh.includes("登壇の詳細") && mh.includes("舞台挨拶（シアター1）"),
);
reset();
STATES.movie.flags.guestOnly = true;
check(
  "映画: 舞台挨拶つきだけが残る",
  JSON.stringify(
    titles(mv.filter((it) => matchesFilters(mtab, STATES.movie, it))),
  ) === JSON.stringify(["M1 舞台挨拶つき"]),
);
reset();
check(
  "映画のカレンダー初期日付は出演日（明日以降の最初）",
  Sch.suggestedVisitDate(MT["M1 舞台挨拶つき"], "2026-10-20") === "2026-10-24",
);
check(
  "出演者のいない映画は従来どおり（明日）",
  Sch.suggestedVisitDate(MT["M2 普通の上映"], "2026-10-20") === "2026-10-21",
);

console.log("\n--- ライブ・列が無いCSV ---");
await loadTab("live");
const lh = cardHtml(TABS.live, ITEMS.live[0], STATES.live, []);
check(
  "ライブのカードに出演者行(guest-line)は出ない",
  !lh.includes("guest-line"),
);
// 3列が無い旧形式のCSV（移行前）でも読める
const OLD = COLS.slice(0, 12);
const old = await load(
  "event",
  [
    row({
      id: 1,
      title: "旧形式",
      start_date: "2026-10-01",
      end_date: "2026-11-30",
    }),
  ],
  OLD,
);
check(
  "3列が無いCSVでも読める・出演者は空",
  old.length === 1 && activeGuests(old[0]).length === 0,
);
reset();
on(st());
check(
  "その状態で出演チップを立てても落ちず0件",
  old.filter((it) => matchesFilters(tab, st(), it)).length === 0,
);
check("件数バッジも0", flagCounts(tab, st(), old).guestOnly === 0);
reset();

/* ================================================================
   5. タブを移るとき
   ================================================================ */
console.log("\n--- タブの持ち越し ---");
reset();
STATES.event.flags.guestOnly = true;
const plan = carryPlan("event", "movie");
carryFilters("event", "movie");
check(
  "event → movie: 出演チップは映画へ持ち越される（同じ id）",
  STATES.movie.flags.guestOnly === true,
);
check("carryPlan も同じ予測を返す", plan.next.flags.guestOnly === true);
check("event → movie では何も落とさない", plan.dropped.length === 0);
STATES.movie.flags.guestOnly = true;
const planLive = carryPlan("movie", "live");
check(
  "movie → live: 落とした条件として映画の文言が知らされる（トースト用）",
  planLive.dropped.includes(TABS.movie.guestWords.chip),
  planLive.dropped.join(","),
);
carryFilters("movie", "live");
check(
  "movie → live: ライブには無いチップなので落ちる（キーが生えない）",
  !("guestOnly" in STATES.live.flags),
);
reset();

/* ================================================================
   6. 総当たり（乱数で作った行×日付×期間を、仕様どおりの別実装と突き合わせる）
   ================================================================ */
console.log("\n--- 総当たり ---");
let seed = 20261020;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (n) => Math.floor(rnd() * n);
const addDays = (ymd, n) => {
  const d = new RealDate(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const BASE = "2026-10-01";
const rows = [];
for (let i = 1; i <= 160; i++) {
  const start = addDays(BASE, pick(50));
  const open = rnd() < 0.1; // 終了日が空（終わり未定）
  const end = open ? "" : addDays(start, pick(45));
  let guests = "";
  let gd = "";
  if (rnd() < 0.65) {
    guests = ["甲", "乙", "丙"]
      .slice(0, 1 + pick(3))
      .map((x) => x + i)
      .join("|");
    const k = pick(4); // 出演日の個数（0 = 不明）
    const days = new Set();
    for (let j = 0; j < k; j++) days.add(addDays(start, pick(60) - 3));
    gd = [...days].sort().join("|");
    // 読めない値・順不同を混ぜる（画面は検証を通ったことを前提にしない。第3.5節）
    if (rnd() < 0.12) gd = (gd ? gd + "|" : "") + "TBD";
    else if (rnd() < 0.1) gd = gd.split("|").reverse().join("|");
  }
  rows.push(
    row({
      id: i,
      title: `R${i}`,
      start_date: start,
      end_date: end,
      guests,
      guest_dates: gd,
    }),
  );
}
ev = await load("event", rows);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const refDays = (r) =>
  (r.guest_dates ? r.guest_dates.split("|") : []).filter((d) => ISO.test(d));
const refActive = (r, today) => {
  if (!r.guests) return false;
  const days = refDays(r);
  if (days.length) return days.some((d) => d >= today);
  return !(r.end_date && r.end_date < today);
};
const refShown = (r, today, rs, re, guestOn) => {
  if (r.end_date && r.end_date < today) return false; // 終了は既定で隠す（showEnded なし）
  if (guestOn && !refActive(r, today)) return false;
  if (rs && re) {
    if (r.end_date && r.end_date < rs) return false;
    if (r.start_date > re) return false;
    if (guestOn && refDays(r).length) {
      if (!refDays(r).some((d) => d >= rs && d <= re)) return false;
    }
  }
  return true;
};
let bad = 0,
  trials = 0;
for (let t = 0; t < 500; t++) {
  const today = addDays(BASE, 5 + pick(100));
  setToday(today);
  reset();
  const useRange = rnd() < 0.7;
  const rs = useRange ? addDays(BASE, pick(120)) : null;
  const re = useRange ? addDays(rs, pick(14)) : null;
  st().rangeStart = rs;
  st().rangeEnd = re;
  for (const guestOn of [false, true]) {
    on(st(), guestOn);
    const got = titles(ev.filter((it) => matchesFilters(tab, st(), it)));
    const want = titles(
      ev.filter((it) => {
        const r = rows[Number(it.title.slice(1)) - 1];
        return refShown(r, today, rs, re, guestOn);
      }),
    );
    trials++;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      bad++;
      if (bad <= 3)
        console.log(
          `    食い違い today=${today} range=${rs}〜${re} guestOn=${guestOn} 実装${got.length}件 仕様${want.length}件`,
        );
    }
  }
  // バッジ（立てていない状態で数える）= 立てた後の件数
  on(st(), false);
  const badge = flagCounts(tab, st(), ev).guestOnly;
  const wantBadge = ev.filter((it) =>
    refShown(rows[Number(it.title.slice(1)) - 1], today, rs, re, true),
  ).length;
  trials++;
  if (badge !== wantBadge) {
    bad++;
    if (bad <= 3)
      console.log(
        `    バッジ食い違い today=${today} range=${rs}〜${re} バッジ${badge} 仕様${wantBadge}`,
      );
  }
}
check(
  `乱数500通り×(一覧2＋バッジ1)＝${trials}判定がすべて仕様と一致`,
  bad === 0,
  `${bad}件の食い違い`,
);
setToday("2026-10-20");
reset();

console.log(
  failures.length
    ? `\nNG ${failures.length}件: ${failures.join(", ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
