/* 起動とタブ切り替え。各モジュールの配線だけを持ち、ロジックは持たない。 */

import { TABS, TAB_ORDER } from "./config.js";
import {
  ITEMS,
  LOAD,
  loadTab,
  loadTheaters,
  loadVenues,
  loadSpots,
  loadHolidays,
  loadSources,
  loadUpdatedManifest,
  refreshToday,
  dataStatus,
} from "./data.js";
import {
  activeTab,
  STATES,
  setActiveTabKey,
  curTab,
  curState,
  resetAllStates,
  hasAnyFilter,
  loadFavorites,
  loadFavSpots,
  loadFavView,
  loadFavArtists,
  loadFavArtistView,
  pinFavSpots,
  setPinFavSpots,
  pinFavArtists,
  setPinFavArtists,
  setFavSecMoreOpen,
  setArtSecMoreOpen,
  setPlaceFilter,
  rememberTab,
  recalledTab,
  queryToState,
  carryFilters,
  enableUrlSync,
  syncUrl,
} from "./state.js";
import {
  refreshNow,
  visibleItems,
  renderDirectories,
  syncUpdatedLabel,
  bindList,
  onRefresh,
  toast,
  syncTabCounts,
} from "./render.js";
import { initPopover, closePopover, isPopoverOpen } from "./ui-popover.js";
import {
  initArea,
  syncAreaForTab,
  renderVenueList,
  syncPrefChips,
  updateMapAreaStatus,
} from "./ui-area.js";
import {
  initCalendar,
  renderCalendar,
  resetCalendarCursor,
} from "./ui-calendar.js";
import {
  initMapSheet,
  initPlaceSheet,
  openPlaceSheet,
  closeMapSheet,
  closePlaceSheet,
  isMapSheetOpen,
  isPlaceSheetOpen,
} from "./ui-map.js";
import {
  initLineupSheet,
  openLineupSheet,
  closeLineupSheet,
  isLineupSheetOpen,
} from "./ui-lineup.js";
import {
  initCalAddSheet,
  openCalAddSheet,
  closeCalAddSheet,
  isCalAddSheetOpen,
} from "./ui-caladd.js";
import {
  initFavSpots,
  toggleSpot,
  onFavReflow,
  showToast,
  hideToast,
  scrollToElement,
} from "./ui-favspot.js";
import {
  initFavArtists,
  toggleArtist,
  openArtistSheet,
  closeArtistSheet,
  isArtistSheetOpen,
} from "./ui-favartist.js";
import {
  initFavManage,
  openFavManage,
  closeFavManage,
  isFavManageOpen,
} from "./ui-favmanage.js";
import { syncSeen } from "./artists.js";
import { presetRange } from "./schedule.js";
import {
  initWelcome,
  openWelcome,
  closeWelcome,
  refreshWelcome,
  isWelcomeOpen,
} from "./ui-welcome.js";
import {
  initWeekly,
  openWeekly,
  closeWeekly,
  isWeeklyOpen,
} from "./ui-weekly.js";
import {
  isWelcomeSeen,
  canPersist,
  readWeekly,
  writeWeekly,
  planWeekly,
  currentDates,
  currentUids,
} from "./onboard.js";
import {
  initControls,
  updateSortUI,
  syncSearchForTab,
  resetFilters,
  resetSharedFilters,
} from "./ui-controls.js";

/* ---------- タブ ---------- */

const tabBtn = (k) => document.getElementById(TABS[k].btnId);
const tabPane = (k) => document.getElementById(TABS[k].paneId);

export function setActiveTab(tab, opts = {}) {
  /* 日程・エリア・特別チップは切替先へ持ち越す（設計書 第4.2.2節）。
     戻る/進む（opts.carry === false）は URL から組み立てた状態が正なので、
     出発側で上書きしない。起動時や同じタブの再選択は from === tab で何もしない。
     opts.render === false は、呼び出し側がこの直後に状態を整えて自分で描くとき
     （一覧を2度描かないため。applyBoardFilter）。 */
  const dropped = opts.carry === false ? [] : carryFilters(activeTab, tab);
  TAB_ORDER.forEach((k) => {
    const active = k === tab;
    tabBtn(k).setAttribute("aria-selected", String(active));
    tabBtn(k).tabIndex = active ? 0 : -1; // tablist内はTab1回で入り、左右キーで移動する
    tabPane(k).hidden = !active;
  });
  setActiveTabKey(tab);
  rememberTab(tab);

  if (isPopoverOpen()) closePopover();
  if (isMapSheetOpen()) closeMapSheet();
  if (isPlaceSheetOpen()) closePlaceSheet({ noBack: true });
  if (isLineupSheetOpen()) closeLineupSheet();
  if (isCalAddSheetOpen()) closeCalAddSheet();
  if (isArtistSheetOpen()) closeArtistSheet({ noBack: true });
  if (isFavManageOpen()) closeFavManage();
  if (isWeeklyOpen()) closeWeekly({ noBack: true });
  if (isWelcomeOpen()) closeWelcome();

  // 絞り込み状態はタブごとに別々に持っているので、それを映す表示も全部ぬりかえる。
  syncSearchForTab();
  resetCalendarCursor();
  renderCalendar();
  syncAreaForTab();
  syncUpdatedLabel();
  ensureTabData(tab);
  if (opts.render !== false)
    refreshNow({ push: opts.push !== false, url: opts.url !== false });
  // 運べなかった条件があるときだけ知らせる。毎回出すとタブを移るたびにうるさい
  if (dropped.length)
    toast(
      `${dropped.map((d) => `「${d}」`).join("")}は${TABS[tab].label}に無い条件のため、引き継げませんでした`,
    );
}

/* ---------- 出演予定のシートの公演 → そのカード ----------
   行を押したら、シートを閉じてその公演のカードまで移り、少しのあいだ目立たせる。
   別のタブの公演ならタブも切り替える。カードが見つからないときは理由で分ける:
     先頭セクションの「ほか◯件」の裏にいる       → 広げて描き直す
     いまの絞り込みで隠れている                   → そう伝え、外すボタンを出す
   どちらでもなければ（描画の途中でデータが入れ替わったなど）、何も起こさず黙る。 */
const cardIn = (tabKey, key) => {
  const list = document.getElementById(TABS[tabKey].listId);
  return (
    (list &&
      [...list.querySelectorAll(".card")].find((c) => c.dataset.key === key)) ||
    null
  );
};

function flashCard(card) {
  scrollToElement(card);
  card.classList.add("card-flash");
  // 読み上げ・キーボードの利用者にも、着いた先が分かるようにフォーカスを置く
  card.tabIndex = -1;
  card.focus({ preventScroll: true });
  card.addEventListener("blur", () => card.removeAttribute("tabindex"), {
    once: true,
  });
  setTimeout(() => card.classList.remove("card-flash"), 2600);
}

function showCard(tabKey, key, again) {
  let card = cardIn(tabKey, key);
  if (!card && visibleItems(tabKey).some((it) => it.key === key)) {
    // 見たい公演が先頭セクションの「ほか◯件」の裏にあるので、そのタブのセクションを広げる
    setFavSecMoreOpen(tabKey, true);
    setArtSecMoreOpen(tabKey, true);
    refreshNow({ url: false });
    card = cardIn(tabKey, key);
  }
  if (card) {
    flashCard(card);
    return;
  }
  const exists = ITEMS[tabKey].some((it) => it.key === key);
  if (!exists || !again) return;
  showToast("この公演は、いまの絞り込みで隠れています。", [
    {
      label: "絞り込みをすべて外す",
      primary: true,
      run: () => {
        hideToast();
        resetFilters();
        showCard(tabKey, key, false);
      },
    },
    { label: "とじる", run: hideToast },
  ]);
}

function goToItem(tabKey, key) {
  if (!TABS[tabKey]) return;
  if (tabKey !== activeTab) setActiveTab(tabKey);
  showCard(tabKey, key, true);
}

function initTabs() {
  TAB_ORDER.forEach((k) =>
    tabBtn(k).addEventListener("click", () => setActiveTab(k)),
  );
  document.querySelector(".tab-group").addEventListener("keydown", (e) => {
    const i = TAB_ORDER.findIndex((k) => tabBtn(k) === document.activeElement);
    if (i < 0) return;
    let next = null;
    if (e.key === "ArrowRight") next = TAB_ORDER[(i + 1) % TAB_ORDER.length];
    else if (e.key === "ArrowLeft")
      next = TAB_ORDER[(i - 1 + TAB_ORDER.length) % TAB_ORDER.length];
    else if (e.key === "Home") next = TAB_ORDER[0];
    else if (e.key === "End") next = TAB_ORDER[TAB_ORDER.length - 1];
    if (!next) return;
    e.preventDefault();
    setActiveTab(next);
    tabBtn(next).focus();
  });
}

/* ---------- データ読み込み ----------
   表示中のタブを先に出し、残りは手が空いたときに裏で取る。
   単純な遅延読み込みだけにすると、初めて別タブを押したときに待ち時間が生まれる
   （いまは常に一瞬で切り替わる）ので、先読みして体感を落とさないようにする。 */

const started = new Map(); // タブ -> 読み込みの Promise（読み込み中のタブを待てるように、結果を覚える）
/* 起動中は、読み終えたタブを個別には描かない。boot() は名簿を待ってから setActiveTab で
   一度だけ描く。ここでも描くと、★と駐車場のない一覧が先に出て、名簿が届いた直後に同じ
   約500枚を描き直すことになる（遅い端末では1回に数秒かかる）。起動中にタブが切り替わって
   いても、boot() の setActiveTab がそのときの表示タブを描くので取りこぼさない。 */
let booting = true;

function ensureTabData(tabKey) {
  if (!started.has(tabKey)) started.set(tabKey, loadTabOnce(tabKey));
  return started.get(tabKey);
}

async function loadTabOnce(tabKey) {
  try {
    await loadTab(tabKey);
  } catch {
    // 状態は LOAD に入っている。表示は render 側が出し分ける
    if (activeTab === tabKey && !booting) refreshNow({ url: false });
    // タブの件数バッジは全タブぶんをまとめて出すので、いま裏で読み終えた
    // タブが表示中でなくても塗り直す（doRefresh() は activeTab のときしか
    // 呼ばれないので、これを外すと裏タブの件数がいつまでも「不明」のまま残る）。
    syncTabCounts();
    return false;
  }
  // お気に入りアーティストの「前回から追加」。一覧を描く前に、前回との差を決めておく
  syncSeen(tabKey);
  if (activeTab === tabKey && !booting) {
    syncUpdatedLabel();
    renderVenueList();
    refreshNow({ url: false });
  }
  syncTabCounts();
  return true;
}

async function boot() {
  loadFavorites();
  loadFavSpots();
  loadFavView();
  loadFavArtists();
  loadFavArtistView();
  /* 名簿は★・駐車場バッジ・先頭セクションの前提なので、最初の描画までに間に合わせる
     （あとから読むと、カードの★だけが遅れて現れて見た目が跳ねる）。3つとも小さく、
     表示中のタブのCSVと並行して取る。読めなくても各ローダーが握りつぶすので、待つだけでよい。 */
  const rosters = Promise.all([loadSpots(), loadTheaters(), loadVenues()]);
  // カレンダーを開くまでに間に合えばよいので待たない（データが無くても支障はない）
  loadHolidays().then(() => renderCalendar());

  // URLに状態があればそれを最優先。無ければ前回のタブを思い出す。
  const fromUrl = queryToState(location.search);
  const startTab = fromUrl || recalledTab() || "event";
  setActiveTabKey(startTab);

  initPopover({ onOpen: () => {}, onClose: () => {} });
  initArea();
  initCalendar();
  initMapSheet();
  initPlaceSheet();
  initLineupSheet();
  initCalAddSheet();
  initFavSpots();
  initFavArtists({ onGoToItem: goToItem });
  initFavManage();
  initWelcome();
  initWeekly({
    onGoToItem: goToItem,
    onApply: applyBoardFilter,
    onManage: () => openFavManage(),
  });
  document.getElementById("statUpdatedChip")?.addEventListener("click", (e) =>
    // detail が 0 のクリックは、キーボード（Enter・Space）からのもの
    openBoardManually(e.detail === 0),
  );
  document
    .getElementById("favEntry")
    ?.addEventListener("click", () => openFavManage());
  onFavReflow(renderVenueList);
  initControls();
  initTabs();
  onRefresh(updateSortUI);

  TAB_ORDER.forEach((k) => {
    const listEl = document.getElementById(TABS[k].listId);
    if (listEl)
      bindList(listEl, {
        onOpenPlace: openPlaceSheet,
        onOpenLineup: openLineupSheet,
        onCalAdd: openCalAddSheet,
        onReset: resetFilters,
        onResetShared: resetSharedFilters,
        onToggleSpot: (name) => toggleSpot(name),
        onToggleArtist: (name) => toggleArtist(name),
        onOpenArtist: openArtistSheet,
        // 「この◯本でしぼる」は、会場シートの「この会場でしぼりこむ」と同じ操作
        onChainFilter: (chain) => {
          setPlaceFilter(curState(), "venue", chain);
          syncPrefChips();
          updateMapAreaStatus();
          renderVenueList();
          refreshNow({ push: true });
        },
      });
  });

  // 絞り込みチップ（件数つき）の押下
  document.getElementById("catBody").addEventListener("click", (e) => {
    // 管理シートを開くだけのボタン（状態を持たないので、チップの処理には回さない）
    if (e.target.closest("[data-manage-fav]")) {
      openFavManage();
      return;
    }
    const chip = e.target.closest(".chip");
    if (!chip || chip.disabled) return;
    const tab = curTab(),
      st = curState();
    const key = chip.dataset.key;
    // 先頭にまとめるかどうかは絞り込みではなく見え方の設定（state.js）。URLには載せない
    if (key === "__pinFav") {
      setPinFavSpots(!pinFavSpots());
      refreshNow({ push: false, url: false });
      return;
    }
    if (key === "__pinArtist") {
      setPinFavArtists(!pinFavArtists());
      refreshNow({ push: false, url: false });
      return;
    }
    const row = chip.closest("[data-facet]");
    if (row) {
      const set = st.sets[row.dataset.facet];
      if (!set) return;
      if (set.has(key)) set.delete(key);
      else set.add(key);
    } else {
      const flag = tab.flags.find((f) => f.id === key);
      if (!flag) return;
      st.flags[key] = !st.flags[key];
      // 同時に立つと必ず0件になる組み合わせは、片方を押したらもう片方を外す
      if (st.flags[key])
        (flag.exclusive || []).forEach((other) => {
          st.flags[other] = false;
        });
    }
    refreshNow({ push: false });
  });

  // ページ全体で使う一括表示
  await loadSources();
  renderDirectories();
  manifestReady = loadUpdatedManifest().then(syncUpdatedLabel);

  // 表示中のタブを先に（名簿も一緒に待つ）、続いて残りのタブ
  await Promise.all([ensureTabData(activeTab), rosters]);
  booting = false;
  setActiveTab(activeTab, { push: false, url: false });
  enableUrlSync();
  syncUrl(false);
  maybeOpenWelcome();

  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));
  idle(async () => {
    for (const k of TAB_ORDER) {
      if (k !== activeTab) await ensureTabData(k);
    }
    renderVenueList();
    refreshNow({ url: false });
    refreshWelcome();
    maybeAutoBoard();
  });
}

/* ---------- ようこそカードと今週のボード（設計書 第5.15・5.16節） ----------
   ようこそカードは、初めて開いたとき1回だけ。今週のボードは、データの更新日が前回ボードを開いた
   ときより進んでいたら、3タブが読み終わった時点で1回。初めての人には、ようこそカードを出した回は
   ボードを出さず、その時点の更新日と一覧を覚えるだけにする（案内が全画面で2つ続かないように）。 */
let welcomeShown = false;
/* 更新日（data/updated.json）が届く前に比べると、CSV の Last-Modified（デプロイした日時）で
   判断してしまい、のちの比べ方とずれる。自動で出す判断も、日付のボタンも、届いてから行う */
let manifestReady = Promise.resolve();

function maybeOpenWelcome() {
  // 閉じた記録を書けない端末では、開くたびに出続けてしまうので出さない
  if (isWelcomeSeen() || !canPersist()) return;
  welcomeShown = true;
  openWelcome();
}

/* 別のシートを開いている間・文字を打っている間は割り込まない。あとで空いたら出す */
const boardBusy = () =>
  isPopoverOpen() ||
  isMapSheetOpen() ||
  isPlaceSheetOpen() ||
  isLineupSheetOpen() ||
  isCalAddSheetOpen() ||
  isArtistSheetOpen() ||
  isFavManageOpen() ||
  isWelcomeOpen() ||
  isWeeklyOpen() ||
  /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");

async function maybeAutoBoard() {
  await manifestReady;
  // 1タブでも読めていない回は判断しない（件数も更新日も揃わないため）。
  // オフライン表示の古いデータでは、「更新した」と言わない
  if (TAB_ORDER.some((k) => LOAD[k].state !== "done") || dataStatus.offline)
    return;
  const plan = planWeekly({
    rec: readWeekly(),
    dates: currentDates(),
    uids: currentUids(),
    welcomeNow: welcomeShown,
  });
  if (plan.action === "baseline") {
    writeWeekly(plan.rec);
    return;
  }
  if (plan.action === "show" && canPersist()) openBoardWhenFree(plan, 0);
}

function openBoardWhenFree(plan, tries) {
  if (boardBusy()) {
    if (tries < 20) setTimeout(() => openBoardWhenFree(plan, tries + 1), 1500);
    return;
  }
  // 記録を書けなければ出さない。書けないまま出すと、開くたびに「更新した」と言い続ける
  if (!writeWeekly(plan.rec)) return;
  openWeekly({
    dates: plan.rec.seen,
    advanced: plan.advanced,
    fresh: plan.rec.fresh,
  });
}

/* 「最終更新日」のボタンから。更新の有無にかかわらず開く。記録は変えない（開き直しても同じ中身） */
async function openBoardManually(viaKeyboard = false) {
  await Promise.all([manifestReady, ...TAB_ORDER.map((k) => ensureTabData(k))]);
  if (isWeeklyOpen() || isWelcomeOpen()) return;
  const rec = readWeekly();
  openWeekly({
    dates: currentDates(),
    fresh: (rec && rec.fresh) || {},
    manual: true,
    viaKeyboard,
  });
}

/* ボードの「◯件を見る」。ほかの条件が残っていると、ボードの件数と押した先の件数が食い違うので、
   全タブの絞り込みと検索語をいったん外してから、この条件だけを掛ける。

   一覧を描くのも履歴を積むのも最後の1回だけにする。「外す→タブを移す→条件を掛ける」を
   既存の操作（resetFilters・setActiveTab）で順に呼ぶと、そのたびに約500枚の一覧を描き直し
   （遅い端末では1回に数秒かかる）、「戻る」で2回戻らないと元の画面に帰れなくなる。
   だから、先に状態だけを作り、表示の塗り直しはタブの切り替えに任せ、描画と URL は最後に1度。
   持ち越し（carry）は、全タブを空にしたあとで運ぶものが無いので使わない
   （使うと「引き継げませんでした」という、この操作には意味のない知らせが出る）。 */
function applyBoardFilter({ tab, kind }) {
  if (!TABS[tab]) return;
  // 外したことを知らせるかは、外す前にしか分からない
  const hadFilters = TAB_ORDER.some((k) => hasAnyFilter(k));
  resetAllStates();
  const st = STATES[tab];
  if (kind === "weekend") {
    [st.rangeStart, st.rangeEnd] = presetRange("weekend");
  } else if (kind === "free" && Object.hasOwn(st.flags, "freeOnly")) {
    st.flags.freeOnly = true;
  }
  // 同じタブでも通す。検索窓・カレンダー（週末の日程の反映）・エリアの表示を、いまの状態から塗り直すため
  setActiveTab(tab, { carry: false, render: false });
  refreshNow({ push: true });
  if (hadFilters) toast("ほかの絞り込みを外しました");
  const first = document.getElementById("resultCount");
  if (first) scrollToElement(first, 24);
}

/* ---------- 戻る/進む ---------- */
window.addEventListener("popstate", () => {
  const key = queryToState(location.search) || "event";
  setActiveTab(key, { push: false, url: false, carry: false });
});

/* ---------- 日付をまたいだとき ----------
   ページを開きっぱなしにしていると「本日開催」「あと0日」がずれる。
   タブに戻ってきたタイミングで今日を採り直し、変わっていれば塗り直す。 */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (refreshToday()) {
    resetCalendarCursor();
    renderCalendar();
    refreshNow({ url: false });
  }
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
function recentlyReloaded() {
  try {
    return (
      Date.now() - (Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0) <
      10000
    );
  } catch {
    return false;
  }
}
function reloadForUpdate() {
  if (!swUpdating) return;
  swUpdating = false;
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    /* 保存できなくても進む */
  }
  location.reload();
}

function applyUpdate(waiting) {
  if (swUpdating || recentlyReloaded()) return;
  swUpdating = true;
  const overlay = document.getElementById("updateOverlay");
  if (overlay) overlay.hidden = false;
  waiting.postMessage({ type: "SKIP_WAITING" });
  // controllerchange が来ないまま止まると画面が覆われたままになるので、保険で読み直す
  setTimeout(reloadForUpdate, 4000);
}

function initServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost")
    return;

  navigator.serviceWorker
    .register("./sw.js")
    .then((reg) => {
      // 前回の訪問で用意され、待機したままの版があればそれを適用する
      if (reg.waiting && navigator.serviceWorker.controller)
        applyUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          // controller が無い＝初回訪問。入れ替えるものが無いので何もしない
          if (sw.state === "installed" && navigator.serviceWorker.controller)
            applyUpdate(sw);
        });
      });

      /* 開きっぱなしのタブにも新しい版を届ける。
       ブラウザ任せだと次のナビゲーションまで気づかないので、
       画面に戻ってきたときに確認する（頻度は30分に1回まで）。 */
      let lastCheck = Date.now();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        if (Date.now() - lastCheck < 30 * 60 * 1000) return;
        lastCheck = Date.now();
        reg.update().catch(() => {
          /* 通信できなければ次の機会に */
        });
      });
    })
    .catch(() => {
      /* 登録できなくても通常どおり動く */
    });

  // 初回訪問では clients.claim() でこのページが掌握されるため controllerchange が
  // 必ず1回起きる。読み込み中のCSVを中断しないよう、更新のときだけ読み直す。
  navigator.serviceWorker.addEventListener("controllerchange", reloadForUpdate);
}

boot().catch((err) => {
  console.error(err);
  toast("初期化に失敗しました。ページを再読み込みしてください。");
});
initServiceWorker();
