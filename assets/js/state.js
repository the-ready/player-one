/* 絞り込み状態。UIは3タブで共有し、状態はタブごとに分ける（設計書 第4.2節）。
   加えて、いま見えている状態をURLに写す。共有・ブックマーク・戻るボタンが
   効かないと「この週末の横浜のイベント」を人に渡せないため。 */

import { TABS, TAB_ORDER } from "./config.js";

/* ---------- タブごとの状態 ---------- */

function newState(tab){
  const sets = {};
  tab.facets.forEach(f => { sets[f.id] = new Set(); });
  const flags = {};
  tab.flags.forEach(f => { flags[f.id] = false; });
  return {
    q:"", sets, flags,
    pref:null, venue:null, mapArea:null,
    rangeStart:null, rangeEnd:null,
    sortBy:"date", userLoc:null
  };
}

export const STATES = {};
TAB_ORDER.forEach(k => { STATES[k] = newState(TABS[k]); });

export let activeTab = "event";
export function setActiveTabKey(k){ activeTab = k; }
export function curTab(){ return TABS[activeTab]; }
export function curState(){ return STATES[activeTab]; }

/** 場所の絞り込みは「会場 → 地図の範囲 → 都県」の3つが排他。
    ANDで重ねると「東京都」＋「Kアリーナ横浜」のように必ず0件になる
    組み合わせを作れてしまうため、1つ立てたら他を落とす。 */
export function setPlaceFilter(st, kind, value){
  st.pref = kind === "pref" ? value : null;
  st.venue = kind === "venue" ? value : null;
  st.mapArea = kind === "map" ? value : null;
}

export function resetState(tabKey){
  const tab = TABS[tabKey];
  STATES[tabKey] = newState(tab);
  return STATES[tabKey];
}

export function hasAnyFilter(tabKey = activeTab){
  const st = STATES[tabKey], tab = TABS[tabKey];
  if(st.q || st.pref || st.venue || st.mapArea || (st.rangeStart && st.rangeEnd)) return true;
  if(st.sortBy !== "date") return true;
  if(tab.facets.some(f => st.sets[f.id].size)) return true;
  if(tab.flags.some(f => st.flags[f.id])) return true;
  return false;
}

/* ---------- お気に入り ----------
   ログインを持たない方針（設計書 1.4）は変えず、この端末の中だけに保存する。
   行番号や id ではなく内容から決まる安定キーを使うので、週次でCSVを
   差し替えてもお気に入りが別の行へ移らない。 */

const FAV_KEY = "eventboard.favorites.v1";
let favorites = new Set();

export function loadFavorites(){
  try{
    const raw = localStorage.getItem(FAV_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if(Array.isArray(arr)) favorites = new Set(arr.filter(x => typeof x === "string"));
  } catch { favorites = new Set(); }
}
function saveFavorites(){
  try{ localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); }
  catch { /* プライベートブラウズ等で保存できなくても操作自体は続けられる */ }
}
export function isFav(item){ return favorites.has(item.uid); }
export function toggleFav(item){
  if(favorites.has(item.uid)) favorites.delete(item.uid);
  else favorites.add(item.uid);
  saveFavorites();
  return favorites.has(item.uid);
}
export function favCount(){ return favorites.size; }

/* ---------- 最後に見ていたタブ ---------- */
const TAB_KEY = "eventboard.lastTab.v1";
export function rememberTab(k){
  try{ localStorage.setItem(TAB_KEY, k); } catch { /* 保存できなくても動く */ }
}
export function recalledTab(){
  try{
    const v = localStorage.getItem(TAB_KEY);
    return TAB_ORDER.includes(v) ? v : null;
  } catch { return null; }
}

/* ---------- URL との同期 ----------
   URLに書くのは「いま表示しているタブ」の状態だけにする。3タブぶんを載せると
   URLが読めない長さになり、共有した相手にとっても意味の無い情報が混ざるため。 */

// ファセットidはそのままだと長いので、URL上の短い名前に対応づける。
const FACET_PARAM = {
  cats:"cats", statuses:"status", genres:"genre",
  screeningTypes:"screen", liveTypes:"ltype"
};
const FLAG_PARAM = {
  dealsOnly:"deals", newOnly:"new", onsaleOnly:"onsale",
  beforeOnly:"before", limitedOnly:"limited", favOnly:"fav"
};
const FLAG_BY_PARAM = Object.fromEntries(Object.entries(FLAG_PARAM).map(([k,v]) => [v,k]));

export function stateToQuery(){
  const st = curState(), tab = curTab();
  const p = new URLSearchParams();
  if(activeTab !== "event") p.set("tab", activeTab);
  if(st.q) p.set("q", st.q);
  if(st.rangeStart && st.rangeEnd){ p.set("from", st.rangeStart); p.set("to", st.rangeEnd); }
  if(st.pref) p.set("pref", st.pref);
  if(st.venue) p.set("venue", st.venue);
  if(st.mapArea) p.set("map", `${st.mapArea.lat.toFixed(5)},${st.mapArea.lng.toFixed(5)},${st.mapArea.radiusKm.toFixed(2)}`);
  tab.facets.forEach(f => {
    const v = [...st.sets[f.id]];
    if(v.length) p.set(FACET_PARAM[f.id] || f.id, v.join(","));
  });
  const on = tab.flags.filter(f => st.flags[f.id]).map(f => FLAG_PARAM[f.id] || f.id);
  if(on.length) p.set("f", on.join(","));
  // 現在地順は端末の位置情報が要るので、URLに書いても復元できない。日程順/新着順だけ載せる。
  if(st.sortBy === "announced") p.set("sort", "new");
  return p;
}

/** URLのクエリを読み、対象タブとその絞り込みを組み立てて返す。 */
export function queryToState(search){
  const p = new URLSearchParams(search);
  const tabKey = TAB_ORDER.includes(p.get("tab")) ? p.get("tab") : null;
  if(!tabKey && ![...p.keys()].length) return null;
  const key = tabKey || "event";
  const tab = TABS[key], st = newState(tab);

  st.q = p.get("q") || "";
  const from = p.get("from"), to = p.get("to");
  if(/^\d{4}-\d{2}-\d{2}$/.test(from || "") && /^\d{4}-\d{2}-\d{2}$/.test(to || "")){
    st.rangeStart = from < to ? from : to;
    st.rangeEnd   = from < to ? to : from;
  }
  const map = p.get("map");
  if(map){
    const [la, ln, r] = map.split(",").map(Number);
    if([la, ln, r].every(Number.isFinite) && r > 0) st.mapArea = {lat:la, lng:ln, radiusKm:r};
  }
  if(!st.mapArea && p.get("venue")) st.venue = p.get("venue");
  if(!st.mapArea && !st.venue && p.get("pref")) st.pref = p.get("pref");

  tab.facets.forEach(f => {
    const raw = p.get(FACET_PARAM[f.id] || f.id);
    if(raw) raw.split(",").map(s => s.trim()).filter(Boolean).forEach(v => st.sets[f.id].add(v));
  });
  const flags = (p.get("f") || "").split(",").map(s => s.trim()).filter(Boolean);
  flags.forEach(name => {
    const id = FLAG_BY_PARAM[name] || name;
    if(id in st.flags) st.flags[id] = true;
  });
  // 「受付中」と「発売前」は同時に成り立たない。URL直打ちでも矛盾させない。
  if(st.flags.onsaleOnly && st.flags.beforeOnly) st.flags.beforeOnly = false;
  if(p.get("sort") === "new") st.sortBy = "announced";

  STATES[key] = st;
  return key;
}

let urlSyncEnabled = false;
export function enableUrlSync(){ urlSyncEnabled = true; }

/**
 * URLを現在の状態に合わせる。
 *   push=true  … 履歴に積む（タブ切替・地図の適用など「戻る」で取り消したい操作）
 *   push=false … 積まずに差し替える（検索の打鍵・チップの連打）
 * 全部積むと、8個絞り込んだ人がサイトを離れるのに8回戻る必要が出るため分けている。
 */
export function syncUrl(push){
  if(!urlSyncEnabled) return;
  const q = stateToQuery().toString();
  const url = q ? `${location.pathname}?${q}` : location.pathname;
  if(url === location.pathname + location.search) return;
  try{
    if(push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  } catch { /* file:// などで history が使えなくても動作は続ける */ }
}
