/* 絞り込み・並べ替えの判定。3タブとも同じ関数を通る。
   タブごとの違いは config.js のファセット宣言だけが持つ。 */

import { DAY_MS, haversineKm, searchTerms } from "./util.js";
import { CLOSED_ONSALE, venueNames } from "./config.js";
import { TODAY, ITEMS } from "./data.js";
import { isFav } from "./state.js";

/* ---------- 日付まわり ---------- */

// TODAY からの日数。未来が正、過去が負。パースできない値は null。
export function daysFromToday(ymd){
  if(!ymd) return null;
  const t = new Date(ymd + "T00:00:00");
  if(isNaN(t.getTime())) return null;
  return Math.round((t - new Date(TODAY() + "T00:00:00")) / DAY_MS);
}

// 発表から7日以内なら「NEW」。announced_date が空の行はNEW扱いしない（憶測で新着にしない）。
export function isNewlyAnnounced(it){
  const d = daysFromToday(it.announcedDate);
  return d != null && d <= 0 && d >= -7;
}

/* 受付の開始・終了は「日付」ではなく「時刻まで含めた瞬間」で判定する。
   先着順のチケットは発売時刻ちょうどに動くもので、「8/1発売」と「8/1 10:00発売」では
   利用者がとる行動がまるで違う。日付だけで比べると、当日の朝に見た人に
   「もう発売中」と嘘をつくことになる。
   時刻が未登録なら、開始は0:00・締切は23:59とみなす。不明を理由に発売前の公演を
   早く開けたり、受付中の公演を早く閉じたりしないための寄せ方。 */
function onsaleAt(ymd, hm, fallbackHM){
  if(!ymd) return null;
  const t = new Date(`${ymd}T${hm || fallbackHM}:00`);
  return isNaN(t.getTime()) ? null : t;
}
export const onsaleStartAt = it => onsaleAt(it.onsaleStart, it.onsaleStartTime, "00:00");
export const onsaleEndAt   = it => onsaleAt(it.onsaleEnd,   it.onsaleEndTime,   "23:59");

/* 受付の状態。カード表面の表示・絞り込み・シリーズの他公演一覧で共通して使う。
     closed  … 終了・完売
     before  … 発売前（開始時刻がまだ来ていない）
     open    … 受付中
     unknown … 受付情報そのものが未確認 */
export function onsaleState(it){
  const now = new Date();
  if(it.onsaleLabel && CLOSED_ONSALE.includes(it.onsaleLabel)) return "closed";
  const end = onsaleEndAt(it);
  if(end && end < now) return "closed";
  const start = onsaleStartAt(it);
  if(start && start > now) return "before";
  if(it.onsaleLabel || start) return "open";
  return "unknown";
}

// 締切までの残り日数。7日以内のときだけ「あと◯日」を添える（常時出すと目立たなくなる）。
export function deadlineDays(it){
  if(onsaleState(it) !== "open") return null;
  const d = daysFromToday(it.onsaleEnd);
  return (d == null || d < 0 || d > 7) ? null : d;
}
// 発売開始までの残り日数。締切より猶予があるので14日まで添える。
export function onsaleInDays(it){
  if(onsaleState(it) !== "before") return null;
  const d = daysFromToday(it.onsaleStart);
  return (d == null || d < 0 || d > 14) ? null : d;
}

/* ---------- シリーズ（ツアー／巡回展／特集上映） ---------- */

// 同じシリーズの他会場。「東京は取れないが横浜なら」という判断ができるようにする。
export function seriesSiblings(it){
  if(!it.seriesId) return [];
  return ITEMS[it.tab]
    .filter(x => x.seriesId === it.seriesId && x.key !== it.key)
    .sort((a, b) => (a.startDate || "9999") < (b.startDate || "9999") ? -1 : 1);
}
// シリーズ内の他公演にだけ出ている枠を、このカードからも気づけるようにするための集計。
export function seriesHighlights(it){
  const others = seriesSiblings(it);
  return {
    total: others.length,
    limited: others.filter(o => !!o.limitedSale).length,
    before:  others.filter(o => onsaleState(o) === "before").length
  };
}

/* flags の test に渡す判定ヘルパ。config.js が state/data を直接見なくて済むようにする。 */
const FLAG_HELPERS = {onsaleState, isNewlyAnnounced, isFav};

/* ---------- 絞り込み ---------- */

function matchesQuery(st, it){
  if(!st.q) return true;
  const terms = searchTerms(st.q);
  if(!terms.length) return true;
  return terms.every(t => it._fold.includes(t));   // スペース区切りは AND
}

function matchesDate(st, it){
  if(!(st.rangeStart && st.rangeEnd)) return true;
  // 期間が重なっていれば表示。開始/終了が空欄＝不明または無期限として扱い、
  // その端は制約なしとみなす（不明を理由に取りこぼさないため）。
  if(it.endDate && it.endDate < st.rangeStart) return false;
  if(it.startDate && it.startDate > st.rangeEnd) return false;
  return true;
}

function matchesFacets(tab, st, it, exceptId){
  return tab.facets.every(f => {
    if(f.id === exceptId) return true;
    const sel = st.sets[f.id];
    if(!sel.size) return true;
    return f.get(it).some(v => sel.has(v));       // 軸の中は OR
  });
}

function matchesFlags(tab, st, it, exceptId){
  return tab.flags.every(f => {
    if(f.id === exceptId) return true;
    if(!st.flags[f.id]) return true;
    return f.test(it, FLAG_HELPERS);
  });
}

// 円の中に入っているか。座標が未登録の行は判定できないため対象外にする。
export function withinArea(it, area){
  if(it.lat == null || it.lng == null) return false;
  return haversineKm(area.lat, area.lng, it.lat, it.lng) <= area.radiusKm;
}

export function matchesArea(st, it){
  if(st.venue) return venueNames(it).includes(st.venue);
  if(st.mapArea) return withinArea(it, st.mapArea);
  if(st.pref) return it.pref === st.pref;
  return true;
}

/* 場所以外の条件。地図シートの「この範囲に◯件」プレビューは、他の条件を
   効かせたまま円だけを差し替えて数えたいので、場所の判定と切り離してある。 */
export function matchesBaseFilters(tab, st, it){
  return matchesQuery(st, it) && matchesDate(st, it)
      && matchesFacets(tab, st, it) && matchesFlags(tab, st, it);
}

export function matchesFilters(tab, st, it){
  return matchesBaseFilters(tab, st, it) && matchesArea(st, it);
}

/* ---------- 並べ替え ---------- */

/* 並べ替え用の実効日付。
   「近い順」で長期開催イベント/長期上映作品が開始日の古さだけで上位に来ないよう、
   起点（期間指定時はその開始日、未指定なら本日）より前の開始日は起点に丸める。 */
export function effectiveDate(st, it){
  const anchor = st.rangeStart || TODAY();
  if(it.startDate) return it.startDate < anchor ? anchor : it.startDate;
  if(it.endDate)   return it.endDate < anchor ? it.endDate : anchor;
  return anchor;
}

export function byDateThenRank(st){
  return (a, b) => {
    const da = effectiveDate(st, a), db = effectiveDate(st, b);
    if(da !== db) return da < db ? -1 : 1;
    return (a.rank - b.rank) || ((a.id ?? 0) - (b.id ?? 0));
  };
}

// 発表日の新しい順。発表日が無い行は末尾に置く（不明を「古い」と決めつけないが、
// 「今週なにが発表されたか」を見に来た人の邪魔もしない位置に寄せる）。
export function byAnnouncedDesc(st){
  const fallback = byDateThenRank(st);
  return (a, b) => {
    const da = a.announcedDate, db = b.announcedDate;
    if(da && db && da !== db) return da < db ? 1 : -1;
    if(da && !db) return -1;
    if(!da && db) return 1;
    return fallback(a, b);
  };
}

export function sortItems(items, st){
  if(st.sortBy === "location" && st.userLoc) return items.slice().sort((a, b) => a._dist - b._dist);
  if(st.sortBy === "announced") return items.slice().sort(byAnnouncedDesc(st));
  return items.slice().sort(byDateThenRank(st));
}

export function withDistances(items, st){
  items.forEach(it => {
    it._dist = (st.userLoc && it.lat != null)
      ? haversineKm(st.userLoc.lat, st.userLoc.lng, it.lat, it.lng)
      : Infinity;
  });
  return items;
}

/* ---------- チップに出す件数 ----------
   「押したら0件だった」を防ぐために、選択肢ごとに「これを足すと何件になるか」を出す。
   その軸自身の選択は数えるときだけ外す（軸の中は OR なので、外さないと
   すでに選んだチップ以外がすべて0に見えてしまう）。 */
export function facetCounts(tab, st, items){
  const out = {};
  tab.facets.forEach(f => {
    const pool = items.filter(it =>
      matchesQuery(st, it) && matchesDate(st, it) &&
      matchesFacets(tab, st, it, f.id) && matchesFlags(tab, st, it) && matchesArea(st, it));
    const tally = {};
    pool.forEach(it => f.get(it).forEach(v => { tally[v] = (tally[v] || 0) + 1; }));
    out[f.id] = tally;
  });
  return out;
}

export function flagCounts(tab, st, items){
  const out = {};
  tab.flags.forEach(f => {
    out[f.id] = items.filter(it =>
      matchesQuery(st, it) && matchesDate(st, it) &&
      matchesFacets(tab, st, it) && matchesFlags(tab, st, it, f.id) && matchesArea(st, it) &&
      f.test(it, FLAG_HELPERS)).length;
  });
  return out;
}

/** 会場ピッカー用。いま効いている他の条件のもとで、会場ごとに何件あるか。 */
export function venueCounts(tab, st, items){
  const m = new Map();
  items.forEach(it => {
    if(!(matchesQuery(st, it) && matchesDate(st, it) &&
         matchesFacets(tab, st, it) && matchesFlags(tab, st, it))) return;
    venueNames(it).forEach(v => m.set(v, (m.get(v) || 0) + 1));
  });
  return m;
}
