/* データの取得と正規化。
   このページは静的ホスティング上での配信を前提としており、file:// で直接開く
   ケースはサポートしない。取得先を1つに保つため、別のパスへのフォールバックは
   意図的に持たない——「今表示されているのがどのファイルの中身か」が分からなく
   なるほうが、読み込み失敗をそのままエラーとして見せるより有害なため。 */

import { txt, num, int, fold, stableUid } from "./util.js";
import { mapRows, parseCsvObjects } from "./csv.js";
import { TABS, TAB_ORDER, venueNames } from "./config.js";
import {
  statusOf,
  rankOf,
  displayDate,
  refreshToday as refreshTodayRaw,
} from "./schedule.js";

/* 「本日」は schedule.js が持つ。ここから再輸出しているのは、呼び出し側
   （絞り込み・カレンダー・描画）にとってはデータ層の一部に見えていたほうが
   自然で、import 元を分けるほどの区別ではないため。 */
export { TODAY } from "./schedule.js";

/* 「最終更新日」は日本時間の日付で表示する。
   閲覧者のタイムゾーンで換算すると、同じデータを見ている人どうしで表示が
   1日ずれる（例: 7/26 22:29 UTC のコミットは JST では 7/27）。 */
const JST_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}); // en-CA は YYYY-MM-DD 形式で返る
function toJstDate(value) {
  const t = new Date(value);
  return isNaN(t.getTime()) ? null : JST_DATE_FMT.format(t);
}

/* ---------- 取得 ---------- */

// Service Worker がキャッシュから返したかどうか。オフライン表示の注記に使う。
export const dataStatus = { offline: false, tabs: {} };

async function fetchText(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok)
    throw new Error(
      `${path.replace("./", "")} の取得に失敗しました（HTTP ${res.status}）`,
    );
  const text = await res.text();
  if (!text || !text.trim())
    throw new Error(`${path.replace("./", "")} が空です`);
  if (res.headers.get("X-From-Cache") === "1") dataStatus.offline = true;
  return { text, lastModified: toJstDate(res.headers.get("Last-Modified")) };
}

/* data/updated.json は「そのCSVを最後に差し替えたコミットの日付」を
   デプロイ時に git の履歴から書き出したもの（.github/workflows/pages.yml）。
   これを最優先で使う。

   Last-Modified だけに頼れない理由: actions/checkout は全ファイルの mtime を
   チェックアウト時刻にそろえるので、GitHub Pages 上では3つのCSVの Last-Modified が
   「デプロイした日時」で揃ってしまい、タブごとの差が消える。 */
export const DATA_UPDATED = { event: null, movie: null, live: null };
let updatedManifest = null;

export async function loadUpdatedManifest() {
  try {
    const res = await fetch("./data/updated.json", { cache: "no-store" });
    if (!res.ok) return; // 無い環境では Last-Modified に任せる
    const json = await res.json();
    if (json && typeof json === "object") updatedManifest = json;
  } catch {
    /* 取得も解析もできなければ Last-Modified に任せる */
  }
}

// updated.json の値は ISO8601 の日時。すでに日付だけの値ならそのまま使う
// （換算にかけるとUTCの0時と解釈されて前日にずれるため）。
function manifestToIso(v) {
  const s = txt(v);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : toJstDate(s);
}
export function updatedFor(tabKey) {
  const fromManifest = updatedManifest
    ? manifestToIso(updatedManifest[tabKey])
    : null;
  return fromManifest || DATA_UPDATED[tabKey] || null;
}

/* ---------- 本体データ ---------- */

export const ITEMS = { event: [], movie: [], live: [] };

/* タブごとの読み込み状態。描画側が「読み込み中」「読み込めなかった」「0件」を
   出し分けるために持つ。以前は読み込み中のプレースホルダを描いた直後に
   一覧の再描画が走って「見つかりません」に上書きされていた。 */
export const LOAD = {
  event: { state: "idle", error: null },
  movie: { state: "idle", error: null },
  live: { state: "idle", error: null },
};

/* 検索用の畳み込み済み文字列を作る。打鍵のたびに全件を正規化しないための前計算。
   カテゴリ・ジャンル・上映形態などのラベルも含める——「アート」「グルメ」と
   打った人は、チップを探しているのではなく検索窓に言葉を入れているため。 */
function searchHay(tab, it) {
  const labels = tab.facets.flatMap((f) =>
    f.get(it).map((k) => f.meta(k).text),
  );
  return fold(
    [it.title, it.kana, it.venue, it.area, it.desc, it.note]
      .concat(it.venues || [])
      .concat(it.artists || [])
      .concat(labels)
      .filter(Boolean)
      .join(" "),
  );
}

/* schedule.js の refreshToday() をラップし、日付が変わったときに検索インデックス
   （_fold）も塗り直す。

   status/rank/dateText はゲッタなので日付をまたげば自然に新しくなるが、_fold は
   ロード時に1回だけ作る前計算（打鍵のたびに全件を畳み込まないための最適化）で、
   その中には status のラベル文字列（例：「まもなく開催」）も畳み込んで入っている。
   ラベルだけが日付とともに変わるのに _fold を作り直さなければ、バッジは
   「本日まで」に変わっているのに検索窓に「本日まで」と打っても見つからない、
   という食い違いが起きる——ここで直そうとしていた「収集した日で時間が止まる」
   問題を、キャッシュの形を変えて再生産することになる。 */
export function refreshToday() {
  if (!refreshTodayRaw()) return false;
  TAB_ORDER.forEach((key) => {
    const tab = TABS[key];
    ITEMS[key].forEach((it) => {
      it._fold = searchHay(tab, it);
    });
  });
  return true;
}

/* 日程から決まる3つの値は、読むたびに計算する。

   読み込み時に1回だけ計算して持たせると、ページを開いたままにしている間だけ
   時間が止まる——CSVの `status` 列が「収集した日の判定」で止まっていたのと
   同じ壊れ方を、寿命を1日縮めただけで繰り返すことになる。ゲッタにしておけば
   日付をまたいだあとの再描画（main.js の visibilitychange）で自然に新しくなる。 */
function defineDerived(out) {
  Object.defineProperties(out, {
    status: { get: () => statusOf(out), enumerable: true },
    rank: { get: () => rankOf(out), enumerable: true },
    dateText: { get: () => displayDate(out), enumerable: true },
  });
}

function finalize(tab, out, row, i) {
  out.key = `${tab.keyPrefix}${i}`; // DOMのid用（CSVのidの欠損・重複に影響されない）
  out.title =
    out.title || (tab.key === "live" ? "(公演名未設定)" : "(タイトル未設定)");
  out.tab = tab.key;
  defineDerived(out);
  // お気に入りは週次でCSVが差し替わっても残ってほしいので、行番号でも id でもなく
  // 内容から決まる安定キーを使う（id は収集のたびに振り直されることがある）。
  out.uid = `${tab.key}:${stableUid([out.title, out.startDate, out.venue])}`;
  out._fold = searchHay(tab, out);
  out._dist = Infinity;
  return out;
}

export async function loadTab(tabKey) {
  const tab = TABS[tabKey];
  LOAD[tabKey] = { state: "loading", error: null };
  try {
    const { text, lastModified } = await fetchText(tab.csv);
    DATA_UPDATED[tabKey] = lastModified;
    ITEMS[tabKey] = mapRows(text, tab.columns, (out, row, i) =>
      finalize(tab, out, row, i),
    );
    LOAD[tabKey] = { state: "done", error: null };
  } catch (err) {
    LOAD[tabKey] = { state: "error", error: err.message };
    throw err;
  }
  if (tabKey === "live" || tabKey === "movie") resolveVenues();
  return ITEMS[tabKey];
}

/* ---------- 調査元サイト（data/sources.json） ---------- */
export const SOURCES = { event: [], movie: [], live: [] };
export async function loadSources() {
  try {
    const res = await fetch("./data/sources.json", { cache: "no-store" });
    if (!res.ok) return;
    const json = await res.json();
    TAB_ORDER.forEach((k) => {
      if (Array.isArray(json[k])) SOURCES[k] = json[k];
    });
  } catch {
    /* 一覧が出ないだけで本体の表示には影響しない */
  }
}

/* ---------- 準静的なマスター ----------
   更新頻度が本体データと違うので分けてある（公演は毎週入れ替わるが、
   会場の座標とキャパは年単位でしか変わらない）。読み込めなくても本体は動く。 */

export let THEATERS = [];
export let VENUES = [];

export async function loadTheaters() {
  try {
    const { text } = await fetchText("./data/theaters.csv");
    THEATERS = parseCsvObjects(text).map((row) => ({
      chain: txt(row.chain),
      name: txt(row.name) || "(店舗名未設定)",
      pref: txt(row.pref),
      area: txt(row.area),
      lat: num(row.lat),
      lng: num(row.lng),
      url: txt(row.url),
    }));
    resolveVenues();
  } catch {
    /* チェーン名がただの文字列になるだけ */
  }
}

export async function loadVenues() {
  try {
    const { text } = await fetchText("./data/venues.csv");
    VENUES = parseCsvObjects(text)
      .map((row) => ({
        venue: txt(row.venue),
        kind: txt(row.kind),
        pref: txt(row.pref),
        area: txt(row.area),
        capacity: int(row.capacity),
        lat: num(row.lat),
        lng: num(row.lng),
        url: txt(row.url),
      }))
      .filter((v) => v.venue);
    resolveVenues();
  } catch {
    /* 会場種別で絞れなくなるだけ */
  }
}

export function venueMeta(name) {
  return name ? VENUES.find((v) => v.venue === name) || null : null;
}
export function chainBranches(chain) {
  return THEATERS.filter((t) => t.chain === chain);
}
export function isKnownChain(name) {
  return THEATERS.some((t) => t.chain === name);
}
export function theaterMeta(name) {
  return THEATERS.find((t) => t.name === name) || null;
}

/* マスターから座標を補う。ツアーや長期上映は同じ会場が何行にも出てくるので、
   毎行に緯度経度を書かせると表記ゆれと座標のずれの温床になる。
   CSV側に値がある行は上書きしない（臨時会場はそちらが正しいため）。 */
export function resolveVenues() {
  ITEMS.live.forEach((lv) => {
    const v = venueMeta(lv.venue);
    if (!v) return;
    if (lv.lat == null) lv.lat = v.lat;
    if (lv.lng == null) lv.lng = v.lng;
  });
  ITEMS.movie.forEach((mv) => {
    if (mv.lat != null) return;
    const names = venueNames(mv);
    // 単館の行だけ補う。チェーン名の行に座標を入れると、そのチェーンの
    // どこか1店舗の位置を作品の位置として扱ってしまう。
    if (names.length !== 1) return;
    const t = theaterMeta(names[0]);
    if (t && t.lat != null) {
      mv.lat = t.lat;
      mv.lng = t.lng;
    }
  });
}

/** その会場（チェーン名含む）に紐づく地図上の点を返す。 */
export function pointsForPlace(name) {
  if (isKnownChain(name)) {
    return chainBranches(name)
      .filter((b) => b.lat != null && b.lng != null)
      .map((b) => ({
        name: b.name,
        area: b.area,
        lat: b.lat,
        lng: b.lng,
        url: b.url,
      }));
  }
  const v = venueMeta(name);
  if (v && v.lat != null)
    return [
      { name: v.venue, area: v.area, lat: v.lat, lng: v.lng, url: v.url },
    ];
  const t = theaterMeta(name);
  if (t && t.lat != null)
    return [{ name: t.name, area: t.area, lat: t.lat, lng: t.lng, url: t.url }];
  // マスターに無い臨時会場は、その会場を使っている行の座標から代表点を拾う
  for (const key of TAB_ORDER) {
    const hit = ITEMS[key].find(
      (it) => it.lat != null && venueNames(it).includes(name),
    );
    if (hit)
      return [
        { name, area: hit.area, lat: hit.lat, lng: hit.lng, url: hit.venueUrl },
      ];
  }
  return [];
}
