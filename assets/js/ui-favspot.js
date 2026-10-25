/* お気に入りスポット（★）の操作。星を押したときの反応・取り消し・管理シート。

   ★を押した瞬間には一覧を並べ替えない。押した指の下でカードが動くと、続けて別の
   ★を押そうとして押し間違える（会場名は小さなリンクの隣にあり、そもそも押しやすい
   場所ではない）。代わりにトーストで「何が起きたか」を知らせ、並べ直したいときだけ
   ボタンで反映させる。並びは次に絞り込みを変えたときにも自然に追いつく。 */

import { esc } from "./util.js";
import { TABS, TAB_ORDER } from "./config.js";
import { ITEMS } from "./data.js";
import { hasEnded } from "./filters.js";
import { activeTab, toggleFavSpot, isFavSpot, pinFavSpots } from "./state.js";
import { spotByName, spotsOfItem, favSpotEntries, spotFacts } from "./spots.js";
import { visibleItems, refreshNow, onRefresh } from "./render.js";
import {
  setBackgroundInert,
  trapTab,
  closePopover,
  openerElement,
} from "./ui-popover.js";
import { barExpandedHeight } from "./ui-controls.js";

const el = {};
let pendingReorder = false; // ★の状態に、画面の並びがまだ追いついていない
let favChanged = false; // 一覧の描き直しのとき、会場一覧のグループ分けも直すためのしるし
const reflowHooks = [];
/** ★が変わったあとに一覧が描き直されたときに呼ぶ（会場一覧のグループ分けを直す等）。 */
export const onFavReflow = (fn) => reflowHooks.push(fn);
let toastTimer = null;
let returnFocus = null;

/* ---------- ★の見た目をそろえる ----------
   同じ場所の★は、カード・会場一覧・スポットのシート・管理シートに同時に出ている
   ことがある。どれを押しても全部が同じ状態になるよう、DOM上の★をまとめて塗り直す。 */
export function syncStars(root = document) {
  root.querySelectorAll("[data-star]").forEach((b) => {
    const on = isFavSpot(b.dataset.star);
    b.setAttribute("aria-pressed", String(on));
    if (b.classList.contains("star-big")) {
      const t = b.querySelector("[data-star-text]");
      if (t)
        t.textContent = on
          ? "お気に入りスポット（登録済み）"
          : "お気に入りスポットにする";
    } else {
      b.title = on ? "お気に入りスポットから外す" : "お気に入りスポットにする";
    }
  });
}

/* ---------- トースト ---------- */

export function hideToast() {
  clearTimeout(toastTimer);
  if (el.toast) {
    el.toast.hidden = true;
    el.toast.classList.remove("show");
  }
}
function armToast() {
  clearTimeout(toastTimer);
  // 押したいボタンが消えるのは困るので、指やカーソルが乗っている間は消さない
  toastTimer = setTimeout(hideToast, 10000);
}

export function showToast(text, actions) {
  if (!el.toast) return;
  el.msg.textContent = text;
  el.acts.innerHTML = actions
    .map(
      (a, i) =>
        `<button type="button" data-i="${i}"${a.primary ? ' class="primary"' : ""}>${esc(a.label)}</button>`,
    )
    .join("");
  el.acts
    .querySelectorAll("button")
    .forEach((b) =>
      b.addEventListener("click", () => actions[Number(b.dataset.i)].run()),
    );
  el.toast.hidden = false;
  // hidden を外した直後に class を付けないと、出現のトランジションが走らない
  requestAnimationFrame(() => el.toast.classList.add("show"));
  armToast();
}

/** 先頭セクションが見える位置へ。操作バー（sticky）の高さは画面幅と縮み具合で変わるので、
    固定の余白ではなく、伸びたときの操作バーの高さに合わせる。先頭セクションは一覧の最上部に
    あり、そこへ戻るのは上へのスクロールなので、着いたときのバーは伸びている
    （縮んだときの高さで合わせると、伸びたバーが見出しを覆っていた） */
export function revealFavHead(selector = ".fav-head:not(.art)") {
  const list = document.getElementById(TABS[activeTab].listId);
  const target = list && list.querySelector(selector);
  if (target) scrollToElement(target);
}

/** 要素を、操作バー（sticky）の下に見える位置へ。バーは伸びたときの高さで見込む
    （縮んだ高さで合わせると、上へ戻って伸びたバーが要素を覆う）。 */
export function scrollToElement(target) {
  const top =
    target.getBoundingClientRect().top +
    window.scrollY -
    barExpandedHeight() -
    12;
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({
    top: Math.max(0, top),
    behavior: calm ? "auto" : "smooth",
  });
}

function applyReorder() {
  pendingReorder = false;
  hideToast();
  // エリアの一覧から付けた場合、開いたままだと並び替わった結果が背面に隠れて見えない
  closePopover();
  refreshNow({ url: false });
  revealFavHead();
}

/** このタブで、いまの絞り込みのもとに、その場所の催しが何件あるか。 */
function affectedCount(name) {
  const e = spotByName(name);
  if (!e) return 0;
  return visibleItems(activeTab).filter((it) => spotsOfItem(it).includes(e))
    .length;
}

/** ★を付ける／外す。silent は、シートの中など「閉じたときにまとめて反映する」場面向け。 */
export function toggleSpot(name, { silent = false } = {}) {
  const on = toggleFavSpot(name);
  syncStars();
  pendingReorder = true;
  favChanged = true;
  if (silent) return on;

  const n = affectedCount(name);
  // 劇場を★にしたとき、映画タブではチェーンの新作のまとめ行が増えることがある
  const touches = n > 0 || !!spotByName(name)?.chain;
  const undo = {
    label: "元に戻す",
    run: () => {
      toggleSpot(name, { silent: true });
      hideToast();
    },
  };
  const reorder = {
    label: on ? "先頭にまとめる" : "並べ直す",
    primary: true,
    run: applyReorder,
  };
  const canReorder = touches && pinFavSpots();

  let msg;
  if (on)
    msg = `「${name}」をお気に入りスポットにしました。${
      n > 0
        ? `このタブに${n}件あります。`
        : "いまの条件では、このタブに予定がありません。"
    }`;
  else msg = `「${name}」をお気に入りスポットから外しました。`;
  showToast(msg, canReorder ? [reorder, undo] : [undo]);
  return on;
}

/** 閉じたときなど、保留していた並べ替えを反映する。 */
export function flushFavChange() {
  if (!pendingReorder) return;
  pendingReorder = false;
  hideToast();
  refreshNow({ url: false });
}

/* ---------- 管理シート ---------- */

function countsFor(e) {
  return TAB_ORDER.map((k) => [
    TABS[k].label,
    ITEMS[k].filter((it) => !hasEnded(it) && spotsOfItem(it).includes(e))
      .length,
  ]).filter(([, n]) => n > 0);
}

function renderSheetBody() {
  const entries = favSpotEntries();
  el.help.textContent = entries.length
    ? "この端末の中だけに保存されます。★を押すと外れ、もう一度押すと戻ります。"
    : "まだ登録がありません。カードの会場名の左の☆を押すと、その場所の催しが一覧の先頭にまとまります。";
  el.body.innerHTML = entries.length
    ? `<ul class="venue-rows">${entries
        .map((e) => {
          const star = `<button type="button" class="star-btn" data-star="${esc(e.name)}" aria-pressed="${isFavSpot(e.name)}" aria-label="${esc(e.name)}をお気に入りスポットにする">${STAR_SVG}</button>`;
          const sub = e.missing
            ? "名簿に見つかりません（名前が変わった可能性があります）"
            : [
                spotFacts(e),
                countsFor(e)
                  .map(([l, n]) => `${l}${n}件`)
                  .join("・"),
              ]
                .filter(Boolean)
                .join("　");
          return `<li>${star}<span class="vr-main"><span class="vr-name">${esc(e.name)}</span><small>${esc(sub)}</small></span></li>`;
        })
        .join("")}</ul>`
    : "";
  syncStars(el.body);
}
const STAR_SVG = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8 6.8 19.5l1-5.8L3.6 9.6l5.8-.8z"/></svg>`;

export function openFavSheet() {
  returnFocus = openerElement();
  hideToast();
  renderSheetBody();
  el.sheet.hidden = false;
  document.body.style.overflow = "hidden";
  setBackgroundInert(true, [document.querySelector(".controls")]);
  el.close.focus();
}
export function closeFavSheet() {
  if (el.sheet.hidden) return;
  el.sheet.hidden = true;
  document.body.style.overflow = "";
  setBackgroundInert(false, [document.querySelector(".controls")]);
  /* 開いた元（先頭セクションの「管理」ボタン）は、反映の再描画で消えていることがある。
     そのときは操作バーの「絞り込み」へ逃がし、フォーカスが行き場を失わないようにする。 */
  flushFavChange();
  const back =
    returnFocus && returnFocus.isConnected && returnFocus.offsetParent !== null
      ? returnFocus
      : document.getElementById("catBtn");
  if (back && typeof back.focus === "function") back.focus();
  returnFocus = null;
}
export const isFavSheetOpen = () => !!el.sheet && !el.sheet.hidden;

export function initFavSpots() {
  el.toast = document.getElementById("favToast");
  el.msg = el.toast && el.toast.querySelector(".ft-msg");
  el.acts = el.toast && el.toast.querySelector(".ft-acts");
  el.sheet = document.getElementById("favSheet");
  el.help = document.getElementById("favSheetHelp");
  el.body = document.getElementById("favSheetBody");
  el.close = document.getElementById("favSheetClose");
  if (!el.toast || !el.sheet) return; // マークアップが無い版でも他の機能は動かす

  el.toast.addEventListener("pointerenter", () => clearTimeout(toastTimer));
  el.toast.addEventListener("focusin", () => clearTimeout(toastTimer));
  el.toast.addEventListener("pointerleave", armToast);
  el.toast.addEventListener("focusout", armToast);

  el.close.addEventListener("click", closeFavSheet);
  el.sheet.addEventListener("click", (e) => {
    if (e.target === el.sheet) closeFavSheet();
    const star = e.target.closest("button[data-star]");
    if (star) toggleSpot(star.dataset.star, { silent: true });
  });
  el.sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeFavSheet();
      return;
    }
    trapTab(el.sheet, e);
  });

  // 絞り込みなどで一覧が描き直されたら、並びは追いついている。古い案内は消す
  onRefresh(() => {
    pendingReorder = false;
    hideToast();
    if (favChanged) {
      favChanged = false;
      reflowHooks.forEach((fn) => fn());
    }
  });
}
