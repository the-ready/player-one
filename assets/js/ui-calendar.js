/* 日程ポップアップ：並び順・期間プリセット・カレンダー。
   カレンダーは以前 role="grid" を名乗りながら row/gridcell を持たず、
   日付ボタン31個がすべて個別のタブストップだった。さらに日付を押すたびに
   グリッドを作り直すためフォーカスが body に落ち、モーダルの外へ抜けられた。
   ここでは APG の Date Picker に沿って、Tab 1回で入り矢印キーで動く形にする。 */

import { iso, WD, fmtDateDots } from "./util.js";
import { PRESETS } from "./config.js";
import { TODAY } from "./data.js";
import { curState } from "./state.js";
import { refreshNow } from "./render.js";

let calCursor = null; // 表示中の月の1日
let pendingStart = null; // 開始日だけ選ばれている状態
let focusDate = null; // ロービングtabindexで「いま選択されている」日
let gridHadFocus = false;

function baseToday() {
  return new Date(TODAY() + "T00:00:00");
}

export function presetRange(key) {
  const t = baseToday();
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

function ensureCursor() {
  const st = curState();
  const anchor = st.rangeStart || TODAY();
  if (!calCursor)
    calCursor = new Date(
      anchor.slice(0, 4),
      parseInt(anchor.slice(5, 7), 10) - 1,
      1,
    );
  if (!focusDate) focusDate = anchor;
}

export function initCalendar() {
  document
    .getElementById("calPrev")
    .addEventListener("click", () => shiftMonth(-1));
  document
    .getElementById("calNext")
    .addEventListener("click", () => shiftMonth(1));
  document.getElementById("calClear").addEventListener("click", () => {
    const st = curState();
    st.rangeStart = null;
    st.rangeEnd = null;
    pendingStart = null;
    renderCalendar();
    refreshNow({ push: true });
  });

  const presetWrap = document.getElementById("calPresets");
  presetWrap.innerHTML = PRESETS.map(
    (p) =>
      `<button type="button" class="preset-chip" data-key="${p.key}" aria-pressed="false">${p.label}</button>`,
  ).join("");
  presetWrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".preset-chip");
    if (!btn) return;
    const [s, en] = presetRange(btn.dataset.key);
    const st = curState();
    st.rangeStart = s;
    st.rangeEnd = en;
    pendingStart = null;
    st.sortBy = st.sortBy === "announced" ? "announced" : "date";
    calCursor = new Date(s.slice(0, 4), parseInt(s.slice(5, 7), 10) - 1, 1);
    focusDate = s;
    renderCalendar();
    refreshNow({ push: true });
  });

  // 並び順（3タブ共通。以前はライブタブだけに出していた）
  document
    .getElementById("sortDateChip")
    .addEventListener("click", () => setSort("date"));
  document
    .getElementById("sortAnnouncedChip")
    .addEventListener("click", () => setSort("announced"));

  const grid = document.getElementById("calGrid");
  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".cal-day");
    if (btn) pickDate(btn.dataset.date);
  });
  grid.addEventListener("keydown", onGridKey);
  grid.addEventListener("focusin", () => {
    gridHadFocus = true;
  });
  grid.addEventListener("focusout", () => {
    gridHadFocus = false;
  });
}

function setSort(kind) {
  curState().sortBy = kind;
  renderCalendar();
  refreshNow({ push: true });
}

function shiftMonth(n) {
  ensureCursor();
  calCursor.setMonth(calCursor.getMonth() + n);
  // 表示月が変わったら、ロービングの対象もその月の中へ寄せる
  const d = new Date(calCursor.getFullYear(), calCursor.getMonth(), 1);
  focusDate = iso(d);
  renderCalendar();
}

function pickDate(dateStr) {
  const st = curState();
  focusDate = dateStr;
  if (!pendingStart) {
    pendingStart = dateStr;
    st.rangeStart = null;
    st.rangeEnd = null;
    document.getElementById("calSelectionText").textContent =
      `${fmtDateDots(dateStr)} 〜 終了日を選んでください`;
    renderCalendar();
    refreshNow({ push: false });
    return;
  }
  st.rangeStart = dateStr < pendingStart ? dateStr : pendingStart;
  st.rangeEnd = dateStr < pendingStart ? pendingStart : dateStr;
  pendingStart = null;
  renderCalendar();
  refreshNow({ push: true });
}

function onGridKey(e) {
  const btn = e.target.closest(".cal-day");
  if (!btn) return;
  const cur = new Date(btn.dataset.date + "T00:00:00");
  let next = null;
  switch (e.key) {
    case "ArrowLeft":
      next = new Date(cur);
      next.setDate(cur.getDate() - 1);
      break;
    case "ArrowRight":
      next = new Date(cur);
      next.setDate(cur.getDate() + 1);
      break;
    case "ArrowUp":
      next = new Date(cur);
      next.setDate(cur.getDate() - 7);
      break;
    case "ArrowDown":
      next = new Date(cur);
      next.setDate(cur.getDate() + 7);
      break;
    case "Home":
      next = new Date(cur);
      next.setDate(cur.getDate() - cur.getDay());
      break;
    case "End":
      next = new Date(cur);
      next.setDate(cur.getDate() + (6 - cur.getDay()));
      break;
    case "PageUp":
      next = new Date(cur);
      next.setMonth(cur.getMonth() - 1);
      break;
    case "PageDown":
      next = new Date(cur);
      next.setMonth(cur.getMonth() + 1);
      break;
    default:
      return;
  }
  e.preventDefault();
  focusDate = iso(next);
  if (
    next.getMonth() !== calCursor.getMonth() ||
    next.getFullYear() !== calCursor.getFullYear()
  ) {
    calCursor = new Date(next.getFullYear(), next.getMonth(), 1);
  }
  renderCalendar(true);
}

export function renderCalendar(restoreFocus) {
  ensureCursor();
  const st = curState();
  const y = calCursor.getFullYear(),
    m = calCursor.getMonth();
  document.getElementById("calMonth").textContent = `${y}年 ${m + 1}月`;

  const first = new Date(y, m, 1),
    lastDay = new Date(y, m + 1, 0).getDate();
  const lead = first.getDay();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= lastDay; d++) cells.push(iso(new Date(y, m, d)));
  while (cells.length % 7) cells.push(null);

  // フォーカス対象がこの月に無ければ、月内の最初の日へ寄せる（ロービングの受け皿を必ず1つ作る）
  const inMonth = cells.filter(Boolean);
  if (!inMonth.includes(focusDate)) focusDate = inMonth[0];

  const s = st.rangeStart,
    e = st.rangeEnd;
  const dayCls = (date) => {
    if (pendingStart && date === pendingStart) return "edge";
    if (s && e) {
      if (date === s || date === e) return "edge";
      if (date > s && date < e) return "in-range";
    }
    return "";
  };

  let html =
    `<div class="cal-row" role="row">` +
    WD.map(
      (d) =>
        `<span class="cal-dow" role="columnheader" aria-label="${d}曜日">${d}</span>`,
    ).join("") +
    `</div>`;
  for (let i = 0; i < cells.length; i += 7) {
    html +=
      `<div class="cal-row" role="row">` +
      cells
        .slice(i, i + 7)
        .map((date) => {
          if (!date) return `<span class="cal-cell" role="gridcell"></span>`;
          const [yy, mm, dd] = date.split("-");
          const cls = dayCls(date);
          const isToday = date === TODAY();
          const selected = cls === "edge" || cls === "in-range";
          return `<span class="cal-cell" role="gridcell" aria-selected="${selected}">
        <button type="button" class="cal-day ${cls}${isToday ? " is-today" : ""}" data-date="${date}"
          tabindex="${date === focusDate ? 0 : -1}"
          aria-label="${yy}年${parseInt(mm, 10)}月${parseInt(dd, 10)}日${isToday ? "・本日" : ""}">${parseInt(dd, 10)}</button>
      </span>`;
        })
        .join("") +
      `</div>`;
  }

  const grid = document.getElementById("calGrid");
  // innerHTML を差し替えるとフォーカス中のボタンごと消え、focusout が走って
  // gridHadFocus が false になる。判定は「差し替える前」に取っておく。
  const hadFocus =
    restoreFocus || gridHadFocus || grid.contains(document.activeElement);
  grid.innerHTML = html;
  // 日付を押すとグリッドを作り直すので、押した日にフォーカスを戻さないと
  // フォーカスが body に落ちてモーダルの外へ抜けてしまう。
  if (hadFocus) {
    const back = grid.querySelector(`.cal-day[data-date="${focusDate}"]`);
    if (back) back.focus();
  }

  const sel = document.getElementById("calSelectionText");
  if (!pendingStart) {
    sel.textContent =
      st.rangeStart && st.rangeEnd
        ? `${fmtDateDots(st.rangeStart)} 〜 ${fmtDateDots(st.rangeEnd)}`
        : "開始日を選んでください";
  }
  document.querySelectorAll("#calPresets .preset-chip").forEach((c) => {
    const [ps, pe] = presetRange(c.dataset.key);
    c.setAttribute(
      "aria-pressed",
      String(st.rangeStart === ps && st.rangeEnd === pe),
    );
  });
  document
    .getElementById("sortDateChip")
    .setAttribute("aria-pressed", String(st.sortBy !== "announced"));
  document
    .getElementById("sortAnnouncedChip")
    .setAttribute("aria-pressed", String(st.sortBy === "announced"));
}

/** タブを切り替えたときに、そのタブの期間へカレンダーを合わせ直す。 */
export function resetCalendarCursor() {
  pendingStart = null;
  const anchor = curState().rangeStart || TODAY();
  calCursor = new Date(
    anchor.slice(0, 4),
    parseInt(anchor.slice(5, 7), 10) - 1,
    1,
  );
  focusDate = anchor;
}
