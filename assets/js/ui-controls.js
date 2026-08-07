/* 操作バー：検索窓・3つのボタン・適用中の絞り込み・リセット・スクロール時の縮小。 */

import { curTab, curState, resetState, activeTab } from "./state.js";
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
      closeSearch();
    }
  });
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
}

/* すべての絞り込みを解除する。
   以前は適用中バーの「すべて解除」と、その下の「すべての絞り込みを解除」ボタンが
   同じ役割で並んでいた。同じ機能を2つ置くぶんだけ縦が伸び、狭い画面では
   カードの見える枚数が減るので、バー側の1つに寄せた。 */
export function resetFilters() {
  resetState(activeTab);
  el.q.value = "";
  resetCalendarCursor();
  renderCalendar();
  syncPrefChips();
  renderVenueList();
  updateMapAreaStatus();
  syncLocateMsg();
  refreshNow({ push: true });
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
  el.controls.classList.add("search-open");
  el.q.focus();
}
function closeSearch() {
  el.controls.classList.remove("search-open");
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

export function syncSearchForTab() {
  const tab = curTab();
  el.q.placeholder = tab.placeholder;
  el.qLabel.textContent = tab.placeholder;
  el.q.value = curState().q;
  closeSearch();
}

/* ---------- スクロール時の縮小 ----------
   監視は常に登録する。以前は prefers-reduced-motion のときリスナごと付けて
   いなかったため、バーの縮小だけでなく「スクロールしたらポップアップを閉じる」も
   効かなくなっていた。動きを減らすのは compact の付け外しだけに限定する。 */
function initScroll() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let lastY = window.scrollY,
    ticking = false;
  const onScroll = () => {
    const y = window.scrollY;
    if (!reduced) {
      if (y < 32) el.controls.classList.remove("compact");
      else if (y > lastY + 2) el.controls.classList.add("compact");
      else if (y < lastY - 2) el.controls.classList.remove("compact");
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
