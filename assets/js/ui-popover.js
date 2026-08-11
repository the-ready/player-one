/* 日程／エリア／絞り込みの3つのポップアップ。
   **モーダルにはしない。** 以前は aria-modal + inert + フォーカストラップで
   閉じ込めていたが、そのせいで「日程」を開いている間は「エリア」「絞り込み」を
   押せず、いちいち閉じてから押し直す必要があった。3つは並列の絞り込み軸なので、
   開いたまま隣へ移れるほうが正しい。
   操作バー(.controls)は背景(.popover-backdrop)より上に置いてあるので、
   背面クリックで閉じつつ、3つのボタンだけは押せる状態を保つ。 */

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
  window.addEventListener("resize", () => {
    if (currentPopover) positionPopover(currentPopover);
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
  if (!currentPopover) returnFocus = document.activeElement;
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
  positionPopover(which);
  if (initPopover._onOpen) initPopover._onOpen(which);
  const first = focusableIn(el.bodies[which])[0];
  if (first) first.focus();
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
  el.backdrop.hidden = true;
  el.panel.hidden = true;
  el.panel.classList.remove("show");
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
