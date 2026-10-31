/* お気に入りスポット（★）の操作。星を押したときの反応・取り消し。登録の管理シートは、
   アーティストと1枚にまとめて ui-favmanage.js が持つ。

   ★を押した瞬間には一覧を並べ替えない。押した指の下でカードが動くと、続けて別の
   ★を押そうとして押し間違える（会場名は小さなリンクの隣にあり、そもそも押しやすい
   場所ではない）。代わりにトーストで「何が起きたか」を知らせ、並べ直したいときだけ
   ボタンで反映させる。並びは次に絞り込みを変えたときにも自然に追いつく。 */

import { esc } from "./util.js";
import { TABS } from "./config.js";
import { activeTab, toggleFavSpot, isFavSpot, pinFavSpots } from "./state.js";
import { spotByName, spotsOfItem } from "./spots.js";
import { visibleItems, refreshNow, onRefresh } from "./render.js";
import { closePopover } from "./ui-popover.js";
import { barExpandedHeight } from "./ui-controls.js";

const el = {};
let pendingReorder = false; // ★の状態に、画面の並びがまだ追いついていない
let favChanged = false; // 一覧の描き直しのとき、会場一覧のグループ分けも直すためのしるし
const reflowHooks = [];
/** ★が変わったあとに一覧が描き直されたときに呼ぶ（会場一覧のグループ分けを直す等）。 */
export const onFavReflow = (fn) => reflowHooks.push(fn);
let toastTimer = null;

/* ---------- ★の見た目をそろえる ----------
   同じ場所の★は、カード・会場一覧・スポットのシート・管理シートに同時に出ている
   ことがある。どれを押しても全部が同じ状態になるよう、DOM上の★をまとめて塗り直す。 */
export function syncStars(root = document) {
  root.querySelectorAll("[data-star]").forEach((b) => {
    const on = isFavSpot(b.dataset.star);
    b.setAttribute("aria-pressed", String(on));
    b.title = on ? "お気に入りスポットから外す" : "お気に入りスポットにする";
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

/** 先頭セクション（kind: "spot"＝場所・"art"＝人）の先頭のカードが見える位置へ。操作バー（sticky）の
    高さは画面幅と縮み具合で変わるので、固定の余白ではなく、伸びたときの操作バーの高さに合わせる。
    先頭セクションは一覧の最上部にあり、そこへ戻るのは上へのスクロールなので、着いたときのバーは
    伸びている（縮んだときの高さで合わせると、伸びたバーがカードを覆っていた）。
    カードは上端からカテゴリの札が出っ張っているので、その分も余白に足す。
    カードが無ければ（劇場チェーンのまとめ行だけ・条件で隠れた注記だけ）、その行へ移る。 */
export function revealFav(kind = "spot") {
  const list = document.getElementById(TABS[activeTab].listId);
  const target =
    list &&
    (list.querySelector(`[data-fav="${kind}"]`) ||
      (kind === "spot" ? list.querySelector(".chain-row") : null) ||
      list.querySelector(".fav-note"));
  if (target) scrollToElement(target, target.matches(".card") ? 36 : 12);
}

/** 要素を、操作バー（sticky）の下に見える位置へ。バーは伸びたときの高さで見込む
    （縮んだ高さで合わせると、上へ戻って伸びたバーが要素を覆う）。 */
export function scrollToElement(target, gap = 12) {
  const top =
    target.getBoundingClientRect().top +
    window.scrollY -
    barExpandedHeight() -
    gap;
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
  revealFav("spot");
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

export function initFavSpots() {
  el.toast = document.getElementById("favToast");
  el.msg = el.toast && el.toast.querySelector(".ft-msg");
  el.acts = el.toast && el.toast.querySelector(".ft-acts");
  if (!el.toast) return; // マークアップが無い版でも他の機能は動かす

  el.toast.addEventListener("pointerenter", () => clearTimeout(toastTimer));
  el.toast.addEventListener("focusin", () => clearTimeout(toastTimer));
  el.toast.addEventListener("pointerleave", armToast);
  el.toast.addEventListener("focusout", armToast);

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
