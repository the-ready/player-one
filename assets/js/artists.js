/* 「人」を3タブで共通に扱う層。お気に入りアーティストの鍵になる。

   出演者の持ち方がタブで違う。
     ライブ        … `artists` 列（主要な出演者）と、フェスの日割りラインナップ（lineups.csv の全出演者）
     イベント・映画 … いま残っている登壇者（`guests`。出演日を過ぎた人は schedule.js の activeGuests が外す）
   「この公演に、この人は出るか」を答えるのがこのモジュールで、どの表記も名前の照合キー
   （util.js の artistKey）にそろえて引く。お気に入りの保存は state.js が持つ。

   `artists` 列が空の行（タイトルに名前だけが出る単独公演など）は、出演者を知らないので
   どの人にも当たらない。タイトルから名前を拾うと、`HANA` が `HANABI` の公演に当たるような
   取り違えが起きるため、推測では補わない（設計書 第7.2.3節）。 */

import { artistKey, artistHead, fold } from "./util.js";
import { TAB_ORDER } from "./config.js";
import { ITEMS, LOAD, lineupRows, lineupArtistNames } from "./data.js";
import { TODAY, activeGuests } from "./schedule.js";
import {
  favArtistCount,
  favArtistByKey,
  favArtistRev,
  cleanArtistName,
} from "./state.js";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY = Object.freeze([]);

/* ---------- 行の出演者 ---------- */

/* 行 → 出演者（artistKey -> 表示名）。同じ人が `artists` とラインナップの両方に出るので
   キーで束ねる。出演の有無は本日から決まる（登壇者の期限）ので、日付をまたいだら捨てる。
   検索の索引づくりと同じく、1行が最大200組になるので行に覚えさせる。 */
export function performersOf(it) {
  const today = TODAY();
  const c = it._pi;
  if (c && c.today === today) return c.map;
  const map = new Map();
  const add = (n) => {
    const k = artistKey(n);
    if (k && !map.has(k)) map.set(k, n);
  };
  (it.artists || []).forEach(add);
  lineupArtistNames(it.lineupId).forEach(add);
  activeGuests(it).forEach(add);
  it._pi = { today, map };
  return map;
}

/* ラインナップの「どの日に誰が出るか」。ラインナップの行は読み込み後に変わらないので、
   行の配列ごとに1度だけ組む。日付の無い行（日割り未発表）は日として数えない。 */
const dayCache = new WeakMap();
function lineupDays(rows) {
  let m = dayCache.get(rows);
  if (!m) {
    m = new Map();
    rows.forEach((r) => {
      if (!ISO_DAY.test(r.date || "")) return;
      const k = artistKey(r.artist);
      if (!k) return;
      if (!m.has(k)) m.set(k, new Set());
      m.get(k).add(r.date);
    });
    dayCache.set(rows, m);
  }
  return m;
}

/** その人がこの行でこれから出る日（ISO・昇順）。日が決まっていなければ空。 */
export function upcomingDaysOf(it, key, today = TODAY()) {
  if (!it.lineupId) return EMPTY;
  const rows = lineupRows(it.lineupId);
  const set = rows.length ? lineupDays(rows).get(key) : null;
  if (!set) return EMPTY;
  return [...set].filter((d) => d >= today).sort();
}

/* ---------- お気に入りとの照合 ---------- */

/* その行に出るお気に入りの人。{ key, name（登録名）, days }[] を出演の並び順で返す。
   絞り込み・先頭セクションの振り分け・カードの印・チップの件数のすべてがここを引くので、
   登録の増減（favArtistRev）と日付が変わらない限り、行ごとに覚えた答えを返す。
   返す配列は共有されるため、呼び出し側では書き換えないこと。 */
export function favArtistsOf(it) {
  if (favArtistCount() === 0) return EMPTY;
  const rev = favArtistRev();
  const today = TODAY();
  const c = it._fa;
  if (c && c.rev === rev && c.today === today) return c.hits;
  const hits = [];
  for (const k of performersOf(it).keys()) {
    const name = favArtistByKey(k);
    if (name !== undefined)
      hits.push({ key: k, name, days: upcomingDaysOf(it, k, today) });
  }
  const out = hits.length ? hits : EMPTY;
  it._fa = { rev, today, hits: out };
  return out;
}

export const isFavArtistItem = (it) => favArtistsOf(it).length > 0;

/* ---------- 「前回から追加」 ----------
   お気に入りの人の公演が、前回この端末で見たときから増えたかどうか。
   「前回」は、この端末で最後に一覧を読み込んだ訪問が基準になる。サーバーを持たないので
   端末の中に、読み込んだ公演の一覧（uid）を覚えておいて、次の訪問で差を取る。

   訪問の区切りは時間で決める（VISIT_GAP_MS）。区切りを持たず読み込みのたびに前回と比べると、
   画面を開いた直後に自動更新（Service Worker）で読み直されたり、少し間を置いて開き直したり
   しただけで、見せたはずの印が消える。区切り内の読み直しは比べる相手（base）を動かさない。

   次のときは印を付けない（付けると、新しい公演ではないものが並ぶため）。
     ・初めて比べるとき（比べる前回が無い）
     ・一覧の半分以上が「新しい」ときの一括入れ替わり（uid の作り方の変更など、前回と比べられない）
   お気に入りが1人もいない間は、一覧を覚えない（使っていない人の端末を埋めないため）。
   最初の1人を登録した時点から覚え始める（reconcileSeen）。 */
const SEEN_KEY = "eventboard.favartseen.v1";
export const VISIT_GAP_MS = 30 * 60 * 1000;
const NEW_RATIO_CAP = 0.6;
let newUids = {};
TAB_ORDER.forEach((k) => {
  newUids[k] = new Set();
});

function readSeen() {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function writeSeen(all) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(all));
  } catch {
    /* 保存できなくても、このページを開いている間の印は付く */
  }
}
function clearSeen() {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    /* 消せなくても害は無い（次に登録したときに作り直す） */
  }
}
const validRec = (r) =>
  r &&
  Array.isArray(r.base) &&
  Array.isArray(r.cur) &&
  Number.isFinite(r.at) &&
  r;

/** そのタブを読み込んだ直後に呼ぶ。印を決め、いまの一覧を「前回」として覚える。 */
export function syncSeen(tabKey, now = Date.now()) {
  newUids[tabKey] = new Set();
  if (favArtistCount() === 0) return;
  const uids = (ITEMS[tabKey] || []).map((it) => it.uid);
  if (!uids.length) return; // 空の読み込みで、覚えている前回を消さない
  const all = readSeen();
  const rec = validRec(all[tabKey]);
  let base;
  if (!rec) base = uids;
  // 時計が戻っている（at が未来）場合も、新しい訪問として扱う
  else if (now - rec.at > VISIT_GAP_MS || rec.at > now) base = rec.cur;
  else base = rec.base;
  const baseSet = new Set(base.filter((x) => typeof x === "string"));
  const fresh = uids.filter((u) => !baseSet.has(u));
  newUids[tabKey] =
    fresh.length > uids.length * NEW_RATIO_CAP ? new Set() : new Set(fresh);
  all[tabKey] = { base, cur: uids, at: now };
  writeSeen(all);
}

/** お気に入りの登録が増減したあとに呼ぶ。最初の1人で覚え始め、0人に戻ったら全部捨てる。 */
export function reconcileSeen(now = Date.now()) {
  if (favArtistCount() === 0) {
    clearSeen();
    TAB_ORDER.forEach((k) => {
      newUids[k] = new Set();
    });
    return;
  }
  const all = readSeen();
  let dirty = false;
  TAB_ORDER.forEach((k) => {
    if (LOAD[k].state !== "done" || validRec(all[k])) return;
    const uids = ITEMS[k].map((it) => it.uid);
    if (!uids.length) return;
    all[k] = { base: uids, cur: uids, at: now };
    newUids[k] = new Set();
    dirty = true;
  });
  if (dirty) writeSeen(all);
}

/** この行は、前回この端末で見たときには無かった公演か。 */
export const isNewSinceVisit = (it) => !!newUids[it.tab]?.has(it.uid);

/* ---------- 名前の候補（管理シートの手入力） ---------- */

/* いまのデータにある出演者を、名前（括弧の補足を外したもの）ごとに数える。手入力の候補と、
   「いま予定なし」の判定の材料。count はこれから出る公演（終わった行を除く）の数で、
   終了の判定は filters.js にあるので、呼び出し側が渡す（artists.js が filters.js を
   読むと、filters.js が artists.js を読むのと循環するため）。 */
export function knownArtists(isLive) {
  const m = new Map();
  TAB_ORDER.forEach((tab) =>
    (ITEMS[tab] || []).forEach((it) => {
      const live = isLive(it);
      performersOf(it).forEach((name, k) => {
        let e = m.get(k);
        if (!e) {
          e = { key: k, name: artistHead(name), count: 0 };
          m.set(k, e);
        }
        if (live) e.count++;
      });
    }),
  );
  return [...m.values()];
}

/* ---------- 管理シートの手入力 ----------
   打った文字に合う候補と、Enter（「追加」）が何をするか。画面に触れない純粋な関数にして、
   DOM なしで試せるようにしている（tools/fav_artists_test.mjs）。 */

// かな・全角半角・大小の違いと空白は、検索と同じ畳み込みで吸収する
const squash = (s) => fold(s).replace(/\s+/g, "");

/** 打った文字に合う候補。すでに登録した人は出さない。前方が合うものを先に、
    同じ並びの中では予定の多い人を先に、最後は五十音順。 */
export function suggestArtists(query, known, isFav, limit = 8) {
  const q = squash(query);
  if (!q) return [];
  return known
    .map((k) => ({ k, f: squash(k.name) }))
    .filter(({ k, f }) => f.includes(q) && !isFav(k.name))
    .sort(
      (a, b) =>
        Number(b.f.startsWith(q)) - Number(a.f.startsWith(q)) ||
        b.k.count - a.k.count ||
        a.f.localeCompare(b.f, "ja"),
    )
    .slice(0, limit)
    .map(({ k }) => k);
}

/* Enter（「追加」）の動き。打ちかけの文字がそのまま登録されると、名前は完全一致でしか
   当たらないので、その人の公演がずっと先頭に出なくなる。だから、
     データにある名前と同じ → その名前を登録（登録済みなら、そう伝える）
     候補がある             → 先頭の候補を登録
     どちらも無い           → 登録しない。「この名前のまま登録」を明示的に押してもらう
   データに無い名前（発表前の人）は、押し間違いでなく意図して登録したものにするため。 */
export function planAdd(raw, known, isFav) {
  const text = String(raw == null ? "" : raw);
  const typed = cleanArtistName(text);
  if (!typed) return { kind: text.trim() ? "invalid" : "empty" };
  const key = artistKey(typed);
  const exact = known.find((k) => k.key === key);
  if (exact) return { kind: "add", name: exact.name, typed };
  const first = suggestArtists(typed, known, isFav, 1)[0];
  if (first) return { kind: "add", name: first.name, typed };
  return { kind: "raw", typed };
}
