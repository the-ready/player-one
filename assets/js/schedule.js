/* 日程まわりの「いま」を一手に引き受けるモジュール。

   ここが持つのは次の3つで、いずれも**CSVに書き置かず、見るたびに計算する**。

     1. 「本日」（日本時間）
     2. 日程の表示文字列（`2026.9.5(土) 開場16:30／開演18:00`）
     3. 開催ステータス（`開催中` `まもなく開催` …）と、その並べ替え順

   以前は 2 と 3 がCSVの `date` / `status` / `rank` 列に文字列として書かれていた。
   書き手は週次の収集タスク（＝生成AI）なので、これには2つの問題があった。

     - **表記がそろわない。** 同じ「8月1日から9月30日まで」が `2026.8.1〜9.30`
       `2026-08-01〜2026-09-30` `2026年8月1日〜9月30日` のどれにもなり、
       曜日・開場時刻・注記の有無も行ごとに違っていた。
     - **収集した日で時間が止まる。** `status` は収集を実行した日の判定なので、
       週の後半に見た人には「まもなく開催」のまま始まっていたり、終わった催しが
       「開催中」のまま残ったりする。データが古いほど嘘が増える。

   どちらも「表示のために計算できる値を、計算せずに書き置いた」ことが原因である。
   CSVには**機械が読める事実**（ISOの日付・時刻・飛び日程・注記）だけを置き、
   人が読む文字列はここで毎回組み立てる。 */

import { fmtSpan, fmtTimes, DAY_MS } from "./util.js";
import {
  TABS,
  STATUS_BY_PHASE,
  TIME_WORDS,
  SOON_DAYS,
  RANK_FALLBACK,
} from "./config.js";

/* ---------- 「本日」 ----------

   データは関東の催しで、日付はすべて日本時間で書かれている。閲覧者の端末の
   タイムゾーンで「今日」を決めると、同じデータを見ている人どうしで判定が1日
   ずれる（西回りの地域では、日本の8/9の朝がまだ8/8として扱われる）。
   ステータスがこの値だけで決まる以上、基準は**データ側の暦**にそろえる。 */
const JST_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}); // en-CA は YYYY-MM-DD 形式で返る

export const todayJst = () => JST_DATE_FMT.format(new Date());

/* ページを開きっぱなしで日付をまたぐと「本日まで」「あと0日」がずれるので、
   タブに戻ってきたタイミングで refreshToday() を呼んで採り直す（main.js）。 */
let today = todayJst();
export const TODAY = () => today;
export function refreshToday() {
  const now = todayJst();
  if (now === today) return false;
  today = now;
  return true;
}

/* ---------- 日程の表示文字列 ---------- */

/**
 * カードの日付欄に出す文字列。
 *
 *   会期  [空白]  時刻  （注記）
 *   2026.9.5(土)〜6(日) 開場16:00／開演18:00（雨天決行）
 *
 * `date` 列に値が入っている行だけは、その自由記述をそのまま出す。
 * 「毎週土日」「10月中旬〜下旬（見頃予想）」のように、ISOの日付に落とすと
 * 持っていない精度を騙ることになる日程のための逃げ道である（第3.6節）。
 */
export function displayDate(it) {
  if (it.date) return it.date;
  const words = TIME_WORDS[it.tab] || TIME_WORDS.event;
  const span = fmtSpan(it.startDate, it.endDate, it.dates);
  const time = fmtTimes(it.openTime, it.startTime, it.endTime, words);
  const body = [span, time].filter(Boolean).join(" ");
  if (!it.dateNote) return body;
  return body ? `${body}（${it.dateNote}）` : `（${it.dateNote}）`;
}

/* ---------- 開催ステータス ---------- */

// 2つの YYYY-MM-DD の間の日数。パースできない値は null。
function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = new Date(from + "T00:00:00"),
    b = new Date(to + "T00:00:00");
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((b - a) / DAY_MS);
}

/**
 * その行が「いまどの段階か」を返す。返す値の意味は config.js の STATUS_BY_PHASE 参照。
 * 日付が1つも無い行では null を返す——分からないものを推測して段階を名乗らない。
 *
 * 判定は日付の単位で行う。開演時刻を持っている行でも「開演を過ぎたら終了」とは
 * しない：終演時刻はほとんどの行で未登録で、公演中も物販も続いているのに
 * 「終了」と出すほうが、当日の来場者にとっては有害なため。
 *
 * 飛び日程（`dates`）を持つ行では、会期の端ではなく**実際の開催日**で判定する。
 * 「8.10・11・14・16 開催」の8.12に「開催中」と出すのは、その日に行ける人を
 * 空振りさせる嘘なので、開催日でない日は gap（本日は休み）として分ける。
 *
 * 予備日（`backupDate`）は判定に入れない。本開催で終われば使われない日であり、
 * 「順延されたかどうか」を画面は知らないため、先回りして会期を延ばさない。
 */
export function schedulePhase(it, ref = TODAY()) {
  const days = it.dates && it.dates.length ? it.dates : null;
  const s = days ? days[0] : it.startDate;
  const e = days ? days[days.length - 1] : it.endDate;
  if (!s && !e) return null;
  if (e && e < ref) return "ended";
  if (s && s > ref) {
    const d = daysBetween(ref, s);
    return d != null && d <= SOON_DAYS ? "soon" : "far";
  }
  if (!e) return "openrun"; // 始まっているが終了日が未定
  if (days && !days.includes(ref)) return "gap";
  if (e === ref) return "last";
  if (s === ref) return "opening";
  return "ongoing";
}

/** 飛び日程の行で、今日を含めて次に開催される日。無ければ null。 */
export function nextOpenDay(it, ref = TODAY()) {
  const days = it.dates && it.dates.length ? it.dates : null;
  if (!days) return null;
  return days.find((d) => d >= ref) || null;
}

/**
 * 画面に出す開催ステータス。日付から決まらない行だけ、CSVの申告（csvStatus）に戻す。
 */
export function statusOf(it) {
  const phase = schedulePhase(it);
  const table = STATUS_BY_PHASE[it.tab];
  if (!phase || !table) return it.csvStatus;
  return table[phase] || it.csvStatus;
}

/**
 * 並べ替えの優先度。ステータス表の並び順がそのまま順位になる
 * （「本日まで」= 0 が先頭、「終了」= 末尾）。表に無いラベルの行は
 * CSVの rank に戻し、それも無ければ末尾に寄せる。
 */
export function rankOf(it) {
  const label = statusOf(it);
  const tab = TABS[it.tab];
  if (label && tab) {
    const i = Object.keys(tab.statusTable).indexOf(label);
    if (i >= 0) return i;
  }
  return it.csvRank != null ? it.csvRank : RANK_FALLBACK;
}
