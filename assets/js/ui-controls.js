/* 操作バー：検索窓・3つのボタン・適用中の絞り込み・リセット・スクロール時の縮小。 */

import {
  curTab,
  curState,
  resetAllStates,
  clearSharedFilters,
  activeTab,
} from "./state.js";
import { refresh, refreshNow } from "./render.js";
import { handleScrollForPopover } from "./ui-popover.js";
import {
  syncPrefChips,
  renderVenueList,
  updateMapAreaStatus,
  syncLocateMsg,
} from "./ui-area.js";
import { renderCalendar, resetCalendarCursor } from "./ui-calendar.js";

const el = {};

export function initControls() {
  el.controls = document.querySelector(".controls");
  el.q = document.getElementById("q");
  el.qLabel = document.getElementById("qLabel");
  el.toggle = document.getElementById("searchToggle");
  el.applied = document.getElementById("appliedBar");
  el.sortDate = document.getElementById("sortDateBtn");
  el.sortLoc = document.getElementById("sortLocBtn");
  el.cat = document.getElementById("catBtn");
  el.catTitle = document.getElementById("catPopoverTitle");

  // 検索は打鍵ごとに一覧を作り直す。件数が少ないうちは即時のほうが手応えが良いので、
  // 遅延は render 側が件数を見て決める（ここでは値の反映だけ）。
  el.q.addEventListener("input", (e) => {
    curState().q = e.target.value;
    refresh({ push: false });
  });
  el.q.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el.controls.classList.contains("search-open")) {
      e.preventDefault();
      // 閉じるならフォーカスも手放す。入力欄に居座ったままだと、
      // 縮んだバーの中で表示だけ消えた入力欄にフォーカスが残ってしまう。
      el.q.blur();
      closeSearch();
    }
  });
  // 入力欄に触れて開いた場合も「開いている」状態にする。虫めがね経由でないと
  // search-open が付かないままだったため、直後に compact が付くと
  // .controls.compact .search-row（display:none）で入力欄ごと消えていた。
  el.q.addEventListener("focus", openSearch);
  // 入力が残っているあいだは開いたままにして、何で検索したかを見えるようにする。
  // 開いたまま縮んでも、いまは検索欄とボタンが縦に積まれるだけで何も隠れない。
  el.q.addEventListener("blur", () => {
    if (!el.q.value) closeSearch();
  });

  el.toggle.addEventListener("click", openSearch);

  // 適用中チップ：1タップで外す
  el.applied.addEventListener("click", (e) => {
    const clear = e.target.closest("#appliedClear");
    if (clear) {
      resetFilters();
      return;
    }
    const chip = e.target.closest(".applied-chip");
    if (!chip) return;
    removeFilter(chip.dataset.type, chip.dataset.facet, chip.dataset.key);
  });

  initScroll();
  trackBarBox();
  keepFocusVisible();
}

/* すべての絞り込みを解除する。
   以前は適用中バーの「すべて解除」と、その下の「すべての絞り込みを解除」ボタンが
   同じ役割で並んでいた。同じ機能を2つ置くぶんだけ縦が伸び、狭い画面では
   カードの見える枚数が減るので、バー側の1つに寄せた。 */
export function resetFilters() {
  resetAllStates();
  el.q.value = "";
  syncFilterViews();
  refreshNow({ push: true });
}

/* 日程・都県・地図の範囲・特別チップだけを外す（検索語とタブ固有の絞り込みは残す）。
   0件の画面から、持ち越された条件だけをすぐ手放せるようにする出口。 */
export function resetSharedFilters() {
  clearSharedFilters(activeTab);
  syncFilterViews();
  refreshNow({ push: true });
}

// 状態を映す表示（カレンダー・都県チップ・会場一覧・地図範囲・現在地メッセージ）を塗り直す
function syncFilterViews() {
  resetCalendarCursor();
  renderCalendar();
  syncPrefChips();
  renderVenueList();
  updateMapAreaStatus();
  syncLocateMsg();
}

function removeFilter(type, facetId, key) {
  const st = curState();
  switch (type) {
    case "q":
      st.q = "";
      el.q.value = "";
      break;
    case "range":
      st.rangeStart = null;
      st.rangeEnd = null;
      renderCalendar();
      break;
    case "sort":
      st.sortBy = "date";
      if (st.userLoc) st.userLoc = null;
      syncLocateMsg();
      renderCalendar();
      break;
    case "pref":
      st.pref = null;
      syncPrefChips();
      break;
    case "venue":
      st.venue = null;
      renderVenueList();
      break;
    case "map":
      st.mapArea = null;
      updateMapAreaStatus();
      break;
    case "facet":
      st.sets[facetId]?.delete(key);
      break;
    case "flag":
      st.flags[key] = false;
      break;
  }
  refreshNow({ push: true });
}

/* ---------- 検索窓の開閉（狭い画面で縮んだとき） ----------
   以前は入力欄そのものを32pxまで潰してアイコンのように見せていたが、
   「入力欄が消えた」と受け取られるうえ、タッチ目標としても小さすぎた。
   縮んだときは虫めがねボタンを出し、押したら入力欄を開く形にする。 */
function openSearch() {
  if (!el.controls.classList.contains("search-open"))
    morphBar(() => el.controls.classList.add("search-open"));
  el.q.focus({ preventScroll: true });
}
function closeSearch() {
  if (el.controls.classList.contains("search-open"))
    morphBar(() => el.controls.classList.remove("search-open"));
}

/* ---------- ボタンの状態 ----------
   ラベルは「日程／エリア／絞り込み」で固定し、いま何で絞っているかは
   適用中チップの行が受け持つ（同じ情報を2か所に出さない）。
   ボタン側は aria-pressed で「この軸に絞り込みがある」ことだけを示す。 */
export function updateSortUI() {
  const tab = curTab(),
    st = curState();
  const hasRange = !!(st.rangeStart && st.rangeEnd);
  el.sortDate.setAttribute(
    "aria-pressed",
    String(hasRange || st.sortBy === "announced"),
  );
  el.sortLoc.setAttribute(
    "aria-pressed",
    String(!!(st.pref || st.venue || st.mapArea || st.sortBy === "location")),
  );
  el.cat.setAttribute(
    "aria-pressed",
    String(
      tab.facets.some((f) => st.sets[f.id].size) ||
        tab.flags.some((f) => st.flags[f.id]),
    ),
  );
  el.catTitle.textContent = tab.catTitle;
}

// 検索語は3タブで共有なので、タブを切り替えても入力欄の中身とplaceholderは
// 変えない（index.htmlに直接書いた固定文言のまま）。値の再代入だけ行うのは、
// resetFilters() 等の外側の操作で state.q が変わったときに表示を追いつかせるため。
export function syncSearchForTab() {
  el.q.value = curState().q;
  closeSearch();
}

/* ---------- スクロール時の縮小 ----------
   監視は常に登録する。以前は prefers-reduced-motion のときリスナごと付けて
   いなかったため、バーの縮小だけでなく「スクロールしたらポップアップを閉じる」も
   効かなくなっていた。動きを減らすのは compact の付け外しだけに限定する。

   入力中はバーの形を変えない。スマホで検索欄をタップするとキーボードが上がり、
   端末が入力欄を見せようとしてページを勝手に下へ送る。その動きを「ユーザーが
   下スクロールした」と読んで compact を付けてしまうと、狭い画面では
   .controls.compact .search-row が display:none になり、入力欄ごと消えて
   フォーカスが外れる（＝キーボードが一瞬で引っ込む）。

   .controls は position:sticky で自分の分だけ文書の高さを占めている。縮んだ分を
   下の余白（syncBarBox）で埋めて文書の高さを保つので、縮んでも下の一覧はずれず、
   最下部付近で scrollY が新しい上限へクランプされることもない（以前はこのクランプが
   scroll イベントを連発させ、「逆方向にスクロールした」と誤認して縮む→伸びる…を
   繰り返していた）。それでも縮んでいる間に帯が増えるとバーの高さは変わるので、
   形を変えている最中（MORPH_MS）は方向判定を止めておく。

   埋めた余白は、バーが元の位置（ヘッダーの真下）にあるあいだはバーの下の空白としてそのまま見える。
   画面の上に張り付いたバーの裏へ余白が隠れきるまで（barHiddenGapY）は縮めず、余白が見える位置まで
   戻ったら、方向や入力中かどうかに関係なく伸ばす。伸ばしても埋めていた余白をバーが覆い直すだけで、
   一覧は動かず、フォーカスのある部品も覆わない。 */
function initScroll() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let lastY = window.scrollY;
  let lockUntil = 0;
  let ticking = false;
  // Tab でフォーカスを移したときのスクロールでは、バーの形を変えない。上へ戻るスクロールで
  // バーが伸びると、伸びた分がちょうどフォーカスのある部品を覆ってしまう（keepFocusVisible）
  let keyNavUntil = 0;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab") keyNavUntil = performance.now() + 600;
    },
    true,
  );
  const setCompact = (add, instant = false) => {
    if (el.controls.classList.contains("compact") === add) return;
    morphBar(() => el.controls.classList.toggle("compact", add), instant);
    lockUntil = performance.now() + MORPH_MS + 40;
  };
  // 向きが変わった位置からどれだけ進んだかで判定する。1コマごとの差で見ると、指でゆっくり
  // 動かしたとき（1コマ 1〜2px）は何度戻っても伸びず、縮んだまま余白の見える位置まで戻れてしまう
  let dir = 0;
  let turnY = lastY;
  const onScroll = () => {
    const y = window.scrollY;
    if (y !== lastY) {
      const d = y > lastY ? 1 : -1;
      if (d !== dir) {
        dir = d;
        turnY = lastY;
      }
    }
    const compact = el.controls.classList.contains("compact");
    const gapY = barHiddenGapY(barGap());
    // scrollY は端末によって整数に丸められるので、1px 未満の差は見えている余白と見なさない
    if (compact && y < gapY - 1) {
      // 埋めた余白が見えている。少しだけなら形を変える動きで埋め、大きく見えている（一度に
      // 飛んできた）ときは動かすあいだ空白が残るので、その場で伸ばす
      setCompact(false, gapY - y > 24);
    } else if (
      !reduced &&
      document.activeElement !== el.q &&
      performance.now() >= lockUntil &&
      performance.now() >= keyNavUntil
    ) {
      // 縮める前の余白の高さはまだ分からないので、伸びたバーの高さぶん（＝余白の上限）を見込む
      if (dir > 0 && y - turnY > 6 && y >= barHiddenGapY(expandedH) - 1)
        setCompact(true);
      else if (dir < 0 && turnY - y > 6) setCompact(false);
    }
    handleScrollForPopover();
    lastY = y;
    ticking = false;
  };
  window.addEventListener(
    "scroll",
    () => {
      if (!ticking) {
        window.requestAnimationFrame(onScroll);
        ticking = true;
      }
    },
    { passive: true },
  );
}

/* ---------- 操作バーの形の切り替え（縮小・検索欄の開閉） ----------
   形（縦横の並び・大きさ）は一度に切り替え、見た目だけを前の形から transform と
   opacity でつなぐ（FLIP）。以前は padding・min-height・幅を CSS の遷移で動かしていたため、
   毎コマ バーとその下のページ全体のレイアウトと描画をやり直してカクつき、縦→横の並びの
   切り替えや検索欄の表示・非表示は遷移できずに瞬間移動していた。transform と opacity は
   描き直さずに合成だけで動かせるので、遅い端末でも滑らかに動く。
   - 地（.controls-bg）は縦に伸縮、下線（.controls-line）は上下に動かす
   - 残る部品は前の位置・大きさから動かす。ボタンは文字が伸び縮みしないよう、中身を逆向きに縮める
   - 消える部品（描いたまま見えない形にしてある）はその場でフェードアウト、現れる部品はフェードイン
   - 大きさが大きく変わる部品（PC の検索欄 全幅→200px）は伸縮させると文字が潰れるので、フェードインにする
   動いている途中で次の切り替えが来たら、その時点の見た目から次の形へつなぐ。 */
const MORPH_MS = 320;
const MORPH_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
const MORPH_PARTS =
  ".search-row, .search-toggle, .sort-btn, .applied-bar, .result-count, .popover-panel";
let morphs = [];
let morphSeq = 0;

// 見えている部品の矩形。見えていなければ null
function shownRect(n) {
  if (n.hidden || !n.isConnected) return null;
  const cs = getComputedStyle(n);
  if (cs.display === "none" || cs.visibility === "hidden") return null;
  if (parseFloat(cs.opacity) < 0.05) return null;
  const r = n.getBoundingClientRect();
  return r.width && r.height ? r : null;
}

// 検索欄の見た目の写し（ふるまいは持たない飾り）。PC 幅で全幅 ⇔ 200px と大きさが大きく変わるとき、
// 前の検索欄が一瞬で消えないよう、写しをその場でフェードアウトさせる。
// cloneNode にしないのは、写しにも .controls.compact … の規則が当たって形が変わってしまうため
function snapshotInput(rowRect) {
  const q = el.q;
  if (!rowRect || !q) return null;
  const r = q.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const cs = getComputedStyle(q);
  const g = document.createElement("div");
  g.className = "bar-ghost";
  g.setAttribute("aria-hidden", "true");
  g.textContent = q.value || q.placeholder;
  Object.assign(g.style, {
    width: `${r.width}px`,
    height: `${r.height}px`,
    border: cs.border,
    borderRadius: cs.borderRadius,
    background: cs.backgroundColor,
    color: q.value ? cs.color : getComputedStyle(q, "::placeholder").color,
    font: cs.font,
    padding: cs.padding,
  });
  return { el: g, r };
}

function morphBar(apply, instant = false) {
  const bar = el.controls;
  const bg = bar.querySelector(".controls-bg");
  const line = bar.querySelector(".controls-line");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (instant || reduced || typeof bar.animate !== "function" || !bg || !line) {
    morphs.forEach((a) => a.cancel());
    morphs = [];
    bar.querySelectorAll(".bar-ghost").forEach((g) => g.remove());
    apply();
    syncBarBox();
    morphSeq++;
    bar.dispatchEvent(new Event("barmorphend"));
    return;
  }
  // 前の形（動いている途中なら、その時点の見た目）を測ってから、動きを止めて切り替える
  const parts = [...bar.querySelectorAll(MORPH_PARTS)];
  const first = new Map(parts.map((n) => [n, shownRect(n)]));
  const h0 = bg.getBoundingClientRect().height;
  const line0 = line.getBoundingClientRect().top;
  const ghost = snapshotInput(first.get(bar.querySelector(".search-row")));
  morphs.forEach((a) => a.cancel());
  morphs = [];
  bar.querySelectorAll(".bar-ghost").forEach((g) => g.remove());
  apply();
  syncBarBox();
  const h1 = bg.getBoundingClientRect().height;
  const line1 = line.getBoundingClientRect().top;
  const opts = { duration: MORPH_MS, easing: MORPH_EASE };
  const run = (n, kf, o = opts) => morphs.push(n.animate(kf, o));
  const fadeIn = (n) =>
    run(n, [{ opacity: 0 }, { opacity: 1 }], {
      duration: MORPH_MS * 0.6,
      delay: MORPH_MS * 0.4,
      easing: "ease-out",
      fill: "backwards",
    });
  if (h1 > 0 && Math.abs(h0 - h1) > 0.5)
    run(bg, [{ transform: `scaleY(${h0 / h1})` }, { transform: "none" }]);
  if (Math.abs(line0 - line1) > 0.5)
    run(line, [
      { transform: `translateY(${line0 - line1}px)` },
      { transform: "none" },
    ]);
  for (const n of parts) {
    const a = first.get(n);
    const b = shownRect(n);
    if (a && b) {
      const sx = a.width / b.width;
      const sy = a.height / b.height;
      if (Math.abs(sx - 1) > 0.25) {
        // 伸縮させると文字が潰れるので、前の見た目を写しにしてその場で消し、新しい形はフェードインする
        if (ghost) {
          const br = bar.getBoundingClientRect();
          Object.assign(ghost.el.style, {
            left: `${ghost.r.left - br.left}px`,
            top: `${ghost.r.top - br.top}px`,
          });
          bar.append(ghost.el);
          const g = ghost.el.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: MORPH_MS * 0.5,
            easing: "ease-in",
          });
          morphs.push(g);
          const drop = () => ghost.el.remove();
          g.finished.then(drop, drop);
        }
        fadeIn(n);
        continue;
      }
      const dx = a.left + a.width / 2 - (b.left + b.width / 2);
      const dy = a.top + a.height / 2 - (b.top + b.height / 2);
      const scaled = n.matches(".sort-btn, .search-toggle");
      if (
        Math.abs(dx) < 0.5 &&
        Math.abs(dy) < 0.5 &&
        (!scaled || (Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01))
      )
        continue;
      if (!scaled) {
        // 地の位置だけを合わせる（中身の伸び縮みは要らない）
        const tx = a.left - b.left;
        const ty = a.top - b.top;
        run(n, [
          { transform: `translate(${tx}px, ${ty}px)` },
          { transform: "none" },
        ]);
        continue;
      }
      run(n, [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transform: "none" },
      ]);
      for (const c of n.children)
        run(c, [
          { transform: `scale(${1 / sx}, ${1 / sy})` },
          { transform: "none" },
        ]);
    } else if (a && !b) {
      // 消える部品：見えない形（並びから外れた位置）から、前の位置へ戻してフェードアウト
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const tx = a.left - r.left;
      const ty = a.top - r.top;
      const at = `translate(${tx}px, ${ty}px)`;
      run(
        n,
        [
          { transform: at, opacity: 1, visibility: "visible" },
          { transform: at, opacity: 0, visibility: "visible" },
        ],
        { duration: MORPH_MS * 0.5, easing: "ease-in" },
      );
    } else if (!a && b) {
      fadeIn(n);
    }
  }
  // 動き終わったら知らせる（ポップアップが高さを引き直す。ui-popover.js）。
  // 途中で次の切り替えが来たときは、最後の切り替えの分だけ知らせる
  const seq = ++morphSeq;
  Promise.allSettled(morphs.map((m) => m.finished)).then(() => {
    if (seq === morphSeq) bar.dispatchEvent(new Event("barmorphend"));
  });
}

/* ---------- 縮んだ分を下の余白で埋める ----------
   縮んだ分を margin-bottom で埋めて、文書の中でバーが占める高さを保つ。保たないと、
   縮むたびに下の一覧が一度に120pxほど上へずれ（スクロールしている指と関係なく中身が動く）、
   ページ全体の配置と描画もやり直しになる。 */
let expandedH = 0;
function syncBarBox() {
  const bar = el.controls;
  // 小数まで測る（offsetHeight の整数だと、縮むたびに一覧が 1px ずれる）
  const h = bar.getBoundingClientRect().height;
  if (!bar.classList.contains("compact")) {
    expandedH = h;
    bar.style.marginBottom = "";
    return;
  }
  // 縮んでいる間に帯が増減したり折り返しが変わったりすると、伸びたときの高さも変わる。
  // 縮める前に測った値のままだと、伸ばした瞬間に差の分だけ一覧がずれるので、その場で測り直す。
  // 同じ処理の中で戻すので、外した形が描かれることは無い
  bar.classList.remove("compact");
  expandedH = bar.getBoundingClientRect().height;
  bar.classList.add("compact");
  bar.style.marginBottom = expandedH > h ? `${expandedH - h}px` : "";
}
// いま埋めている余白の高さ
function barGap() {
  return parseFloat(el.controls.style.marginBottom) || 0;
}
/** 伸びたときのバーの高さ。縮んでいても「いまの高さ＋埋めている余白」で分かる */
export function barExpandedHeight() {
  return el.controls.getBoundingClientRect().height + barGap();
}
/** ここより下ならバーを縮めても余白が見えない、最初の scrollY */
export function barCompactScrollY() {
  return Math.ceil(barHiddenGapY(barExpandedHeight()));
}
// 高さ gap の余白が、画面の上に張り付いたバーの裏へ隠れきる scrollY。
// 余白は文書の中でバーの元の位置（ヘッダーの真下）の下に付くので、
// そこから gap だけ進むと、余白の下端が張り付いたバーの下端より上へ抜ける
function barHiddenGapY(gap) {
  const prev = el.controls.previousElementSibling;
  const top = prev ? prev.getBoundingClientRect().bottom + window.scrollY : 0;
  return top + gap;
}
function trackBarBox() {
  syncBarBox();
  // 縮んでいる間に帯が増えたり、画面幅が変わって折り返したりしても追いつかせる
  if (typeof ResizeObserver === "function")
    new ResizeObserver(syncBarBox).observe(el.controls, { box: "border-box" });
  else window.addEventListener("resize", syncBarBox);
}

/* ---------- キーボードのフォーカスを操作バーの下に隠さない（WCAG 2.2 の 2.4.11） ----------
   .controls は画面の上に張り付く。Tab で上へ戻ると、ブラウザはフォーカスのある部品を
   「画面の上端」まで動かして止めるため、部品がバーの真下に入り、枠ごと隠れる。
   ブラウザが動かしたあとで、隠れていればバーの下まで戻す。
   html の scroll-padding-top で済ませないのは、バーの中の部品（検索欄・ボタン・ポップアップ）に
   フォーカスが移るたびに「上の余白に隠れている」と見なされ、ページが先頭まで戻ってしまうため。
   バーの中・全画面のシートの中の部品と、マウス・指で押したときは動かさない。 */
function keepFocusVisible() {
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!(t instanceof Element) || el.controls.contains(t)) return;
    if (t.closest(".map-sheet, .cal-menu, .update-overlay, .fav-toast, .toast"))
      return;
    if (!t.matches(":focus-visible")) return;
    requestAnimationFrame(() => {
      if (document.activeElement !== t) return;
      const r = t.getBoundingClientRect();
      const b = el.controls.getBoundingClientRect();
      if (r.bottom > b.top && r.top < b.bottom + 8)
        window.scrollBy({ top: r.top - b.bottom - 12, behavior: "instant" });
    });
  });
}
