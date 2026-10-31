/* ようこそカードと今週のボード（assets/js/onboard.js）の回帰テスト。DOM不要。

   壊れ方は3種類ある。どれも画面では「出ない」「出すぎる」「数が合わない」としか見えないので、ここで固定する。
     1. いつ出すか   — 更新のたびに出る／初回はボードを出さない／日付が戻っても出さない／書けない端末で出し続けない
     2. 何を載せるか — 件数が一覧の「◯件を表示」と一致する／中身の無いページを作らない／お気に入りの新着の数え方
     3. 文言         — 3枚目に♡★が文中で強調されない（お気に入りは「先頭にまとまる」だけを伝える）

   前半は合成した状態で判断の規則そのものを、後半は実データで件数を「別の方法で数えた値」と突き合わせる
   （実データの件数は毎週変わるので、固定の数は書かない）。

   使い方（リポジトリのルートから）:
     node tools/onboard_test.mjs
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
let storageBroken = false;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (storageBroken) throw new Error("QuotaExceededError");
    store.set(k, String(v));
  },
  removeItem: (k) => store.delete(k),
};
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
};

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}${detail ? "  — " + detail : ""}`,
  );
  if (!ok) failures.push(name);
};

const O = await import("../assets/js/onboard.js");
const D = await import("../assets/js/data.js");
const { TABS, TAB_ORDER } = await import("../assets/js/config.js");
const F = await import("../assets/js/filters.js");
const S = await import("../assets/js/state.js");
const { presetRange } = await import("../assets/js/schedule.js");
const { isFreePrice } = await import("../assets/js/util.js");

/* ---------- 1. いつ出すか（合成） ---------- */
console.log("\n--- いつ出すか ---");
const dates = (e, m, l) => ({ event: e, movie: m, live: l });
const uids = (e, m, l) => ({ event: e, movie: m, live: l });
const range = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const U = uids(range("e", 10), range("m", 10), range("l", 10));
const REC = {
  v: 1,
  seen: dates("2026-10-21", "2026-10-22", "2026-10-23"),
  cur: U,
  fresh: {},
};

let r = O.planWeekly({
  rec: null,
  dates: dates("2026-10-28", "2026-10-29", "2026-10-30"),
  uids: U,
  welcomeNow: false,
});
check("記録が無い（初めての端末）は出さずに覚える", r.action === "baseline");
check(
  "覚える記録に、いまの更新日と一覧が入る",
  r.rec.seen.live === "2026-10-30" && r.rec.cur.event.length === 10,
);

r = O.planWeekly({
  rec: REC,
  dates: dates("2026-10-28", "2026-10-29", "2026-10-30"),
  uids: U,
  welcomeNow: true,
});
check(
  "ようこそカードを出した回は、更新があってもボードを出さない",
  r.action === "baseline",
);

r = O.planWeekly({
  rec: REC,
  dates: dates("2026-10-21", "2026-10-22", "2026-10-23"),
  uids: U,
  welcomeNow: false,
});
check("更新日が前回と同じなら何もしない", r.action === "none");

r = O.planWeekly({
  rec: REC,
  dates: dates("2026-10-21", "2026-10-22", "2026-10-30"),
  uids: U,
  welcomeNow: false,
});
check(
  "どれか1タブでも進んだら出す",
  r.action === "show" && r.advanced.join() === "live",
  r.advanced.join(),
);

r = O.planWeekly({
  rec: REC,
  dates: dates("2026-10-01", "2026-10-02", "2026-10-03"),
  uids: U,
  welcomeNow: false,
});
check("更新日が前回より古い（戻った）ときは出さない", r.action === "none");

r = O.planWeekly({
  rec: REC,
  dates: dates("2026-10-28", null, "2026-10-30"),
  uids: U,
  welcomeNow: false,
});
check("更新日が1つでも分からないときは判断しない", r.action === "none");
r = O.planWeekly({
  rec: REC,
  dates: dates("2026-10-28", "2026-10-29", "2026-10-30"),
  uids: uids(U.event, null, U.live),
  welcomeNow: false,
});
check("読めていないタブがあるときは判断しない", r.action === "none");

// 新着の差
const NOW = uids([...U.event, "e-new1", "e-new2"], U.movie, U.live);
r = O.planWeekly({
  rec: REC,
  dates: dates("2026-10-28", "2026-10-29", "2026-10-30"),
  uids: NOW,
  welcomeNow: false,
});
check(
  "前回の一覧に無かった uid だけが新着になる",
  r.rec.fresh.event.join() === "e-new1,e-new2" &&
    r.rec.fresh.movie.length === 0,
  JSON.stringify(r.rec.fresh.event),
);
check(
  "出したあとの記録は、いまの更新日と一覧に進む",
  r.rec.seen.event === "2026-10-28" && r.rec.cur.event.length === 12,
);

const BULK = uids(range("x", 10), U.movie, U.live);
r = O.planWeekly({
  rec: REC,
  dates: dates("2026-10-28", "2026-10-29", "2026-10-30"),
  uids: BULK,
  welcomeNow: false,
});
check(
  "6割以上が新しいとき（一括の入れ替わり）は新着に数えない",
  r.rec.fresh.event.length === 0,
);

r = O.planWeekly({
  rec: { ...REC, cur: { ...U, event: [] } },
  dates: dates("2026-10-28", "2026-10-29", "2026-10-30"),
  uids: NOW,
  welcomeNow: false,
});
check(
  "比べる前回の一覧が空のタブは、新着を持たない",
  r.rec.fresh.event.length === 0,
);

// 書けない端末
console.log("\n--- 端末への記録 ---");
check("書ける端末では canPersist が true", O.canPersist() === true);
storageBroken = true;
check(
  "書けない端末では canPersist が false（案内を出し続けないため）",
  O.canPersist() === false,
);
check("書けないとき writeWeekly は false を返す", O.writeWeekly(REC) === false);
check(
  "書けないとき markWelcomeSeen は false を返す",
  O.markWelcomeSeen() === false,
);
storageBroken = false;
O.writeWeekly(REC);
check("書いた記録を読み戻せる", O.readWeekly()?.seen.live === "2026-10-23");
store.set(O.WEEKLY_KEY, "{broken");
check(
  "壊れた記録は無いものとして扱う（起動を止めない）",
  O.readWeekly() === null,
);
store.set(O.WEEKLY_KEY, JSON.stringify({ seen: 1 }));
check("形の違う記録も無いものとして扱う", O.readWeekly() === null);
check("ようこそカードは、閉じる前は未読", O.isWelcomeSeen() === false);
O.markWelcomeSeen();
check("閉じたら既読になる", O.isWelcomeSeen() === true);

/* ---------- 3. 文言 ---------- */
console.log("\n--- ようこそカードの文言 ---");
const slides = O.welcomeSlides();
check("3枚ある", slides.length === 3);
const third = slides[2];
check(
  "3枚目の文章に ♡ ★ ☆ を書かない（強調しない）",
  !/[♡♥★☆]/.test(third.title + third.body),
  third.title + third.body,
);
check(
  "3枚目は「先頭にまとまる」を伝える",
  /先頭/.test(third.title) && /まとま/.test(third.body),
);
check("3枚目は保存先（この端末の中）も伝える", /この端末の中/.test(third.body));
check(
  "1枚目は読み込み前には件数を言わない（言えるのは読み終えてから）",
  !/約|NaN|undefined|null/.test(slides[0].body),
  slides[0].body,
);

/* ---------- 2. 何を載せるか（実データ） ---------- */
console.log("\n--- 今週のボード（実データ） ---");
await Promise.all([D.loadSpots(), D.loadTheaters(), D.loadVenues()]);
for (const k of TAB_ORDER) await D.loadTab(k);
TAB_ORDER.forEach((k) => S.resetState?.(k));

const blank = (k, extra = {}) => {
  const sets = {};
  TABS[k].facets.forEach((f) => (sets[f.id] = new Set()));
  const flags = {};
  TABS[k].flags.forEach((f) => (flags[f.id] = false));
  return {
    sets,
    flags,
    q: "",
    pref: null,
    venue: null,
    mapArea: null,
    rangeStart: null,
    rangeEnd: null,
    sortBy: "date",
    userLoc: null,
    ...extra,
  };
};
const count = (k, extra) =>
  D.ITEMS[k].filter((it) => F.matchesFilters(TABS[k], blank(k, extra), it))
    .length;

const total = TAB_ORDER.reduce((n, k) => n + count(k), 0);
check(
  "掲載中の合計が、3タブの「◯件を表示」の和と一致する",
  O.totalListed() === total,
  `${O.totalListed()} / ${total}`,
);
check(
  "1枚目の件数が入る（読み込み後）",
  /約[\d,]+件/.test(O.welcomeSlides()[0].body),
);

const D3 = { event: "2026-10-28", movie: "2026-10-29", live: "2026-10-30" };
let pages = O.buildBoard({
  dates: D3,
  advanced: ["event"],
  fresh: {},
  manual: false,
});
const ids = pages.map((p) => p.id);
check(
  "先頭は全体、末尾は最後のページ",
  ids[0] === "total" && ids.at(-1) === "last",
  ids.join(),
);
check(
  "お気に入りが無いときは、お気に入りのページを作らない",
  !ids.includes("fav"),
);
check("ページの id に重複がない", new Set(ids).size === ids.length);

const tp = pages[0];
check("全体の合計が一覧の件数と一致する", tp.total === total);
check(
  "内訳が3タブぶん",
  tp.breakdown.length === 3 && tp.breakdown.every((b) => b.n === count(b.tab)),
);
check(
  "進んだタブにだけ「更新」が付く",
  tp.updates
    .filter((u) => u.advanced)
    .map((u) => u.tab)
    .join() === "event",
);
const man = O.buildBoard({
  dates: D3,
  advanced: ["event"],
  fresh: {},
  manual: true,
})[0];
check(
  "日付のボタンから開いたときは、どのタブにも「更新」を付けない",
  man.updates.every((u) => !u.advanced),
);
check("更新日は月/日で出す", tp.updates[0].date === "10/28");

const wk = pages.find((p) => p.id === "weekend");
const [ws, we] = presetRange("weekend");
if (wk) {
  const expect = ["event", "live"]
    .map((k) => ({ k, n: count(k, { rangeStart: ws, rangeEnd: we }) }))
    .filter((x) => x.n);
  check(
    "今週末の件数が、日程の「今週末」で絞った一覧の件数と一致する",
    wk.counts.map((c) => `${c.tab}:${c.n}`).join() ===
      expect.map((x) => `${x.k}:${x.n}`).join(),
    wk.counts.map((c) => `${c.tab}:${c.n}`).join(),
  );
  check(
    "今週末の題名は最大3件で、重複しない",
    wk.items.length <= 3 &&
      new Set(wk.items.map((i) => i.title)).size === wk.items.length,
  );
  const freeWk = ["event", "live"].reduce(
    (acc, k) =>
      acc +
      D.ITEMS[k].filter(
        (it) =>
          F.matchesFilters(
            TABS[k],
            blank(k, { rangeStart: ws, rangeEnd: we }),
            it,
          ) && isFreePrice(it.price),
      ).length,
    0,
  );
  check(
    "今週末のうち無料の数が合う",
    wk.free === freeWk,
    `${wk.free} / ${freeWk}`,
  );
} else {
  check(
    "今週末に開催のものが無いときは、ページを作らない（実データに該当なし）",
    !ids.includes("weekend"),
  );
}

const fr = pages.find((p) => p.id === "free");
const freeAll = count("event", {
  flags: { ...blank("event").flags, freeOnly: true },
});
if (fr) {
  check(
    "無料の件数が「無料のものだけ」で絞った件数と一致する",
    fr.n === freeAll,
    `${fr.n} / ${freeAll}`,
  );
  const today = D.TODAY();
  const byKey = new Map(D.ITEMS.event.map((it) => [it.key, it]));
  const soon = fr.items.map((i) => {
    const it = byKey.get(i.key);
    return it.startDate > today ? it.startDate : today;
  });
  check(
    "無料の題名は、これから始まる日・本日（開催中）の順に並ぶ（古くから続くものが先頭を占めない）",
    soon.every((d, i) => i === 0 || soon[i - 1] <= d),
    soon.join(),
  );
  check("無料の題名は最大3件", fr.items.length <= 3);
} else check("無料が0件ならページを作らない", freeAll === 0);

const mv = pages.find((p) => p.id === "movies");
if (mv)
  check(
    "映画の題名は最大3件",
    mv.items.length <= 3 && mv.items.every((i) => i.tab === "movie"),
  );

check(
  "最後のページは、お気に入りが無ければ管理ボタンを出さない",
  pages.at(-1).hasFavs === false,
);

// お気に入りの新着
console.log("\n--- お気に入りの新着 ---");
const target = D.ITEMS.live.find((it) => it.venue && !F.hasEnded(it));
const spots = await import("../assets/js/spots.js");
const hit = spots.spotsOfItem(target)[0];
if (hit) {
  S.setFavSpot(hit.name, true);
  const freshUids = { event: [], movie: [], live: [target.uid] };
  pages = O.buildBoard({
    dates: D3,
    advanced: ["live"],
    fresh: freshUids,
    manual: false,
  });
  const fv = pages.find((p) => p.id === "fav");
  check("お気に入りの会場に新着があればページを作る", !!fv, hit.name);
  check(
    "新着が1件なら、件数も1件",
    fv && fv.count === 1,
    String(fv && fv.count),
  );
  // 場所と人の両方に当たる催しは、合計では1件と数える（グループは2つ出る）
  const A = await import("../assets/js/artists.js");
  const who = [...A.performersOf(target).values()][0];
  if (who) {
    S.setFavArtist(who, true);
    const p3 = O.buildBoard({
      dates: D3,
      advanced: [],
      fresh: freshUids,
      manual: false,
    }).find((p) => p.id === "fav");
    check(
      "場所と人の両方に当たる新着は、合計を1件と数え、グループは2つに分かれる",
      p3 && p3.count === 1 && p3.groups.length === 2,
      p3 && `${p3.count} / ${p3.groups.map((g) => g.kind).join()}`,
    );
    S.setFavArtist(who, false);
  }
  check("ページ順は 全体→お気に入り→…→最後", pages[1].id === "fav");
  check(
    "最後のページに管理ボタンが出る（お気に入りがあるとき）",
    pages.at(-1).hasFavs === true,
  );
  // 終わった催しは新着に数えない
  const ended = D.ITEMS.live.find((it) => F.hasEnded(it));
  if (ended) {
    const spotE = spots.spotsOfItem(ended)[0];
    if (spotE) {
      S.setFavSpot(spotE.name, true);
      const p2 = O.buildBoard({
        dates: D3,
        advanced: [],
        fresh: { event: [], movie: [], live: [ended.uid] },
        manual: false,
      });
      check(
        "終わった催しは新着に数えない",
        !p2.some(
          (p) =>
            p.id === "fav" &&
            p.groups.some((g) => g.items.some((i) => i.key === ended.key)),
        ),
      );
    }
  }
  // 新着が無ければ作らない
  pages = O.buildBoard({ dates: D3, advanced: [], fresh: {}, manual: true });
  check(
    "お気に入りがあっても新着が無ければ、そのページは作らない",
    !pages.some((p) => p.id === "fav"),
  );
  S.setFavSpot(hit.name, false);
} else {
  console.log(
    "  （実データに名簿と一致する会場が無いため、お気に入りの新着は合成で確認できない）",
  );
}

// 画面の部品を触らないこと（STATES・検索語を汚さない）
S.STATES.event.q = "秘密の検索語";
O.buildBoard({ dates: D3, advanced: [], fresh: {}, manual: true });
check(
  "ボードの組み立てが、閲覧者の検索語を消さない",
  S.STATES.event.q === "秘密の検索語",
);
check(
  "ボードの組み立てが、閲覧者の絞り込みを変えない",
  S.STATES.event.flags.freeOnly === false && !S.STATES.event.rangeStart,
);

console.log(
  failures.length
    ? `\n${failures.length} 件が失敗しました: ${failures.join(" / ")}`
    : "\nすべて通りました",
);
process.exit(failures.length ? 1 : 0);
