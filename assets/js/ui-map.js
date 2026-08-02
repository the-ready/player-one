/* 地図まわり。2種類のシートを扱う。
     1. 範囲えらび（円の中だけに絞り込む）
     2. 会場シート（会場・劇場チェーンの場所と、そこでのこれからの予定）
   Leaflet はリポジトリ内に同梱しているが、地図は「追加の絞り込み手段」なので
   初期表示では読み込まず、初めてシートを開いたときだけ読む。 */

import { esc, safeUrl, fmtKm, haversineKm } from "./util.js";
import {
  DEFAULT_CENTER,
  PLACE_UPCOMING_MAX,
  TABS,
  TAB_ORDER,
  venueNames,
  VENUE_KINDS,
} from "./config.js";
import {
  ITEMS,
  venueMeta,
  theaterMeta,
  isKnownChain,
  pointsForPlace,
} from "./data.js";
import { matchesBaseFilters, withinArea, byDateThenRank } from "./filters.js";
import { activeTab, curTab, curState, setPlaceFilter } from "./state.js";
import { refreshNow, toast } from "./render.js";
import { closePopover, trapTab, setBackgroundInert } from "./ui-popover.js";
import {
  geoPrecheckError,
  geoErrorMessage,
  getPositionWithRetry,
  updateMapAreaStatus,
  renderVenueList,
} from "./ui-area.js";

const LEAFLET_CSS = "./assets/vendor/leaflet/leaflet.css";
const LEAFLET_JS = "./assets/vendor/leaflet/leaflet.js";
const MAP_MIN_ZOOM = 5,
  MAP_MAX_ZOOM = 18;
// 円の直径＝地図表示領域の短辺 × この比率。画面上の円の大きさは常に一定で、
// ズームすると「円が覆う実距離」のほうが変わる。ピンチ＝範囲の広さの調整になる。
const RING_RATIO = 0.78;
const M_PER_PX_Z0 = 156543.03392804097; // Web Mercator のズーム0での m/px（赤道上）

let leafletPromise = null;
function ensureLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = LEAFLET_CSS;
    document.head.appendChild(link);
    const s = document.createElement("script");
    s.src = LEAFLET_JS;
    s.async = true;
    s.onload = () =>
      window.L
        ? resolve()
        : reject(new Error("地図ライブラリを初期化できませんでした"));
    s.onerror = () => {
      leafletPromise = null;
      reject(new Error("地図ライブラリを読み込めませんでした"));
    };
    document.head.appendChild(s);
  });
  return leafletPromise;
}

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

/* ================= 範囲えらび ================= */

const el = {};
let map = null,
  markerLayer = null;
let liveArea = null; // 地図の現在の中心・半径（まだ適用していない候補）
let lastView = null; // シートを閉じても直前の見え方を覚えておく
let mapReturnFocus = null;

export function initMapSheet() {
  el.sheet = document.getElementById("mapSheet");
  el.ring = document.getElementById("mapRing");
  el.loading = document.getElementById("mapLoading");
  el.radius = document.getElementById("mapRadiusText");
  el.hits = document.getElementById("mapHitsText");
  el.sr = document.getElementById("mapSrStatus");
  el.note = document.getElementById("mapNote");
  el.apply = document.getElementById("mapApplyBtn");
  el.clear = document.getElementById("mapClearBtn");
  el.locate = document.getElementById("mapLocateBtn");
  el.close = document.getElementById("mapSheetClose");
  el.help = document.getElementById("mapSheetHelp");

  document.getElementById("openMapBtn").addEventListener("click", openMapSheet);
  el.close.addEventListener("click", closeMapSheet);
  el.sheet.addEventListener("click", (e) => {
    if (e.target === el.sheet) closeMapSheet();
  });
  el.sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMapSheet();
      return;
    }
    trapTab(el.sheet, e);
  });

  el.apply.addEventListener("click", () => {
    if (!liveArea) return;
    setPlaceFilter(curState(), "map", {
      lat: liveArea.lat,
      lng: liveArea.lng,
      radiusKm: liveArea.radiusKm,
    });
    closeMapSheet();
    updateMapAreaStatus();
    renderVenueList();
    refreshNow({ push: true });
  });
  el.clear.addEventListener("click", () => {
    curState().mapArea = null;
    closeMapSheet();
    updateMapAreaStatus();
    refreshNow({ push: true });
  });
  el.locate.addEventListener("click", onMapLocate);

  window.addEventListener("resize", () => {
    if (el.sheet.hidden || !map) return;
    map.invalidateSize();
    layoutRing();
    settleMap();
  });
}

function showMapError(text) {
  el.ring.hidden = true;
  el.loading.hidden = false;
  el.loading.textContent = text;
}
function ringRadiusPx() {
  const size = map.getSize();
  return Math.max(1, (Math.min(size.x, size.y) * RING_RATIO) / 2);
}
function layoutRing() {
  el.ring.style.setProperty("--ring-size", ringRadiusPx() * 2 + "px");
}

// 円の縁までの実距離。東西方向で測ると、その緯度での縮尺をそのまま使えて誤差が出ない。
function currentRadiusKm() {
  const size = map.getSize();
  const c = map.getCenter();
  const edge = map.containerPointToLatLng([
    size.x / 2 + ringRadiusPx(),
    size.y / 2,
  ]);
  return map.distance(c, edge) / 1000;
}
function zoomForRadius(lat, radiusKm) {
  const needed = (radiusKm * 1000) / ringRadiusPx();
  const z = Math.log2((M_PER_PX_Z0 * Math.cos((lat * Math.PI) / 180)) / needed);
  return Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, z));
}
function setMapNote(text) {
  el.note.textContent = text || "";
  el.note.hidden = !text;
}
const itemNoun = () => curTab().noun;

function defaultMapNote() {
  const n = ITEMS[activeTab].filter(
    (it) => it.lat == null || it.lng == null,
  ).length;
  return n
    ? `位置情報が未登録の${itemNoun()}（${n}件）は、地図でしぼりこむと表示されません。`
    : "";
}
function countInLiveArea() {
  const tab = curTab(),
    st = curState();
  return ITEMS[activeTab].filter(
    (it) => matchesBaseFilters(tab, st, it) && withinArea(it, liveArea),
  ).length;
}

// announce=true のときだけ読み上げる。ドラッグ中は毎フレーム変わるので、
// 指を離して確定したときにまとめて伝える。
function updateReadout(announce) {
  if (!liveArea) return;
  const n = countInLiveArea();
  el.radius.textContent = `半径 ${fmtKm(liveArea.radiusKm)}`;
  el.hits.innerHTML = `この範囲に <b>${n}</b> 件`;
  el.apply.textContent = `この範囲でしぼりこむ（${n}件）`;
  if (announce)
    el.sr.textContent = `中心から半径 約${fmtKm(liveArea.radiusKm)}。この範囲に ${n} 件の${itemNoun()}があります。`;
}

/* ピンの吹き出しからは、地図を閉じて一覧の該当カードへ飛べる。
   閉じるだけで一覧側の絞り込みは変えないので、地図の範囲プレビュー中に
   円の外にあったピンなど、いま一覧に出ていない行のときは見つからない
   （黙って何も起きないより、理由をトーストで伝える）。 */
function gotoItemFromMap(key) {
  closeMapSheet();
  const list = document.getElementById(curTab().listId);
  const card = list?.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!card) {
    toast("いまの絞り込みでは一覧に表示されていません");
    return;
  }
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.remove("jump-highlight");
  // 直前のクラスを一度剥がしてから付け直す（連続で押されてもアニメーションを再生させるため）
  void card.offsetWidth;
  card.classList.add("jump-highlight");
  card.addEventListener(
    "animationend",
    () => card.classList.remove("jump-highlight"),
    { once: true },
  );
}

function refreshMarkers() {
  if (!markerLayer || !liveArea) return;
  markerLayer.clearLayers();
  const tab = curTab(),
    st = curState();
  ITEMS[activeTab].forEach((it) => {
    if (it.lat == null || it.lng == null) return;
    if (!matchesBaseFilters(tab, st, it)) return;
    const inside = withinArea(it, liveArea);
    const d = haversineKm(liveArea.lat, liveArea.lng, it.lat, it.lng);
    const place = [venueNames(it).join("・"), it.area]
      .filter(Boolean)
      .join("／");
    L.circleMarker([it.lat, it.lng], {
      radius: inside ? 6 : 4,
      weight: inside ? 2 : 1.5,
      color: "#33302B",
      fillColor: inside ? "#B3566E" : "#FFFFFF",
      fillOpacity: inside ? 0.95 : 0.55,
    })
      .bindPopup(
        `<button type="button" class="popup-goto-item" data-key="${esc(it.key)}">${esc(it.title)}</button><br>${esc(place)}<br>${esc(it.date || "")}<br>中心から ${d.toFixed(1)}km`,
      )
      .addTo(markerLayer);
  });
}

let liveTick = false;
function scheduleLive() {
  if (liveTick) return;
  liveTick = true;
  requestAnimationFrame(() => {
    liveTick = false;
    if (!map || el.sheet.hidden) return;
    const c = map.getCenter();
    liveArea = { lat: c.lat, lng: c.lng, radiusKm: currentRadiusKm() };
    updateReadout(false);
  });
}
function settleMap() {
  if (!map) return;
  const c = map.getCenter();
  liveArea = { lat: c.lat, lng: c.lng, radiusKm: currentRadiusKm() };
  lastView = { center: [c.lat, c.lng], zoom: map.getZoom() };
  updateReadout(true);
  refreshMarkers();
}

function startView() {
  const st = curState();
  if (st.mapArea)
    return {
      center: [st.mapArea.lat, st.mapArea.lng],
      radiusKm: st.mapArea.radiusKm,
    };
  if (lastView) return lastView;
  if (st.userLoc)
    return { center: [st.userLoc.lat, st.userLoc.lng], radiusKm: 15 };
  return { center: DEFAULT_CENTER, radiusKm: 25 };
}

function initMap() {
  if (!map) {
    map = L.map("mapCanvas", {
      preferCanvas: true,
      zoomControl: true,
      zoomSnap: 0,
      zoomDelta: 0.5, // ピンチの拡大率をそのまま半径に反映させる
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
    }).setView(DEFAULT_CENTER, 10);
    L.tileLayer(TILE_URL, {
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      attribution: TILE_ATTR,
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    map.on("move zoom", scheduleLive);
    map.on("moveend zoomend", settleMap);
    // 吹き出し（.leaflet-popup-pane）は .map-ring と兄弟要素の関係にあり、
    // ring 側の z-index が勝つと吹き出しが点線の下に隠れてしまうため、
    // 開いている間だけ .map-canvas を ring より前面に出す（app.css参照）。
    map.on("popupopen", () =>
      map.getContainer().classList.add("has-open-popup"),
    );
    map.on("popupclose", () =>
      map.getContainer().classList.remove("has-open-popup"),
    );
    // 吹き出し内の「このイベントへ飛ぶ」ボタン。Leafletは吹き出しの中身を
    // クリックしても背面の地図クリックとして扱わないようpropagationを止めて
    // いるため、外側の要素へのイベント委譲では拾えない。開くたびに直接束ねる。
    map.on("popupopen", (e) => {
      const btn = e.popup.getElement()?.querySelector(".popup-goto-item");
      if (btn)
        btn.addEventListener("click", () => gotoItemFromMap(btn.dataset.key));
    });
  }
  el.loading.hidden = true;
  el.ring.hidden = false;
  map.invalidateSize();
  layoutRing();
  const view = startView();
  const zoom =
    view.zoom != null
      ? view.zoom
      : zoomForRadius(view.center[0], view.radiusKm);
  map.setView(view.center, zoom, { animate: false });
  settleMap();
}

export function openMapSheet() {
  mapReturnFocus = document.activeElement;
  closePopover();
  el.sheet.hidden = false;
  document.body.style.overflow = "hidden";
  setBackgroundInert(true, [document.querySelector(".controls")]);
  el.ring.hidden = true;
  el.loading.hidden = false;
  el.loading.textContent = "地図を読み込んでいます…";
  el.clear.disabled = !curState().mapArea;
  el.help.textContent = `地図をドラッグして中心を決め、ピンチや ＋ − ボタンで円の広さを変えられます。円の中にある${itemNoun()}だけを検索結果にします。`;
  setMapNote(defaultMapNote());
  el.close.focus();
  ensureLeaflet().then(
    () => {
      try {
        initMap();
      } catch (e) {
        showMapError(`地図を表示できませんでした（${e.message}）。`);
      }
    },
    (err) =>
      showMapError(
        `${err.message}。通信環境を確認して開きなおすか、下のエリアから絞り込んでください。`,
      ),
  );
}

export function closeMapSheet() {
  // シートごと閉じるときにピンの吹き出しが開いたままだと、popupcloseが発火せず
  // has-open-popup が残ったままになる。次に開いたときに古い状態を持ち越さない
  // よう、ここで明示的に閉じる。
  map?.closePopup();
  el.sheet.hidden = true;
  document.body.style.overflow = "";
  setBackgroundInert(false, [document.querySelector(".controls")]);
  // 呼び出し元の「地図で範囲をえらぶ」はポップアップ内にあり、シートを開いた時点で
  // ポップアップごと閉じている。非表示の要素にはフォーカスが当たらないので、
  // その場合は「エリア」ボタンに戻す（キーボード操作で迷子にしない）。
  const back =
    mapReturnFocus && mapReturnFocus.offsetParent !== null
      ? mapReturnFocus
      : document.getElementById("sortLocBtn");
  if (back && typeof back.focus === "function") back.focus();
  mapReturnFocus = null;
}
export const isMapSheetOpen = () => el.sheet && !el.sheet.hidden;

function onMapLocate() {
  const pre = geoPrecheckError();
  if (pre) {
    setMapNote(pre);
    return;
  }
  const st = curState();
  if (st.userLoc && map) {
    map.panTo([st.userLoc.lat, st.userLoc.lng]);
    setMapNote(defaultMapNote());
    return;
  }
  el.locate.disabled = true;
  setMapNote(
    "現在地をさがしています…（許可ダイアログが出たら「許可」を選んでください）",
  );
  getPositionWithRetry(
    (pos) => {
      el.locate.disabled = false;
      const st2 = curState();
      st2.userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (map) map.panTo([st2.userLoc.lat, st2.userLoc.lng]);
      setMapNote(defaultMapNote());
      refreshNow({ url: false });
    },
    (err) => {
      el.locate.disabled = false;
      setMapNote(geoErrorMessage(err));
    },
  );
}

/* ================= 会場シート =================
   映画のチェーン店舗マップとライブの会場モーダルは、もともと別々の考え方で
   書かれていた（前者は地図だけ、後者は地図＋この会場の公演）。
   「この場所は今どこにあって、これから何があるのか」は3タブに共通の問いなので、
   1つのシートに統一し、イベントの会場からも開けるようにした。 */

const ps = {};
let placeMap = null,
  placeLayer = null,
  placeReturnFocus = null;

export function initPlaceSheet() {
  ps.sheet = document.getElementById("placeSheet");
  ps.title = document.getElementById("placeSheetTitle");
  ps.help = document.getElementById("placeSheetHelp");
  ps.loading = document.getElementById("placeMapLoading");
  ps.info = document.getElementById("placeInfo");
  ps.close = document.getElementById("placeSheetClose");

  ps.close.addEventListener("click", closePlaceSheet);
  ps.sheet.addEventListener("click", (e) => {
    if (e.target === ps.sheet) closePlaceSheet();
  });
  ps.sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePlaceSheet();
      return;
    }
    trapTab(ps.sheet, e);
  });
  window.addEventListener("resize", () => {
    if (!ps.sheet.hidden && placeMap) placeMap.invalidateSize();
  });
}

function initPlaceMap(points) {
  if (!placeMap) {
    placeMap = L.map("placeMapCanvas", {
      preferCanvas: true,
      zoomControl: true,
    }).setView(DEFAULT_CENTER, 10);
    L.tileLayer(TILE_URL, { attribution: TILE_ATTR }).addTo(placeMap);
    placeLayer = L.layerGroup().addTo(placeMap);
  }
  ps.loading.hidden = true;
  placeMap.invalidateSize();
  placeLayer.clearLayers();
  const pts = [];
  points.forEach((b) => {
    if (b.lat == null || b.lng == null) return;
    pts.push([b.lat, b.lng]);
    const href = safeUrl(b.url);
    const popupHtml =
      `<b>${esc(b.name)}</b><br>${esc(b.area || "")}` +
      (href
        ? `<br><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">サイトを見る ↗</a>`
        : "");
    L.circleMarker([b.lat, b.lng], {
      radius: 7,
      weight: 2,
      color: "#33302B",
      fillColor: "#B3566E",
      fillOpacity: 0.9,
    })
      .bindPopup(popupHtml)
      .addTo(placeLayer);
  });
  if (pts.length) placeMap.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
  else placeMap.setView(DEFAULT_CENTER, 10);
}

/** その会場（チェーン名含む）で、これから予定されているもの。全タブ横断で拾う。 */
function upcomingAt(name) {
  const st = curState();
  const rows = [];
  TAB_ORDER.forEach((key) => {
    ITEMS[key]
      .filter((it) => venueNames(it).includes(name))
      .forEach((it) => rows.push(it));
  });
  return rows.sort(byDateThenRank(st));
}

function placeFacts(name) {
  const v = venueMeta(name);
  if (v) {
    return [
      v.kind ? VENUE_KINDS[v.kind] || v.kind : null,
      v.capacity ? `収容 約${v.capacity.toLocaleString()}人` : null,
      v.area,
    ]
      .filter(Boolean)
      .join("　");
  }
  const t = theaterMeta(name);
  if (t) return [t.area, t.pref].filter(Boolean).join("　");
  if (isKnownChain(name)) return `関東の店舗 ${pointsForPlace(name).length}件`;
  return "";
}
function placeSite(name) {
  const v = venueMeta(name);
  if (v && v.url) return safeUrl(v.url);
  const t = theaterMeta(name);
  if (t && t.url) return safeUrl(t.url);
  return null;
}

export function openPlaceSheet(name) {
  placeReturnFocus = document.activeElement;
  closePopover();
  if (!el.sheet.hidden) closeMapSheet();
  ps.sheet.hidden = false;
  document.body.style.overflow = "hidden";
  setBackgroundInert(true, [document.querySelector(".controls")]);

  const chain = isKnownChain(name);
  ps.title.textContent = chain ? `${name}の店舗` : name;
  ps.help.textContent = chain
    ? `${name}の関東の店舗です。ピンをタップすると劇場のページを開けます。`
    : "会場の場所と、ここでこれから予定されているものです。";

  const upcoming = upcomingAt(name);
  const shown = upcoming.slice(0, PLACE_UPCOMING_MAX);
  const facts = placeFacts(name);
  const site = placeSite(name);
  ps.info.hidden = false;
  ps.info.innerHTML = `
    ${facts ? `<p class="vi-facts">${esc(facts)}</p>` : ""}
    ${site ? `<p class="vi-site"><a class="vi-link" href="${esc(site)}" target="_blank" rel="noopener noreferrer">${chain ? "チェーンの公式サイト" : "会場の公式サイト"}を見る ↗</a></p>` : ""}
    <p class="vi-facts">ここでのこれからの予定（${upcoming.length}件）</p>
    ${
      shown.length
        ? `<ul>${shown.map((o) => `<li><span class="vi-tag">${esc(TABS[o.tab].label)}</span>${esc([o.date, o.title].filter(Boolean).join("　"))}</li>`).join("")}</ul>
         ${upcoming.length > shown.length ? `<p class="venue-empty">ほか${upcoming.length - shown.length}件</p>` : ""}`
        : `<p class="venue-empty">登録されている予定はありません。</p>`
    }
    <p class="vi-actions"><button type="button" class="map-btn" id="placeFilterBtn">この会場でしぼりこむ</button></p>`;

  document.getElementById("placeFilterBtn").addEventListener("click", () => {
    setPlaceFilter(curState(), "venue", name);
    closePlaceSheet();
    updateMapAreaStatus();
    renderVenueList();
    refreshNow({ push: true });
  });

  const points = pointsForPlace(name);
  ps.loading.hidden = false;
  ps.loading.textContent = points.length
    ? "地図を読み込んでいます…"
    : "この会場の位置情報が未登録です。";
  ps.close.focus();
  if (!points.length) return;
  ensureLeaflet().then(
    () => {
      try {
        initPlaceMap(points);
      } catch (e) {
        ps.loading.hidden = false;
        ps.loading.textContent = `地図を表示できませんでした（${e.message}）。`;
      }
    },
    (err) => {
      ps.loading.hidden = false;
      ps.loading.textContent = `${err.message}。通信環境を確認して開きなおしてください。`;
    },
  );
}

export function closePlaceSheet() {
  ps.sheet.hidden = true;
  document.body.style.overflow = "";
  setBackgroundInert(false, [document.querySelector(".controls")]);
  // 呼び出し元はカード内の会場ボタン（.place-link）。開いている間に一覧が
  // 再描画される（日付をまたいだ・データが更新された等）と元のボタンがDOMから
  // 消えていることがあるので、closeMapSheet() と同じく「エリア」ボタンへ
  // 逃がす（フォーカスが行き場を失って迷子にならないようにする）。
  const back =
    placeReturnFocus && placeReturnFocus.offsetParent !== null
      ? placeReturnFocus
      : document.getElementById("sortLocBtn");
  if (back && typeof back.focus === "function") back.focus();
  placeReturnFocus = null;
}
export const isPlaceSheetOpen = () => ps.sheet && !ps.sheet.hidden;
