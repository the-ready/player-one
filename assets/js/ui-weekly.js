/* 今週のボード（設計書 第5.16節）。更新のあとに初めて開いたときと、ヘッダーの「最終更新日」の
   ボタンから開く、全画面のスライド。何を載せるかは onboard.js、ここは見せ方と操作だけを持つ。

   自動で進む。ただし次の間は止まる（WCAG 2.2.2）。
     ・止めるボタンを押している間
     ・画面を長押ししている間（指を離すと再開）
     ・キーボードの操作でフォーカスが中にある間（矢印・ボタンで自分の速さで読める）
     ・タブが裏に回っている間
   動きを減らす設定（prefers-reduced-motion）の人には、はじめから自動で進めない。
   進む仕組みは CSS の animation（進捗の棒）の終わりで次へ送る。タイマーも rAF も持たないので、
   開いている間も画面を描き直し続けない。 */

import { esc } from "./util.js";
import {
  setBackgroundInert,
  trapTab,
  closePopover,
  openerElement,
} from "./ui-popover.js";
import { buildBoard } from "./onboard.js";

const el = {};
let handlers = {};
let pages = [];
let cur = 0;
let open = false;
let returnFocus = null;
let userPaused = false;
let holding = false;
/* キーボードで操作している間は止める（自分の速さで読めるように）。:focus-visible では判断しない：
   開いたときにスクリプトが置くフォーカスは、まだ何も操作していない人には :focus-visible として
   扱われ、自動で開いたボードがはじめから止まってしまうため。キーを押したら true、
   ポインタで触れたら false にする（開き方がキーボードなら、はじめから true）。 */
let kbMode = false;
let holdAt = 0;

// ページごとの滞在秒数。題名の一覧があるページは読むのに時間がかかる
const DUR = { total: 7, fav: 9, weekend: 9, free: 8, movies: 8, last: 7 };

const PAUSE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" class="ico-pause"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" class="ico-play"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;

// 最後のページの絵。♡は「先頭にまとまる」ものではないので描かない（★と人のマークだけ）
const LAST_ART = `<svg viewBox="0 0 170 80" width="170" height="80" role="presentation"><g transform="translate(46 40)"><circle r="32" fill="var(--card)" stroke="var(--ink)" stroke-width="3"/><path transform="scale(2.4)" d="M0-8.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L0 4.8-5.2 7.5l1-5.8-4.2-4.1 5.8-.8z" fill="#e8b93c" stroke="var(--ink)" stroke-width="1"/></g><g transform="translate(124 40)"><circle r="32" fill="var(--card)" stroke="var(--ink)" stroke-width="3"/><g transform="scale(2.4)"><circle cy="-3" r="3.6" fill="var(--sky)" stroke="var(--ink)" stroke-width="1"/><path d="M-7 8c0-4 3-6.5 7-6.5S7 4 7 8z" fill="var(--sky)" stroke="var(--ink)" stroke-width="1"/></g></g></svg>`;

/* ---------- ページの HTML ---------- */

const n = (v) => Number(v).toLocaleString("ja-JP");

function itemsHtml(items) {
  return `<ul class="wk-list">${items
    .map(
      (it) =>
        `<li><button type="button" class="wk-item" data-go="${esc(it.tab)}|${esc(it.key)}"><b>${esc(it.title)}</b>${it.sub ? `<span>${esc(it.sub)}</span>` : ""}</button></li>`,
    )
    .join("")}</ul>`;
}

const PAGE_HTML = {
  total: (p) => `
    <h2 class="wk-h">${p.manual ? "いまのデータ" : "データを更新しました"}</h2>
    <p class="wk-kicker">いま探せる</p>
    <p class="wk-big">${n(p.total)}<small>件</small></p>
    <p class="wk-sub">${p.breakdown.map((b) => `${esc(b.label)} ${n(b.n)}`).join("・")}</p>
    <ul class="wk-updates">${p.updates
      .map(
        (u) =>
          `<li${u.advanced ? ' class="adv"' : ""}><span>${esc(u.label)}</span><b>${u.date ? esc(u.date) : "–"}</b>${u.advanced ? "<em>更新</em>" : ""}</li>`,
      )
      .join("")}</ul>
    <p class="wk-note">${
      p.manual
        ? "各タブの最終更新日です。"
        : p.freshCount > 0
          ? `前回のボードのあとに、新しく${n(p.freshCount)}件が加わりました。`
          : "更新日が進んだタブを「更新」で示しています。"
    }</p>`,
  fav: (p) => `
    <h2 class="wk-h">お気に入りに新着があります</h2>
    <p class="wk-big">${n(p.count)}<small>件</small></p>
    ${p.groups
      .map(
        (g) => `<section class="wk-group">
          <h3><span class="wk-kind">${g.kind === "spot" ? "会場" : "アーティスト"}</span>${esc(g.label)}<em>${n(g.count)}件</em></h3>
          ${itemsHtml(g.items)}${g.count > g.items.length ? `<p class="wk-rest">ほか${n(g.count - g.items.length)}件</p>` : ""}</section>`,
      )
      .join("")}
    ${p.more > 0 ? `<p class="wk-note">ほか${n(p.more)}か所・人にも新着があります。</p>` : ""}`,
  weekend: (p) => `
    <h2 class="wk-h">今週末に開催</h2>
    <p class="wk-range">${esc(p.range)}</p>
    <p class="wk-big">${n(p.counts.reduce((s, c) => s + c.n, 0))}<small>件</small></p>
    <p class="wk-sub">${p.counts.map((c) => `${esc(c.label)} ${n(c.n)}`).join("・")}</p>
    ${itemsHtml(p.items)}
    ${p.free > 0 ? `<p class="wk-note">うち無料は${n(p.free)}件です。</p>` : ""}
    <div class="wk-acts">${p.counts
      .map(
        (c) =>
          `<button type="button" class="map-btn" data-act="apply" data-tab="${esc(c.tab)}" data-kind="weekend">${esc(c.label)}${n(c.n)}件を見る</button>`,
      )
      .join("")}</div>`,
  free: (p) => `
    <h2 class="wk-h">無料で楽しめるイベント</h2>
    <p class="wk-big">${n(p.n)}<small>件</small></p>
    ${itemsHtml(p.items)}
    <div class="wk-acts"><button type="button" class="map-btn" data-act="apply" data-tab="event" data-kind="free">無料のイベントだけを見る</button></div>`,
  movies: (p) => `
    <h2 class="wk-h">今週公開の映画</h2>
    <p class="wk-big">${n(p.n)}<small>本</small></p>
    ${itemsHtml(p.items)}`,
  last: (p) => `
    <div class="wk-art" aria-hidden="true">${LAST_ART}</div>
    <h2 class="wk-h">お気に入りを登録しよう</h2>
    <p class="wk-text">会場名の横の★と、出演者の横の人のマークで登録すると、その予定が一覧の先頭にまとまります。登録はこの端末の中だけに保存されます。</p>
    <div class="wk-acts">
      <button type="button" class="map-btn primary" data-act="close">一覧を見る</button>
      ${p.hasFavs ? `<button type="button" class="map-btn" data-act="manage">お気に入り管理</button>` : ""}
    </div>`,
};

/* ---------- フォントの先読み ---------- */

/* 日本語のフォントは、文字の範囲（unicode-range）ごとに百あまりの断片に分けて配られ、ブラウザは
   画面に初めて出た文字の断片をその場で取りに行く。断片が1つ届くたびに、そのフォントを使う文をページ全体で
   測り直す（背面の約500枚のカードまで。遅い端末では1回2秒ほど止まる）。ボードは一覧にまだ出ていない
   漢字（見出しの太字・ほかのタブの題名）を1ページに1〜2字ずつ出すので、描くときに取りに行くと、
   ページを送るたびにこれが起きる。開いた時点で全ページの文字をまとめて頼み、届くのを1回に寄せる
   （ようこそカードも同じ。ui-welcome.js。設計書 第5.16節）。

   頼むのは U+3000 以上の文字（かな・漢字・和文の約物・全角形）だけにする。この範囲の文字はどれも
   1つの断片にしか入っておらず、描くときに取りに行く断片と同じものになるため、使わない断片は読まない。
   英数字や一部の記号は複数の断片に重ねて入っていて、document.fonts.load に渡すと重なる断片を全部
   読んでしまう。これらは描いたときの取得に任せる（ほぼ起動時の一覧で読み終えている）。
   フォントは要素の getComputedStyle から取る。見出し・題名・数字で書体と太さが違い、
   CSS の対応を JS に写すと、CSS を直したときに黙ってずれるため。 */
export function preloadFonts(pairs) {
  if (typeof document.fonts?.load !== "function") return;
  const byFont = new Map();
  for (const [node, text] of pairs) {
    if (!node || !text) continue;
    const cs = getComputedStyle(node);
    const font = `${cs.fontStyle} ${cs.fontWeight} 16px ${cs.fontFamily}`;
    let chars = byFont.get(font);
    if (!chars) byFont.set(font, (chars = new Set()));
    for (const ch of text) if (ch.codePointAt(0) >= 0x3000) chars.add(ch);
  }
  for (const [font, chars] of byFont) {
    if (!chars.size) continue;
    try {
      // 届かなくても（オフライン・遮断）、描くときに代わりのフォントで出るだけなので、失敗は捨てる
      document.fonts.load(font, [...chars].join("")).catch(() => {});
    } catch {
      /* 解釈できない指定は飛ばす（先読みは無くても表示は変わらない） */
    }
  }
}

/* 全ページをシートの本文へ一度だけ書き、文字ごとのフォントを getComputedStyle で読む。
   スタイルを読むだけでレイアウトはさせないので、ここで書いたページは測られも描かれもせず、
   断片の取得も起きない。本文は直後の renderPage がいまのページで上書きする。 */
function preloadBoardFonts() {
  el.body.innerHTML = pages
    .map((p) => `<div class="wk-page">${PAGE_HTML[p.id](p)}</div>`)
    .join("");
  const pairs = [];
  const walk = document.createTreeWalker(el.sheet, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode())
    pairs.push([t.parentElement, t.data]);
  preloadFonts(pairs);
}

/* ---------- 描画と送り ---------- */

function renderBars() {
  // 棒ごと作り直すのは、いま開いているページの進捗の動き（animation）を頭から始め直すため
  el.bars.innerHTML = pages
    .map(
      (_, i) =>
        `<i class="wk-bar${i < cur ? " done" : i === cur ? " cur" : ""}"><b class="wk-fill"></b></i>`,
    )
    .join("");
}

function renderPage() {
  const p = pages[cur];
  el.body.innerHTML = `<div class="wk-page">${PAGE_HTML[p.id](p)}</div>`;
  el.body.scrollTop = 0;
  el.inner.dataset.page = p.id;
  el.sheet.style.setProperty("--wk-dur", `${DUR[p.id] || 7}s`);
  renderBars();
  el.count.textContent = `${cur + 1} / ${pages.length}`;
  setDisabled(el.prev, cur === 0);
  setDisabled(el.next, cur === pages.length - 1);
}

// 押している最中のボタンを disabled にすると、フォーカスが body に落ちる。行き先を残す
function setDisabled(btn, off) {
  if (btn.disabled === off) return;
  if (off && document.activeElement === btn) el.close.focus();
  btn.disabled = off;
}

function go(i) {
  if (i < 0 || i >= pages.length || i === cur) return;
  cur = i;
  renderPage();
  syncPaused();
}

function syncPaused() {
  const paused = userPaused || holding || kbMode || document.hidden;
  el.sheet.classList.toggle("is-paused", paused);
  el.pause.setAttribute("aria-pressed", String(userPaused));
  el.pause.setAttribute(
    "aria-label",
    userPaused ? "自動で進むのを再開する" : "自動で進むのを止める",
  );
}

/* ---------- 開閉 ---------- */

export function initWeekly(h) {
  handlers = h || {};
  el.sheet = document.getElementById("weeklySheet");
  if (!el.sheet) return;
  el.inner = el.sheet.querySelector(".wk-inner");
  el.bars = document.getElementById("weeklyBars");
  el.body = document.getElementById("weeklyBody");
  el.prev = document.getElementById("weeklyPrev");
  el.next = document.getElementById("weeklyNext");
  el.count = document.getElementById("weeklyCount");
  el.pause = document.getElementById("weeklyPause");
  el.close = document.getElementById("weeklyClose");
  el.pause.innerHTML = PAUSE_ICON;

  el.close.addEventListener("click", closeWeekly);
  el.prev.addEventListener("click", () => go(cur - 1));
  el.next.addEventListener("click", () => go(cur + 1));
  el.pause.addEventListener("click", () => {
    userPaused = !userPaused;
    syncPaused();
  });
  // 暗幕を押しても閉じる
  el.sheet.addEventListener("click", (e) => {
    if (e.target === el.sheet) closeWeekly();
  });

  // 棒が満ちたら次のページへ。最後のページでは止まる（繰り返さない）
  el.bars.addEventListener("animationend", (e) => {
    if (!open || !e.target.classList.contains("wk-fill")) return;
    if (cur < pages.length - 1) go(cur + 1);
  });

  // 本文の押下：中のボタン・リンクは本来の動き。それ以外は、左側で前へ・右側で次へ。
  // 長押しは「止めて読む」操作なので、指を離しても進めない
  el.body.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, a")) return;
    holding = true;
    holdAt = performance.now();
    syncPaused();
  });
  const release = () => {
    if (!holding) return;
    holding = false;
    syncPaused();
  };
  el.body.addEventListener("pointerup", release);
  el.body.addEventListener("pointercancel", release);
  el.body.addEventListener("pointerleave", release);
  el.body.addEventListener("click", (e) => {
    const t = e.target;
    const btn = t.closest && t.closest("button, a");
    if (btn) return onBodyButton(btn);
    if (performance.now() - holdAt > 350) return;
    const r = el.body.getBoundingClientRect();
    if (e.clientX - r.left < r.width * 0.35) go(cur - 1);
    else go(cur + 1);
  });

  el.sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeWeekly();
      return;
    }
    // 入力欄を持たないので、矢印はそのままページ送りに使える
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(cur + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(cur - 1);
    }
    trapTab(el.sheet, e);
    kbMode = true;
    syncPaused();
  });
  el.sheet.addEventListener("pointerdown", () => {
    kbMode = false;
    syncPaused();
  });
  document.addEventListener("visibilitychange", () => {
    if (open) syncPaused();
  });
}

function onBodyButton(btn) {
  if (btn.dataset.go) {
    const [tab, key] = btn.dataset.go.split("|");
    closeWeekly({ noBack: true });
    handlers.onGoToItem?.(tab, key);
  } else if (btn.dataset.act === "apply") {
    closeWeekly({ noBack: true });
    handlers.onApply?.({ tab: btn.dataset.tab, kind: btn.dataset.kind });
  } else if (btn.dataset.act === "manage") {
    closeWeekly({ noBack: true });
    handlers.onManage?.();
  } else if (btn.dataset.act === "close") {
    closeWeekly();
  }
}

/** ボードを開く。manual は日付のボタンから（更新の有無にかかわらず3タブの更新日を並べる）。 */
export function openWeekly({
  dates,
  advanced = [],
  fresh = {},
  manual = false,
  viaKeyboard = false,
}) {
  if (!el.sheet || open) return false;
  pages = buildBoard({ dates, advanced, fresh, manual });
  closePopover();
  returnFocus = manual ? openerElement() : null;
  open = true;
  cur = 0;
  holding = false;
  kbMode = viaKeyboard;
  // 動きを減らす設定の人には、はじめから自動で進めない（再開は押せる）
  userPaused = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.sheet.hidden = false;
  document.body.style.overflow = "hidden";
  setBackgroundInert(true, [document.querySelector(".controls")]);
  /* 背面を inert にしたあと、1ページ目を描く前に頼む。getComputedStyle は溜まっているスタイルの
     計算をその場で済ませるので、inert より前に呼ぶと「直前の一覧の描き直し」と「inert」の計算が
     2回に分かれる（どちらも背面のほぼ全要素で、遅い端末では1回1秒ほど）。ここなら1回にまとまる。
     1ページ目を描いて（renderPage のレイアウトで）その断片を先に取りに行かせると、
     残りのページの断片と届く時刻が分かれやすい */
  preloadBoardFonts();
  renderPage();
  syncPaused();
  // 既定の送り先は、閉じるボタン。空白を押しても、キー入力がこのシートの中に届くよう、
  // 枠そのもの（tabindex="-1"）にもフォーカスを受けさせている
  el.close.focus();
  return true;
}

export function closeWeekly(opts = {}) {
  if (!el.sheet || !open) return;
  open = false;
  el.sheet.hidden = true;
  el.bars.innerHTML = "";
  document.body.style.overflow = "";
  setBackgroundInert(false, [document.querySelector(".controls")]);
  if (opts.noBack) {
    returnFocus = null;
    return;
  }
  // 開いた元（日付のボタン）が残っていればそこへ。自動で開いたときは本文の先頭へ
  const back =
    returnFocus && returnFocus.isConnected && returnFocus.offsetParent !== null
      ? returnFocus
      : document.getElementById("mainContent");
  if (back) {
    if (back.id === "mainContent") back.tabIndex = -1;
    back.focus({ preventScroll: back.id === "mainContent" });
  }
  returnFocus = null;
}

export const isWeeklyOpen = () => open;
