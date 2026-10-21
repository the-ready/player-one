/* 日程／エリア／絞り込みの3つのポップアップ。
   **モーダルにはしない。** 以前は aria-modal + inert + フォーカストラップで
   閉じ込めていたが、そのせいで「日程」を開いている間は「エリア」「絞り込み」を
   押せず、いちいち閉じてから押し直す必要があった。3つは並列の絞り込み軸なので、
   開いたまま隣へ移れるほうが正しい。
   操作バー(.controls)は背景(.popover-backdrop)より上に置いてあるので、
   背面クリックで閉じつつ、3つのボタンだけは押せる状態を保つ。 */

import { barCompactScrollY } from "./ui-controls.js";

/* ---------- 閉じたときにフォーカスを戻す先 ----------
   シートやポップアップは、開いた時点の document.activeElement を「開いた元」として覚え、
   閉じたらそこへフォーカスを戻す。ところが iOS の Safari はボタンを指で押してもフォーカスを
   移さないため、activeElement は body（か、前に触った別の部品）のままになる。戻し先が
   見つからないと代わりの部品へ逃がすが、それが検索欄だと閉じた途端に検索欄が開いて
   キーボードまで上がり、前に触った部品がページの上のほうにあると、そこまでページが飛ぶ。
   押された部品を click の捕捉段階で覚えておき、activeElement が当てにならないときはそれを使う。 */
let lastPressed = null;
let lastPressedAt = 0;
document.addEventListener(
  "click",
  (e) => {
    const t = e.target instanceof Element ? e.target : null;
    lastPressed = t && t.closest("button, a[href], input, [tabindex]");
    lastPressedAt = performance.now();
  },
  true,
);
export function openerElement() {
  const a = document.activeElement;
  // いま押された部品と activeElement が食い違うのは、押してもフォーカスが移らなかったとき。
  // 少し前の押下は使わない（キーボードで開いたときに、前にマウスで押した部品へ戻してしまう）
  if (
    lastPressed &&
    lastPressed.isConnected &&
    performance.now() - lastPressedAt < 1000 &&
    !(a && a !== document.body && a.contains(lastPressed))
  )
    return lastPressed;
  return a;
}

/** 表示中でフォーカスを受け取れる要素だけを、DOM順で拾う。 */
export function focusableIn(root) {
  return Array.from(
    root.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** Tab / Shift+Tab を container の中で循環させる。3か所で同じ実装を書いていたので共通化した。 */
export function trapTab(container, e) {
  if (e.key !== "Tab") return;
  const items = focusableIn(container);
  if (!items.length) return;
  const first = items[0],
    last = items[items.length - 1];
  // 再描画でフォーカスが body に落ちている場合は、先頭に引き戻して外へ抜けさせない
  if (!container.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
    return;
  }
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/* 背面を inert にする。aria-modal だけでは支援技術が背面を読めてしまうため。 */
const INERT_TARGETS = () =>
  [
    document.querySelector("header.pop-header"),
    document.querySelector("main"),
    document.querySelector(".skip-link"),
  ].filter(Boolean);

export function setBackgroundInert(on, extra = []) {
  INERT_TARGETS()
    .concat(extra)
    .forEach((el) => {
      if (!el) return;
      if (on) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    });
}

/* ---------- ポップアップ本体 ---------- */

const el = {};
let currentPopover = null;
let returnFocus = null;
let openScrollY = 0;
let onClosed = null;

const LABELS = { date: "期間でしぼる", loc: "場所でしぼる", cat: "絞り込み" };

export function initPopover({ onOpen, onClose }) {
  el.panel = document.getElementById("popoverPanel");
  el.backdrop = document.getElementById("popoverBackdrop");
  el.inner = document.querySelector(".controls-inner");
  el.flex = document.getElementById("controlsFlex");
  el.count = document.getElementById("resultCount");
  el.applied = document.getElementById("appliedBar");
  el.bodies = {
    date: document.getElementById("datePopoverBody"),
    loc: document.getElementById("locPopoverBody"),
    cat: document.getElementById("catPopoverBody"),
  };
  el.btns = {
    date: document.getElementById("sortDateBtn"),
    loc: document.getElementById("sortLocBtn"),
    cat: document.getElementById("catBtn"),
  };
  el.arrows = {
    date: document.getElementById("dateArrow"),
    loc: document.getElementById("locArrow"),
    cat: document.getElementById("catArrow"),
  };
  onClosed = onClose;

  Object.entries(el.btns).forEach(([which, btn]) =>
    btn.addEventListener("click", () => togglePopover(which)),
  );
  ["datePopoverClose", "locPopoverClose", "catPopoverClose"].forEach((id) =>
    document.getElementById(id).addEventListener("click", closePopover),
  );
  el.backdrop.addEventListener("click", closePopover);
  el.panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePopover();
    }
  });
  // 非モーダルなので Tab で外へ出られる。パネルからも操作バーからも
  // フォーカスが離れたら閉じる（開きっぱなしで迷子にしない）。
  el.panel.addEventListener("focusout", (e) => {
    const to = e.relatedTarget;
    if (!to) return; // 再描画中などは閉じない
    if (el.panel.contains(to)) return;
    if (document.querySelector(".controls").contains(to)) return;
    closePopover();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.panel.hidden) closePopover();
  });
  // 操作バーが小さくなるアニメーションが終わったら、パネルの上端が動いているので高さを引き直す
  // （負荷の高い端末では、決め打ちの待ち時間より遅れることがある。ui-controls.js の morphBar が知らせる）
  const bar = document.querySelector(".controls");
  bar.addEventListener("barmorphend", () => {
    if (currentPopover) {
      fitPopover();
      openScrollY = window.scrollY;
    }
  });
  window.addEventListener("resize", () => {
    if (!currentPopover) return;
    positionPopover(currentPopover);
    fitPopover();
  });

  if (onOpen) initPopover._onOpen = onOpen;
}

const desktopMQ = () => window.matchMedia("(min-width:641px)").matches;

function positionPopover(which) {
  if (!desktopMQ()) {
    el.panel.style.left = "";
    return;
  }
  const btnRect = el.btns[which].getBoundingClientRect();
  const containerRect = el.inner.getBoundingClientRect();
  const maxLeft = Math.max(0, containerRect.width - el.panel.offsetWidth);
  const left = Math.min(
    Math.max(0, btnRect.left - containerRect.left),
    maxLeft,
  );
  el.panel.style.left = `${left}px`;
}

export function isPopoverOpen() {
  return !el.panel.hidden;
}
export function currentPopoverName() {
  return currentPopover;
}

export function openPopover(which) {
  if (!currentPopover) returnFocus = openerElement();
  currentPopover = which;
  openScrollY = window.scrollY;
  el.backdrop.hidden = false;
  el.panel.hidden = false;
  el.panel.classList.add("show");
  el.panel.setAttribute("aria-label", LABELS[which]);
  Object.entries(el.bodies).forEach(([k, body]) => {
    body.hidden = k !== which;
  });
  Object.entries(el.btns).forEach(([k, btn]) =>
    btn.setAttribute("aria-expanded", String(k === which)),
  );
  Object.entries(el.arrows).forEach(([k, a]) => {
    a.textContent = k === which ? "▴" : "▾";
  });
  // 絞り込みだけ幅を広げる（第5.5節）。幅が決まってから位置を決める
  el.panel.classList.toggle("wide", which === "cat");
  positionPopover(which);
  if (initPopover._onOpen) initPopover._onOpen(which);
  const first = focusableIn(el.bodies[which])[0];
  // 開いた直後のフォーカスでページが勝手にスクロールすると、下の revealPopover の
  // 計算が狂い、スクロール量の判定（handleScrollForPopover）で閉じてしまう
  if (first) first.focus({ preventScroll: true });
  revealPopover();
}

/* ポップアップを、スクロールしなくても全部見える大きさ・位置にする（第5.5節）。
   高さは「画面の残り」までに抑え、収まる分は中でスクロールさせない。
   ページの上端付近で開いたときは、操作バーが画面上端に貼りつく位置までページを送って
   場所を作る（操作バーはスクロールすると小さくなり、その下に十分な高さが空く）。
   そのスクロールで閉じてしまわないよう、基準位置（openScrollY）も合わせて動かす。 */
const SETTLE_MS = 380; // 操作バーが小さくなるアニメーション（0.32s）が終わるまで
let settleTimer = null;
function fitPopover() {
  const top = el.panel.getBoundingClientRect().top;
  el.panel.style.maxHeight = `${Math.max(120, window.innerHeight - top - 12)}px`;
}
function revealPopover() {
  clearTimeout(settleTimer);
  el.panel.style.maxHeight = "";
  const controls = document.querySelector(".controls");
  const compact = controls.classList.contains("compact");
  const top = el.panel.getBoundingClientRect().top;
  const need = el.panel.scrollHeight + 6; // 枠線ぶん
  if (!compact && top + need > window.innerHeight - 12) {
    // バーを縮めても、縮んだ分の余白が張り付いたバーの裏に隠れる位置まで（ui-controls.js の
    // initScroll はそこより上では縮めない）。以後、バーが縮んでパネルの上端が上がる
    const y = Math.max(window.scrollY, barCompactScrollY());
    window.scrollTo({ top: y, behavior: "instant" });
    // ページが短いと目標まで送れず、行き着いた位置が y より手前になる。実際の位置を基準にする
    openScrollY = window.scrollY;
    fitPopover(); // 縮む前の暫定。内側スクロールの出っぱなしを避けるため、下で引き直す
    settleTimer = setTimeout(() => {
      openScrollY = window.scrollY;
      if (currentPopover) fitPopover();
    }, SETTLE_MS);
    return;
  }
  fitPopover();
}

export function closePopover() {
  if (el.panel.hidden) {
    currentPopover = null;
    return;
  }
  const back =
    returnFocus && returnFocus.offsetParent !== null
      ? returnFocus
      : el.btns[currentPopover];
  currentPopover = null;
  clearTimeout(settleTimer);
  el.backdrop.hidden = true;
  el.panel.hidden = true;
  el.panel.classList.remove("show");
  el.panel.style.maxHeight = "";
  Object.values(el.btns).forEach((b) =>
    b.setAttribute("aria-expanded", "false"),
  );
  Object.values(el.arrows).forEach((a) => {
    a.textContent = "▾";
  });
  if (back && typeof back.focus === "function") back.focus();
  returnFocus = null;
  if (onClosed) onClosed();
}

export function togglePopover(which) {
  if (
    !el.panel.hidden &&
    el.btns[which].getAttribute("aria-expanded") === "true"
  )
    closePopover();
  else {
    // 別のポップアップが開いていれば、閉じずにそのまま中身だけ差し替える
    if (!el.panel.hidden) returnFocus = null;
    openPopover(which);
  }
}

/* スクロールでポップアップを閉じる判定。
   以前は2pxでも動いたら閉じていたため、
     ・指が軽く滑っただけで閉じる
     ・ポップアップ内の入力欄をタップ→ソフトキーボードが出てページがスクロール→
       入力途中のままポップアップごと消える
   という状態だった。中の入力にフォーカスがある間は閉じず、しきい値も
   「意図してスクロールした」と言える幅まで上げる。 */
export function handleScrollForPopover() {
  if (el.panel.hidden) return;
  if (el.panel.contains(document.activeElement)) {
    openScrollY = window.scrollY;
    return;
  }
  if (Math.abs(window.scrollY - openScrollY) > 48) closePopover();
}
