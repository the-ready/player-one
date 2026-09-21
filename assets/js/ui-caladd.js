/* カレンダーに追加する前に、日付・時刻を選ばせるシート（設計書 第5.10節）。

   会期のある催し（美術展など、時に数ヶ月続く）をそのまま終日イベントとして
   端末やGoogleカレンダーへ渡すと、実際に行く1日ではなく会期全体が予定表に
   載ってしまう。渡す前にここで1日・時刻を選ばせ、選んだ内容は cards.js の
   buildIcs()/gcalUrl() に override として渡す。

   端末（.ics）・Googleどちらを選んだときも同じシートを通す。Google の作成
   画面自体にも編集機能はあるが、渡す時点で正しい候補になっているほうが
   手間が少なく、「端末だけ聞かれる」非対称も避けられる。

   入力欄は日付・開始（任意）・終了（任意）の3つだけで、終日か時刻指定かを
   選ぶモードは持たない。時刻が空なら終日、入っていればその時刻の予定になる。 */

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

export function initCalAddSheet() {
  el.sheet = document.getElementById("calAddSheet");
  if (!el.sheet) return;
  el.title = document.getElementById("calAddSheetTitle");
  el.help = document.getElementById("calAddSheetHelp");
  el.close = document.getElementById("calAddSheetClose");
  el.date = document.getElementById("calAddDate");
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
  el.submit.addEventListener("click", onSubmit);
}

/* 終日か時刻指定かは選ばせず、開始時刻が入っているかどうかで決める
   （設計書 第5.10節）。終了だけ入っている状態は入力の取りこぼしなので、
   黙って終日にせず開始を促す。 */
function onSubmit() {
  if (!currentItem || !el.date.value) return;
  const startTime = el.start.value;
  const endTime = el.end.value;
  if (endTime && !startTime) {
    toast("開始時刻も入力してください");
    return;
  }
  const override = { date: el.date.value, startTime, endTime };
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

  el.title.textContent = `${item.title} をカレンダーに追加`;
  el.help.textContent =
    "行く日を選んでください。時刻を空のままにすると終日の予定として追加します。" +
    (target === "ics"
      ? ""
      : "この内容でGoogleカレンダーの作成画面を開きます。");
  el.date.value = item.startDate || item.endDate || "";
  el.start.value = item.startTime || item.openTime || "";
  el.end.value = item.endTime || "";
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
