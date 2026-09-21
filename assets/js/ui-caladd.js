/* カレンダーに追加する前に、日付・時刻を選ばせるシート（設計書 第5.10節）。

   会期のある催し（美術展など、時に数ヶ月続く）をそのまま終日イベントとして
   端末やGoogleカレンダーへ渡すと、実際に行く1日ではなく会期全体が予定表に
   載ってしまう。渡す前にここで1日・時刻を選ばせ、選んだ内容は cards.js の
   buildIcs()/gcalUrl() に override として渡す。

   端末（.ics）・Googleどちらを選んだときも同じシートを通す。Google の作成
   画面自体にも編集機能はあるが、渡す時点で正しい候補になっているほうが
   手間が少なく、「端末だけ聞かれる」非対称も避けられる。 */

import { buildIcs, gcalUrl } from "./cards.js";
import { toast } from "./render.js";
import { setBackgroundInert, trapTab, closePopover } from "./ui-popover.js";

const el = {};
let currentItem = null;
let currentTarget = null; // "ics" | "google"
let returnFocus = null;

function downloadIcs(item, override) {
  const ics = buildIcs(item, override);
  if (!ics) {
    toast("日付が未登録のためカレンダーに追加できません");
    return;
  }
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${item.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function openGoogle(item, override) {
  const url = gcalUrl(item, override);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
  else toast("日付が未登録のためカレンダーに追加できません");
}

/* 終日／時刻指定の切り替え。preset-chip と同じ見た目のトグルにしてある
   （設計書 第5.10節：日時が決まっていない利用者ほど多いので、終日を
   既定にし、時刻指定はいつでも選べる第二の選択肢として並べる）。 */
function setMode(allDay) {
  el.allDayChip.setAttribute("aria-pressed", String(allDay));
  el.timedChip.setAttribute("aria-pressed", String(!allDay));
  el.times.hidden = allDay;
}
const isAllDay = () => el.allDayChip.getAttribute("aria-pressed") === "true";

export function initCalAddSheet() {
  el.sheet = document.getElementById("calAddSheet");
  if (!el.sheet) return;
  el.title = document.getElementById("calAddSheetTitle");
  el.help = document.getElementById("calAddSheetHelp");
  el.close = document.getElementById("calAddSheetClose");
  el.allDayChip = document.getElementById("calAddAllDayChip");
  el.timedChip = document.getElementById("calAddTimedChip");
  el.date = document.getElementById("calAddDate");
  el.times = document.getElementById("calAddTimes");
  el.start = document.getElementById("calAddStart");
  el.end = document.getElementById("calAddEnd");
  el.submit = document.getElementById("calAddSubmit");

  el.close.addEventListener("click", closeCalAddSheet);
  el.sheet.addEventListener("click", (e) => {
    if (e.target === el.sheet) closeCalAddSheet();
  });
  el.sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCalAddSheet();
      return;
    }
    trapTab(el.sheet, e);
  });
  el.allDayChip.addEventListener("click", () => setMode(true));
  el.timedChip.addEventListener("click", () => setMode(false));
  el.submit.addEventListener("click", onSubmit);
}

function onSubmit() {
  if (!currentItem || !el.date.value) return;
  const allDay = isAllDay();
  if (!allDay && !el.start.value) {
    toast("開始時刻を入力してください");
    return;
  }
  const override = {
    date: el.date.value,
    allDay,
    startTime: allDay ? "" : el.start.value,
    endTime: allDay ? "" : el.end.value,
  };
  const item = currentItem;
  if (currentTarget === "ics") downloadIcs(item, override);
  else openGoogle(item, override);
  closeCalAddSheet();
}

export function openCalAddSheet(item, target) {
  if (!el.sheet) return;
  closePopover();
  currentItem = item;
  currentTarget = target;
  returnFocus = document.activeElement;

  const hasTime = Boolean(item.startTime);
  el.title.textContent = `${item.title} をカレンダーに追加`;
  el.help.textContent =
    target === "ics"
      ? "追加する日付を選べます。時刻が決まっていなければ終日のままで構いません。"
      : "Googleカレンダーに渡す日付を選べます。時刻が決まっていなければ終日のままで構いません。";
  el.date.value = item.startDate || item.endDate || "";
  el.start.value = item.startTime || item.openTime || "";
  el.end.value = item.endTime || "";
  setMode(!hasTime);
  el.submit.textContent =
    target === "ics" ? "端末のカレンダーに追加" : "Googleカレンダーを開く";

  el.sheet.hidden = false;
  document.body.style.overflow = "hidden";
  setBackgroundInert(true);
  el.date.focus();
}

export function closeCalAddSheet() {
  if (!el.sheet || el.sheet.hidden) return;
  el.sheet.hidden = true;
  document.body.style.overflow = "";
  setBackgroundInert(false);
  currentItem = null;
  const back =
    returnFocus && returnFocus.offsetParent !== null ? returnFocus : null;
  if (back && typeof back.focus === "function") back.focus();
  returnFocus = null;
}

export const isCalAddSheetOpen = () => el.sheet && !el.sheet.hidden;
