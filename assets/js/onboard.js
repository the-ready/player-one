/* はじめての人への案内（ようこそカード）と、更新後に開く「今週のボード」の中身。
   画面には触れない。いつ出すか・何を載せるかの判断だけを持ち、描画は ui-welcome.js・ui-weekly.js、
   配線は main.js が受け持つ（DOM なしで試せるようにするため。tools/onboard_test.mjs）。

   端末に残すのは次の2つだけで、どちらも外部へは送らない（設計書 1.4）。
     eventboard.welcome.v1 … ようこそカードを閉じたか
     eventboard.weekly.v1  … 最後にボードを開いたときの3タブの更新日と、そのときの行の一覧（uid）、
                             そこで「新しい」と判定した uid */

import { TABS, TAB_ORDER, venueNames } from "./config.js";
import { ITEMS, LOAD, TODAY, updatedFor } from "./data.js";
import { matchesFilters, hasEnded } from "./filters.js";
import { isFreePrice, WD } from "./util.js";
import { presetRange } from "./schedule.js";
import { favSpotCount, favArtistCount, isFavSpot } from "./state.js";
import { spotsOfItem } from "./spots.js";
import { favArtistsOf } from "./artists.js";

export const WELCOME_KEY = "eventboard.welcome.v1";
export const WEEKLY_KEY = "eventboard.weekly.v1";

/* 一覧の6割以上が「新しい」のは、uid の作り方の変更や一括の入れ替わりで前回と比べられない
   ときなので、新着としては数えない（artists.js の「前回から追加」と同じ理由と同じ値）。 */
const NEW_RATIO_CAP = 0.6;
const PAGE_ITEMS = 3; // 1ページに並べる題名の数。これ以上は「ほか◯件」にたたむ
const FAV_GROUP_ITEMS = 2; // お気に入りのページは、場所・人ごとに並べる題名の数
const FAV_GROUPS = 3; // 同じく、1ページに出す場所・人の数
const MOVIE_DAYS = 7; // 「今週公開」の範囲（今日から数えて）

/* ---------- 端末への記録 ---------- */

const getLS = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const setLS = (k, v) => {
  try {
    localStorage.setItem(k, v);
    return true;
  } catch {
    return false;
  }
};

/* 書き込めない端末（容量いっぱい・保存を禁じた設定）では、閉じた記録が残らず、開くたびに
   同じ案内が出続ける。使い方の案内は繰り返し出すほど邪魔になるので、書けないときは出さない。 */
export function canPersist() {
  const k = "eventboard.probe";
  if (!setLS(k, "1")) return false;
  try {
    localStorage.removeItem(k);
  } catch {
    /* 消せなくても、書けたことは確かめられている */
  }
  return true;
}

export const isWelcomeSeen = () => getLS(WELCOME_KEY) === "1";
export const markWelcomeSeen = () => setLS(WELCOME_KEY, "1");

/* 端末の記録は、拡張機能や手での書き換え・別の版の書式で壊れうる。型が違うまま通すと、
   diffUids が起動のたびに TypeError で止まり、ボードが二度と自動で出ず、記録も書き直されない。
   タブごとに型まで確かめ、1つでも合わなければ記録が無いものとして扱う
   （次の起動で baseline として正しい形に書き直される）。
     seen … 更新日の文字列か無し／cur・fresh … uid（文字列）の配列か無し */
const isPlainObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isUidList = (v) => v == null || (Array.isArray(v) && v.every(isStr));

const validWeekly = (v) =>
  isPlainObj(v) &&
  isPlainObj(v.seen) &&
  isPlainObj(v.cur) &&
  isPlainObj(v.fresh) &&
  TAB_ORDER.every(
    (k) =>
      (v.seen[k] == null || isStr(v.seen[k])) &&
      isUidList(v.cur[k]) &&
      isUidList(v.fresh[k]),
  ) &&
  v;

export function readWeekly() {
  try {
    return validWeekly(JSON.parse(getLS(WEEKLY_KEY) || "null")) || null;
  } catch {
    return null;
  }
}
export const writeWeekly = (rec) => setLS(WEEKLY_KEY, JSON.stringify(rec));

/* ---------- いつ自動で出すか ---------- */

/** 3タブの更新日。どれか1つでも分からなければ null を含む（その回は判断しない）。 */
export function currentDates() {
  const d = {};
  TAB_ORDER.forEach((k) => {
    d[k] = updatedFor(k);
  });
  return d;
}

/** 3タブの行の uid。読み込めていないタブは null。 */
export function currentUids() {
  const u = {};
  TAB_ORDER.forEach((k) => {
    u[k] = LOAD[k].state === "done" ? ITEMS[k].map((it) => it.uid) : null;
  });
  return u;
}

function diffUids(prev, now) {
  const fresh = {};
  TAB_ORDER.forEach((k) => {
    const before = prev[k] || [];
    const base = new Set(before);
    const list = now[k].filter((u) => !base.has(u));
    // 比べる前回が空、または6割以上が新しいときは、比べられないものとして新着を持たない
    fresh[k] =
      !before.length || list.length > now[k].length * NEW_RATIO_CAP ? [] : list;
  });
  return fresh;
}

/* 起動のあと、3タブが読み終わった時点で呼ぶ。何をするかと、書き込む記録を返す（書くのは呼び出し側）。
     none     … 何もしない（更新日が進んでいない・判断できない）
     baseline … 出さずに、いまの更新日と一覧を既読として覚える
                （初めての端末・ようこそカードを出した回。初回に案内を2つ重ねないため）
     show     … 更新日が1つでも進んだので、ボードを出す。記録は「出したとき」に書く
   更新日が進んだかは「前回開いたときの更新日より新しいか」で見る。日付が戻ることは進んだと数えない。 */
export function planWeekly({ rec, dates, uids, welcomeNow }) {
  const complete = TAB_ORDER.every((k) => dates[k] && uids[k]);
  if (!complete) return { action: "none", rec, advanced: [] };
  const next = (fresh) => ({ v: 1, seen: { ...dates }, cur: uids, fresh });
  if (!rec || welcomeNow)
    return { action: "baseline", rec: next({}), advanced: [] };
  const advanced = TAB_ORDER.filter(
    (k) => !rec.seen[k] || dates[k] > rec.seen[k],
  );
  if (!advanced.length) return { action: "none", rec, advanced };
  return { action: "show", rec: next(diffUids(rec.cur, uids)), advanced };
}

/* ---------- ようこそカードの文言 ---------- */

/** 3タブの掲載中の件数（「◯件を表示」と同じ数え方）。読み込めていないタブがあれば null。 */
export function totalListed() {
  if (TAB_ORDER.some((k) => LOAD[k].state !== "done")) return null;
  return TAB_ORDER.reduce((n, k) => n + listed(k).length, 0);
}

export function welcomeSlides() {
  const total = totalListed();
  const n = total ? `あわせて約${total.toLocaleString("ja-JP")}件。` : "";
  return [
    {
      art: "tabs",
      title: "関東の「行きたい」を、1つの画面で。",
      // タブの名前（ライブ・フェス）は「・」を含むので、並べるときは読点で区切る（4つに読まれないため）
      body: `イベント、映画、ライブ・フェスを${n || "まとめて探せます。"}毎週、データを更新しています。`,
    },
    {
      art: "filters",
      title: "日程・エリア・地図で、行ける日と場所だけに。",
      body: "今週末だけ、現在地から近い順、地図に描いた円の中だけ。ほしい条件で、一覧をしぼれます。",
    },
    {
      art: "favs",
      // ここは「先頭にまとまる」だけを伝える。♡（行きたい）は先頭にまとまる機能ではないので書かない
      title: "お気に入りは、一覧の先頭に。",
      body: "よく行く会場や好きなアーティストを登録すると、その予定がいつも一覧のいちばん上にまとまります。登録はこの端末の中だけに保存されます。",
    },
  ];
}

/* ---------- 今週のボードの中身 ---------- */

/* 一覧と同じ数え方で数えるための、絞り込み状態の写し。STATES を触らない（検索語は3タブで共有の
   変数なので、state.js の newState を使うと閲覧者の検索語を消してしまう）。 */
function probe(k, extra = {}) {
  const tab = TABS[k];
  const sets = {};
  tab.facets.forEach((f) => {
    sets[f.id] = new Set();
  });
  const flags = {};
  tab.flags.forEach((f) => {
    flags[f.id] = false;
  });
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
}
function listed(k, extra) {
  const tab = TABS[k];
  const st = probe(k, extra);
  return ITEMS[k].filter((it) => matchesFilters(tab, st, it));
}

const md = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  return m ? `${Number(m[2])}/${Number(m[3])}` : "";
};
const mdw = (ymd) => {
  const base = md(ymd);
  if (!base) return "";
  return `${base}(${WD[new Date(`${ymd}T00:00:00`).getDay()]})`;
};
const spanText = (it) => {
  const s = mdw(it.startDate);
  const e = it.endDate && it.endDate !== it.startDate ? mdw(it.endDate) : "";
  if (s && e) return `${s}〜${e}`;
  return s || (e ? `〜${e}` : "");
};
const placeText = (it) => {
  const v = venueNames(it);
  if (!v.length) return "";
  return v.length > 2 ? `${v.slice(0, 2).join("・")}ほか` : v.join("・");
};
const ref = (it) => ({
  tab: it.tab,
  key: it.key,
  title: it.title,
  sub: [spanText(it), placeText(it)].filter(Boolean).join("　"),
});

/* 同じ題名の行（ツアーの各公演など）は1件にまとめて数える。ボードに同じ題が並ぶのを避ける。 */
function uniqueByTitle(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = `${it.tab}|${it.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const byStart = (a, b) =>
  (a.startDate || "9999").localeCompare(b.startDate || "9999") ||
  a.title.localeCompare(b.title, "ja");

/* 「いま行くなら」の並び。これから始まるものは始まる日の順、すでに始まっているものは本日として
   扱い、終わりが近い順に並べる。開始日だけで並べると、何か月も前に始まった展示が先頭を占め、
   ボードが「いま知らせたいもの」に見えなくなる。 */
const bySoon = (a, b) => {
  const t = TODAY();
  const ka = a.startDate > t ? a.startDate : t;
  const kb = b.startDate > t ? b.startDate : t;
  return (
    ka.localeCompare(kb) ||
    (a.endDate || "9999").localeCompare(b.endDate || "9999") ||
    a.title.localeCompare(b.title, "ja")
  );
};

/** お気に入りの場所・人の、前回のボードのあとに増えた予定。場所ごと・人ごとにまとめる。 */
function favNewGroups(fresh) {
  const groups = new Map(); // `${種別}|${名前}` -> { kind, label, items }
  const uids = new Set(); // 場所と人の両方に当たる催しを、合計では1件と数える
  const add = (kind, label, it) => {
    const key = `${kind}|${label}`;
    if (!groups.has(key)) groups.set(key, { kind, label, items: [] });
    groups.get(key).items.push(it);
    uids.add(it.uid);
  };
  TAB_ORDER.forEach((k) => {
    const set = new Set(fresh[k] || []);
    if (!set.size) return;
    ITEMS[k].forEach((it) => {
      if (!set.has(it.uid) || hasEnded(it)) return;
      if (favSpotCount() > 0)
        spotsOfItem(it).forEach((e) => {
          if (isFavSpot(e.name)) add("spot", e.name, it);
        });
      if (favArtistCount() > 0)
        favArtistsOf(it).forEach((h) => add("artist", h.name, it));
    });
  });
  const list = [...groups.values()]
    .map((g) => {
      const items = uniqueByTitle(g.items.sort(byStart));
      return {
        kind: g.kind,
        label: g.label,
        count: items.length,
        items: items.slice(0, FAV_GROUP_ITEMS).map(ref),
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ja"));
  return { list, total: uids.size };
}

const COUNT_LABELS = {
  event: "イベント",
  movie: "映画",
  live: "ライブ・フェス",
};

/* ボードのページを、画面に触れない形で組み立てる。中身が無いページは作らない。
     manual … 日付のボタンから開いた（更新があったかどうかに関わらず、3タブの更新日を並べる）
   返すページは { id, ... } の素朴なデータで、ui-weekly.js が HTML にする。 */
export function buildBoard({
  dates,
  advanced = [],
  fresh = {},
  manual = false,
}) {
  const pages = [];
  // 何も絞らない一覧は、全体・内訳・映画で同じものを使うので、タブごとに1回だけ数える
  const base = {};
  TAB_ORDER.forEach((k) => {
    base[k] = LOAD[k].state === "done" ? listed(k) : [];
  });
  const total = TAB_ORDER.reduce((n, k) => n + base[k].length, 0);
  // 新着の数。終わった催しは数えない（一覧の既定で隠れているものを「新着」と言わないため）
  const freshCount = TAB_ORDER.reduce((n, k) => {
    const set = new Set(fresh[k] || []);
    if (!set.size) return n;
    return n + ITEMS[k].filter((it) => set.has(it.uid) && !hasEnded(it)).length;
  }, 0);

  // 1. 全体
  pages.push({
    id: "total",
    manual,
    total,
    breakdown: TAB_ORDER.filter((k) => LOAD[k].state === "done").map((k) => ({
      tab: k,
      label: COUNT_LABELS[k],
      n: base[k].length,
    })),
    updates: TAB_ORDER.map((k) => ({
      tab: k,
      label: COUNT_LABELS[k],
      date: md(dates[k]),
      advanced: !manual && advanced.includes(k),
    })),
    freshCount,
  });

  // 2. お気に入りの新着
  const favNew = favNewGroups(fresh);
  if (favNew.list.length)
    pages.push({
      id: "fav",
      count: favNew.total,
      groups: favNew.list.slice(0, FAV_GROUPS),
      more: Math.max(0, favNew.list.length - FAV_GROUPS),
    });

  // 3. 今週末（イベント・ライブ・フェス）
  const [ws, we] = presetRange("weekend");
  const wk = ["event", "live"]
    .filter((k) => LOAD[k].state === "done")
    .map((k) => ({
      tab: k,
      label: COUNT_LABELS[k],
      items: listed(k, { rangeStart: ws, rangeEnd: we }),
    }))
    .filter((w) => w.items.length);
  if (wk.length) {
    // 週末の中で始まるものを先に。長く続く展示ばかりが並ぶと「今週末のおすすめ」に見えない
    const starts = (it) => (it.startDate >= ws && it.startDate <= we ? 0 : 1);
    const pool = uniqueByTitle(wk.flatMap((w) => w.items)).sort(
      (a, b) => starts(a) - starts(b) || bySoon(a, b),
    );
    pages.push({
      id: "weekend",
      range: ws === we ? mdw(ws) : `${mdw(ws)}・${mdw(we)}`,
      counts: wk.map((w) => ({
        tab: w.tab,
        label: w.label,
        n: w.items.length,
      })),
      items: pool.slice(0, PAGE_ITEMS).map(ref),
      free: wk.reduce(
        (n, w) => n + w.items.filter((it) => isFreePrice(it.price)).length,
        0,
      ),
    });
  }

  // 4. 無料（「無料のものだけ」と同じ判定。イベントの数を出す）
  if (LOAD.event.state === "done") {
    const free = listed("event", {
      flags: { ...probe("event").flags, freeOnly: true },
    });
    if (free.length)
      pages.push({
        id: "free",
        n: free.length,
        items: uniqueByTitle(free.sort(bySoon)).slice(0, PAGE_ITEMS).map(ref),
      });
  }

  // 5. 今週公開の映画
  if (LOAD.movie.state === "done") {
    const t = TODAY();
    const end = new Date(`${t}T00:00:00`);
    end.setDate(end.getDate() + MOVIE_DAYS - 1);
    const endIso = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
    const releases = uniqueByTitle(
      base.movie
        .filter(
          (it) =>
            it.startDate >= t &&
            it.startDate <= endIso &&
            (it.screeningType || []).includes("new"),
        )
        .sort(byStart),
    );
    if (releases.length)
      pages.push({
        id: "movies",
        n: releases.length,
        items: releases.slice(0, PAGE_ITEMS).map((it) => ({
          ...ref(it),
          sub: `${mdw(it.startDate)}公開　${placeText(it)}`.trim(),
        })),
      });
  }

  // 6. 最後
  pages.push({
    id: "last",
    hasFavs: favSpotCount() > 0 || favArtistCount() > 0,
  });
  return pages;
}
