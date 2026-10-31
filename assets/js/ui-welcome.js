/* ようこそカード（設計書 第5.15節）。初めて開いた人に、3枚で全体像を見せる。

   モーダルにする（aria-modal + inert + フォーカスの閉じ込め）。一覧の前に立つぶん、閉じ方を
   必ず用意する：スキップ・×・最後の「さっそく探す」・Esc のどれでも閉じ、閉じたら二度と出さない。
   暗幕（カードの外）を押しても閉じない：閉じると既読になって二度と見られず、スマホでは余白への
   うっかりの接触で消えてしまうため。
   閉じたあとのフォーカスは本文の先頭へ戻す。開く元になった部品が無い（起動時に自動で開く）ので、
   検索欄へ戻すとスマホでキーボードが上がってしまうため。 */

import { setBackgroundInert, trapTab, closePopover } from "./ui-popover.js";
import { welcomeSlides, markWelcomeSeen } from "./onboard.js";
import { preloadFonts } from "./ui-weekly.js";

const el = {};
let slides = [];
let index = 0;
let open = false;

/* 絵は文章と別に持つ。色は昼夜の変数から引くので、夜の空モードでもそのまま読める。
   3枚目のイラストは♡★人のマークを並べたままにしている（文章のほうは「先頭にまとまる」だけを伝える）。 */
const ART = {
  tabs: `<svg viewBox="0 0 250 150" width="250" height="150" role="presentation">
    <g font-weight="900" font-size="11" text-anchor="middle" fill="var(--on-accent)">
      <g transform="rotate(-6 60 80)"><rect x="12" y="44" width="96" height="70" rx="14" fill="var(--card)" stroke="var(--ink)" stroke-width="3"/><rect x="24" y="34" width="62" height="20" rx="10" fill="var(--pink)" stroke="var(--ink)" stroke-width="2.5"/><text x="55" y="48.5">イベント</text><rect x="26" y="70" width="70" height="7" rx="3" fill="var(--neutral-bg-2)"/><rect x="26" y="84" width="50" height="7" rx="3" fill="var(--neutral-bg-2)"/></g>
      <g><rect x="80" y="30" width="96" height="74" rx="14" fill="var(--card)" stroke="var(--ink)" stroke-width="3"/><rect x="96" y="20" width="56" height="20" rx="10" fill="var(--sky)" stroke="var(--ink)" stroke-width="2.5"/><text x="124" y="34.5">映画</text><rect x="94" y="58" width="70" height="7" rx="3" fill="var(--neutral-bg-2)"/><rect x="94" y="72" width="44" height="7" rx="3" fill="var(--neutral-bg-2)"/></g>
      <g transform="rotate(7 190 80)"><rect x="144" y="50" width="96" height="70" rx="14" fill="var(--card)" stroke="var(--ink)" stroke-width="3"/><rect x="150" y="40" width="84" height="20" rx="10" fill="var(--coral)" stroke="var(--ink)" stroke-width="2.5"/><text x="192" y="54.5">ライブ・フェス</text><rect x="158" y="76" width="70" height="7" rx="3" fill="var(--neutral-bg-2)"/><rect x="158" y="90" width="52" height="7" rx="3" fill="var(--neutral-bg-2)"/></g>
    </g></svg>`,
  filters: `<svg viewBox="0 0 250 150" width="250" height="150" role="presentation">
    <rect x="20" y="22" width="110" height="104" rx="14" fill="var(--card)" stroke="var(--ink)" stroke-width="3"/>
    <path d="M34 22h82a14 14 0 0 1 14 14v12H20V36a14 14 0 0 1 14-14z" fill="var(--ink)"/>
    <g fill="var(--neutral-bg-2)">${[0, 1, 2, 3]
      .map((r) =>
        [0, 1, 2, 3, 4]
          .map(
            (c) =>
              `<rect x="${30 + c * 19}" y="${58 + r * 16}" width="13" height="10" rx="3"/>`,
          )
          .join(""),
      )
      .join("")}</g>
    <rect x="87" y="106" width="13" height="10" rx="3" fill="var(--pink)"/>
    <g transform="translate(150 30)"><rect width="84" height="96" rx="14" fill="var(--teal-tint)" stroke="var(--ink)" stroke-width="3"/><path d="M0 60Q30 40 50 66T84 50" stroke="var(--card)" stroke-width="6" fill="none"/><circle cx="42" cy="48" r="26" fill="var(--pink)" fill-opacity=".18" stroke="var(--pink)" stroke-width="2.5" stroke-dasharray="5 4"/><path d="M42 50s-10-9-10-16a10 10 0 0 1 20 0c0 7-10 16-10 16z" fill="var(--pink)" stroke="var(--ink)" stroke-width="2.5"/><circle cx="42" cy="34" r="3.5" fill="var(--card)"/></g></svg>`,
  favs: `<svg viewBox="0 0 250 150" width="250" height="150" role="presentation">
    <g transform="translate(48 82)"><circle r="34" fill="var(--card)" stroke="var(--ink)" stroke-width="3"/><path transform="scale(2.6)" d="M0 9s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 7-1c0 5.6-7 10-7 10z" fill="var(--pink)" stroke="var(--ink)" stroke-width="1"/></g>
    <g transform="translate(125 68)"><circle r="34" fill="var(--card)" stroke="var(--ink)" stroke-width="3"/><path transform="scale(2.6)" d="M0-8.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L0 4.8-5.2 7.5l1-5.8-4.2-4.1 5.8-.8z" fill="#e8b93c" stroke="var(--ink)" stroke-width="1"/></g>
    <g transform="translate(202 82)"><circle r="34" fill="var(--card)" stroke="var(--ink)" stroke-width="3"/><g transform="scale(2.6)"><circle cy="-3" r="3.6" fill="var(--sky)" stroke="var(--ink)" stroke-width="1"/><path d="M-7 8c0-4 3-6.5 7-6.5S7 4 7 8z" fill="var(--sky)" stroke="var(--ink)" stroke-width="1"/></g></g></svg>`,
};

// 次へのボタンの文言。先読み（preloadSlideFonts）にも同じ文字列を渡すので、1か所に置く
const NEXT_LABEL = "つぎへ";
const LAST_LABEL = "さっそく探す";
const ART_BG = {
  tabs: "var(--sky-tint)",
  filters: "var(--teal-tint)",
  favs: "var(--pink-tint)",
};

/* 点は、任意の枚へ移れるボタンにする（前の枚へ戻る手段が、これと ← キーしか無いため）。
   枚が変わるたびに作り直すと、押した点からフォーカスが落ちる（キーボードで点を順に押している途中で
   外れる）ので、枚数が変わったときだけ作り、あとは印だけを付け替える。 */
function drawDots() {
  if (el.dots.children.length !== slides.length) {
    el.dots.innerHTML = slides
      .map(
        (_, i) =>
          `<button type="button" class="onb-dot" data-i="${i}" aria-label="${i + 1}枚目へ"><i></i></button>`,
      )
      .join("");
  }
  Array.from(el.dots.children).forEach((b, i) => {
    const on = i === index;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "step");
    else b.removeAttribute("aria-current");
  });
}

function draw() {
  const s = slides[index];
  const last = index === slides.length - 1;
  el.art.style.background = ART_BG[s.art] || "var(--sky-tint)";
  el.art.innerHTML = ART[s.art] || "";
  el.step.textContent = `${index + 1} / ${slides.length}`;
  el.title.textContent = s.title;
  el.text.textContent = s.body;
  drawDots();
  el.next.textContent = last ? LAST_LABEL : NEXT_LABEL;
  el.skip.hidden = last;
}

/* 3枚ぶんの文字のフォントを、開いた時点でまとめて頼む（理由は ui-weekly.js の preloadFonts）。
   2枚目・3枚目の見出しは、一覧に出ていない漢字を太字の丸ゴシックで出す。描くときに取りに行くと、
   「つぎへ」を押すたびに新しい断片が届き、背面の一覧ごと測り直されて止まる。初めての訪問では、
   ちょうど一覧のフォントを読んでいる最中に開くので、そこへ相乗りさせる。 */
function preloadSlideFonts() {
  preloadFonts([
    ...slides.flatMap((s) => [
      [el.title, s.title],
      [el.text, s.body],
    ]),
    [el.next, NEXT_LABEL + LAST_LABEL],
  ]);
}

function go(i) {
  if (i < 0 || i >= slides.length || i === index) return;
  index = i;
  draw();
  // 背の低い画面（横向きのスマホ）では本文が自分の中でスクロールする。前の枚で下まで送って
  // ボタンを押していても、新しい枚は見出しから読ませる
  el.body.scrollTop = 0;
  // 最後の枚ではスキップが消える。そこにフォーカスがあったときは、フォーカスが宙に浮く
  // （そのあとの Esc・矢印が効かなくなる）ので、主ボタンへ移す
  if (!el.sheet.contains(document.activeElement))
    el.next.focus({ preventScroll: true });
}

export function initWelcome() {
  el.sheet = document.getElementById("welcomeSheet");
  if (!el.sheet) return;
  el.art = document.getElementById("welcomeArt");
  el.step = document.getElementById("welcomeStep");
  el.title = document.getElementById("welcomeTitle");
  el.text = document.getElementById("welcomeText");
  el.body = document.getElementById("welcomeBody");
  el.dots = document.getElementById("welcomeDots");
  el.next = document.getElementById("welcomeNext");
  el.skip = document.getElementById("welcomeSkip");
  el.close = document.getElementById("welcomeClose");
  el.inner = el.sheet.querySelector(".onb-inner");

  el.next.addEventListener("click", () => {
    if (index < slides.length - 1) go(index + 1);
    else closeWelcome();
  });
  el.skip.addEventListener("click", closeWelcome);
  el.close.addEventListener("click", closeWelcome);
  el.dots.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".onb-dot") : null;
    if (b) go(Number(b.dataset.i));
  });
  // 暗幕を押しても閉じない。ただ、暗幕は押してもフォーカスを受けないので、そのままだと
  // フォーカスが body に落ち、以後の Esc・矢印がこのシートに届かなくなる。枠へ戻しておく
  el.sheet.addEventListener("click", (e) => {
    if (e.target === el.sheet && !el.sheet.contains(document.activeElement))
      el.inner.focus({ preventScroll: true });
  });
  el.sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeWelcome();
      return;
    }
    // ← → で枚を送る。Alt+← はブラウザの「戻る」なので、修飾キーつきは触らない
    if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      go(index + (e.key === "ArrowRight" ? 1 : -1));
      return;
    }
    trapTab(el.sheet, e);
  });
}

export function openWelcome() {
  if (!el.sheet || open) return false;
  closePopover();
  slides = welcomeSlides();
  index = 0;
  open = true;
  draw();
  el.sheet.hidden = false;
  document.body.style.overflow = "hidden";
  setBackgroundInert(true, [document.querySelector(".controls")]);
  // inert のあとで読む（getComputedStyle が、起動直後の一覧の描画と inert のスタイル計算を
  // 1回にまとめて済ませる。前に置くと2回に分かれる。ui-weekly.js の openWeekly と同じ）
  preloadSlideFonts();
  // 初めは「つぎへ」に置く。Enter だけで3枚を読み進められ、閉じる操作も手前に残る。
  // preventScroll が要る：背の低い画面では本文が自分の中でスクロールし、ボタンを見せようとして
  // 見出しが絵の下へ送られてしまうため
  el.body.scrollTop = 0;
  el.next.focus({ preventScroll: true });
  return true;
}

export function closeWelcome() {
  if (!el.sheet || !open) return;
  open = false;
  el.sheet.hidden = true;
  document.body.style.overflow = "";
  setBackgroundInert(false, [document.querySelector(".controls")]);
  // どの閉じ方でも既読にする。次の訪問から出さない
  markWelcomeSeen();
  const main = document.getElementById("mainContent");
  if (main) {
    main.tabIndex = -1;
    main.focus({ preventScroll: true });
  }
}

/** 3タブが読み終わったとき、開いたままなら文を引き直す（1枚目の「約◯件」は読み終えてからでないと言えない）。 */
export function refreshWelcome() {
  if (!open) return;
  slides = welcomeSlides();
  // 1枚目の文が件数入りに変わる。描いていない枚にいても、戻ったときに断片を待たないように
  preloadSlideFonts();
  draw();
}

export const isWelcomeOpen = () => open;
