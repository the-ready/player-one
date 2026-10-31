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

import { fmtSpan, fmtTimes, iso, DAY_MS } from "./util.js";
import {
  TABS,
  STATUS_BY_PHASE,
  catWording,
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

/* ページを開きっぱなしで日付をまたぐと「本日開催」「あと0日」がずれるので、
   タブに戻ってきたタイミングで refreshToday() を呼んで採り直す（main.js）。 */
let today = todayJst();
export const TODAY = () => today;
export function refreshToday() {
  const now = todayJst();
  if (now === today) return false;
  today = now;
  return true;
}

/* 日程の期間プリセット（今日・今週末・1週間・月末・3か月）。
   日程ポップアップのチップ（ui-calendar.js）と、今週のボードの「今週末の◯件を見る」
   （onboard.js）が同じ範囲を引くよう、「本日」を持つここに置く。別々に計算すると、
   ボードの件数と、押した先の一覧の件数が食い違う。 */
export function presetRange(key) {
  const t = new Date(today + "T00:00:00");
  if (key === "today") return [iso(t), iso(t)];
  if (key === "weekend") {
    const dow = t.getDay();
    const sat = new Date(t);
    sat.setDate(t.getDate() + ((6 - dow + 7) % 7));
    const sun = new Date(sat);
    sun.setDate(sat.getDate() + 1);
    return [iso(dow === 0 ? t : sat), iso(dow === 0 ? t : sun)];
  }
  if (key === "7d") {
    const e = new Date(t);
    e.setDate(t.getDate() + 6);
    return [iso(t), iso(e)];
  }
  if (key === "month") {
    const e = new Date(t.getFullYear(), t.getMonth() + 1, 0);
    return [iso(t), iso(e)];
  }
  const e = new Date(t);
  e.setMonth(t.getMonth() + 3);
  return [iso(t), iso(e)];
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
 * 予備日（`backupDate`）は会期を延ばさない。本開催が成立すれば使われずに終わる日
 * だからである。ただし**予備日当日だけは別扱い**にする：本開催が流れていれば今日
 * やる日なのに、会期を過ぎたという理由だけで「終了」と出すのは、その日に行ける人に
 * 対して早すぎる。順延されたかどうかを画面は知らないので、「今日は予備日である」と
 * いう確かな事実だけを出して、あとは公式サイトに委ねる。
 */
export function schedulePhase(it, ref = TODAY()) {
  const days = it.dates && it.dates.length ? it.dates : null;
  const s = days ? days[0] : it.startDate;
  const e = days ? days[days.length - 1] : it.endDate;
  if (!s && !e) return null;
  // 予備日は会期の外にしか置けない（validate_data.py が中にある行を止める）ので、
  // 会期との前後関係を見るより先に決めてよい。
  if ((it.backupDate || []).includes(ref)) return "backup";
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

/* ---------- 出演者（guests / guest_dates・設計書 第3.4.5節・第5.4.2節） ----------

   「出演あり」の絞り込みも、カードの出演行も、検索の索引も、**ここが返す名前だけ**を
   使う。CSVの `guests` をそのまま見ない理由は2つある。

   1. 出演は日で終わる。会期が数週間続く展覧会で、トークが10/25の1日だけなら、
      10/26以降の「出演あり」は嘘になる。CSVは週に1度しか書き換わらないので、
      **終わったかどうかは、見るたびに本日から決める**（日程の状態と同じ理由。上の節）。
   2. 出演日が分からない行（`guest_dates` が空）は、その行の会期が終わるまで生きている
      ものとして扱う。出演日を推測で補うことも、分からないという理由で外すこともしない。

   出演日があるときは**出演日が決める**。会期末が過ぎていても、これからの出演日が
   あるなら残す（データの食い違いを、利用者が行ける日の側に寄せて受け止める）。 */
/* 出演日として読める値だけを、日付順にして返す。
   CSV由来の値は信用しない（設計書 第3.5節）。`TBD` や `10/25` のような値は文字列の比較で
   「未来」にも「過去」にもなってしまい、**読めない値が1つあるだけで出演が永久に残る**
   （`"TBD" > "2026-10-20"`）。検証（validate_data.py）は書式の崩れを ERROR にするが、
   画面は検証を通ったことを前提にしない。読めない値は無いものとして扱い、全部が読めなければ
   「出演日が不明」（＝会期で判定）に落とす。並べ替えるのは、順不同でも「次の出演日」と
   日付の並びが正しく出るようにするため。 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export function guestDays(it) {
  return (it.guestDates || []).filter((d) => ISO_DAY.test(d)).sort();
}
export function upcomingGuestDates(it, ref = TODAY()) {
  return guestDays(it).filter((d) => d >= ref);
}
export function activeGuests(it, ref = TODAY()) {
  const names = it.guests || [];
  if (!names.length) return [];
  const days = guestDays(it);
  if (days.length) return days.some((d) => d >= ref) ? names : [];
  return it.endDate && it.endDate < ref ? [] : names;
}

const addDays = (ymd, n) => {
  const d = new Date(ymd + "T00:00:00");
  if (isNaN(d.getTime())) return ymd;
  d.setDate(d.getDate() + n);
  return iso(d);
};

/**
 * カレンダーに追加するときの日付の初期値（設計書 第5.10節）。
 *
 * 起点を今日ではなく**明日**に置いている。この画面を開くのは「これから行く日」を
 * 決めるためで、すでに始まっている今日を提案しても選び直しになるためである。
 *
 *   出演日（`guest_dates`）  明日以降でいちばん近い出演日（出演者がいる行だけ）
 *   飛び日程（`dates`）    明日以降でいちばん近い開催日
 *   会期が始まっている行   明日（会期末がそれより前なら末日）
 *   これから始まる行       初日
 *   すでに終わった行       末日（過去の行でも空欄のまま開かない）
 */
export function suggestedVisitDate(it, ref = TODAY()) {
  const tomorrow = addDays(ref, 1);
  // 出演日が決まっている行は、その日がいちばん行く理由になる日（出演あり・舞台挨拶つき）。
  // 明日以降の出演日が無ければ、下の規則どおり。
  if (activeGuests(it, ref).length) {
    const next = upcomingGuestDates(it, tomorrow)[0];
    if (next) return next;
  }
  const days = it.dates && it.dates.length ? it.dates : null;
  if (days) return nextOpenDay(it, tomorrow) || days[days.length - 1];

  const start = it.startDate || it.endDate || "";
  if (!start) return "";
  if (start >= tomorrow) return start;
  /* 終了日で明日を頭打ちにする。ここで endDate を startDate で埋めないのは、
     終了日が空の行が「初日と同じ1日だけ」ではなく「◯月◯日〜（終わり未定）」
     を意味するためで（util.js の fmtSpan と同じ読み方）、埋めると会期中の行が
     初日に張り付く。 */
  const end = it.endDate || "";
  if (!end || end >= tomorrow) return tomorrow;
  return end;
}

/**
 * 画面に出す開催ステータス。日付から決まらない行だけ、CSVの申告（csvStatus）に戻す。
 */
export function statusOf(it) {
  const phase = schedulePhase(it);
  const table = STATUS_BY_PHASE[it.tab];
  if (!phase || !table) return it.csvStatus;
  // セールなど、予約も発売も無いカテゴリは言い回しが違う（config.js の CAT_WORDING）
  const w = catWording(it);
  return (w && w.status && w.status[phase]) || table[phase] || it.csvStatus;
}

/**
 * 並べ替えの優先度。ステータス表の並び順がそのまま順位になる
 * （「本日開催」= 0 が先頭、「終了」= 末尾）。表に無いラベルの行は
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
