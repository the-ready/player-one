/* 「場所」を3タブで共通に扱う層。お気に入りスポット（★）と駐車場（P）の鍵になる。

   収集側にはすでに場所の名簿が3つある（イベント施設 spots.csv・ライブ会場 venues.csv・
   映画館 theaters.csv）。画面側はこれまでそれぞれ別の用途でしか読んでいなかったので、
   「このイベントの会場は名簿のどの場所か」を答えられなかった。ここでその対応を持つ。

   各行の会場表記は書き手が毎週書くので、名簿の名前と完全には一致しない
   （`東京国際フォーラム ホールE`・`弥生美術館・竹久夢二美術館（弥生美術館）`）。
   照合は収集ツール tools/roster.py の match_venue と同じ規則にそろえてある
   （収集側が「この会場から収穫があった」と数える単位と、画面が★を付ける単位を
   食い違わせないため）。

     1. 完全一致（NFKC・小文字化・空白除去）
     2. 名簿の名前＋区切り記号で始まる表記を、いちばん長い名前で引く
        区切りを必須にするのは、`東京ミッドタウン` が `東京ミッドタウン日比谷` の
        予定を横取りしないため
     3. `／` で区切られた表記は、全体と各部分を同じ規則で引く */

import { SPOTS, VENUES, THEATERS, isKnownChain } from "./data.js";
import {
  venueNames,
  SPOT_KINDS,
  VENUE_KINDS,
  PARKING_KINDS,
  EVENT_PARKING_KINDS,
} from "./config.js";
import { spotKey, spotFold } from "./util.js";
import { isFavSpot, favSpotNames } from "./state.js";

const SUBVENUE_SEP = /[\s（(【[・/／:：]/;
const MULTI_SPLIT = /[／/]/;
const THEATER_KIND = "映画館";

/* 名簿3つを1つの索引にまとめる。同じ名前が複数の名簿にあれば同じ場所として束ね、
   空いている項目だけ後の名簿で埋める（最初に載った名簿の値を尊重する）。
   名簿は読み込みのたびに配列ごと差し替わるので、参照が変わったときだけ作り直す。 */
let built = null;

function build() {
  if (built && built.s === SPOTS && built.v === VENUES && built.t === THEATERS)
    return built;
  const byKey = new Map();
  const add = (e) => {
    const k = spotKey(e.name);
    if (!k) return;
    const cur = byKey.get(k);
    if (!cur) {
      byKey.set(k, e);
      return;
    }
    [
      "area",
      "pref",
      "lat",
      "lng",
      "url",
      "parking",
      "chain",
      "capacity",
    ].forEach((f) => {
      if (cur[f] == null && e[f] != null) cur[f] = e[f];
    });
  };
  THEATERS.forEach((t) =>
    add({
      name: t.name,
      kindLabel: t.chain || THEATER_KIND,
      chain: t.chain || null,
      area: t.area,
      pref: t.pref,
      lat: t.lat,
      lng: t.lng,
      url: t.url,
      parking: t.parking,
      capacity: null,
    }),
  );
  VENUES.forEach((v) =>
    add({
      name: v.venue,
      kindLabel: VENUE_KINDS[v.kind] || v.kind,
      chain: null,
      area: v.area,
      pref: v.pref,
      lat: v.lat,
      lng: v.lng,
      url: v.url,
      parking: v.parking,
      capacity: v.capacity,
    }),
  );
  SPOTS.forEach((s) =>
    add({
      name: s.name,
      kindLabel: SPOT_KINDS[s.kind] || s.kind,
      chain: null,
      area: s.area,
      pref: s.pref,
      lat: s.lat,
      lng: s.lng,
      url: s.url,
      parking: s.parking,
      capacity: null,
    }),
  );
  const list = [...byKey.values()];
  built = {
    s: SPOTS,
    v: VENUES,
    t: THEATERS,
    byKey,
    folded: list.map((e) => [spotFold(e.name), e]),
    cache: new Map(), // 会場表記 -> 名簿の項目の配列
  };
  return built;
}

/** 名簿の正式名から場所を引く（完全一致のみ）。無ければ null。 */
export function spotByName(name) {
  return build().byKey.get(spotKey(name)) || null;
}

/** 行の会場表記1つを、名簿の場所の配列へ。引けなければ空配列。 */
export function matchSpots(venue) {
  const raw = String(venue == null ? "" : venue);
  if (!raw.trim() || raw.trim() === "-") return [];
  const b = build();
  if (b.cache.has(raw)) return b.cache.get(raw);

  const parts = [raw];
  if (MULTI_SPLIT.test(raw))
    parts.push(...raw.split(MULTI_SPLIT).filter((p) => p.trim()));

  const out = [];
  const seen = new Set();
  for (const part of parts) {
    let hit = b.byKey.get(spotKey(part)) || null;
    if (!hit) {
      const nv = spotFold(part);
      let bestLen = 0;
      for (const [n, e] of b.folded) {
        if (
          n.length > bestLen &&
          nv.length > n.length &&
          nv.startsWith(n) &&
          SUBVENUE_SEP.test(nv[n.length])
        ) {
          hit = e;
          bestLen = n.length;
        }
      }
    }
    if (hit && !seen.has(hit)) {
      seen.add(hit);
      out.push(hit);
    }
  }
  b.cache.set(raw, out);
  return out;
}

/* 行 → 場所。複数会場にまたがる行は複数返す。件数は少ない（高々数件）が、絞り込みの
   判定・先頭セクションの振り分け・カードの★で毎回引かれるので行に覚えさせる。 */
export function spotsOfItem(it) {
  const b = build();
  if (it._spotsBuild === b) return it._spots;
  const out = [];
  const seen = new Set();
  venueNames(it).forEach((v) =>
    matchSpots(v).forEach((e) => {
      if (!seen.has(e)) {
        seen.add(e);
        out.push(e);
      }
    }),
  );
  it._spotsBuild = b;
  it._spots = out;
  return out;
}

/** この行は、お気に入りスポットで開かれる催しか（チェーン名だけの行は含まない）。 */
export const isFavSpotItem = (it) =>
  spotsOfItem(it).some((e) => isFavSpot(e.name));

/** お気に入りに入っている場所。名簿から消えた名前は missing 付きの仮の項目で残す。 */
export function favSpotEntries() {
  return favSpotNames().map((n) => spotByName(n) || { name: n, missing: true });
}

/* ---------- 管理シートの手入力 ----------
   打った文字に合う会場の候補と、Enter（「追加」）が何をするか。画面に触れない純粋な関数にして、
   DOM なしで試せるようにしている（tools/fav_spots_test.mjs）。

   候補は名簿の場所だけにする。★の照合は名簿の名前（と、その名前で始まる表記）で行うので、
   名簿に無い名前を登録しても、どの催しにも当たらず、先頭に何も出ないまま残ってしまう
   （アーティストの手入力と違い、「発表前の人」のように後から当たる見込みも無い）。 */
const squashSpot = (s) => spotFold(s).replace(/\s+/g, "");

/** 名簿の全場所。 */
export const allSpots = () => [...build().byKey.values()];

/** 打った文字に合う場所。すでに登録した場所は出さない。前方が合うものを先に、
    同じ並びの中では名前の短いものを先に（`横浜アリーナ` が `横浜アリーナ南館` より前）、
    最後は五十音順。 */
export function suggestSpots(query, isFav, limit = 8) {
  const q = squashSpot(query);
  if (!q) return [];
  return allSpots()
    .map((e) => ({ e, f: squashSpot(e.name) }))
    .filter(({ e, f }) => f.includes(q) && !isFav(e.name))
    .sort(
      (a, b) =>
        Number(b.f.startsWith(q)) - Number(a.f.startsWith(q)) ||
        a.f.length - b.f.length ||
        a.f.localeCompare(b.f, "ja"),
    )
    .slice(0, limit)
    .map(({ e }) => e);
}

/* Enter（「追加」）の動き。
     名簿の名前と同じ → その場所を登録（登録済みなら、そう伝える）
     候補がある       → 先頭の候補を登録
     どちらも無い     → 登録しない（名簿に無い名前は、どの催しとも結びつかない） */
export function planAddSpot(raw, isFav) {
  const text = String(raw == null ? "" : raw);
  if (!squashSpot(text)) return { kind: "empty" };
  const exact = spotByName(text);
  if (exact)
    return isFav(exact.name)
      ? { kind: "dup", name: exact.name }
      : { kind: "add", name: exact.name };
  const first = suggestSpots(text, isFav, 1)[0];
  if (first) return { kind: "add", name: first.name };
  return { kind: "none", typed: text.trim() };
}

/** お気に入りの劇場をチェーンごとにまとめる。映画の新作はチェーン名でしか記録されて
    いないので、劇場を★にした人には「そのチェーンの新作」を別枠で案内する。 */
export function favChainGroups() {
  const groups = new Map();
  favSpotEntries().forEach((e) => {
    if (!e.chain) return;
    if (!groups.has(e.chain)) groups.set(e.chain, []);
    groups.get(e.chain).push(e);
  });
  return [...groups.entries()].map(([chain, theaters]) => ({
    chain,
    theaters,
  }));
}

/** その行が載せているチェーン名（`TOHOシネマズ` など）。劇場名での記録なら空。 */
export const chainNamesOf = (it) => venueNames(it).filter(isKnownChain);

/** チェーンの店舗（名簿の項目）。スポットのシートで★を付ける対象になる。 */
export function branchesOfChain(chain) {
  return THEATERS.filter((t) => t.chain === chain)
    .map((t) => spotByName(t.name))
    .filter(Boolean);
}

/** スポットのシートに出す「どんな場所か」の1行。 */
export function spotFacts(e) {
  return [
    e.kindLabel,
    e.capacity ? `収容 約${e.capacity.toLocaleString()}人` : null,
    e.area,
  ]
    .filter(Boolean)
    .join("　");
}

/* ---------- 駐車場（P） ----------
   常設の駐車場の有無は場所の事実なので名簿（parking 列）から、臨時駐車場や当日の閉鎖は
   催しの行（event_parking 列）から引く。2つを別々に持つ理由と値の意味は config.js の
   PARKING_KINDS の注釈にある。

   base … 名簿が言う常設の駐車場。`yes` / `nearby` / `no`。空は未確認（何も出さない）。
   ep   … その催しの日だけの事情。`temp` / `closed` / `temp_only`。空はいつもどおり。

   複数の場所にまたがる行（`A／B`）は、すべての場所が同じ値のときだけ採る。片方が
   未確認のまま、もう片方の値を行全体の事実として出さないため。 */
export function parkingState(it) {
  const spots = spotsOfItem(it);
  let base = "";
  if (
    spots.length &&
    spots.every((e) => e.parking && e.parking === spots[0].parking)
  )
    base = spots[0].parking;
  if (!(base in PARKING_KINDS)) base = "";
  const ep = it.eventParking in EVENT_PARKING_KINDS ? it.eventParking : "";
  return { base, ep };
}

/** 駐車場を使えるか（「駐車場があるものだけ」の判定）。当日不可は使えない側に倒す。 */
export function hasParking(it) {
  const { base, ep } = parkingState(it);
  if (ep === "temp" || ep === "temp_only") return true;
  if (ep === "closed") return false;
  return base === "yes" || base === "nearby";
}
