/* 今週のボード（設計書 第5.16節）。更新のあとに初めて開いたときと、ヘッダーの「最終更新日」の
   ボタンから開く、全画面のスライド。何を載せるかは onboard.js、ここは見せ方と操作だけを持つ。

   自動で進む。ただし次の間は止まる（WCAG 2.2.2）。
     ・止めるボタンを押している間
     ・画面を長押ししている間（指を離すと再開。題名の札・下のボタンの上も同じ）
     ・キーボードの操作でフォーカスが中にある間（矢印・ボタンで自分の速さで読める）
     ・本文をスクロールしたとき（読んでいるとみなし、止めるボタンを押したのと同じ状態にする）
     ・タブが裏に回っている間
   動きを減らす設定（prefers-reduced-motion）の人には、はじめから自動で進めない（再開は押せる）。
   進む仕組みは CSS の animation（進捗の棒）の終わりで次へ送る。タイマーも rAF も持たないので、
   開いている間も画面を描き直し続けない。 */

import { esc } from "./util.js";
import {
  setBackgroundInert,
  trapTab,
  focusableIn,
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
/* 直近の押下が続いた長さ（ms）。離したあとの click で、長押しだったかを見分けるのに使う */
let heldMs = 0;
// これ以上押していたら長押し（止めて読む操作）とみなし、離しても進めない・ボタンを働かせない
const LONG_MS = 350;
// 開いたときに history へ積んだ1つ（戻るでボードを閉じるため）が残っているか
let pushed = false;
// 自分の history.back() が起こす popstate を、main.js のタブ復元へ渡さない
let ignorePop = false;
let ignoreTimer = 0;
let resizeObs = null;

const reduceMotion = () =>
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ページごとの滞在秒数。題名の一覧があるページは読むのに時間がかかる
const DUR = { total: 7, fav: 9, weekend: 9, free: 8, movies: 8, last: 7 };

const PAUSE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" class="ico-pause"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" class="ico-play"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;

/* 最後のページの絵。♡は「先頭にまとまる」ものではないので描かない（★と人のマークだけ）。
   背景は昼夜で変わらない色つきの面なので、絵の色も昼夜の変数を使わず固定する */
const LAST_ART = `<svg viewBox="0 0 170 80" width="170" height="80" role="presentation"><g transform="translate(46 40)"><circle r="32" fill="#fff" stroke="#33302b" stroke-width="3"/><path transform="scale(2.4)" d="M0-8.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L0 4.8-5.2 7.5l1-5.8-4.2-4.1 5.8-.8z" fill="#e8b93c" stroke="#33302b" stroke-width="1"/></g><g transform="translate(124 40)"><circle r="32" fill="#fff" stroke="#33302b" stroke-width="3"/><g transform="scale(2.4)"><circle cy="-3" r="3.6" fill="#527b86" stroke="#33302b" stroke-width="1"/><path d="M-7 8c0-4 3-6.5 7-6.5S7 4 7 8z" fill="#527b86" stroke="#33302b" stroke-width="1"/></g></g></svg>`;

/* ---------- ページの HTML ---------- */

const n = (v) => Number(v).toLocaleString("ja-JP");
/* 内訳の区切りは「、」にする。「・」だと「ライブ・フェス」の「・」と同じ記号になり、
   「イベント 277・ライブ・フェス 28」が3項目に読めるため */
const joinParts = (rows) => rows.join("、");

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
    <p class="wk-sub">${joinParts(p.breakdown.map((b) => `${esc(b.label)} ${n(b.n)}`))}</p>
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
    <h2 class="wk-h">お気に入りに<br />新着があります</h2>
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
    <p class="wk-sub">${joinParts(p.counts.map((c) => `${esc(c.label)} ${n(c.n)}`))}</p>
    ${itemsHtml(p.items)}
    ${p.free > 0 ? `<p class="wk-note">うち無料は${n(p.free)}件です。</p>` : ""}`,
  free: (p) => `
    <h2 class="wk-h">無料で楽しめるイベント</h2>
    <p class="wk-big">${n(p.n)}<small>件</small></p>
    ${itemsHtml(p.items)}`,
  movies: (p) => `
    <h2 class="wk-h">今週公開の映画</h2>
    <p class="wk-big">${n(p.n)}<small>本</small></p>
    ${itemsHtml(p.items)}`,
  last: (p) => `
    <div class="wk-art" aria-hidden="true">${LAST_ART}</div>
    <h2 class="wk-h">お気に入りを登録しよう</h2>
    <p class="wk-text">会場名の横の★と、出演者の横の人のマークで登録すると、その予定が一覧の先頭にまとまります。登録はこの端末の中だけに保存されます。</p>`,
};

/* 下に固定するボタン。無いページには、操作のヒントを出す。
   本文と分けるのは、題名が長くて本文が溢れても、押したいボタンが画面の外へ出ないようにするため */
const HINT = `<p class="wk-hint">右をタップで次へ・長押しで止まる</p>`;
const PAGE_CTA = {
  weekend: (p) =>
    p.counts
      .map(
        (c) =>
          `<button type="button" class="map-btn" data-act="apply" data-tab="${esc(c.tab)}" data-kind="weekend">${esc(c.label)}${n(c.n)}件を見る</button>`,
      )
      .join(""),
  free: () =>
    `<button type="button" class="map-btn" data-act="apply" data-tab="event" data-kind="free">無料のイベントだけを見る</button>`,
  last: (p) =>
    `<button type="button" class="map-btn primary" data-act="close">一覧を見る</button>${p.hasFavs ? `<button type="button" class="map-btn" data-act="manage">お気に入り管理</button>` : ""}`,
};
const ctaHtml = (p) => (PAGE_CTA[p.id] ? PAGE_CTA[p.id](p) : HINT);

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
  el.cta.innerHTML = pages.map(ctaHtml).join("");
  const pairs = [];
  const walk = document.createTreeWalker(el.sheet, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode())
    pairs.push([t.parentElement, t.data]);
  preloadFonts(pairs);
}

/* ---------- 描画と送り ---------- */

// 題名の横に「・10.28 更新」。3タブのうち最も新しい更新日
function whenText(dates) {
  const latest = Object.values(dates || {})
    .filter(Boolean)
    .sort()
    .pop();
  const m = latest && /^\d{4}-(\d{2})-(\d{2})/.exec(latest);
  return m ? `・${Number(m[1])}.${Number(m[2])} 更新` : "";
}

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
  /* 本文・下のボタンにフォーカスがあるまま描き替えると、その要素が消えてフォーカスが body に落ち、
     矢印も Esc も（シートの keydown が受けられず）効かなくなる。描き替えで失うときは、枠へ移す */
  const hadFocus =
    el.body.contains(document.activeElement) ||
    el.cta.contains(document.activeElement);
  el.body.innerHTML = `<div class="wk-page">${PAGE_HTML[p.id](p)}</div>`;
  el.cta.innerHTML = ctaHtml(p);
  if (hadFocus && !el.sheet.contains(document.activeElement))
    el.inner.focus({ preventScroll: true });
  el.body.scrollTop = 0;
  el.inner.dataset.page = p.id;
  el.sheet.style.setProperty("--wk-dur", `${DUR[p.id] || 7}s`);
  renderBars();
  el.count.textContent = `${cur + 1} / ${pages.length}ページ`;
  setDisabled(el.prev, cur === 0);
  setDisabled(el.next, cur === pages.length - 1);
  watchOverflow();
}

/* 本文が溢れていて、まだ下に続きがあるときだけ、下端をフェードさせる（.has-more）。
   背の低い画面では本文の一部しか見えず、スクロールできることが見た目では分からないため。
   描き替え・画面の大きさ・フォントの読み込みで高さが変わるので、スクロールだけでなく大きさの変化も見る。
   ResizeObserver は最初の観測で1回呼ばれるので、ここでレイアウトを強制して測らずに済む */
function syncMore() {
  const b = el.body;
  b.classList.toggle(
    "has-more",
    b.scrollHeight - b.clientHeight - b.scrollTop > 2,
  );
}
function watchOverflow() {
  if (typeof ResizeObserver !== "function") {
    requestAnimationFrame(syncMore);
    return;
  }
  if (!resizeObs) resizeObs = new ResizeObserver(syncMore);
  resizeObs.disconnect();
  resizeObs.observe(el.body);
  if (el.body.firstElementChild) resizeObs.observe(el.body.firstElementChild);
}

/* 読み上げへページの変化を伝える。見た目は棒とタップで進むだけで、読み上げには何も届かないため。
   開いた直後は伝えない（ダイアログの名前とフォーカスのあるボタンが読まれ、二重になる）ので、
   書くのはページが変わったときだけにしている（openWeekly は空にしておく） */
function announce() {
  const h = el.body.querySelector(".wk-h");
  const title = h ? h.textContent.replace(/\s+/g, "") : "";
  el.live.textContent = `${cur + 1} / ${pages.length}ページ${title ? "：" + title : ""}`;
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
  announce();
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
  el.col = el.sheet.querySelector(".wk-col");
  el.bars = document.getElementById("weeklyBars");
  el.body = document.getElementById("weeklyBody");
  el.cta = document.getElementById("weeklyCta");
  el.when = document.getElementById("weeklyWhen");
  el.prev = document.getElementById("weeklyPrev");
  el.next = document.getElementById("weeklyNext");
  el.count = document.getElementById("weeklyCount");
  el.live = document.getElementById("weeklyLive");
  el.pause = document.getElementById("weeklyPause");
  el.close = document.getElementById("weeklyClose");
  el.pause.innerHTML = PAUSE_ICON;

  el.close.addEventListener("click", closeWeekly);
  el.prev.addEventListener("click", () => go(cur - 1));
  el.next.addEventListener("click", () => go(cur + 1));
  el.pause.addEventListener("click", () => {
    userPaused = !userPaused;
    /* 動きを減らす設定では、棒の animation を切ってあるので animationend が来ず、再開しても進まない。
       再開を押した人は自動で進めることを選んだので、棒だけは動かして進める（ページの出現の動きは無いまま）。
       棒を作り直すのは、animation を頭から始めるため */
    if (!userPaused && reduceMotion()) {
      el.sheet.classList.add("is-resumed");
      renderBars();
    }
    syncPaused();
  });
  // 棒が満ちたら次のページへ。最後のページでは止まる（繰り返さない）
  el.bars.addEventListener("animationend", (e) => {
    if (!open || !e.target.classList.contains("wk-fill")) return;
    if (cur < pages.length - 1) go(cur + 1);
  });

  /* 画面の押下。上の帯（進捗・題名・止める／とじる）と前へ／次へは本来の動き（押すだけ）で、長押しの対象にしない。
     本文の題名の札と下のボタンは、押したまま読む人がいるので、上でも長押し中は止める。
     それ以外は、中身の列の左側（4割）で前へ・それより右で次へ。列の外（広い画面の左右の余白）も、
     列の左右に延ばして同じに扱う。長押しは「止めて読む」操作なので、指を離しても進めず、
     札・ボタンの上なら離してもボタンを働かせない（離した指でボードが閉じてしまわないように） */
  const outsideHold = (t) => t.closest(".wk-bars, .wk-top, .wk-step");
  el.inner.addEventListener("pointerdown", (e) => {
    heldMs = 0;
    if (outsideHold(e.target)) return;
    holding = true;
    // 時刻は、入力が届いた時刻（timeStamp）で測る。遅い端末では処理が遅れ、素早いタップを長押しと誤るため
    holdAt = e.timeStamp;
    syncPaused();
  });
  const release = (e) => {
    if (!holding) return;
    holding = false;
    heldMs = e.timeStamp - holdAt;
    syncPaused();
  };
  el.inner.addEventListener("pointerup", release);
  el.inner.addEventListener("pointercancel", release);
  el.inner.addEventListener("pointerleave", release);
  el.inner.addEventListener("click", (e) => {
    const t = e.target;
    const btn = t.closest && t.closest("button, a");
    if (btn) {
      // detail が 0 の click はキーボード（Enter・Space）や読み上げからで、押し続けるものではないので常に働かせる
      if (e.detail !== 0 && heldMs > LONG_MS && !outsideHold(btn)) return;
      return onBodyButton(btn);
    }
    if (outsideHold(t)) return;
    if (heldMs > LONG_MS) return;
    const r = el.col.getBoundingClientRect();
    if (e.clientX - r.left < r.width * 0.4) go(cur - 1);
    else go(cur + 1);
  });

  /* 本文をスクロールしたら、読んでいるとみなして自動送りを止める（止めるボタンを押したのと同じ状態）。
     描き替えの scrollTop = 0 は数えない（0 のときは読み進めたのではなく先頭に戻っただけ） */
  el.body.addEventListener(
    "scroll",
    () => {
      syncMore();
      if (!open || userPaused || el.body.scrollTop <= 0) return;
      userPaused = true;
      syncPaused();
    },
    { passive: true },
  );

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
    if (e.key === "Tab" && e.shiftKey && document.activeElement === el.inner) {
      /* 描き替えや空白のタップで、フォーカスが枠そのものにあるとき。先頭の部品ではないので
         trapTab は何もせず、Shift+Tab がシートの外（背面・ブラウザの枠）へ抜けてしまう。末尾へ回す */
      const items = focusableIn(el.sheet);
      if (items.length) {
        e.preventDefault();
        items[items.length - 1].focus();
      }
    } else trapTab(el.sheet, e);
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

/* 背面（本文 main の約500枚のカード）を、ボードの下に隠す。
   ボードは不透明で全面を覆うので、背面は見えなくてよい。inert を掛けると、背面のほぼ全要素のスタイルを
   計算し直すので、遅い端末では開くとき・閉じるときにそれぞれ1秒以上固まる。content-visibility: hidden なら、
   本文の中身は計算も描画もされず、フォーカス・読み上げ・検索の対象にもならない（inert と同じ役目を果たす）。
   念のため aria-hidden も付ける（対応が不完全なブラウザで、中身が読み上げに出ないように。この属性は
   CSS の対象ではないので、スタイルの計算は起きない）。
   このとき本文の箱は中身が空のものとして縮むので、元の高さを contain-intrinsic-size で保つ。
   保たないと、閉じたあとにページの長さが戻るまで、スクロール位置が先頭へ寄ってしまう。
   header と検索バーは小さいので、これまでどおり inert にする。
   content-visibility に対応していないブラウザは、これまでどおり本文も inert にする */
const canSkipContents = () =>
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("content-visibility", "hidden") &&
  CSS.supports("contain-intrinsic-block-size", "1px");
let skippedMain = null;

function coverBackground(on) {
  const controls = document.querySelector(".controls");
  const main = document.querySelector("main");
  if (on) {
    if (main && canSkipContents()) {
      main.style.setProperty(
        "--wk-main-h",
        `${Math.ceil(main.getBoundingClientRect().height)}px`,
      );
      main.classList.add("wk-under");
      main.setAttribute("aria-hidden", "true");
      skippedMain = main;
      setBackgroundInert(true, [controls], [main]);
    } else setBackgroundInert(true, [controls]);
  } else {
    if (skippedMain) {
      skippedMain.classList.remove("wk-under");
      skippedMain.removeAttribute("aria-hidden");
      skippedMain.style.removeProperty("--wk-main-h");
      skippedMain = null;
    }
    setBackgroundInert(false, [controls]);
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
  heldMs = 0;
  kbMode = viaKeyboard;
  // 動きを減らす設定の人には、はじめから自動で進めない（再開は押せる）
  userPaused = reduceMotion();
  el.sheet.classList.remove("is-resumed");
  el.when.textContent = whenText(dates);
  el.live.textContent = "";
  el.sheet.hidden = false;
  document.body.style.overflow = "hidden";
  coverBackground(true);
  /* 背面を隠したあと、1ページ目を描く前に頼む。getComputedStyle は溜まっているスタイルの
     計算をその場で済ませるので、隠す前に呼ぶと「直前の一覧の描き直し」と「隠す操作」の計算が
     2回に分かれる（どちらも背面のほぼ全要素で、遅い端末では1回1秒ほど）。ここなら1回にまとまる。
     1ページ目を描いて（renderPage のレイアウトで）その断片を先に取りに行かせると、
     残りのページの断片と届く時刻が分かれやすい */
  preloadBoardFonts();
  renderPage();
  syncPaused();
  // 既定の送り先は、閉じるボタン。空白を押しても、キー入力がこのシートの中に届くよう、
  // 枠そのもの（tabindex="-1"）にもフォーカスを受けさせている
  el.close.focus();
  pushBoardEntry();
  return true;
}

/* 戻る（ブラウザ・Android の戻るボタン）でボードを閉じられるよう、開いたときに history へ1つ積む。
   積まないと、ボードを開いたまま戻ると、一覧へ戻らずサイトから離れてしまう。URL は変えない（同じ URL を積む）。
   ただし、ページを開いてから何も触っていないうちに自動で開いたときは、Chrome が「操作なしに積んだ項目」を
   戻るの対象から外すことがあり、この1つは効かない（その場合は従来どおりの動きになる）。 */
function pushBoardEntry() {
  try {
    history.pushState({ weeklyBoard: 1 }, "", location.href);
    pushed = true;
  } catch {
    pushed = false; // file:// などで history が使えなくても、ボード自体は動かす
  }
}

/* 積んだ1つを片づける。
     viaPop … 戻るで閉じた。もう消えているので何もしない
     noBack … 題名・「◯件を見る」・お気に入り管理で閉じた。このあと main.js が URL を積むので、戻らずに
              目印（state）だけ外す。history.back() を待つと、そのあとの操作（URL の書き換え）が前後してしまう
     ほか   … ×・Esc・「一覧を見る」。積んだ分を history.back() で消す（その popstate は無視する） */
function dropBoardEntry({ noBack = false, viaPop = false } = {}) {
  if (!pushed) return;
  pushed = false;
  if (viaPop) return;
  try {
    if (noBack) {
      history.replaceState(null, "", location.href);
      return;
    }
    ignorePop = true;
    clearTimeout(ignoreTimer);
    // popstate が届かないまま残ると、次の本物の「戻る」を飲み込むので、時間で解く
    ignoreTimer = setTimeout(() => (ignorePop = false), 2000);
    history.back();
  } catch {
    ignorePop = false;
  }
}

/* popstate は、main.js の「戻る/進む」（URL からタブと絞り込みを復元する）より先に受けて止める。
   このファイルは main.js から import されるので、モジュール直下で登録すれば main.js の登録より前になる。
   ボードを閉じるだけの戻るで復元まで走ると、背面の約500枚を描き直してしまう */
window.addEventListener("popstate", (e) => {
  if (ignorePop) {
    ignorePop = false;
    clearTimeout(ignoreTimer);
    e.stopImmediatePropagation();
  } else if (open && pushed) {
    e.stopImmediatePropagation();
    closeWeekly({ viaPop: true });
  }
});

export function closeWeekly(opts = {}) {
  if (!el.sheet || !open) return;
  open = false;
  dropBoardEntry(opts);
  el.sheet.hidden = true;
  el.bars.innerHTML = "";
  el.live.textContent = "";
  resizeObs?.disconnect();
  document.body.style.overflow = "";
  coverBackground(false);
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
