/* お気に入りスポット（★）の回帰テスト。DOM不要（render.js は要素の置き物で動かす）。

   壊れ方は3種類ある。どれも画面では「たまたま出ない」としか見えないので、ここで固定する。
     1. 名寄せの取りこぼし／横取り — ★を付けたのに先頭に出ない、別の施設の予定が先頭に出る
     2. 先頭セクションの振り分け   — 同じカードが2回出る、条件で隠れた理由が出ない、件数が合わない
     3. 保存                       — 全角半角ゆれで二重登録、壊れた保存値で起動できない

   前半は合成した名簿で規則そのものを、後半は実データで画面の出し分けを見る
   （実データの件数は毎週変わるので、後半は「同じデータから別の方法で数えた値」と突き合わせる）。

   使い方（リポジトリのルートから）:
     node tools/fav_spots_test.mjs
*/

import fs from "node:fs";

/* ---------- 置き物 ---------- */
const SYNTH = new Map(); // パス -> 差し替え本文（無ければ実ファイル）
globalThis.fetch = async (p) => {
  const path = String(p).replace(/^\.\//, "");
  const text = SYNTH.has(path)
    ? SYNTH.get(path)
    : fs.existsSync(path)
      ? fs.readFileSync(path, "utf8")
      : null;
  if (text == null)
    return { ok: false, status: 404, headers: { get: () => null } };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const els = new Map();
const el = (k) => {
  if (!els.has(k))
    els.set(k, {
      hidden: true,
      textContent: "",
      innerHTML: "",
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute() {},
    });
  return els.get(k);
};
globalThis.document = {
  getElementById: el,
  querySelector: el,
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.window = {
  matchMedia: () => ({ matches: true }),
  addEventListener() {},
};

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}${detail ? "  — " + detail : ""}`,
  );
  if (!ok) failures.push(name);
};
const names = (arr) => arr.map((e) => e.name);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const D = await import("../assets/js/data.js");
const S = await import("../assets/js/spots.js");
const ST = await import("../assets/js/state.js");
const F = await import("../assets/js/filters.js");
const { TABS } = await import("../assets/js/config.js");
const { venueNames } = await import("../assets/js/config.js");
const R = await import("../assets/js/render.js");

/* ================= 1. 名寄せの規則（合成した名簿） ================= */
console.log("\n--- 名寄せの規則（合成した名簿） ---");

SYNTH.set(
  "data/spots.csv",
  [
    "name,kind,pref,area,lat,lng,url,status,closed_until,first_seen,last_hit,hit_count,note",
    "東京ミッドタウン,mall,tokyo,東京都・港区,,,,active,,,,,",
    "東京ミッドタウン日比谷,mall,tokyo,東京都・千代田区,,,,active,,,,,",
    "東京国際フォーラム,hall,tokyo,東京都・千代田区,,,,active,,,,,",
    "弥生美術館・竹久夢二美術館,museum,tokyo,東京都・文京区,,,,active,,,,,",
    "Ａ館,museum,tokyo,東京都・港区,,,,active,,,,,",
    'ひとつ"引用"の館,museum,tokyo,東京都・港区,,,,active,,,,,',
  ].join("\n"),
);
SYNTH.set(
  "data/venues.csv",
  [
    "venue,kind,pref,area,capacity,lat,lng,url,status,closed_until,first_seen,last_hit,hit_count,note",
    // spots と同名: 同じ場所として束ねられ、空いている項目（収容）だけ埋まる
    "東京国際フォーラム,hall,tokyo,東京都・千代田区,5000,,,active,,,,,",
  ].join("\n"),
);
SYNTH.set(
  "data/theaters.csv",
  [
    "chain,name,pref,area,lat,lng,url,status,first_seen,last_hit,hit_count,note",
    "TOHOシネマズ,TOHOシネマズ日比谷,tokyo,東京都・千代田区,,,https://example.com/h,active,,,,",
    "TOHOシネマズ,TOHOシネマズ新宿,tokyo,東京都・新宿区,,,https://example.com/s,active,,,,",
    ",新文芸坐,tokyo,東京都・豊島区,,,,active,,,,",
  ].join("\n"),
);
await Promise.all([D.loadSpots(), D.loadTheaters(), D.loadVenues()]);

const m = (v) => names(S.matchSpots(v));
check(
  "完全一致",
  eq(m("東京国際フォーラム"), ["東京国際フォーラム"]),
  JSON.stringify(m("東京国際フォーラム")),
);
check(
  "館内の会場（半角空白）を名簿の場所に寄せる",
  eq(m("東京国際フォーラム ホールE"), ["東京国際フォーラム"]),
);
check(
  "館内の会場（全角空白・括弧・中黒）も寄せる",
  eq(m("東京国際フォーラム　ホールE"), ["東京国際フォーラム"]) &&
    eq(m("東京国際フォーラム（ホールE）"), ["東京国際フォーラム"]) &&
    eq(m("東京国際フォーラム・地上広場"), ["東京国際フォーラム"]),
);
check(
  "区切りの無い続きは寄せない（横取りしない）",
  eq(m("東京国際フォーラムホールE"), []) && eq(m("東京ミッドタウンホール"), []),
);
check(
  "短い名前が、長い名前の予定を横取りしない",
  eq(m("東京ミッドタウン"), ["東京ミッドタウン"]) &&
    eq(m("東京ミッドタウン日比谷"), ["東京ミッドタウン日比谷"]),
);
check(
  "長い名前のほうに区切りつきで続く表記は、長い名前を採る",
  eq(m("東京ミッドタウン日比谷 6F"), ["東京ミッドタウン日比谷"]),
);
check(
  "名簿の名前そのものに中黒がある施設",
  eq(m("弥生美術館・竹久夢二美術館（弥生美術館）"), [
    "弥生美術館・竹久夢二美術館",
  ]),
);
check(
  "／で区切られた複数会場は、それぞれ引く",
  eq(m("東京ミッドタウン／東京国際フォーラム"), [
    "東京ミッドタウン",
    "東京国際フォーラム",
  ]),
);
check(
  "全角半角・大文字小文字のゆれを吸収する",
  eq(m("ａ館"), ["Ａ館"]) && eq(m("Ａ館"), ["Ａ館"]),
);
check(
  "空・ハイフン・未知の会場は何にも寄せない",
  eq(m(""), []) && eq(m("-"), []) && eq(m("どこにも無い会場"), []),
);
check(
  "同じ名前の2つの名簿は1つの場所に束ね、空いた項目だけ補う",
  (() => {
    const e = S.spotByName("東京国際フォーラム");
    return e && e.capacity === 5000 && e.area === "東京都・千代田区";
  })(),
);
check(
  "チェーン名そのものは場所に寄せない（店舗は別の場所）",
  eq(m("TOHOシネマズ"), []) && D.isKnownChain("TOHOシネマズ"),
);
check(
  "劇場は chain を持ち、独立系の劇場は持たない",
  S.spotByName("TOHOシネマズ日比谷")?.chain === "TOHOシネマズ" &&
    S.spotByName("新文芸坐")?.chain === null,
);
check(
  "チェーンの店舗一覧",
  eq(names(S.branchesOfChain("TOHOシネマズ")), [
    "TOHOシネマズ日比谷",
    "TOHOシネマズ新宿",
  ]),
);
{
  const row = { venue: "東京国際フォーラム ホールE" };
  const row2 = { venue: "東京ミッドタウン／東京国際フォーラム" };
  check(
    "行 → 場所（複数会場の行は複数）",
    eq(names(S.spotsOfItem(row)), ["東京国際フォーラム"]) &&
      eq(names(S.spotsOfItem(row2)), [
        "東京ミッドタウン",
        "東京国際フォーラム",
      ]),
  );
  check(
    "映画の行（劇場名の配列）も引ける",
    eq(names(S.spotsOfItem({ venues: ["新文芸坐", "TOHOシネマズ"] })), [
      "新文芸坐",
    ]),
  );
  // 名簿が読み直されたら、行に覚えさせた結果も作り直される
  const fresh = { venue: "あとから載った館" };
  check("読み直し前は引けない", eq(names(S.spotsOfItem(fresh)), []));
  SYNTH.set(
    "data/spots.csv",
    "name,kind,pref,area,lat,lng,url,status\nあとから載った館,museum,tokyo,東京都・港区,,,,active\n",
  );
  await D.loadSpots();
  check(
    "名簿の読み直しで、行に覚えさせた結果も更新される（古い「引けない」を返さない）",
    eq(names(S.spotsOfItem(fresh)), ["あとから載った館"]) &&
      eq(names(S.spotsOfItem(row2)), ["東京国際フォーラム"]),
  );
}

/* ================= 2. 保存 ================= */
console.log("\n--- 保存（localStorage） ---");
{
  store.clear();
  ST.loadFavSpots();
  check("初回は空", ST.favSpotCount() === 0);
  ST.toggleFavSpot("東京国際フォーラム");
  check("付けられる", ST.isFavSpot("東京国際フォーラム"));
  check(
    "全角半角・空白のゆれがあっても同じ場所として扱う",
    ST.isFavSpot("東京国際フォーラム ") && ST.isFavSpot("東京　国際フォーラム"),
  );
  ST.toggleFavSpot("東京　国際フォーラム");
  check(
    "ゆれた名前で外しても外れる（二重登録しない）",
    ST.favSpotCount() === 0,
  );
  ST.setFavSpot("Ａ館", true);
  check(
    "同じ状態への setFavSpot は変化なし",
    ST.setFavSpot("ａ館", true) === false,
  );
  ST.loadFavSpots(); // 読み直し
  check(
    "保存され、読み直しても残る（表示名のまま）",
    eq(ST.favSpotNames(), ["Ａ館"]),
  );
  store.set("eventboard.favspots.v1", "{壊れたJSON");
  ST.loadFavSpots();
  check("壊れた保存値でも空で起動する", ST.favSpotCount() === 0);
  store.set("eventboard.favspots.v1", JSON.stringify({ a: 1 }));
  ST.loadFavSpots();
  check("配列でない保存値でも空で起動する", ST.favSpotCount() === 0);
  store.set("eventboard.favspots.v1", JSON.stringify(["x", 3, null, "", "y"]));
  ST.loadFavSpots();
  check("文字列でない・空の要素は捨てる", eq(ST.favSpotNames(), ["x", "y"]));
  store.set("eventboard.favpin.v1", "0");
  store.set("eventboard.favfold.v1", "{壊れ");
  ST.loadFavView();
  check(
    "表示設定: 「まとめない」を覚え、壊れたたたみ状態は既定に戻る",
    ST.pinFavSpots() === false && ST.isFavSecFolded("event") === false,
  );
  store.clear();
  ST.loadFavView();
  check("表示設定の既定は「まとめる」", ST.pinFavSpots() === true);
  check(
    "名簿に無い名前は missing 付きで残る",
    (() => {
      ST.loadFavSpots();
      ST.setFavSpot("もう無い会場", true);
      const e = S.favSpotEntries().find((x) => x.name === "もう無い会場");
      ST.setFavSpot("もう無い会場", false);
      return !!e && e.missing === true;
    })(),
  );
}

/* ================= 3. 実データで画面の出し分けを見る ================= */
console.log("\n--- 実データ ---");
SYNTH.clear();
await Promise.all([D.loadSpots(), D.loadTheaters(), D.loadVenues()]);
for (const k of ["event", "movie", "live"]) await D.loadTab(k);
ST.setActiveTabKey("event");

const html = () => els.get("list")?.innerHTML || "";
const keysIn = (h) =>
  [...h.matchAll(/<article class="card" data-key="([^"]+)"/g)].map((x) => x[1]);
const draw = (tabKey) => {
  ST.setActiveTabKey(tabKey);
  R.renderList();
  return els.get(TABS[tabKey].listId).innerHTML;
};
const reset = () => {
  ["event", "movie", "live"].forEach((k) => ST.resetState(k));
  store.clear();
  ST.loadFavSpots();
  ST.loadFavView();
};

// 件数の多い順に、予定のある場所（終了していないもの）を数える
function spotsByCount(tabKey) {
  const c = new Map();
  D.ITEMS[tabKey].forEach((it) => {
    if (F.hasEnded(it)) return;
    S.spotsOfItem(it).forEach((e) => c.set(e.name, (c.get(e.name) || 0) + 1));
  });
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}
const evSpots = spotsByCount("event");
check(
  "イベントに★を付けられる場所が複数ある",
  evSpots.length >= 3,
  `${evSpots.length}か所`,
);
const coverage =
  D.ITEMS.event.filter((it) => S.spotsOfItem(it).length).length /
  D.ITEMS.event.length;
check(
  "イベント行の8割以上が名簿の場所に当たる",
  coverage >= 0.8,
  `${(coverage * 100).toFixed(1)}%`,
);

// --- A. お気に入りが空: 先頭セクションも区切りも出ない
reset();
{
  const h = draw("event");
  check(
    "A. お気に入りが空なら先頭セクションは出ない",
    !h.includes("fav-head") && !h.includes("list-divider"),
  );
  check(
    "A. 全カードが出る（重複なし）",
    keysIn(h).length === R.visibleItems("event").length &&
      new Set(keysIn(h)).size === keysIn(h).length,
  );
  check(
    "A. 各カードの会場名に★が付く",
    (h.match(/class="star-btn"/g) || []).length > 0,
  );
}

// --- B. 1か所を★: 先頭にまとまり、重複しない
reset();
{
  const [top] = evSpots[0];
  ST.setFavSpot(top, true);
  const h = draw("event");
  const vis = R.visibleItems("event");
  const favItems = vis.filter((it) => S.isFavSpotItem(it));
  const ks = keysIn(h);
  check("B. 先頭セクションが出る", h.includes("fav-head"));
  // 先頭セクションは6件までに抑える。超えた分は「ほか◯件を表示」の先にあり、描かれない
  const hiddenByCap = Math.max(0, favItems.length - 6);
  check(
    "B. 全カードが1回ずつ出る（先頭セクションの分を「そのほか」に重ねない）",
    ks.length === vis.length - hiddenByCap && new Set(ks).size === ks.length,
    `${ks.length}/${vis.length}（上限で畳んだ${hiddenByCap}件）`,
  );
  const divAt = h.indexOf("list-divider");
  const before = keysIn(h.slice(0, divAt === -1 ? h.length : divAt));
  const shownCap = Math.min(6, favItems.length);
  check(
    "B. 区切りの前には、お気に入りスポットの催しだけが（上限6件まで）並ぶ",
    before.length === shownCap &&
      before.every((k) => favItems.some((it) => it.key === k)),
    `${before.length}件`,
  );
  check(
    "B. 見出しの件数が実際と合う",
    h.includes(`1か所・${favItems.length}件`),
  );
  check(
    "B. ★の付いた会場名の★は押された状態で描かれる",
    new RegExp(`data-star="${top}" aria-pressed="true"`).test(h),
  );
  // 並びは日付順のまま（先頭セクションの中でも崩れない）
  const order = vis.filter((it) => favItems.includes(it)).map((it) => it.key);
  check(
    "B. 先頭セクションの中の並びは、いまの並び順のまま",
    eq(before, order.slice(0, shownCap)),
  );
}

// --- C. 「まとめない」設定: 見出しは出ず、並びはそのまま
reset();
{
  ST.setFavSpot(evSpots[0][0], true);
  ST.setPinFavSpots(false);
  const h = draw("event");
  check(
    "C. まとめない設定では先頭セクションも区切りも出ない",
    !h.includes("fav-head") && !h.includes("list-divider"),
  );
  check(
    "C. 並びは通常（日付順）のまま",
    eq(
      keysIn(h),
      R.visibleItems("event").map((it) => it.key),
    ),
  );
  ST.setPinFavSpots(true);
}

// --- D. 「★お気に入りスポットだけ」: お気に入りの催しだけ、見出しは出ない
reset();
{
  ST.setFavSpot(evSpots[0][0], true);
  ST.STATES.event.flags.favSpotOnly = true;
  const h = draw("event");
  const ks = keysIn(h);
  check(
    "D. 「★お気に入りスポットだけ」は該当の催しだけを出す",
    ks.length > 0 &&
      ks.length === R.visibleItems("event").length &&
      R.visibleItems("event").every((it) => S.isFavSpotItem(it)),
    `${ks.length}件`,
  );
  check("D. このとき先頭セクションの見出しは出ない", !h.includes("fav-head"));
  const flagN = F.flagCounts(TABS.event, ST.STATES.event, D.ITEMS.event);
  check(
    "D. チップの件数は絞り込み結果と同じ数え方",
    flagN.favSpotOnly >= 0 &&
      (() => {
        ST.STATES.event.flags.favSpotOnly = false;
        const n = F.flagCounts(
          TABS.event,
          ST.STATES.event,
          D.ITEMS.event,
        ).favSpotOnly;
        ST.STATES.event.flags.favSpotOnly = true;
        return n === ks.length;
      })(),
  );
}

// --- E. 条件で先頭が空になる: 理由を1行出す。予定そのものが無いなら何も出さない
reset();
{
  const [spot] = evSpots[0];
  ST.setFavSpot(spot, true);
  // お気に入りの場所に無い催しのタイトルで検索する → 先頭は0件、「そのほか」は残る
  const other = D.ITEMS.event.find(
    (it) => !F.hasEnded(it) && !S.isFavSpotItem(it) && it.title.length >= 4,
  );
  ST.STATES.event.q = other.title;
  const h = draw("event");
  check(
    "E. 条件で隠れたときは理由の1行が出る",
    h.includes("fav-note") && h.includes("いまの絞り込みでは0件"),
  );
  check("E. 「そのほか」は残る", keysIn(h).length >= 1);
  ST.STATES.event.q = "";
  // 別のタブの場所だけをお気に入りにしている → このタブでは何も出さない（毎回うるさくしない）
  reset();
  const onlyLive = spotsByCount("live").find(
    ([n]) =>
      !D.ITEMS.event.some((it) => S.spotsOfItem(it).some((e) => e.name === n)),
  );
  if (onlyLive) {
    ST.setFavSpot(onlyLive[0], true);
    ST.STATES.event.q = other.title;
    const h2 = draw("event");
    check(
      "E. このタブに予定の無い場所だけをお気に入りにしていても、イベントタブは静か",
      !h2.includes("fav-head") && !h2.includes("fav-note"),
    );
    ST.STATES.event.q = "";
  } else {
    check("E. （ライブ専用の場所が無いのでスキップ）", true);
  }
}

// --- F. 上限6件と「ほか◯件を表示」、たたむ
reset();
{
  let total = 0;
  const picked = [];
  for (const [n, c] of evSpots) {
    picked.push(n);
    total += c;
    if (total > 8) break;
  }
  picked.forEach((n) => ST.setFavSpot(n, true));
  let h = draw("event");
  const favN = R.visibleItems("event").filter((it) =>
    S.isFavSpotItem(it),
  ).length;
  const divAt = h.indexOf("list-divider");
  check(
    "F. 先頭の件数が6を超えると、6件までに抑えて「ほか◯件を表示」を出す",
    favN > 6 &&
      keysIn(h.slice(0, divAt)).length === 6 &&
      h.includes(`ほか${favN - 6}件を表示`),
    `お気に入りの催し${favN}件`,
  );
  ST.setFavSecMoreOpen("event", true);
  h = draw("event");
  const divAt2 = h.indexOf("list-divider");
  check(
    "F. 開くと全件が先頭に並ぶ",
    keysIn(h.slice(0, divAt2)).length === favN &&
      h.includes("先頭の表示をへらす"),
  );
  ST.setFavSecMoreOpen("event", false);
  ST.setFavSecFolded("event", true);
  h = draw("event");
  const total2 = keysIn(h).length;
  check(
    "F. たたむと先頭のカードを隠す（見出しは残り、「そのほか」は残る）",
    h.includes("fav-head") &&
      h.includes("ひらく") &&
      total2 === R.visibleItems("event").length - favN,
    `${total2}枚`,
  );
  ST.setFavSecFolded("event", false);
}

// --- G. 映画: チェーンの劇場を★にすると、チェーンの新作は1行にまとまる
reset();
{
  const chainTheater = D.THEATERS.find((t) => t.chain === "TOHOシネマズ");
  const chainName = chainTheater && chainTheater.chain;
  if (!chainTheater) {
    check("G. （TOHOシネマズの名簿が無いのでスキップ）", true);
  } else {
    ST.setFavSpot(chainTheater.name, true);
    const expected = D.ITEMS.movie.filter(
      (it) => venueNames(it).includes(chainName) && !F.hasEnded(it),
    ).length;
    let h = draw("movie");
    const mHead = h.match(/class="chain-head">([^<]*)/);
    check(
      "G. チェーンの新作が1行にまとまり、本数がデータと合う",
      expected > 0 && mHead && mHead[1].includes(`${expected}本`),
      mHead ? mHead[1] : "行なし",
    );
    const cardsForChain = R.visibleItems("movie").filter(
      (it) => venueNames(it).includes(chainName) && !S.isFavSpotItem(it),
    );
    const divAt = h.indexOf("list-divider");
    check(
      "G. チェーンの新作を先頭セクションのカードとして並べない（その本数ぶん増えない）",
      divAt === -1 ||
        keysIn(h.slice(0, divAt)).every((k) =>
          R.visibleItems("movie").some(
            (it) => it.key === k && S.isFavSpotItem(it),
          ),
        ) ||
        cardsForChain.length === 0,
    );
    check(
      "G. 劇場のページへのリンクと「この◯本でしぼる」が出る",
      h.includes("の上映スケジュール") &&
        h.includes(`data-chain-filter="${chainName}"`),
    );
    // 会場でしぼっている最中は、押した結果と同じなので出さない
    ST.STATES.movie.venue = chainName;
    h = draw("movie");
    check("G. 会場でしぼっているときは出さない", !h.includes("chain-row"));
    ST.STATES.movie.venue = null;
    // 都県の条件に、お気に入りの劇場が入らなければ出さない
    ST.STATES.movie.pref = chainTheater.pref === "chiba" ? "saitama" : "chiba";
    h = draw("movie");
    check(
      "G. お気に入りの劇場がエリアの外なら出さない",
      !h.includes("chain-row"),
    );
    ST.STATES.movie.pref = null;
    // 「★お気に入りスポットだけ」でもまとめ行は出る
    ST.STATES.movie.flags.favSpotOnly = true;
    h = draw("movie");
    check(
      "G. 「★お気に入りスポットだけ」でもチェーンの新作の行は案内される",
      h.includes("chain-row"),
    );
    ST.STATES.movie.flags.favSpotOnly = false;
    // チェーンの劇場の★は、イベントタブの先頭セクションには影響しない
    const hEv = draw("event");
    check("G. ★の劇場はイベントタブに何も出さない", !hEv.includes("chain-row"));
  }
}

// --- H. 絞り込みの配線（URL・タブ間の持ち越し・ラベル）
reset();
{
  check(
    "H. 3タブとも「★お気に入りスポットだけ」の特別チップを持つ",
    ["event", "movie", "live"].every((k) =>
      TABS[k].flags.some((f) => f.id === "favSpotOnly"),
    ),
  );
  check(
    "H. ♡のチップは「行きたいだけ」に改名されている（★と紛れない）",
    TABS.event.flags.find((f) => f.id === "favOnly").label(TABS.event) ===
      "行きたいだけ",
  );
  ST.STATES.event.flags.favSpotOnly = true;
  ST.setActiveTabKey("event");
  const q = ST.stateToQuery().toString();
  check("H. URLに載る（f=favspot）", /f=favspot/.test(q), q);
  const key = ST.queryToState("?f=favspot");
  check(
    "H. URLから復元できる",
    key === "event" && ST.STATES.event.flags.favSpotOnly === true,
  );
  reset();
  ST.STATES.live.flags.favSpotOnly = true;
  ST.carryFilters("live", "movie");
  check(
    "H. タブを移っても持ち越される（id が同じ特別チップ）",
    ST.STATES.movie.flags.favSpotOnly === true,
  );
}

// --- I. 検索・日程・並び順との組み合わせでも壊れない（取りこぼしと重複が無い）
reset();
{
  evSpots.slice(0, 4).forEach(([n]) => ST.setFavSpot(n, true));
  const patterns = [
    { name: "検索語あり", set: (s) => (s.q = "展") },
    { name: "新着順", set: (s) => (s.sortBy = "announced") },
    {
      name: "日程の範囲",
      set: (s) => {
        s.rangeStart = "2026-10-01";
        s.rangeEnd = "2026-10-31";
      },
    },
    { name: "都県", set: (s) => (s.pref = "tokyo") },
    { name: "終了も表示", set: (s) => (s.flags.showEnded = true) },
    { name: "割引あり", set: (s) => (s.flags.dealsOnly = true) },
  ];
  for (const p of patterns) {
    ST.resetState("event");
    p.set(ST.STATES.event);
    const h = draw("event");
    const ks = keysIn(h);
    const vis = R.visibleItems("event");
    const folded = ST.isFavSecFolded("event");
    const expectedMax = vis.length;
    check(
      `I. ${p.name}: 重複なし・件数が絞り込み結果を超えない`,
      new Set(ks).size === ks.length && ks.length <= expectedMax,
      `${ks.length}/${vis.length}${folded ? "（たたみ）" : ""}`,
    );
    // 先頭に出たカードは、すべて絞り込みに合う催しである
    check(
      `I. ${p.name}: 出たカードはどれも絞り込みに合う`,
      ks.every((k) => vis.some((it) => it.key === k)),
    );
  }
}

console.log(
  failures.length
    ? `\n失敗 ${failures.length}件:\n  - ${failures.join("\n  - ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
