/* 絞り込み状態。UIは3タブで共有し、状態はタブごとに分けて持ち、
   共通の条件だけ切替時に持ち越す（設計書 第4.2節・第4.2.2節）。
   加えて、いま見えている状態をURLに写す。共有・ブックマーク・戻るボタンが
   効かないと「この週末の横浜のイベント」を人に渡せないため。 */

import { TABS, TAB_ORDER, PREFS, MAP_RADIUS_MAX_KM } from "./config.js";
import { spotKey, artistKey, artistHead } from "./util.js";

/* ---------- タブごとの状態 ---------- */

/* 検索語（q）だけは3タブで共有する。検索窓はDOM上に1つしかなく、
   「Vaundyで検索したのにタブを移ったら入力欄が空になった」という体験のほうが、
   「絞り込みが引き継がれて0件になる」より混乱を招くため。
   ファセット・日程・エリアはタブごとの state に持ち、切替時に carryFilters が
   持ち越せるものだけ写す（行き先で選べない値を黙って持たないよう、毎回検証するため）。

   実体を1つの変数にし、各タブの state オブジェクトには同じ変数を指す
   getter/setter を生やす。呼び出し側（filters.js・render.js・ui-controls.js）は
   これまでどおり `st.q` を読み書きするだけでよく、共有であることを意識しなくて済む。 */
let sharedQuery = "";
function bindSharedQuery(state) {
  Object.defineProperty(state, "q", {
    get: () => sharedQuery,
    set: (v) => {
      sharedQuery = v;
    },
    enumerable: true,
  });
}

function newState(tab) {
  const sets = {};
  tab.facets.forEach((f) => {
    sets[f.id] = new Set();
  });
  const flags = {};
  tab.flags.forEach((f) => {
    flags[f.id] = false;
  });
  const state = {
    sets,
    flags,
    pref: null,
    venue: null,
    mapArea: null,
    rangeStart: null,
    rangeEnd: null,
    sortBy: "date",
    userLoc: null,
  };
  bindSharedQuery(state);
  // 起動時の3タブぶんの初期化と、resetState()（「すべての絞り込みを解除」）の
  // 両方がここを通る。検索窓もそのボタンで空にする対象なので、ここで空にする。
  state.q = "";
  return state;
}

export const STATES = {};
TAB_ORDER.forEach((k) => {
  STATES[k] = newState(TABS[k]);
});

export let activeTab = "event";
export function setActiveTabKey(k) {
  activeTab = k;
}
export function curTab() {
  return TABS[activeTab];
}
export function curState() {
  return STATES[activeTab];
}

/** 場所の絞り込みは「会場 → 地図の範囲 → 都県」の3つが排他。
    ANDで重ねると「東京都」＋「Kアリーナ横浜」のように必ず0件になる
    組み合わせを作れてしまうため、1つ立てたら他を落とす。 */
export function setPlaceFilter(st, kind, value) {
  st.pref = kind === "pref" ? value : null;
  st.venue = kind === "venue" ? value : null;
  st.mapArea = kind === "map" ? value : null;
}

export function resetState(tabKey) {
  const tab = TABS[tabKey];
  STATES[tabKey] = newState(tab);
  return STATES[tabKey];
}

/* ---------- タブをまたぐ引き継ぎ ----------
   引き継ぐのは「どのタブでも同じ意味を持つ条件」だけ。
     日程・地図の範囲・都県・並び順（と現在地）・特別チップ（flag の id が同じもの）
   引き継がないのは、タブごとに選択肢そのものが違うもの。
     カテゴリ／ジャンル／上映形態／公演形態／開催状況（ファセット）と会場。
   後者は各タブの state にそのまま残るので、元のタブへ戻れば復元される。
   開催状況を運ばないのは、言い回しがタブで違う（開催中／上映中）ためで、
   「イベントで押した“発売中”を映画へ持ち込む」ような誤った対応づけを作らない。 */

const prefKeysOf = (tab) => tab.prefKeys || PREFS.map((p) => p.key);

/** 引き継ぎ対象の条件が立っているか（検索語・ファセット・会場・並び順は数えない）。 */
export function hasSharedFilter(st, tab) {
  return !!(
    st.pref ||
    st.mapArea ||
    (st.rangeStart && st.rangeEnd) ||
    tab.flags.some((f) => st.flags[f.id])
  );
}

/** 引き継ぎ後の `toKey` の姿を、state を書き換えずに組み立てて返す。
    dropped は「引き継ぎたかったが行き先に無くて落とした条件」のラベル。
    会場やファセットのように最初から運ばないものは数えない（毎回の通知がうるさくなるため）。 */
export function carryPlan(fromKey, toKey) {
  const from = STATES[fromKey],
    to = STATES[toKey];
  const fromTab = TABS[fromKey],
    toTab = TABS[toKey];
  const dropped = [];
  const next = {
    ...to, // q は共有変数なので、ここで現在の値がそのまま入る
    sets: to.sets,
    flags: { ...to.flags },
  };

  next.rangeStart = from.rangeStart;
  next.rangeEnd = from.rangeEnd;

  /* 場所は「都県／地図の範囲」だけを運ぶ。会場は名簿がタブごとに違うので運ばず、
     行き先が持っていた会場はそのまま残す。ただし運ぶ側が立つなら、会場とは排他
     （setPlaceFilter の規則）なので、そのときだけ行き先の会場を外す。
     行き先の都県・地図は常に出発側の値で置き換える（出発側が会場やなしなら空になる）。
     共有の「場所」の最新値は出発側が持っているため。 */
  next.pref = null;
  next.mapArea = null;
  if (from.pref) {
    if (prefKeysOf(toTab).includes(from.pref)) {
      next.pref = from.pref;
    } else {
      dropped.push(
        (PREFS.find((p) => p.key === from.pref) || {}).label || from.pref,
      );
    }
  } else if (from.mapArea) {
    next.mapArea = { ...from.mapArea };
  }
  if (next.pref || next.mapArea) next.venue = null;

  /* 現在地は条件ではなく端末の情報なので、出発側に無ければ行き先のものを残す。
     「現在地順」だけが運ばれて現在地が無い、という並びの壊れ方は起こさない。 */
  next.userLoc = from.userLoc || to.userLoc;
  next.sortBy = from.sortBy;
  if (next.sortBy === "location" && !next.userLoc) next.sortBy = "date";

  /* 特別チップは id で対応づける（同じ id は3タブで同じ意味に宣言してある）。
     出発側のオン・オフを行き先へ写し、行き先に無いチップが立っていたら落として知らせる。
     行き先にだけあるチップ（ライブに無い割引など）は出発側が知らないので触らない。 */
  fromTab.flags.forEach((f) => {
    const on = !!from.flags[f.id];
    if (Object.hasOwn(next.flags, f.id)) next.flags[f.id] = on;
    else if (on) dropped.push(f.label(fromTab));
  });

  return { next, dropped };
}

/** タブを切り替えるときに呼ぶ。出発側の共通条件を行き先へ写し、落としたもののラベルを返す。 */
export function carryFilters(fromKey, toKey) {
  if (fromKey === toKey || !STATES[fromKey] || !STATES[toKey]) return [];
  const { next, dropped } = carryPlan(fromKey, toKey);
  const to = STATES[toKey];
  [
    "rangeStart",
    "rangeEnd",
    "sortBy",
    "userLoc",
    "pref",
    "venue",
    "mapArea",
  ].forEach((k) => {
    to[k] = next[k];
  });
  Object.assign(to.flags, next.flags);
  return dropped;
}

/** 全タブの絞り込みと検索語を初期状態に戻す（「すべて解除」）。
    他のタブに固有の絞り込みを残すと、見えない場所に条件が残って
    次にそのタブを開いたときに驚くため、いまのタブだけでなく全部消す。 */
export function resetAllStates() {
  TAB_ORDER.forEach((k) => resetState(k));
}

/** 引き継ぎ対象の条件（日程・都県・地図の範囲・特別チップ）だけを外す。
    検索語・ファセット・会場は残す。 */
export function clearSharedFilters(tabKey = activeTab) {
  const st = STATES[tabKey],
    tab = TABS[tabKey];
  st.rangeStart = null;
  st.rangeEnd = null;
  st.pref = null;
  st.mapArea = null;
  tab.flags.forEach((f) => {
    st.flags[f.id] = false;
  });
}

export function hasAnyFilter(tabKey = activeTab) {
  const st = STATES[tabKey],
    tab = TABS[tabKey];
  if (
    st.q ||
    st.pref ||
    st.venue ||
    st.mapArea ||
    (st.rangeStart && st.rangeEnd)
  )
    return true;
  if (st.sortBy !== "date") return true;
  if (tab.facets.some((f) => st.sets[f.id].size)) return true;
  if (tab.flags.some((f) => st.flags[f.id])) return true;
  return false;
}

/* ---------- お気に入り ----------
   ログインを持たない方針（設計書 1.4）は変えず、この端末の中だけに保存する。
   行番号や id ではなく内容から決まる安定キーを使うので、週次でCSVを
   差し替えてもお気に入りが別の行へ移らない。 */

const FAV_KEY = "eventboard.favorites.v1";
let favorites = new Set();

export function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr))
      favorites = new Set(arr.filter((x) => typeof x === "string"));
  } catch {
    favorites = new Set();
  }
}
function saveFavorites() {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favorites]));
  } catch {
    /* プライベートブラウズ等で保存できなくても操作自体は続けられる */
  }
}
export function isFav(item) {
  return favorites.has(item.uid);
}
export function toggleFav(item) {
  if (favorites.has(item.uid)) favorites.delete(item.uid);
  else favorites.add(item.uid);
  saveFavorites();
  return favorites.has(item.uid);
}
export function favCount() {
  return favorites.size;
}

/* ---------- お気に入りスポット ----------
   「行きたい」（催し1件ごと）とは別に、**場所**を覚えておく。よく行く会場の催しを
   一覧の先頭にまとめるための印で、イベント・映画・ライブの3タブで同じ場所を共有する。

   保存するのは名簿に載っている会場名そのもの（表示用）で、照合は spotKey でそろえる。
   uid のような内容ハッシュにしないのは、名簿の名前が人が読める識別子であり、
   管理画面にそのまま出せるため。名簿から消えた名前も残す（週次の名簿更新で
   登録が黙って消えると、先頭に出なくなった理由が誰にも分からないため）。
   ログインを持たない方針（設計書 1.4）は変えず、この端末の中だけに保存する。 */

const FAV_SPOT_KEY = "eventboard.favspots.v1";
let favSpots = new Map(); // spotKey -> 表示名

export function loadFavSpots() {
  favSpots = new Map();
  try {
    const raw = localStorage.getItem(FAV_SPOT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr))
      arr.forEach((x) => {
        if (typeof x === "string" && x.trim()) favSpots.set(spotKey(x), x);
      });
  } catch {
    favSpots = new Map();
  }
}
function saveFavSpots() {
  try {
    localStorage.setItem(FAV_SPOT_KEY, JSON.stringify([...favSpots.values()]));
  } catch {
    /* 保存できなくても、このページを開いている間は効く */
  }
}
export const isFavSpot = (name) => favSpots.has(spotKey(name));
/** 登録状態を on/off に揃える。変化したら true を返す。 */
export function setFavSpot(name, on) {
  const k = spotKey(name);
  if (!k || favSpots.has(k) === on) return false;
  if (on) favSpots.set(k, String(name).trim());
  else favSpots.delete(k);
  saveFavSpots();
  return true;
}
export function toggleFavSpot(name) {
  const next = !isFavSpot(name);
  setFavSpot(name, next);
  return next;
}
export const favSpotNames = () => [...favSpots.values()];
export const favSpotCount = () => favSpots.size;

/* 先頭にまとめる設定。「見え方の好み」で、絞り込みではないので URL には載せない
   （共有した相手には相手のお気に入りがあるため、載せても意味が通らない）。保存できなくても
   既定（まとめる）で動く。
   先頭セクションの「たたむ」は、見出しごと廃止した。以前の保存値（OBSOLETE_FOLD_KEYS）は、
   使われないまま端末に残らないよう読み込みのときに消す。 */
const PIN_KEY = "eventboard.favpin.v1";
const OBSOLETE_FOLD_KEYS = [
  "eventboard.favfold.v1",
  "eventboard.favartfold.v1",
];
let pinFav = true;
let moreOpen = {}; // 「ほか◯件を表示」は覚えない（開いたままだと次に来た人が長い先頭に驚く）

export function loadFavView() {
  try {
    pinFav = localStorage.getItem(PIN_KEY) !== "0";
  } catch {
    pinFav = true;
  }
  try {
    OBSOLETE_FOLD_KEYS.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* 消せなくても害は無い（読まれない保存値が残るだけ） */
  }
}
export const pinFavSpots = () => pinFav;
export function setPinFavSpots(on) {
  pinFav = !!on;
  try {
    localStorage.setItem(PIN_KEY, pinFav ? "1" : "0");
  } catch {
    /* 保存できなくても動く */
  }
}
export const isFavSecMoreOpen = (tabKey) => !!moreOpen[tabKey];
export function setFavSecMoreOpen(tabKey, on) {
  moreOpen[tabKey] = !!on;
}

/* ---------- お気に入りアーティスト ----------
   場所（★）・催し（♡）とは別に、**人**を覚える。登録した人が出る公演が、各タブの一覧の先頭に
   まとまる。3タブで同じ人を共有する（ライブは出演者・イベントと映画は登壇者）。

   保存するのは表示名で、照合は artistKey でそろえる（util.js の artistKey の注釈）。
   末尾の括弧の補足（`U-KNOW(東方神起)`）は保存のとき外す。登録したのは人であって、
   所属や役割ではないため。公演が無くなった名前も残す。アーティストは公演の無い期間のほうが
   長いのが普通で、登録が黙って消えると、先頭に出ない理由が誰にも分からなくなるため。
   ログインを持たない方針（設計書 第1.4節）は変えず、この端末の中だけに保存する。 */

const FAV_ARTIST_KEY = "eventboard.favartists.v1";
// 手入力で際限なく増えても、保存領域と管理シートが壊れないための上限
export const FAV_ARTIST_MAX = 200;
// データの出演者名には60文字を超えるものがある（公演名がそのまま名前になっている出演者）ので、
// カードのボタンから登録できなくならないよう、実データの最長より余裕を持たせる
export const FAV_ARTIST_NAME_MAX = 100;
let favArtists = new Map(); // artistKey -> 表示名
// 登録の増減のたびに進める。出演者との照合の覚え（artists.js）を捨てる合図になる
let favArtistRevision = 0;

/** 保存できる名前に整える。空・長すぎる名前は null。 */
export function cleanArtistName(name) {
  const head = artistHead(
    String(name == null ? "" : name).replace(/\s+/g, " "),
  );
  if (!head || head.length > FAV_ARTIST_NAME_MAX) return null;
  return artistKey(head) ? head : null;
}

export function loadFavArtists() {
  favArtists = new Map();
  favArtistRevision++;
  try {
    const raw = localStorage.getItem(FAV_ARTIST_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr))
      arr.forEach((x) => {
        const n = typeof x === "string" ? cleanArtistName(x) : null;
        const k = n && artistKey(n);
        if (k && !favArtists.has(k) && favArtists.size < FAV_ARTIST_MAX)
          favArtists.set(k, n);
      });
  } catch {
    favArtists = new Map();
  }
}
function saveFavArtists() {
  try {
    localStorage.setItem(
      FAV_ARTIST_KEY,
      JSON.stringify([...favArtists.values()]),
    );
  } catch {
    /* 保存できなくても、このページを開いている間は効く */
  }
}
export const isFavArtist = (name) => favArtists.has(artistKey(name));
/** 登録状態を on/off に揃える。変化したら true を返す（上限・空の名前では false）。 */
export function setFavArtist(name, on) {
  const n = cleanArtistName(name);
  const k = n && artistKey(n);
  if (!k || favArtists.has(k) === !!on) return false;
  if (on) {
    if (favArtists.size >= FAV_ARTIST_MAX) return false;
    favArtists.set(k, n);
    // 登録のしかたを知った人に、使い方の案内はもう要らない
    markArtHintSeen();
  } else favArtists.delete(k);
  favArtistRevision++;
  saveFavArtists();
  return true;
}
export function toggleFavArtist(name) {
  const next = !isFavArtist(name);
  setFavArtist(name, next);
  return isFavArtist(name);
}
export const favArtistNames = () => [...favArtists.values()];
export const favArtistCount = () => favArtists.size;
/** 照合用: artistKey に当たる登録名。無ければ undefined。 */
export const favArtistByKey = (k) => favArtists.get(k);
export const favArtistRev = () => favArtistRevision;

/* 先頭にまとめる設定は、お気に入りスポットとは別に持つ。場所だけ・人だけを使う人が、片方の
   設定に引きずられないため。URL には載せない理由はスポットと同じ（共有した相手には相手の
   お気に入りがあるため、載せても意味が通らない）。 */
const ART_PIN_KEY = "eventboard.favartpin.v1";
const ART_HINT_KEY = "eventboard.arthint.v1";
let pinArtist = true;
let artMoreOpen = {};
let artHintSeen = false;

/* 一覧の上に出す「人のマークで登録できます」の案内を、閉じたか（または登録したか）。
   一度きりの案内なので、閉じたら二度と出さない。人のボタンの意味は、初めて見る人には
   「アカウント」に読めてしまうため（設計書 第5.14節）。 */
export const isArtHintSeen = () => artHintSeen;
export function markArtHintSeen() {
  if (artHintSeen) return;
  artHintSeen = true;
  try {
    localStorage.setItem(ART_HINT_KEY, "1");
  } catch {
    /* 保存できなくても、このページを開いている間は出さない */
  }
}

export function loadFavArtistView() {
  try {
    artHintSeen = localStorage.getItem(ART_HINT_KEY) === "1";
  } catch {
    artHintSeen = false;
  }
  try {
    pinArtist = localStorage.getItem(ART_PIN_KEY) !== "0";
  } catch {
    pinArtist = true;
  }
}
export const pinFavArtists = () => pinArtist;
export function setPinFavArtists(on) {
  pinArtist = !!on;
  try {
    localStorage.setItem(ART_PIN_KEY, pinArtist ? "1" : "0");
  } catch {
    /* 保存できなくても動く */
  }
}
export const isArtSecMoreOpen = (tabKey) => !!artMoreOpen[tabKey];
export function setArtSecMoreOpen(tabKey, on) {
  artMoreOpen[tabKey] = !!on;
}

/* ---------- 最後に見ていたタブ ---------- */
const TAB_KEY = "eventboard.lastTab.v1";
export function rememberTab(k) {
  try {
    localStorage.setItem(TAB_KEY, k);
  } catch {
    /* 保存できなくても動く */
  }
}
export function recalledTab() {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return TAB_ORDER.includes(v) ? v : null;
  } catch {
    return null;
  }
}

/* ---------- URL との同期 ----------
   URLに書くのは「いま表示しているタブ」の状態だけにする。3タブぶんを載せると
   URLが読めない長さになり、共有した相手にとっても意味の無い情報が混ざるため。 */

// ファセットidはそのままだと長いので、URL上の短い名前に対応づける。
const FACET_PARAM = {
  cats: "cats",
  statuses: "status",
  genres: "genre",
  screeningTypes: "screen",
  formats: "fmt",
  liveTypes: "ltype",
};
const FLAG_PARAM = {
  dealsOnly: "deals",
  freeOnly: "free",
  newOnly: "new",
  guestOnly: "guest",
  onsaleOnly: "onsale",
  beforeOnly: "before",
  limitedOnly: "limited",
  favOnly: "fav",
  favArtistOnly: "favartist",
  favSpotOnly: "favspot",
  parkingOnly: "parking",
  showEnded: "ended",
};
const FLAG_BY_PARAM = Object.fromEntries(
  Object.entries(FLAG_PARAM).map(([k, v]) => [v, k]),
);

export function stateToQuery() {
  const st = curState(),
    tab = curTab();
  const p = new URLSearchParams();
  if (activeTab !== "event") p.set("tab", activeTab);
  if (st.q) p.set("q", st.q);
  if (st.rangeStart && st.rangeEnd) {
    p.set("from", st.rangeStart);
    p.set("to", st.rangeEnd);
  }
  if (st.pref) p.set("pref", st.pref);
  if (st.venue) p.set("venue", st.venue);
  if (st.mapArea)
    p.set(
      "map",
      `${st.mapArea.lat.toFixed(5)},${st.mapArea.lng.toFixed(5)},${st.mapArea.radiusKm.toFixed(2)}`,
    );
  tab.facets.forEach((f) => {
    const v = [...st.sets[f.id]];
    if (v.length) p.set(FACET_PARAM[f.id] || f.id, v.join(","));
  });
  const on = tab.flags
    .filter((f) => st.flags[f.id])
    .map((f) => FLAG_PARAM[f.id] || f.id);
  if (on.length) p.set("f", on.join(","));
  // 現在地順は端末の位置情報が要るので、URLに書いても復元できない。日程順/新着順だけ載せる。
  if (st.sortBy === "announced") p.set("sort", "new");
  return p;
}

/* URL は手で書き換えられる前提で、受け付ける値を絞る。通した値は検索の索引・チップの文言・地図の
   初期位置にそのまま使われるため、壊れた値は「効かない」ではなく「画面が壊れる」になる。 */

// 2026-13-45 のように形だけ合っている日付を通さない（Date は 13月を翌年に繰り上げるので、戻して比べる）
function isRealYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d
  );
}

/** ?map=緯度,経度,半径km。地図で作れる範囲（緯度経度が地球上にあり、半径が選べる上限以下）だけ通す。 */
function parseMapArea(raw) {
  const parts = String(raw || "").split(",");
  // Number() は "" を 0 に、"0x10" を 16 にする。書き出すのは toFixed の10進表記だけなので、それ以外は捨てる
  if (parts.length !== 3 || !parts.every((x) => /^-?\d+(\.\d+)?$/.test(x)))
    return null;
  const [lat, lng, radiusKm] = parts.map(Number);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (!(radiusKm > 0 && radiusKm <= MAP_RADIUS_MAX_KM)) return null;
  return { lat, lng, radiusKm };
}

/** URLのクエリを読み、対象タブとその絞り込みを組み立てて返す。 */
export function queryToState(search) {
  const p = new URLSearchParams(search);
  const tabKey = TAB_ORDER.includes(p.get("tab")) ? p.get("tab") : null;
  if (!tabKey && ![...p.keys()].length) return null;
  const key = tabKey || "event";
  const tab = TABS[key],
    st = newState(tab);

  st.q = p.get("q") || "";
  const from = p.get("from"),
    to = p.get("to");
  if (isRealYmd(from) && isRealYmd(to)) {
    st.rangeStart = from < to ? from : to;
    st.rangeEnd = from < to ? to : from;
  }
  st.mapArea = parseMapArea(p.get("map"));
  if (!st.mapArea && p.get("venue")) st.venue = p.get("venue");
  if (!st.mapArea && !st.venue && p.get("pref")) st.pref = p.get("pref");

  tab.facets.forEach((f) => {
    const raw = p.get(FACET_PARAM[f.id] || f.id);
    if (raw)
      raw
        .split(",")
        .map((s) => s.trim())
        // constructor・__proto__ などは、どの表にも無い値なのに表引きが継承したものに当たる
        .filter((v) => v && !(v in Object.prototype))
        .forEach((v) => st.sets[f.id].add(v));
  });
  const flags = (p.get("f") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  flags.forEach((name) => {
    // どちらも自前のキーだけを引く（?f=constructor が継承したプロパティに当たらないように）
    const id = Object.hasOwn(FLAG_BY_PARAM, name) ? FLAG_BY_PARAM[name] : name;
    if (Object.hasOwn(st.flags, id)) st.flags[id] = true;
  });
  // 「受付中」と「発売前」は同時に成り立たない。URL直打ちでも矛盾させない。
  if (st.flags.onsaleOnly && st.flags.beforeOnly) st.flags.beforeOnly = false;
  if (p.get("sort") === "new") st.sortBy = "announced";

  STATES[key] = st;
  return key;
}

let urlSyncEnabled = false;
export function enableUrlSync() {
  urlSyncEnabled = true;
}

/**
 * URLを現在の状態に合わせる。
 *   push=true  … 履歴に積む（タブ切替・地図の適用など「戻る」で取り消したい操作）
 *   push=false … 積まずに差し替える（検索の打鍵・チップの連打）
 * 全部積むと、8個絞り込んだ人がサイトを離れるのに8回戻る必要が出るため分けている。
 */
export function syncUrl(push) {
  if (!urlSyncEnabled) return;
  const q = stateToQuery().toString();
  const url = q ? `${location.pathname}?${q}` : location.pathname;
  if (url === location.pathname + location.search) return;
  try {
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  } catch {
    /* file:// などで history が使えなくても動作は続ける */
  }
}
