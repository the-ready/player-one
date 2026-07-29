/* エリアポップアップ：現在地・地図の範囲・会場ピッカー・都県チップ。
   会場／地図の範囲／都県は3つとも「場所の絞り込み」なので排他にする。
   ANDで重ねると「東京都」＋「Kアリーナ横浜」のように必ず0件になる組み合わせを
   作れてしまい、原因が分かりにくいため。 */

import { esc, fmtKm } from "./util.js";
import { PREFS } from "./config.js";
import { ITEMS, venueMeta, isKnownChain } from "./data.js";
import { venueCounts } from "./filters.js";
import { activeTab, curTab, curState, setPlaceFilter } from "./state.js";
import { refreshNow } from "./render.js";
import { closePopover } from "./ui-popover.js";

const el = {};
let venueKindFilter = null;

export function initArea(){
  el.regionRow   = document.getElementById("regionRow");
  el.picker      = document.getElementById("venuePicker");
  el.pickerLabel = document.getElementById("venuePickerLabel");
  el.venueQ      = document.getElementById("venueQ");
  el.venueQLabel = document.getElementById("venueQLabel");
  el.kinds       = document.getElementById("venueKinds");
  el.list        = document.getElementById("venueList");
  el.locateMsg   = document.getElementById("locateMsg");
  el.mapStatus   = document.getElementById("mapAreaStatus");

  buildPrefChips();
  el.venueQ.addEventListener("input", renderVenueList);
  el.kinds.addEventListener("click", e => {
    const btn = e.target.closest(".venue-kind");
    if(!btn) return;
    venueKindFilter = venueKindFilter === btn.dataset.kind ? null : btn.dataset.kind;
    buildVenueKinds(); renderVenueList();
  });
  el.list.addEventListener("click", e => {
    const btn = e.target.closest(".venue-opt");
    if(!btn) return;
    const st = curState();
    const next = st.venue === btn.dataset.venue ? null : btn.dataset.venue;
    setPlaceFilter(st, next ? "venue" : null, next);
    syncPrefChips(); renderVenueList(); updateMapAreaStatus();
    refreshNow({push:true});
  });

  document.getElementById("useMyLocationBtn").addEventListener("click", () => {
    const st = curState();
    if(st.userLoc){ st.sortBy = "location"; refreshNow({push:true}); closePopover(); return; }
    requestLocation(() => { curState().sortBy = "location"; });
  });
}

/* ---------- 都県チップ ---------- */

function buildPrefChips(){
  el.regionRow.innerHTML = PREFS.map(pr =>
    `<button type="button" class="region-chip" data-key="${pr.key}" aria-pressed="false">${pr.label}</button>`).join("");
  el.regionRow.addEventListener("click", e => {
    const btn = e.target.closest(".region-chip");
    if(!btn) return;
    const st = curState();
    const next = st.pref === btn.dataset.key ? null : btn.dataset.key;
    setPlaceFilter(st, next ? "pref" : null, next);
    syncPrefChips(); updateMapAreaStatus(); renderVenueList();
    refreshNow({push:true});
  });
}

export function syncPrefChips(){
  const pref = curState().pref;
  el.regionRow.querySelectorAll(".region-chip").forEach(c =>
    c.setAttribute("aria-pressed", String(c.dataset.key === pref)));
}

/* ---------- 会場ピッカー（3タブ共通） ----------
   もともとライブ専用だったが、「どの箱でやるか」で探すのはイベントの施設でも
   映画の劇場でも同じなので共通化した。候補はそのタブのデータに実際に予定が
   ある会場だけを出す（0件の会場を選ばせない）。 */

function venueKindOf(name){
  if(activeTab === "live"){ const v = venueMeta(name); return v ? v.kind : null; }
  if(activeTab === "movie") return isKnownChain(name) ? "chain" : "single";
  return null;
}

export function buildVenueKinds(){
  const kinds = curTab().place.kinds;
  if(!kinds){ el.kinds.innerHTML = ""; el.kinds.hidden = true; return; }
  el.kinds.hidden = false;
  el.kinds.innerHTML = Object.entries(kinds).map(([key, label]) =>
    `<button type="button" class="venue-kind" data-kind="${esc(key)}" aria-pressed="${venueKindFilter === key}">${esc(label)}</button>`).join("");
}

export function renderVenueList(){
  const tab = curTab(), st = curState();
  const place = tab.place;
  el.pickerLabel.textContent = place.pickerLabel;
  el.venueQLabel.textContent = place.searchLabel;
  el.venueQ.placeholder = place.searchPlaceholder;

  const counts = venueCounts(tab, st, ITEMS[activeTab]);
  const q = (el.venueQ.value || "").trim().toLowerCase();
  let opts = [...counts.entries()].map(([venue, count]) => ({venue, count}));
  if(place.kinds && venueKindFilter) opts = opts.filter(o => venueKindOf(o.venue) === venueKindFilter);
  if(q) opts = opts.filter(o => o.venue.toLowerCase().includes(q));
  opts.sort((a, b) => b.count - a.count || a.venue.localeCompare(b.venue, "ja"));

  if(!opts.length){
    el.list.innerHTML = `<p class="venue-empty">${ITEMS[activeTab].length ? "該当する会場がありません。" : "データを読み込むと会場を選べます。"}</p>`;
    return;
  }
  el.list.innerHTML = opts.slice(0, 60).map(o =>
    `<button type="button" class="venue-opt" data-venue="${esc(o.venue)}" aria-pressed="${st.venue === o.venue}">
       <span>${esc(o.venue)}</span><span class="vo-sub">${o.count}件</span>
     </button>`).join("");
}

/** タブが変わったら、そのタブ向けにピッカーを組み直す。 */
export function syncAreaForTab(){
  const place = curTab().place;
  el.picker.hidden = false;
  venueKindFilter = null;
  el.venueQ.value = "";
  el.pickerLabel.textContent = place.pickerLabel;
  buildVenueKinds();
  renderVenueList();
  syncPrefChips();
  updateMapAreaStatus();
  syncLocateMsg();
}

/* ---------- 地図の範囲の表示 ---------- */

export function updateMapAreaStatus(){
  const st = curState();
  if(!st.mapArea){ el.mapStatus.hidden = true; el.mapStatus.textContent = ""; return; }
  el.mapStatus.hidden = false;
  el.mapStatus.innerHTML =
    `地図で選んだ範囲（中心から半径 ${fmtKm(st.mapArea.radiusKm)}）でしぼりこみ中。<button type="button" id="clearMapArea">範囲を解除</button>`;
  el.mapStatus.querySelector("#clearMapArea").addEventListener("click", () => {
    curState().mapArea = null;
    updateMapAreaStatus(); renderVenueList(); refreshNow({push:true});
  });
}

/* ---------- 現在地 ----------
   失敗の原因（未許可／未対応／電波状況／タイムアウト）でメッセージを出し分ける。
   原因が分かれば利用者が次にとるべき行動が変わるため。 */

export function geoPrecheckError(){
  if(!("geolocation" in navigator)) return "このブラウザは位置情報に対応していません。エリアから選んでください。";
  if(location.protocol !== "https:" && location.hostname !== "localhost")
    return "位置情報の取得にはHTTPS接続が必要です。https:// で始まるURLからアクセスしてください。";
  return null;
}
export function geoErrorMessage(err){
  if(err.code === err.PERMISSION_DENIED)
    return "位置情報の利用がブロックされています。ブラウザまたはOSの設定で、このサイトへの位置情報アクセスを許可してからもう一度お試しください。エリアからも絞り込めます。";
  if(err.code === err.TIMEOUT)
    return "現在地の取得がタイムアウトしました。電波の良い場所でもう一度お試しいただくか、エリアから選んでください。";
  return "現在地を取得できませんでした（電波状況などが原因の場合があります）。もう一度お試しいただくか、エリアから選んでください。";
}
// 端末によっては初回試行が電波状況で失敗しやすいため、一度だけ高精度モードで再試行する。
export function getPositionWithRetry(onOk, onErr){
  const attempt = (highAccuracy, isRetry) => {
    navigator.geolocation.getCurrentPosition(onOk, err => {
      if(!isRetry && err.code === err.POSITION_UNAVAILABLE){ attempt(true, true); return; }
      onErr(err);
    }, {timeout:12000, enableHighAccuracy:highAccuracy, maximumAge:300000});
  };
  attempt(false, false);
}

function showLocateReady(){
  el.locateMsg.className = "locate-msg ok show";
  el.locateMsg.innerHTML = `現在地を取得しました。近い順にならべます。<button type="button" class="inline-link" id="clearLoc">現在地をクリア</button>`;
  el.locateMsg.querySelector("#clearLoc").addEventListener("click", () => {
    const st = curState();
    st.userLoc = null;
    if(st.sortBy === "location") st.sortBy = "date";
    el.locateMsg.className = "locate-msg"; el.locateMsg.textContent = "";
    refreshNow({push:true});
  });
}

/** 現在地メッセージは1つをタブ間で使い回している。表示中のタブに合わせて出し直す。 */
export function syncLocateMsg(){
  if(curState().userLoc){ showLocateReady(); return; }
  el.locateMsg.className = "locate-msg"; el.locateMsg.textContent = "";
}

export function requestLocation(onSuccess){
  const pre = geoPrecheckError();
  if(pre){ el.locateMsg.className = "locate-msg err show"; el.locateMsg.textContent = pre; return; }
  const locBtn = document.getElementById("sortLocBtn");
  locBtn.classList.add("loading");
  el.locateMsg.className = "locate-msg show";
  el.locateMsg.textContent = "現在地をさがしています…（許可ダイアログが出たら「許可」を選んでください）";
  getPositionWithRetry(
    pos => {
      locBtn.classList.remove("loading");
      curState().userLoc = {lat:pos.coords.latitude, lng:pos.coords.longitude};
      showLocateReady();
      if(onSuccess) onSuccess();
      refreshNow({push:true});
    },
    err => {
      locBtn.classList.remove("loading");
      el.locateMsg.className = "locate-msg err show";
      el.locateMsg.textContent = geoErrorMessage(err);
    }
  );
}
