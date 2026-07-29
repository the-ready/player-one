/* 起動とタブ切り替え。各モジュールの配線だけを持ち、ロジックは持たない。 */

import { TABS, TAB_ORDER } from "./config.js";
import { LOAD, loadTab, loadTheaters, loadVenues, loadSources, loadUpdatedManifest,
         refreshToday } from "./data.js";
import { activeTab, setActiveTabKey, curTab, curState,
         loadFavorites, rememberTab, recalledTab, queryToState, enableUrlSync, syncUrl } from "./state.js";
import { refreshNow, renderDirectories, syncUpdatedLabel, bindList, onRefresh, toast } from "./render.js";
import { initPopover, closePopover, isPopoverOpen } from "./ui-popover.js";
import { initArea, syncAreaForTab, renderVenueList } from "./ui-area.js";
import { initCalendar, renderCalendar, resetCalendarCursor } from "./ui-calendar.js";
import { initMapSheet, initPlaceSheet, openPlaceSheet, closeMapSheet, closePlaceSheet,
         isMapSheetOpen, isPlaceSheetOpen } from "./ui-map.js";
import { initControls, updateSortUI, syncSearchForTab, resetFilters } from "./ui-controls.js";

/* ---------- タブ ---------- */

const tabBtn = k => document.getElementById(TABS[k].btnId);
const tabPane = k => document.getElementById(TABS[k].paneId);

export function setActiveTab(tab, opts = {}){
  TAB_ORDER.forEach(k => {
    const active = k === tab;
    tabBtn(k).setAttribute("aria-selected", String(active));
    tabBtn(k).tabIndex = active ? 0 : -1;   // tablist内はTab1回で入り、左右キーで移動する
    tabPane(k).hidden = !active;
  });
  setActiveTabKey(tab);
  rememberTab(tab);

  if(isPopoverOpen()) closePopover();
  if(isMapSheetOpen()) closeMapSheet();
  if(isPlaceSheetOpen()) closePlaceSheet();

  // 絞り込み状態はタブごとに別々に持っているので、それを映す表示も全部ぬりかえる。
  syncSearchForTab();
  resetCalendarCursor();
  renderCalendar();
  syncAreaForTab();
  syncUpdatedLabel();
  ensureTabData(tab);
  refreshNow({push:opts.push !== false, url:opts.url !== false});
}

function initTabs(){
  TAB_ORDER.forEach(k => tabBtn(k).addEventListener("click", () => setActiveTab(k)));
  document.querySelector(".tab-group").addEventListener("keydown", e => {
    const i = TAB_ORDER.findIndex(k => tabBtn(k) === document.activeElement);
    if(i < 0) return;
    let next = null;
    if(e.key === "ArrowRight") next = TAB_ORDER[(i + 1) % TAB_ORDER.length];
    else if(e.key === "ArrowLeft") next = TAB_ORDER[(i - 1 + TAB_ORDER.length) % TAB_ORDER.length];
    else if(e.key === "Home") next = TAB_ORDER[0];
    else if(e.key === "End") next = TAB_ORDER[TAB_ORDER.length - 1];
    if(!next) return;
    e.preventDefault();
    setActiveTab(next);
    tabBtn(next).focus();
  });
}

/* ---------- データ読み込み ----------
   表示中のタブを先に出し、残りは手が空いたときに裏で取る。
   単純な遅延読み込みだけにすると、初めて別タブを押したときに待ち時間が生まれる
   （いまは常に一瞬で切り替わる）ので、先読みして体感を落とさないようにする。 */

const started = new Set();

async function ensureTabData(tabKey){
  if(started.has(tabKey)) return LOAD[tabKey].state === "done";
  started.add(tabKey);
  try{
    await loadTab(tabKey);
  } catch {
    // 状態は LOAD に入っている。表示は render 側が出し分ける
    if(activeTab === tabKey) refreshNow({url:false});
    return false;
  }
  if(activeTab === tabKey){ syncUpdatedLabel(); renderVenueList(); refreshNow({url:false}); }
  return true;
}

async function boot(){
  loadFavorites();

  // URLに状態があればそれを最優先。無ければ前回のタブを思い出す。
  const fromUrl = queryToState(location.search);
  const startTab = fromUrl || recalledTab() || "event";
  setActiveTabKey(startTab);

  initPopover({onOpen:() => {}, onClose:() => {}});
  initArea();
  initCalendar();
  initMapSheet();
  initPlaceSheet();
  initControls();
  initTabs();
  onRefresh(updateSortUI);

  TAB_ORDER.forEach(k => {
    const listEl = document.getElementById(TABS[k].listId);
    if(listEl) bindList(listEl, {onOpenPlace: openPlaceSheet, onReset: resetFilters});
  });

  // 絞り込みチップ（件数つき）の押下
  document.getElementById("catBody").addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if(!chip || chip.disabled) return;
    const tab = curTab(), st = curState();
    const key = chip.dataset.key;
    const row = chip.closest("[data-facet]");
    if(row){
      const set = st.sets[row.dataset.facet];
      if(!set) return;
      if(set.has(key)) set.delete(key); else set.add(key);
    } else {
      const flag = tab.flags.find(f => f.id === key);
      if(!flag) return;
      st.flags[key] = !st.flags[key];
      // 同時に立つと必ず0件になる組み合わせは、片方を押したらもう片方を外す
      if(st.flags[key]) (flag.exclusive || []).forEach(other => { st.flags[other] = false; });
    }
    refreshNow({push:false});
  });

  // ページ全体で使う一括表示
  await loadSources();
  renderDirectories();
  loadUpdatedManifest().then(syncUpdatedLabel);

  // 表示中のタブを先に、続いてマスターと残りのタブ
  await ensureTabData(activeTab);
  setActiveTab(activeTab, {push:false, url:false});
  enableUrlSync();
  syncUrl(false);

  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 400));
  idle(async () => {
    await Promise.all([loadTheaters(), loadVenues()]);
    for(const k of TAB_ORDER){ if(k !== activeTab) await ensureTabData(k); }
    renderVenueList();
    refreshNow({url:false});
  });
}

/* ---------- 戻る/進む ---------- */
window.addEventListener("popstate", () => {
  const key = queryToState(location.search) || "event";
  setActiveTab(key, {push:false, url:false});
});

/* ---------- 日付をまたいだとき ----------
   ページを開きっぱなしにしていると「本日まで」「あと0日」がずれる。
   タブに戻ってきたタイミングで今日を採り直し、変わっていれば塗り直す。 */
document.addEventListener("visibilitychange", () => {
  if(document.visibilityState !== "visible") return;
  if(refreshToday()){ resetCalendarCursor(); renderCalendar(); refreshNow({url:false}); }
});

/* ---------- Service Worker ----------
   古いデータを黙って見せないことが最優先。CSVはネットワーク優先で取り、
   取れなかったときだけキャッシュを使う。

   本体が新しくなったときは、確認を挟まずそのまま入れ替える。
   絞り込みの状態・タブはURLに載っているので、読み直しても見ていた条件は
   そのまま復元される（スクロール位置もブラウザが戻す）。
   「新しい版があります／再読み込み」を出して押させるより、そのほうが速い。 */

const RELOAD_GUARD_KEY = "eventboard.swReloadedAt";
let swUpdating = false;

// 何かの拍子に「更新→読み直し→また更新」を繰り返さないための保険。
// 直前に自動更新していたら、今回は入れ替えを見送る（取りこぼしよりループ回避を優先）。
function recentlyReloaded(){
  try{ return Date.now() - (Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0) < 10000; }
  catch{ return false; }
}
function reloadForUpdate(){
  if(!swUpdating) return;
  swUpdating = false;
  try{ sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())); } catch { /* 保存できなくても進む */ }
  location.reload();
}

function applyUpdate(waiting){
  if(swUpdating || recentlyReloaded()) return;
  swUpdating = true;
  const overlay = document.getElementById("updateOverlay");
  if(overlay) overlay.hidden = false;
  waiting.postMessage({type:"SKIP_WAITING"});
  // controllerchange が来ないまま止まると画面が覆われたままになるので、保険で読み直す
  setTimeout(reloadForUpdate, 4000);
}

function initServiceWorker(){
  if(!("serviceWorker" in navigator)) return;
  if(location.protocol !== "https:" && location.hostname !== "localhost") return;

  navigator.serviceWorker.register("./sw.js").then(reg => {
    // 前回の訪問で用意され、待機したままの版があればそれを適用する
    if(reg.waiting && navigator.serviceWorker.controller) applyUpdate(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if(!sw) return;
      sw.addEventListener("statechange", () => {
        // controller が無い＝初回訪問。入れ替えるものが無いので何もしない
        if(sw.state === "installed" && navigator.serviceWorker.controller) applyUpdate(sw);
      });
    });

    /* 開きっぱなしのタブにも新しい版を届ける。
       ブラウザ任せだと次のナビゲーションまで気づかないので、
       画面に戻ってきたときに確認する（頻度は30分に1回まで）。 */
    let lastCheck = Date.now();
    document.addEventListener("visibilitychange", () => {
      if(document.visibilityState !== "visible") return;
      if(Date.now() - lastCheck < 30 * 60 * 1000) return;
      lastCheck = Date.now();
      reg.update().catch(() => { /* 通信できなければ次の機会に */ });
    });
  }).catch(() => { /* 登録できなくても通常どおり動く */ });

  // 初回訪問では clients.claim() でこのページが掌握されるため controllerchange が
  // 必ず1回起きる。読み込み中のCSVを中断しないよう、更新のときだけ読み直す。
  navigator.serviceWorker.addEventListener("controllerchange", reloadForUpdate);
}

boot().catch(err => {
  console.error(err);
  toast("初期化に失敗しました。ページを再読み込みしてください。");
});
initServiceWorker();
