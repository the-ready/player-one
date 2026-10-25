/* お気に入りアーティスト（人のボタン）の回帰テスト。DOM不要（render.js は要素の置き物で動かす）。

   壊れ方は5種類ある。どれも画面では「たまたま出ない」「たまたま二重に出る」としか見えない。
     1. 名前の照合の取りこぼし／取り違え — 登録したのに出ない、別人の公演が出る（HANA と HANABI）
     2. 出演者の持ち方の違い            — フェスのラインナップ・登壇者の期限・括弧の補足
     3. 先頭セクションの振り分け        — 同じカードが2回出る、順番が逆、件数が合わない
     4. 保存                            — 全角半角ゆれで二重登録、壊れた保存値で起動できない、上限
     5. 「前回から追加」                — 初回に全部が新着になる、読み直しで印が消える、使っていない人の端末を埋める

   前半は合成データで規則そのものを、後半は実データで画面の出し分けを見る
   （実データの件数は毎週変わるので、後半は「同じデータから別の方法で数えた値」と突き合わせる）。

   使い方（リポジトリのルートから）:
     node tools/fav_artists_test.mjs
*/

import fs from "node:fs";

/* ---------- 時間を止める（guest_filter_test と同じ方法） ---------- */
const RealDate = Date;
let frozen = null;
class FakeDate extends RealDate {
  constructor(...a) {
    if (a.length === 0 && frozen !== null) super(frozen);
    else super(...a);
  }
  static now() {
    return frozen !== null ? frozen : RealDate.now();
  }
}
globalThis.Date = FakeDate;
const freeze = (ymd) => {
  frozen = RealDate.parse(`${ymd}T12:00:00+09:00`);
};
freeze("2026-10-20");

/* ---------- 環境の差し替え ---------- */
const served = {};
globalThis.fetch = async (p) => {
  const path = String(p).replace(/^\.\//, "");
  const text =
    path in served
      ? served[path]
      : fs.existsSync(path)
        ? fs.readFileSync(path, "utf8")
        : null;
  if (text === null)
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
let storeFails = false; // true の間、localStorage は読み書きとも例外を投げる
globalThis.localStorage = {
  getItem: (k) => {
    if (storeFails) throw new Error("denied");
    return store.has(k) ? store.get(k) : null;
  },
  setItem: (k, v) => {
    if (storeFails) throw new Error("denied");
    store.set(k, String(v));
  },
  removeItem: (k) => {
    if (storeFails) throw new Error("denied");
    store.delete(k);
  },
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
      // 同じHTMLの描き直しを飛ばす判定（render.js の setListHtml）が引く
      querySelector: () => null,
      contains: () => false,
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const U = await import("../assets/js/util.js");
const D = await import("../assets/js/data.js");
const ST = await import("../assets/js/state.js");
const A = await import("../assets/js/artists.js");
const F = await import("../assets/js/filters.js");
const S = await import("../assets/js/spots.js");
const Sch = await import("../assets/js/schedule.js");
const { TABS } = await import("../assets/js/config.js");
const R = await import("../assets/js/render.js");
const { cardHtml } = await import("../assets/js/cards.js");

const setToday = (ymd) => {
  freeze(ymd);
  D.refreshToday();
};

/* ================= 1. 名前の照合キー ================= */
console.log("\n--- 名前の照合キー ---");
{
  const head = U.artistHead;
  const key = U.artistKey;
  check(
    "末尾の括弧の補足（所属・役割・国）は外す",
    head("U-KNOW(東方神起)") === "U-KNOW" &&
      head("熊倉優(指揮)") === "熊倉優" &&
      head("Been Stellar (US)") === "Been Stellar" &&
      head("吾妻光良(吾妻光良＆The Swinging Boppers)") === "吾妻光良" &&
      head("27AM(AtoZ)") === "27AM",
  );
  check(
    "括弧の中が1文字なら名前の一部（JUN SKY WALKER(S)）",
    head("JUN SKY WALKER(S)") === "JUN SKY WALKER(S)",
  );
  check(
    "複数人を1つに書いた表記・区切り記号を含む正式名は割らない",
    head("岩谷翔吾 (THE RAMPAGE)×IKKi,KANAU") ===
      "岩谷翔吾 (THE RAMPAGE)×IKKi,KANAU" &&
      head("KIRA (Girls²)×calin,CHISATO") === "KIRA (Girls²)×calin,CHISATO" &&
      head("DISH//") === "DISH//" &&
      head("Fear, and Loathing in Las Vegas") ===
        "Fear, and Loathing in Las Vegas" &&
      head("H//PE PRINCESS") === "H//PE PRINCESS",
  );
  check(
    "括弧だけ・括弧が先頭の表記は、全体を名前として残す",
    head("(指揮)") === "(指揮)" && head("（指揮）") === "（指揮）",
  );
  check(
    "入れ子の括弧は外さない（誤って削らない側に倒す）",
    head("A(B)(CC)") === "A(B)" && head("X((YY))") === "X((YY))",
  );
  check(
    "大文字小文字・全角半角・空白のゆれを吸収する",
    key("Knosis") === key("knosis") &&
      key("THEカルテット") === key("THE カルテット") &&
      key("Jams Collection") === key("JamsCollection") &&
      key("BARBEE BOYS 4PEACE") === key("BARBEE BOYS 4 PEACE") &&
      key("ＫＮＯＳＩＳ") === key("knosis"),
  );
  check("前後の空白は無視する", key("  Saucy Dog ") === key("Saucy Dog"));
  check(
    "別人は別のキー（部分一致で当てない）",
    key("HANA") !== key("HANABI") &&
      key("東方神起") !== key("U-KNOW(東方神起)") &&
      key("ほか") !== key("ほかの人"),
  );
  check("空は空のキー", key("") === "" && key(null) === "" && key("  ") === "");
}

/* ================= 2. 保存 ================= */
console.log("\n--- 保存 ---");
{
  store.clear();
  ST.loadFavArtists();
  check("空で始まる", ST.favArtistCount() === 0);
  const r0 = ST.favArtistRev();
  check("登録できる", ST.setFavArtist("Saucy Dog", true) === true);
  check("登録の増減で rev が進む", ST.favArtistRev() === r0 + 1);
  check(
    "ゆれた表記では二重登録しない（変化なし）",
    ST.setFavArtist("saucy dog", true) === false &&
      ST.setFavArtist("ＳａｕｃｙＤｏｇ", true) === false &&
      ST.favArtistCount() === 1,
  );
  check("変化が無ければ rev は進まない", ST.favArtistRev() === r0 + 1);
  check(
    "ゆれた名前で外しても外れる",
    ST.setFavArtist("SAUCY DOG", false) === true && ST.favArtistCount() === 0,
  );
  ST.setFavArtist("U-KNOW(東方神起)", true);
  check(
    "括弧の補足を外した名前で保存する（登録したのは人であって所属ではない）",
    eq(ST.favArtistNames(), ["U-KNOW"]) && ST.isFavArtist("U-KNOW(東方神起)"),
  );
  check(
    "所属名では当たらない（本人名義だけ）",
    ST.isFavArtist("東方神起") === false,
  );
  ST.loadFavArtists();
  check(
    "読み直しても残る（表示名のまま）",
    eq(ST.favArtistNames(), ["U-KNOW"]),
  );
  check(
    "空・空白だけ・長すぎる名前は登録できない",
    ST.setFavArtist("", true) === false &&
      ST.setFavArtist("   ", true) === false &&
      ST.setFavArtist("あ".repeat(ST.FAV_ARTIST_NAME_MAX + 1), true) ===
        false &&
      ST.setFavArtist(null, true) === false &&
      ST.favArtistCount() === 1,
  );
  check(
    "上限ちょうどの長さは登録できる",
    ST.setFavArtist("あ".repeat(ST.FAV_ARTIST_NAME_MAX), true) === true,
  );
  check(
    "toggle は登録状態を返す",
    ST.toggleFavArtist("Vaundy") === true &&
      ST.toggleFavArtist("Vaundy") === false,
  );
  check(
    "内部の連続空白は1つにそろえる",
    (() => {
      ST.setFavArtist("a   b", true);
      return ST.favArtistNames().includes("a b");
    })(),
  );
  store.set("eventboard.favartists.v1", "{壊れたJSON");
  ST.loadFavArtists();
  check("壊れた保存値でも空で起動する", ST.favArtistCount() === 0);
  store.set("eventboard.favartists.v1", JSON.stringify({ a: 1 }));
  ST.loadFavArtists();
  check("配列でない保存値でも空で起動する", ST.favArtistCount() === 0);
  store.set(
    "eventboard.favartists.v1",
    JSON.stringify(["x", 3, null, "", "y", "X", { a: 1 }]),
  );
  ST.loadFavArtists();
  check(
    "文字列でない・空・重複（X=x）は捨てる",
    eq(ST.favArtistNames(), ["x", "y"]),
  );
  store.set(
    "eventboard.favartists.v1",
    JSON.stringify(
      Array.from({ length: ST.FAV_ARTIST_MAX + 30 }, (_, i) => `人${i}`),
    ),
  );
  ST.loadFavArtists();
  check(
    "保存値が上限を超えていても上限で切る",
    ST.favArtistCount() === ST.FAV_ARTIST_MAX,
  );
  check(
    "上限に達したら追加できない（外すことはできる）",
    ST.setFavArtist("新しい人", true) === false &&
      ST.setFavArtist("人0", false) === true &&
      ST.setFavArtist("新しい人", true) === true,
  );
  storeFails = true;
  ST.loadFavArtists();
  check(
    "保存領域が使えなくても起動でき、このページの中では効く",
    ST.favArtistCount() === 0 &&
      ST.setFavArtist("メモリだけ", true) === true &&
      ST.isFavArtist("メモリだけ"),
  );
  storeFails = false;
  store.clear();
  ST.loadFavArtists();

  store.set("eventboard.favartpin.v1", "0");
  store.set("eventboard.favartfold.v1", "{壊れ");
  ST.loadFavArtistView();
  check(
    "表示設定: 「まとめない」を覚え、壊れたたたみ状態は既定に戻る",
    ST.pinFavArtists() === false && ST.isArtSecFolded("event") === false,
  );
  store.clear();
  ST.loadFavArtistView();
  check(
    "表示設定の既定は「まとめる」・たたまない",
    ST.pinFavArtists() === true && ST.isArtSecFolded("live") === false,
  );
  ST.setArtSecFolded("live", true);
  ST.loadFavArtistView();
  check(
    "たたんだ状態を覚える（タブごと）",
    ST.isArtSecFolded("live") === true && ST.isArtSecFolded("event") === false,
  );
  check(
    "お気に入りスポットの設定とは別のキーで持つ",
    store.has("eventboard.favartfold.v1") &&
      !store.has("eventboard.favfold.v1"),
  );
  store.clear();
  ST.loadFavArtistView();
}

/* ================= 3. 合成データでの照合 ================= */
console.log("\n--- 照合（合成データ） ---");

const toCsv = (cols, rows) =>
  [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")),
  ].join("\n");
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const LIVE_COLS = [
  "id",
  "title",
  "artists",
  "live_type",
  "area",
  "venue",
  "pref",
  "start_date",
  "end_date",
  "lineup_id",
  "price",
  "source",
  "url",
  "desc",
  "genre",
];
const lrow = (o) => ({
  area: "東京都",
  venue: "テスト会場",
  pref: "tokyo",
  live_type: "oneman",
  genre: "rock",
  price: "指定席8,000円",
  source: "公式サイト",
  url: "https://example.com/",
  desc: "テスト用の行。",
  ...o,
});
const LIVE_ROWS = [
  lrow({
    id: 1,
    title: "Saucy Dog ARENA TOUR",
    artists: "Saucy Dog",
    venue: "有明アリーナ",
    start_date: "2026-12-15",
    end_date: "2026-12-16",
  }),
  lrow({
    id: 2,
    title: "共演ライブ",
    live_type: "event",
    artists: "Saucy Dog|Vaundy|超特急|NEXZ|My Hair is Bad|Ayumu Imazu",
    start_date: "2026-11-06",
    end_date: "2026-11-06",
  }),
  lrow({
    id: 3,
    title: "FES-1",
    live_type: "fes",
    artists: "氣志團|WANIMA",
    lineup_id: "fes1",
    start_date: "2026-11-07",
    end_date: "2026-11-08",
    venue: "幕張メッセ",
  }),
  lrow({
    id: 4,
    title: "U-KNOW PROJECT",
    artists: "U-KNOW(東方神起)",
    start_date: "2026-10-31",
    end_date: "2026-10-31",
  }),
  lrow({
    id: 5,
    title: "終わったツアー",
    artists: "Saucy Dog",
    start_date: "2026-10-01",
    end_date: "2026-10-02",
  }),
  lrow({
    id: 6,
    title: "Saucy Dog 好きのための会",
    artists: "",
    start_date: "2026-11-20",
    end_date: "2026-11-20",
  }),
  lrow({
    id: 7,
    venue: "別の会場",
    title: "Knosis ONE",
    artists: "Knosis",
    start_date: "2026-11-21",
    end_date: "2026-11-21",
  }),
  lrow({
    id: 8,
    venue: "別の会場",
    title: "knosis TWO",
    artists: "knosis",
    start_date: "2026-11-22",
    end_date: "2026-11-22",
  }),
  lrow({
    id: 9,
    venue: "別の会場",
    title: "HANA TOUR",
    artists: "HANA",
    start_date: "2026-11-23",
    end_date: "2026-11-23",
  }),
  lrow({
    id: 10,
    venue: "別の会場",
    title: "HANABI NIGHT",
    artists: "HANABI",
    start_date: "2026-11-24",
    end_date: "2026-11-24",
  }),
  lrow({
    id: 11,
    venue: "別の会場",
    title: "エスケープ試験",
    artists: '<img src=x onerror=alert(1)>|"引用符"|A&B',
    start_date: "2026-11-25",
    end_date: "2026-11-25",
  }),
  lrow({
    id: 12,
    venue: "別の会場",
    title: "指揮者つき",
    live_type: "classic",
    artists: "熊倉優(指揮)|東京フィル",
    start_date: "2026-11-26",
    end_date: "2026-11-26",
  }),
];
const LINEUP_CSV = [
  "lineup_id,date,stage,artist,is_headliner,apple_music_url,note",
  "fes1,2026-11-07,,氣志團,1,,",
  "fes1,2026-11-07,,Saucy Dog,,https://music.apple.com/jp/artist/saucy-dog/1,",
  "fes1,2026-11-08,,10-FEET,,,",
  "fes1,2026-11-08,,Saucy Dog,,,",
  "fes1,,,日割り未発表の人,,,",
  "fes1,2026-11-07,,WANIMA,,,",
].join("\n");
served["data/lineups.csv"] = LINEUP_CSV;
served["data/lives.csv"] = toCsv(LIVE_COLS, LIVE_ROWS);

const EV_COLS = [
  "id",
  "title",
  "cats",
  "area",
  "venue",
  "pref",
  "start_date",
  "end_date",
  "guests",
  "guest_dates",
  "price",
  "source",
  "url",
  "desc",
];
const erow = (o) => ({
  cats: "ent",
  area: "東京都",
  venue: "テスト会場",
  pref: "tokyo",
  price: "一般1,000円",
  source: "公式サイト",
  url: "https://example.com/",
  desc: "テスト用の行。",
  ...o,
});
served["data/events.csv"] = toCsv(EV_COLS, [
  erow({
    id: 1,
    title: "トークイベント",
    start_date: "2026-10-10",
    end_date: "2026-11-30",
    guests: "Saucy Dog|山田花子",
    guest_dates: "2026-10-25|2026-11-03",
  }),
  erow({
    id: 2,
    title: "出演日が過ぎたイベント",
    start_date: "2026-10-10",
    end_date: "2026-11-30",
    guests: "山田花子",
    guest_dates: "2026-10-18",
  }),
  erow({
    id: 3,
    title: "登壇者5人",
    start_date: "2026-10-10",
    end_date: "2026-11-30",
    guests: "甲|乙|丙|丁|戊",
    guest_dates: "2026-11-03",
  }),
]);
served["data/movies.csv"] = toCsv(
  [
    "id",
    "title",
    "genre",
    "area",
    "theater",
    "pref",
    "release_date",
    "end_date",
    "guests",
    "guest_dates",
    "price",
    "source",
    "url",
    "desc",
  ],
  [
    {
      id: 1,
      title: "舞台挨拶つき映画",
      genre: "anime",
      area: "東京都",
      theater: "テスト劇場",
      pref: "tokyo",
      release_date: "2026-10-20",
      end_date: "2026-11-20",
      guests: "山田花子",
      guest_dates: "2026-11-01",
      price: "1,900円",
      source: "公式",
      url: "https://example.com/",
      desc: "テスト",
    },
  ],
);
served["data/spots.csv"] = [
  "name,kind,pref,area,lat,lng,url,status,closed_until,first_seen,last_hit,hit_count,note",
  "テスト会場,hall,tokyo,東京都,,,,active,,,,,",
].join("\n");
served["data/venues.csv"] = [
  "venue,kind,pref,area,capacity,lat,lng,url,status,closed_until,first_seen,last_hit,hit_count,note",
  "有明アリーナ,arena,tokyo,東京都・江東区,15000,,,,active,,,,,",
].join("\n");
served["data/theaters.csv"] = [
  "chain,name,pref,area,lat,lng,url,status,first_seen,last_hit,hit_count,note",
].join("\n");

await Promise.all([D.loadSpots(), D.loadTheaters(), D.loadVenues()]);
for (const k of ["event", "movie", "live"]) await D.loadTab(k);

const liveBy = (title) => D.ITEMS.live.find((it) => it.title === title);
const evBy = (title) => D.ITEMS.event.find((it) => it.title === title);
const resetAll = () => {
  ["event", "movie", "live"].forEach((k) => ST.resetState(k));
  store.clear();
  ST.loadFavorites();
  ST.loadFavSpots();
  ST.loadFavView();
  ST.loadFavArtists();
  ST.loadFavArtistView();
  A.reconcileSeen();
};
const names = (it) => A.favArtistsOf(it).map((h) => h.name);
{
  resetAll();
  check(
    "お気に入りが空なら、どの行も当たらない",
    D.ITEMS.live.every((it) => A.favArtistsOf(it).length === 0),
  );
  ST.setFavArtist("saucy dog", true);
  check(
    "単独公演の artists に当たる（登録名の表記で返る）",
    eq(names(liveBy("Saucy Dog ARENA TOUR")), ["saucy dog"]),
  );
  check(
    "共演の artists（6組のうち1組）に当たる",
    eq(names(liveBy("共演ライブ")), ["saucy dog"]),
  );
  check(
    "フェスは lineups.csv の出演者に当たる（artists 列に無くても）",
    eq(names(liveBy("FES-1")), ["saucy dog"]),
  );
  check(
    "フェスで出る日がこれから先のものだけ添う（11/7 と 11/8）",
    eq(A.favArtistsOf(liveBy("FES-1"))[0].days, ["2026-11-07", "2026-11-08"]),
  );
  setToday("2026-11-08");
  check(
    "日が過ぎたら、その日は外れる（11/8 の朝は 11/8 だけ）",
    eq(A.favArtistsOf(liveBy("FES-1"))[0].days, ["2026-11-08"]),
  );
  setToday("2026-10-20");
  check(
    "タイトルにだけ名前がある行（artists が空）は当たらない（推測で補わない）",
    A.favArtistsOf(liveBy("Saucy Dog 好きのための会")).length === 0,
  );
  check(
    "終わった公演にも当たりは付く（隠すのは終了の既定非表示の役目）",
    A.favArtistsOf(liveBy("終わったツアー")).length === 1,
  );
  check(
    "イベントの登壇者に当たる（イベントタブでも）",
    eq(names(evBy("トークイベント")), ["saucy dog"]),
  );
  check(
    "登壇者の日にちは、行全体の日付を人の出演日として言い切らない（days は空）",
    A.favArtistsOf(evBy("トークイベント"))[0].days.length === 0,
  );
  ST.setFavArtist("山田花子", true);
  check(
    "登壇日が過ぎたイベントは当たらない（出演日 10/18 は昨日以前）",
    A.favArtistsOf(evBy("出演日が過ぎたイベント")).length === 0,
  );
  check(
    "映画の登壇者にも当たる",
    A.favArtistsOf(D.ITEMS.movie[0]).length === 1,
  );
  setToday("2026-11-04");
  check(
    "出演日が全部過ぎたらイベントでも当たらなくなる（日付をまたぐ）",
    A.favArtistsOf(evBy("トークイベント")).length === 0,
  );
  setToday("2026-10-20");
  check(
    "日付が戻れば当たりも戻る（キャッシュが日付を見ている）",
    A.favArtistsOf(evBy("トークイベント")).length >= 1,
  );
  resetAll();
  ST.setFavArtist("U-KNOW", true);
  check(
    "「名前(所属)」の公演は、名前で登録した人に当たる",
    eq(names(liveBy("U-KNOW PROJECT")), ["U-KNOW"]),
  );
  resetAll();
  ST.setFavArtist("東方神起", true);
  check(
    "所属グループで登録した人には、メンバーのソロ公演は当たらない",
    A.favArtistsOf(liveBy("U-KNOW PROJECT")).length === 0,
  );
  resetAll();
  ST.setFavArtist("熊倉優", true);
  check(
    "役割の括弧（指揮）は外して、本人に当たる",
    A.favArtistsOf(liveBy("指揮者つき")).length === 1,
  );
  resetAll();
  ST.setFavArtist("KNOSIS", true);
  check(
    "表記ゆれ（Knosis / knosis）の両方に当たる",
    A.favArtistsOf(liveBy("Knosis ONE")).length === 1 &&
      A.favArtistsOf(liveBy("knosis TWO")).length === 1,
  );
  resetAll();
  ST.setFavArtist("HANA", true);
  check(
    "HANA は HANABI に当たらない（完全一致）",
    A.favArtistsOf(liveBy("HANA TOUR")).length === 1 &&
      A.favArtistsOf(liveBy("HANABI NIGHT")).length === 0,
  );
  resetAll();
  ST.setFavArtist("Saucy Dog", true);
  const it1 = liveBy("Saucy Dog ARENA TOUR");
  const before = A.favArtistsOf(it1);
  ST.setFavArtist("Saucy Dog", false);
  check(
    "外すと直ちに当たらなくなる（キャッシュが登録の増減を見ている）",
    before.length === 1 && A.favArtistsOf(it1).length === 0,
  );
  ST.setFavArtist("Saucy Dog", true);
  check("付け直すと戻る", A.favArtistsOf(it1).length === 1);
  check(
    "同じ行への2回目の問い合わせは同じ配列を返す（行ごとに覚えている）",
    A.favArtistsOf(it1) === A.favArtistsOf(it1),
  );
  check(
    "当たりが無い行は共有の空配列（毎回配列を作らない）",
    A.favArtistsOf(liveBy("HANA TOUR")) ===
      A.favArtistsOf(liveBy("HANABI NIGHT")),
  );
}

/* ================= 4. 絞り込み・URL・タブの持ち越し ================= */
console.log("\n--- 絞り込みの配線 ---");
{
  resetAll();
  check(
    "3タブとも「お気に入りアーティストだけ」の特別チップを持つ",
    ["event", "movie", "live"].every((k) =>
      TABS[k].flags.some((f) => f.id === "favArtistOnly"),
    ),
  );
  const flag = (k) => TABS[k].flags.find((f) => f.id === "favArtistOnly");
  check(
    "3タブで文言と群が同じ（持ち越しで意味が変わらない）",
    ["event", "movie"].every(
      (k) =>
        flag(k).label(TABS[k]) === flag("live").label(TABS.live) &&
        flag(k).group === flag("live").group,
    ),
  );
  check(
    "♡・★のチップと紛れない文言",
    flag("live").label(TABS.live) === "お気に入りアーティストだけ",
  );
  ST.setFavArtist("Saucy Dog", true);
  const tab = TABS.live;
  const st = ST.STATES.live;
  const counts = F.flagCounts(tab, st, D.ITEMS.live);
  const expected = D.ITEMS.live.filter(
    (it) => !F.hasEnded(it) && A.favArtistsOf(it).length > 0,
  ).length;
  check(
    "チップの件数＝押したあとの件数（終わった公演を数えない）",
    counts.favArtistOnly === expected && expected === 3,
    `${counts.favArtistOnly}/${expected}`,
  );
  st.flags.favArtistOnly = true;
  ST.setActiveTabKey("live");
  const vis = R.visibleItems("live");
  check(
    "絞ると出演する公演だけが残る",
    vis.length === expected && vis.every((it) => A.favArtistsOf(it).length),
  );
  const q = ST.stateToQuery().toString();
  check("URLに載る（f=favartist）", /f=favartist/.test(q), q);
  ST.queryToState("?tab=live&f=favartist");
  check("URLから復元できる", ST.STATES.live.flags.favArtistOnly === true);
  ST.queryToState("?tab=live&f=favartist,favspot");
  check(
    "★のチップと同時にも立つ（別の絞り込み）",
    ST.STATES.live.flags.favArtistOnly && ST.STATES.live.flags.favSpotOnly,
  );
  ST.resetState("live");
  ST.STATES.live.flags.favArtistOnly = true;
  ST.carryFilters("live", "event");
  check(
    "タブを移っても持ち越される（id が同じ特別チップ）",
    ST.STATES.event.flags.favArtistOnly === true,
  );
  const plan = ST.carryPlan("event", "movie");
  check(
    "event → movie でも落とさない",
    plan.next.flags.favArtistOnly === true && plan.dropped.length === 0,
  );
  check(
    "hasAnyFilter に数えられる（空表示の出口が出る）",
    ST.hasAnyFilter("event") === true,
  );
}

/* ================= 5. 一覧: 先頭セクションの振り分け ================= */
console.log("\n--- 一覧の先頭セクション（合成データ） ---");
{
  const html = () => els.get("list")?.innerHTML || "";
  const keysIn = (h) =>
    [...h.matchAll(/<article class="card" data-key="([^"]+)"/g)].map(
      (x) => x[1],
    );
  const draw = (tabKey) => {
    ST.setActiveTabKey(tabKey);
    R.renderList();
    return els.get(TABS[tabKey].listId).innerHTML;
  };
  const keyOf = (title) => liveBy(title).key;
  const posOf = (h, title) => h.indexOf(`data-key="${keyOf(title)}"`);

  resetAll();
  let h = draw("live");
  check(
    "お気に入りが空なら先頭セクションも区切りも出ない",
    !h.includes("fav-head") && !h.includes("list-divider"),
  );

  ST.setFavArtist("Saucy Dog", true);
  h = draw("live");
  const artEnd = h.indexOf("list-divider");
  const secKeys = keysIn(h.slice(0, artEnd));
  check(
    "お気に入りアーティストの見出しが出る（人のアイコンつき）",
    h.includes('class="fav-head art"') &&
      h.includes("お気に入りアーティスト") &&
      h.includes("person-ico"),
  );
  check(
    "見出しの件数が実際と合う（1組・これから出る3件。終わった公演は数えない）",
    h.includes("1組・3件"),
    (h.match(/fh-count">([^<]*)/) || [])[1],
  );
  check(
    "区切りの前には、その人の出る公演だけが並ぶ（終わった公演は出ない）",
    eq(
      new Set(secKeys),
      new Set([
        keyOf("Saucy Dog ARENA TOUR"),
        keyOf("共演ライブ"),
        keyOf("FES-1"),
      ]),
    ) && !h.includes(`data-key="${keyOf("終わったツアー")}"`),
  );
  check(
    "並びは日付順のまま（先頭セクションの中でも崩れない）",
    eq(secKeys, [
      keyOf("共演ライブ"),
      keyOf("FES-1"),
      keyOf("Saucy Dog ARENA TOUR"),
    ]),
    JSON.stringify(
      secKeys.map((k) => D.ITEMS.live.find((x) => x.key === k).title),
    ),
  );
  const all = keysIn(h);
  check(
    "全カードが1回ずつ出る",
    new Set(all).size === all.length &&
      all.length === R.visibleItems("live").length,
  );
  check(
    "お気に入りの公演にだけ「なぜ先頭か」の行が付く",
    (h.match(/class="why-line"/g) || []).length === 3,
  );

  // ★との並び: 人 → 場所 → そのほか
  ST.setFavSpot("有明アリーナ", true);
  h = draw("live");
  const ariake = keyOf("Saucy Dog ARENA TOUR");
  check(
    "人と場所の両方に当たる公演は、上（人）のセクションに1回だけ出る",
    (h.match(new RegExp(`data-key="${ariake}"`, "g")) || []).length === 1 &&
      h.indexOf(`data-key="${ariake}"`) < h.indexOf("list-divider"),
  );
  check(
    "場所の公演がすべて人のセクションに出ているときは、場所の見出しを出さない（0件の見出しを残さない）",
    h.includes('class="fav-head art"') && !h.includes('<div class="fav-head" '),
  );
  const all2 = keysIn(h);
  check(
    "両方あっても全カードが1回ずつ出る",
    new Set(all2).size === all2.length &&
      all2.length === R.visibleItems("live").length,
  );

  // 場所だけに当たる公演（人は当たらない）がある場合
  ST.setFavSpot("テスト会場", true);
  h = draw("live");
  const artHead = h.indexOf('class="fav-head art"');
  const spotHead = h.indexOf('<div class="fav-head" ');
  const div = h.indexOf("list-divider");
  check(
    "順番は、お気に入りアーティスト → お気に入りスポット → そのほか",
    artHead >= 0 && spotHead > artHead && div > spotHead,
  );
  const uk = h.indexOf(`data-key="${keyOf("U-KNOW PROJECT")}"`);
  check(
    "人に当たらず場所に当たる公演は、場所のセクションに出る",
    uk > spotHead && uk < div,
  );
  check(
    "人に当たる公演は、場所にも当たっていても人のセクションに出る（場所のセクションには出ない）",
    h.indexOf(`data-key="${keyOf("共演ライブ")}"`) < spotHead,
  );
  const all3 = keysIn(h);
  check(
    "人・場所・そのほかで、全カードが1回ずつ出る",
    new Set(all3).size === all3.length,
  );
  ST.setFavSpot("テスト会場", false);
  ST.setFavSpot("有明アリーナ", false);

  // まとめない設定
  ST.setPinFavArtists(false);
  h = draw("live");
  check(
    "「まとめない」では人の見出しは出ないが、カードの「なぜ」の行は残る",
    !h.includes('class="fav-head art"') &&
      (h.match(/class="why-line"/g) || []).length === 3,
  );
  check(
    "「まとめない」では並びが通常（日付順）のまま",
    eq(
      keysIn(h),
      R.visibleItems("live").map((it) => it.key),
    ),
  );
  ST.setPinFavArtists(true);

  // 「だけ」で絞る
  ST.STATES.live.flags.favArtistOnly = true;
  h = draw("live");
  check(
    "「お気に入りアーティストだけ」では見出しも区切りも出ず、該当だけが並ぶ",
    !h.includes("fav-head") &&
      !h.includes("list-divider") &&
      keysIn(h).length === 3,
  );
  ST.STATES.live.flags.favArtistOnly = false;

  // 6件の上限・「ほか◯件を表示」・たたむ
  ST.setFavArtist("Saucy Dog", false);
  const many = [
    "Saucy Dog",
    "Vaundy",
    "超特急",
    "NEXZ",
    "My Hair is Bad",
    "Ayumu Imazu",
    "氣志團",
    "WANIMA",
    "HANA",
    "HANABI",
    "Knosis",
    "東京フィル",
  ];
  many.forEach((n) => ST.setFavArtist(n, true));
  const favN = R.visibleItems("live").filter((it) =>
    A.isFavArtistItem(it),
  ).length;
  h = draw("live");
  const d3 = h.indexOf("list-divider");
  check(
    "先頭の件数が6を超えると、6件までに抑えて「ほか◯件を表示」を出す",
    favN > 6 &&
      keysIn(h.slice(0, d3)).length === 6 &&
      h.includes(`ほか${favN - 6}件を表示`) &&
      h.includes('data-art-act="more"'),
    `お気に入りの公演${favN}件`,
  );
  ST.setArtSecMoreOpen("live", true);
  h = draw("live");
  check(
    "開くと全件が先頭に並ぶ",
    keysIn(h.slice(0, h.indexOf("list-divider"))).length === favN &&
      h.includes("先頭の表示をへらす"),
  );
  ST.setArtSecMoreOpen("live", false);
  ST.setArtSecFolded("live", true);
  h = draw("live");
  check(
    "たたむと先頭のカードを隠す（見出しは残り、「そのほか」は残る）",
    h.includes("fav-head art") &&
      h.includes("ひらく") &&
      keysIn(h).length === R.visibleItems("live").length - favN,
  );
  ST.setArtSecFolded("live", false);

  // 条件で隠れたとき
  ST.STATES.live.q = "存在しない言葉ひるむ";
  h = draw("live");
  check(
    "検索で全部消えると、空表示になる（先頭セクションだけが残る形にはならない）",
    keysIn(h).length === 0,
  );
  ST.STATES.live.q = "";
  ST.STATES.live.q = "エスケープ";
  h = draw("live");
  check(
    "お気に入りの公演が条件で隠れているときは、その旨の注記が出る（一覧には条件に合う公演が残る）",
    h.includes("fav-note") &&
      h.includes("いまの絞り込みに合うものがありません") &&
      h.includes("いまの絞り込みでは0件") &&
      h.includes(`data-key="${keyOf("エスケープ試験")}"`),
  );
  ST.STATES.live.q = "";

  // 予定が無いだけのとき（別タブの人だけを登録）は何も出さない
  resetAll();
  ST.setFavArtist("山田花子", true);
  h = draw("live");
  check(
    "ライブタブに予定が無い人だけを登録しているときは、ライブタブに何も出さない",
    !h.includes("fav-head") && !h.includes("list-divider"),
  );
  const hEv = draw("event");
  check(
    "同じ人がイベントタブの登壇者なら、イベントタブでは先頭に出る",
    hEv.includes('class="fav-head art"') && hEv.includes("1組・1件"),
  );
  const hMv = draw("movie");
  check("映画タブでも先頭に出る", hMv.includes('class="fav-head art"'));
}

/* ================= 6. カードの部品 ================= */
console.log("\n--- カードの部品 ---");
{
  resetAll();
  ST.setFavArtist("Saucy Dog", true);
  const tab = TABS.live;
  const st = ST.STATES.live;
  const card = (title, terms = []) => cardHtml(tab, liveBy(title), st, terms);

  let c = card("Saucy Dog ARENA TOUR");
  check(
    "単独公演にも出演行が出て、人のボタンと名前のボタンがある",
    /<p class="lineup-line">出演：/.test(c) &&
      c.includes('data-artist="Saucy Dog"') &&
      c.includes('data-artist-open="Saucy Dog"'),
  );
  check(
    "登録済みの人のボタンは押された状態で描かれる",
    /data-artist="Saucy Dog" aria-pressed="true"/.test(c),
  );
  check(
    "ラベルは状態で変えない（読み上げが二重に状態を告げないよう aria-pressed に任せる）",
    c.includes('aria-label="Saucy Dogをお気に入りアーティストにする"'),
  );
  check(
    "人のボタンはボタン要素・SVGは装飾（aria-hidden）",
    /<button type="button" class="art-btn"/.test(c) &&
      /person-ico"[^>]*aria-hidden="true"/.test(c),
  );
  check(
    "「なぜ先頭か」の行に人の名前が出る",
    /class="why-line"[^>]*>[\s\S]*why-name">Saucy Dog</.test(c),
  );
  check("「前回から追加」は印が無ければ出ない", !c.includes("new-tag"));

  c = card("共演ライブ");
  const line = (c.match(/<p class="lineup-line">[\s\S]*?<\/p>/) || [""])[0];
  check(
    "共演は4組まで並び、残りは「ほか2組」に畳む",
    (line.match(/class="art-item[ "]/g) || []).length === 4 &&
      line.includes("ほか2組"),
  );
  check(
    "畳んだ人も「くわしく」に全員並ぶ（6組・人のボタンつき）",
    (() => {
      const d = c.slice(c.indexOf('class="art-detail"'));
      return (
        c.includes('class="art-detail"') &&
        [
          "Saucy Dog",
          "Vaundy",
          "超特急",
          "NEXZ",
          "My Hair is Bad",
          "Ayumu Imazu",
        ].every((n) => d.includes(`data-artist="${n}"`))
      );
    })(),
  );
  c = card("Saucy Dog ARENA TOUR");
  check(
    "出演行に全員が出ている公演には、「くわしく」の出演者一覧を出さない",
    !c.includes('class="art-detail"'),
  );

  c = card("FES-1");
  check(
    "フェスは出演行を「全◯組の日程を見る」ボタンだけにする（人のボタンは出演者シートの中）",
    c.includes('class="lineup-btn"') &&
      !(c.match(/<p class="lineup-line">[\s\S]*?<\/p>/) || [""])[0].includes(
        "data-artist=",
      ) &&
      !c.includes('class="art-detail"'),
  );
  check(
    "フェスの「なぜ」の行に、出る日（11/7(土)・11/8(日)）が添う",
    /why-day">11\/7\(土\)・11\/8\(日\)出演</.test(c),
  );

  c = card("U-KNOW PROJECT");
  check(
    "「名前(所属)」の表記は、見えるままの文字で出し、保存する名前は括弧を外した名前",
    c.includes("U-KNOW(東方神起)") && c.includes('data-artist="U-KNOW"'),
  );

  c = card("エスケープ試験");
  check(
    "名前のHTMLは必ずエスケープされる（タグが生えない・属性が壊れない）",
    !c.includes("<img src=x") &&
      c.includes("&lt;img src=x onerror=alert(1)&gt;") &&
      c.includes('data-artist="&lt;img src=x onerror=alert(1)&gt;"'),
  );
  check(
    "引用符・& もエスケープ（属性値の中で切れない）",
    c.includes('data-artist="&quot;引用符&quot;"') &&
      c.includes('data-artist="A&amp;B"'),
  );

  c = card("Saucy Dog ARENA TOUR", ["saucy"]);
  check(
    "検索語に当たった名前はハイライトされる（名前のボタンの中でも）",
    /art-link"[^>]*><mark>/.test(c) || /art-link"[^>]*>[^<]*<mark>/.test(c),
  );

  // 「なぜ」の行: 3人まで・ほか
  resetAll();
  ["Saucy Dog", "Vaundy", "超特急", "NEXZ", "My Hair is Bad"].forEach((n) =>
    ST.setFavArtist(n, true),
  );
  c = card("共演ライブ");
  const why = (c.match(/<p class="why-line">[\s\S]*?<\/p>/) || [""])[0];
  check(
    "「なぜ」の行は3人まで並べて、残りは「ほか◯組」",
    (why.match(/class="why-item"/g) || []).length === 3 &&
      why.includes("ほか2組"),
  );
  check(
    "「なぜ」の行は読み上げ用の前置きを持つ",
    why.includes('class="sr-only">お気に入りアーティスト：'),
  );

  // イベントの登壇者
  setToday("2026-10-20");
  resetAll();
  ST.setFavArtist("Saucy Dog", true);
  const evTab = TABS.event;
  const ec = cardHtml(evTab, evBy("トークイベント"), ST.STATES.event, []);
  const gl = (ec.match(/<p class="guest-line">[\s\S]*?<\/p>/) || [""])[0];
  check(
    "イベントの登壇者にも人のボタンと名前のボタンが付く",
    gl.includes('data-artist="Saucy Dog"') &&
      gl.includes('data-artist-open="山田花子"'),
  );
  const ec5 = cardHtml(evTab, evBy("登壇者5人"), ST.STATES.event, []);
  check(
    "登壇者が4人以上なら、3人＋ほか2名にして、全員を「くわしく」に並べる",
    (ec5.match(/<p class="guest-line">[\s\S]*?<\/p>/) || [""])[0].includes(
      "ほか2名",
    ) &&
      ec5.includes('class="art-detail"') &&
      ec5.slice(ec5.indexOf('class="art-detail"')).includes('data-artist="戊"'),
  );
  check(
    "登壇者の一覧のラベルはタブの語（イベント=出演者）",
    ec5.includes("出演者</span>"),
  );
  const mc = cardHtml(TABS.movie, D.ITEMS.movie[0], ST.STATES.movie, []);
  check(
    "映画の登壇者にも付く（ラベルは登壇）",
    mc.includes('guest-label">登壇') && mc.includes('data-artist="山田花子"'),
  );
}

/* ================= 7. 「前回から追加」 ================= */
console.log("\n--- 前回から追加 ---");
{
  const SEEN = "eventboard.favartseen.v1";
  const T0 = RealDate.parse("2026-10-20T12:00:00+09:00");
  const GAP = A.VISIT_GAP_MS;
  const isNew = (title) => A.isNewSinceVisit(liveBy(title));
  const liveUids = () => D.ITEMS.live.map((it) => it.uid);

  resetAll();
  A.syncSeen("live", T0);
  check(
    "お気に入りが0人の間は、一覧を覚えない（使っていない人の端末を埋めない）",
    !store.has(SEEN) && D.ITEMS.live.every((it) => !A.isNewSinceVisit(it)),
  );
  ST.setFavArtist("Saucy Dog", true);
  A.reconcileSeen(T0);
  const rec0 = JSON.parse(store.get(SEEN) || "{}");
  check(
    "最初の1人を登録した時点から覚え始める（読み込み済みのタブだけ）",
    rec0.live &&
      rec0.event &&
      rec0.movie &&
      rec0.live.cur.length === D.ITEMS.live.length,
  );
  check(
    "覚え始めた直後は、何も新着にしない",
    D.ITEMS.live.every((it) => !A.isNewSinceVisit(it)),
  );

  // 初回の読み込み（記録なし）は、何も新着にしない
  store.clear();
  A.syncSeen("live", T0);
  check(
    "比べる前回が無い初回の読み込みは、何も新着にしない",
    D.ITEMS.live.every((it) => !A.isNewSinceVisit(it)) && store.has(SEEN),
  );

  // 新しい行が増えた状態を作る: 記録から2行ぶんの uid を抜く
  const dropUids = [liveBy("共演ライブ").uid, liveBy("Knosis ONE").uid];
  const seeded = (at, base, cur) =>
    store.set(SEEN, JSON.stringify({ live: { base, cur, at } }));
  const without = liveUids().filter((u) => !dropUids.includes(u));
  A.reconcileSeen(T0);
  seeded(T0 - 2 * GAP, without, without); // 前回の訪問は2区切り前
  A.syncSeen("live", T0);
  check(
    "新しい訪問では、前回の訪問で無かった行が新着になる",
    isNew("共演ライブ") &&
      isNew("Knosis ONE") &&
      !isNew("Saucy Dog ARENA TOUR"),
  );
  check(
    "新着の行は「前回から追加」の印が、「なぜ」の行の中に出る（バッジ列ではない）",
    (() => {
      const c = cardHtml(TABS.live, liveBy("共演ライブ"), ST.STATES.live, []);
      const why = (c.match(/<p class="why-line">[\s\S]*?<\/p>/) || [""])[0];
      const badge = (c.match(
        /<span class="badge-stack">[\s\S]*?<\/span>\s*<\/div>/,
      ) || [""])[0];
      return (
        why.includes('class="new-tag">前回から追加</span>') &&
        !badge.includes("前回から追加")
      );
    })(),
  );
  const savedRec = JSON.parse(store.get(SEEN));
  check(
    "覚えている一覧は、読み込んだ一覧に更新され、比べる相手は前回の訪問の一覧になる",
    savedRec.live.cur.length === D.ITEMS.live.length &&
      savedRec.live.base.length === without.length,
  );
  A.syncSeen("live", T0 + 60 * 1000);
  check(
    "訪問の区切りの中で読み直しても、印は消えない（自動更新の読み直しで消えない）",
    isNew("共演ライブ") && isNew("Knosis ONE"),
  );
  A.syncSeen("live", T0 + 60 * 1000 + GAP - 1000);
  check(
    "区切りに満たない間隔が続くかぎり、同じ訪問として扱う（訪問は延びる）",
    isNew("共演ライブ"),
  );
  A.syncSeen("live", T0 + 60 * 1000 + 2 * GAP + 5000);
  check(
    "区切りを超えて開き直すと、前回の訪問で見せた行は新着でなくなる",
    !isNew("共演ライブ") && !isNew("Knosis ONE"),
  );

  // 一括入れ替わりでは印を付けない
  seeded(T0 - 2 * GAP, ["old1", "old2", "old3"], ["old1", "old2", "old3"]);
  A.syncSeen("live", T0);
  check(
    "一覧の大半が「新しい」ときは、前回と比べられないとみなして印を付けない",
    D.ITEMS.live.every((it) => !A.isNewSinceVisit(it)),
  );

  // 壊れた記録・未来の時刻
  store.set(SEEN, "{壊れ");
  A.syncSeen("live", T0);
  check(
    "壊れた記録でも落ちず、初回として扱う",
    D.ITEMS.live.every((it) => !A.isNewSinceVisit(it)) &&
      !!JSON.parse(store.get(SEEN)).live,
  );
  store.set(SEEN, JSON.stringify({ live: { base: "x", cur: 3, at: "now" } }));
  A.syncSeen("live", T0);
  check(
    "型の崩れた記録も初回として扱う",
    D.ITEMS.live.every((it) => !A.isNewSinceVisit(it)),
  );
  seeded(T0 + 5 * GAP, without, without); // 時計が戻った（記録のほうが未来）
  A.syncSeen("live", T0);
  check(
    "記録の時刻が未来（端末の時計が戻った）でも、新しい訪問として比べる",
    isNew("共演ライブ"),
  );

  // 保存できない
  storeFails = true;
  A.syncSeen("live", T0);
  check("保存領域が使えなくても落ちない", true);
  storeFails = false;

  // 空の読み込みで前回を消さない
  A.reconcileSeen(T0);
  const keep = store.get(SEEN);
  const saveItems = D.ITEMS.live;
  D.ITEMS.live = [];
  A.syncSeen("live", T0 + 10 * GAP);
  D.ITEMS.live = saveItems;
  check(
    "空の読み込みでは、覚えている前回を書き換えない",
    store.get(SEEN) === keep,
  );

  // 0人に戻す
  ST.setFavArtist("Saucy Dog", false);
  A.reconcileSeen(T0);
  check(
    "0人に戻したら、覚えている一覧を全部捨てる",
    !store.has(SEEN) && D.ITEMS.live.every((it) => !A.isNewSinceVisit(it)),
  );

  // 区間が未読み込みのタブを覚えない
  resetAll();
  ST.setFavArtist("Saucy Dog", true);
  const prevState = D.LOAD.movie.state;
  D.LOAD.movie.state = "idle";
  store.clear();
  A.reconcileSeen(T0);
  const rec = JSON.parse(store.get(SEEN) || "{}");
  D.LOAD.movie.state = prevState;
  check(
    "まだ読み込んでいないタブは、覚えない（空の一覧を「前回」にしない）",
    !!rec.live && !!rec.event && !rec.movie,
  );
}

/* ================= 8. 候補（手入力） ================= */
console.log("\n--- 手入力の候補 ---");
{
  resetAll();
  const known = A.knownArtists((it) => !F.hasEnded(it));
  const get = (n) => known.find((k) => k.key === U.artistKey(n));
  check(
    "データにある出演者（artists・ラインナップ・登壇者）が名前ごとに1件",
    !!get("Saucy Dog") &&
      !!get("10-FEET") &&
      !!get("山田花子") &&
      new Set(known.map((k) => k.key)).size === known.length,
  );
  check(
    "これから出る公演の件数（終わった公演は数えない）",
    get("Saucy Dog").count === 4, // ワンマン・共演・フェス・トークイベント（終わったツアーは除く）
    String(get("Saucy Dog").count),
  );
  check(
    "「名前(所属)」は名前で数える",
    !!get("U-KNOW") && get("U-KNOW").name === "U-KNOW",
  );
  check("表記ゆれ（Knosis/knosis）は1件にまとまる", get("knosis").count === 2);
}

/* ================= 8b. 手入力の動き・案内・カードの導線 ================= */
console.log("\n--- 手入力の動き・案内・カードの導線 ---");
{
  resetAll();
  const known = A.knownArtists((it) => !F.hasEnded(it));
  const isFav = ST.isFavArtist;
  const sug = (q, k = known) =>
    A.suggestArtists(q, k, isFav).map((x) => x.name);

  check(
    "候補: 大文字小文字・全角半角を問わず当たる",
    eq(sug("saucy"), ["Saucy Dog"]) &&
      eq(sug("SAUCY"), ["Saucy Dog"]) &&
      eq(sug("ｓａｕｃｙ"), ["Saucy Dog"]),
    JSON.stringify(sug("saucy")),
  );
  check(
    "候補: 空・空白だけでは何も出さない",
    eq(sug(""), []) && eq(sug("   "), []),
  );
  const mk = (name, count) => ({ name, key: U.artistKey(name), count });
  check(
    "候補: 前方一致が先、同じなら予定の多い順、最後は五十音",
    eq(sug("ab", [mk("XAB", 5), mk("AB", 1), mk("ABC", 2)]), [
      "ABC",
      "AB",
      "XAB",
    ]),
    JSON.stringify(sug("ab", [mk("XAB", 5), mk("AB", 1), mk("ABC", 2)])),
  );
  const many = Array.from({ length: 12 }, (_, i) => mk(`Ax${i}`, 1));
  check(
    "候補: 既定は8件まで、limit で絞れる",
    sug("ax", many).length === 8 &&
      A.suggestArtists("ax", many, isFav, 1).length === 1,
  );
  ST.setFavArtist("Saucy Dog", true);
  check("候補: 登録済みの人は出さない", !sug("saucy").includes("Saucy Dog"));
  ST.setFavArtist("Saucy Dog", false);

  const plan = (raw) => A.planAdd(raw, known, isFav);
  check(
    "Enter: 空・空白だけなら何も登録しない",
    plan("").kind === "empty" && plan("  　 ").kind === "empty",
  );
  check(
    "Enter: 長すぎる名前は登録しない",
    plan("あ".repeat(ST.FAV_ARTIST_NAME_MAX + 1)).kind === "invalid",
  );
  check(
    "Enter: データにある名前と同じなら、データの表記で登録する",
    eq(plan("saucy dog"), {
      kind: "add",
      name: "Saucy Dog",
      typed: "saucy dog",
    }),
    JSON.stringify(plan("saucy dog")),
  );
  check(
    "Enter: 括弧の補足つきの打ち方でも、同じ人として登録する",
    plan("Saucy Dog(ロックバンド)").name === "Saucy Dog",
  );
  check(
    "Enter: 打ちかけの文字は、先頭の候補を登録する（打ちかけのまま登録しない）",
    plan("sauc").kind === "add" && plan("sauc").name === "Saucy Dog",
    JSON.stringify(plan("sauc")),
  );
  check(
    "Enter: データに無い名前は登録せず、「のまま登録」を求める",
    eq(plan("存在しない仮のアーティスト"), {
      kind: "raw",
      typed: "存在しない仮のアーティスト",
    }),
  );
  ST.setFavArtist("Saucy Dog", true);
  check(
    "Enter: 登録済みの人と完全に同じなら add（画面側が「すでに登録」と伝える）",
    plan("Saucy Dog").kind === "add",
  );
  check(
    "Enter: 候補が登録済みの人だけなら登録せず「のまま登録」を求める",
    plan("sauc").kind === "raw",
    JSON.stringify(plan("sauc")),
  );
  ST.setFavArtist("Saucy Dog", false);

  /* ---- 使い方の案内（1度だけ） ---- */
  resetAll();
  check("案内: 初期状態は未読", !ST.isArtHintSeen());
  ST.setFavArtist("  ", true);
  ST.setFavArtist("あ".repeat(ST.FAV_ARTIST_NAME_MAX + 1), true);
  check("案内: 登録できなかった操作では既読にならない", !ST.isArtHintSeen());
  ST.setFavArtist("Saucy Dog", true);
  check(
    "案内: 登録すると既読になり、保存される",
    ST.isArtHintSeen() && store.get("eventboard.arthint.v1") === "1",
  );
  ST.setFavArtist("Saucy Dog", false);
  check("案内: 外しても既読のまま", ST.isArtHintSeen());
  ST.loadFavArtistView();
  check("案内: 読み直しても既読（保存から読む）", ST.isArtHintSeen());
  store.clear();
  ST.loadFavArtistView();
  check("案内: 保存が無ければ未読", !ST.isArtHintSeen());
  storeFails = true;
  ST.loadFavArtistView();
  let threw = false;
  try {
    ST.markArtHintSeen();
  } catch {
    threw = true;
  }
  check(
    "案内: 保存できない端末でも落ちず、そのページの間は既読にできる",
    !threw && ST.isArtHintSeen(),
  );
  storeFails = false;

  /* ---- 一覧の先頭の案内 ---- */
  resetAll();
  const draw = (tabKey) => {
    ST.setActiveTabKey(tabKey);
    R.renderList();
    return els.get(TABS[tabKey].listId).innerHTML;
  };
  let h = draw("live");
  const hintAt = h.indexOf('<div class="art-hint"');
  check(
    "案内: 未登録・未読なら一覧の先頭（最初のカードより前）に1つ出る",
    hintAt === 0 &&
      h.split('class="art-hint"').length === 2 &&
      hintAt < h.indexOf('<article class="card"'),
    String(hintAt),
  );
  check(
    "案内: 閉じるボタンがある",
    h.includes('data-art-hint="close"') && h.includes("人のマーク"),
  );
  ST.setFavArtist("Saucy Dog", true);
  check("案内: 登録したら出ない", !draw("live").includes("art-hint"));
  resetAll();
  ST.markArtHintSeen();
  check("案内: 既読なら出ない", !draw("live").includes("art-hint"));
  resetAll();
  const bare = D.ITEMS.live.find(
    (it) => !F.hasEnded(it) && A.performersOf(it).size === 0 && !it.lineupId,
  );
  if (bare) {
    ST.STATES.live.q = bare.title;
    h = draw("live");
    check(
      "案内: 人のボタンを持つ行が1つも無い一覧には出ない（指す相手が無い）",
      !h.includes("art-hint") && h.includes(`data-key="${bare.key}"`),
    );
    ST.STATES.live.q = "";
  } else check("案内: 出演者の無い行がデータに無い", false);

  /* ---- カードの導線 ---- */
  resetAll();
  const tab = TABS.live;
  const st = ST.STATES.live;
  const card = (title, members) =>
    cardHtml(tab, liveBy(title), st, [], members);
  ST.setFavArtist("Saucy Dog", true);
  let c = card("共演ライブ");
  check(
    "登録済みの人の名前だけに is-fav が付く（共演の他の人には付かない）",
    // 出演行と「くわしく」の全員の一覧の2か所に同じ人が出る。印が付くのはどちらもその人だけ
    (() => {
      const fav = [
        ...c.matchAll(
          /class="art-item is-fav"><button[^>]*data-artist="([^"]+)"/g,
        ),
      ].map((m) => m[1]);
      return (
        (c.match(/class="art-item is-fav"/g) || []).length === 2 &&
        fav.length === 2 &&
        fav.every((n) => n === "Saucy Dog")
      );
    })(),
  );
  const key = liveBy("共演ライブ").key;
  check(
    "「ほか◯組」は押せるボタンで、「くわしく」の本体を指す",
    /<button type="button" class="art-more" data-more-open="1" aria-controls="desc-[^"]+"[^>]*>ほか2組 ▾<\/button>/.test(
      c,
    ) &&
      c.includes(`aria-controls="desc-${key}"`) &&
      c.includes(`id="desc-${key}"`),
  );
  check(
    "ボタンの案内文が、押すと何が起きるかを言う",
    c.includes('aria-label="ほか2組を一覧で見る"'),
  );
  check(
    "「くわしく」の中に全員の一覧がある（ボタンの行き先が実在する）",
    c.includes('class="art-detail"'),
  );
  const other = D.ITEMS.live.find((it) => it !== liveBy("共演ライブ"));
  c = card("共演ライブ", [liveBy("共演ライブ"), other]);
  check(
    "まとめたカード（同時開催）では、一覧を持たないので文字のままにする",
    !c.includes("art-more") && c.includes("ほか2組"),
  );
  c = card("Saucy Dog ARENA TOUR");
  check(
    "出演が収まっているカードには「ほか」のボタンが出ない",
    !c.includes("art-more"),
  );
}

/* ================= 9. 実データで画面の出し分けを見る ================= */
console.log("\n--- 実データ ---");
{
  for (const k of Object.keys(served)) delete served[k];
  freeze(new RealDate().toISOString().slice(0, 10));
  D.refreshToday();
  await Promise.all([D.loadSpots(), D.loadTheaters(), D.loadVenues()]);
  for (const k of ["event", "movie", "live"]) await D.loadTab(k);
  resetAll();

  const draw = (tabKey) => {
    ST.setActiveTabKey(tabKey);
    R.renderList();
    return els.get(TABS[tabKey].listId).innerHTML;
  };
  const keysIn = (h) =>
    [...h.matchAll(/<article class="card" data-key="([^"]+)"/g)].map(
      (x) => x[1],
    );

  // 実データの出演者名は、1つ残らず登録できる（長すぎる・空の名前で、ボタンが効かない人が出ない）
  {
    const bad = [];
    for (const k of ["event", "movie", "live"])
      D.ITEMS[k].forEach((it) =>
        A.performersOf(it).forEach((name) => {
          if (!ST.cleanArtistName(name)) bad.push(name);
        }),
      );
    check(
      "実データの出演者名はすべて登録できる（名前の長さの上限に掛からない）",
      bad.length === 0,
      bad.slice(0, 3).join(" / "),
    );
  }

  // 出演者の多い人を、実データから選ぶ
  const tally = new Map();
  D.ITEMS.live.forEach((it) => {
    if (F.hasEnded(it)) return;
    A.performersOf(it).forEach((name, k) => {
      const e = tally.get(k) || { name: U.artistHead(name), n: 0 };
      e.n++;
      tally.set(k, e);
    });
  });
  const top = [...tally.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  check(
    "実データのライブに、登録できる出演者が複数いる",
    top.length >= 4,
    `${top.length}人`,
  );

  const target = top.slice(0, 3);
  target.forEach((t) => ST.setFavArtist(t.name, true));
  const expected = new Set(
    D.ITEMS.live
      .filter(
        (it) =>
          !F.hasEnded(it) &&
          target.some((t) => A.performersOf(it).has(U.artistKey(t.name))),
      )
      .map((it) => it.key),
  );
  const h = draw("live");
  const dAt = h.indexOf("list-divider");
  const before = new Set(keysIn(h.slice(0, dAt === -1 ? h.length : dAt)));
  const capped = Math.max(0, expected.size - 6);
  check(
    "先頭セクションのカードは、同じデータから数えた「出演する公演」と一致する（上限6件まで）",
    h.includes('class="fav-head art"') &&
      [...before].every((k) => expected.has(k)) &&
      before.size === Math.min(6, expected.size),
    `${before.size}/${expected.size}`,
  );
  const ks = keysIn(h);
  check(
    "全カードが1回ずつ出る（上限で畳んだぶんを除く）",
    new Set(ks).size === ks.length &&
      ks.length === R.visibleItems("live").length - capped,
    `${ks.length}/${R.visibleItems("live").length}`,
  );
  check(
    "実データのカードでも、人のボタンのHTMLが壊れていない（属性の引用符が閉じている）",
    (() => {
      const buttons =
        h.match(/<button type="button" class="art-btn"[^>]*>/g) || [];
      return (
        buttons.length > 0 &&
        buttons.every((b) => (b.match(/"/g) || []).length % 2 === 0)
      );
    })(),
  );

  // 絞り込みとの組み合わせでも壊れない
  const patterns = [
    { name: "検索語あり", set: (s) => (s.q = "ライブ") },
    { name: "新着順", set: (s) => (s.sortBy = "announced") },
    {
      name: "日程の範囲",
      set: (s) => {
        s.rangeStart = "2026-11-01";
        s.rangeEnd = "2026-11-30";
      },
    },
    { name: "都県", set: (s) => (s.pref = "tokyo") },
    { name: "終了も表示", set: (s) => (s.flags.showEnded = true) },
    {
      name: "お気に入りアーティストだけ",
      set: (s) => (s.flags.favArtistOnly = true),
    },
    {
      name: "お気に入りスポットだけ",
      set: (s) => (s.flags.favSpotOnly = true),
    },
  ];
  for (const p of patterns) {
    ST.resetState("live");
    p.set(ST.STATES.live);
    const hh = draw("live");
    const kk = keysIn(hh);
    const vis = R.visibleItems("live");
    check(
      `${p.name}: 重複なし・出たカードはどれも絞り込みに合う`,
      new Set(kk).size === kk.length &&
        kk.every((k) => vis.some((it) => it.key === k)),
      `${kk.length}/${vis.length}`,
    );
  }
  ST.resetState("live");

  // 3タブとも、お気に入りがあっても落ちない
  for (const k of ["event", "movie", "live"]) {
    let ok = true;
    try {
      draw(k);
      F.flagCounts(TABS[k], ST.STATES[k], D.ITEMS[k]);
    } catch (e) {
      ok = false;
    }
    check(`${k}: お気に入りがあっても一覧とチップの集計が落ちない`, ok);
  }

  // 総当たり: 乱数で作った「お気に入り・並びの設定・絞り込み」の組み合わせを、テスト内に書いた
  // 別実装（仕様そのまま）と突き合わせる。一覧に出るカードの並びが、仕様と1枚も違わないこと。
  //   先頭 = お気に入りアーティスト → お気に入りスポット → そのほか。両方に当たる公演は上に1回だけ。
  //   各セクションは6件まで（「ほか◯件を表示」で全部）、たたむと隠れる。「だけ」で絞ったときは見出しなし
  {
    let seed = 20261025;
    const rnd = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (arr, n) => {
      const a = arr.slice();
      const out = [];
      while (out.length < n && a.length)
        out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]);
      return out;
    };
    const pools = {};
    const spotPool = {};
    for (const k of ["event", "movie", "live"]) {
      const cnt = new Map();
      D.ITEMS[k].forEach((it) =>
        A.performersOf(it).forEach((name) =>
          cnt.set(name, (cnt.get(name) || 0) + 1),
        ),
      );
      pools[k] = [...cnt.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 60)
        .map((x) => x[0]);
      const sp = new Map();
      D.ITEMS[k].forEach((it) =>
        S.spotsOfItem(it).forEach((e) =>
          sp.set(e.name, (sp.get(e.name) || 0) + 1),
        ),
      );
      spotPool[k] = [...sp.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map((x) => x[0]);
    }
    const expectedKeys = (tabKey, st) => {
      const entries = F.mergeSimultaneous(R.visibleItems(tabKey));
      const artOn =
        ST.favArtistCount() > 0 &&
        (ST.pinFavArtists() || st.flags.favArtistOnly);
      const spotOn =
        ST.favSpotCount() > 0 && (ST.pinFavSpots() || st.flags.favSpotOnly);
      if (!artOn && !spotOn) return entries.map((e) => e.rep.key);
      if (st.flags.favSpotOnly || st.flags.favArtistOnly)
        return entries.map((e) => e.rep.key);
      const art = [];
      const fav = [];
      const rest = [];
      entries.forEach((e) => {
        if (artOn && e.members.some((m) => A.favArtistsOf(m).length > 0))
          art.push(e);
        else if (
          spotOn &&
          e.members.some((m) =>
            S.spotsOfItem(m).some((sp) => ST.isFavSpot(sp.name)),
          )
        )
          fav.push(e);
        else rest.push(e);
      });
      const cap = (arr, folded, more) =>
        folded ? [] : more ? arr : arr.slice(0, 6);
      return [
        ...cap(art, ST.isArtSecFolded(tabKey), ST.isArtSecMoreOpen(tabKey)),
        ...cap(fav, ST.isFavSecFolded(tabKey), ST.isFavSecMoreOpen(tabKey)),
        ...rest,
      ].map((e) => e.rep.key);
    };
    let mismatches = 0;
    let first = "";
    let nonEmptySections = 0;
    const ROUNDS = 240;
    for (let i = 0; i < ROUNDS; i++) {
      const tabKey = ["event", "movie", "live"][Math.floor(rnd() * 3)];
      resetAll();
      pick(pools[tabKey], Math.floor(rnd() * 6)).forEach((n) =>
        ST.setFavArtist(n, true),
      );
      // 別のタブの人も混ぜる（このタブに予定が無い人がいても崩れない）
      pick(
        pools[["event", "movie", "live"][Math.floor(rnd() * 3)]],
        Math.floor(rnd() * 3),
      ).forEach((n) => ST.setFavArtist(n, true));
      pick(spotPool[tabKey], Math.floor(rnd() * 4)).forEach((n) =>
        ST.setFavSpot(n, true),
      );
      ST.setPinFavArtists(rnd() < 0.8);
      ST.setPinFavSpots(rnd() < 0.8);
      ST.setArtSecFolded(tabKey, rnd() < 0.2);
      ST.setFavSecFolded(tabKey, rnd() < 0.2);
      ST.setArtSecMoreOpen(tabKey, rnd() < 0.4);
      ST.setFavSecMoreOpen(tabKey, rnd() < 0.4);
      const st = ST.STATES[tabKey];
      if (rnd() < 0.25)
        st.q = ["ライブ", "展", "東京", "feat"][Math.floor(rnd() * 4)];
      if (rnd() < 0.2)
        st.pref = ["tokyo", "kanagawa", "chiba", "saitama"][
          Math.floor(rnd() * 4)
        ];
      if (rnd() < 0.15) st.flags.showEnded = true;
      if (rnd() < 0.15) st.flags.favArtistOnly = true;
      if (rnd() < 0.1) st.flags.favSpotOnly = true;
      if (rnd() < 0.15) st.sortBy = "announced";
      if (rnd() < 0.2) st.flags.newOnly = true;
      const got = keysIn(draw(tabKey));
      const want = expectedKeys(tabKey, st);
      if (ST.favArtistCount() > 0 && want.length) nonEmptySections++;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        mismatches++;
        if (!first)
          first = `${tabKey} 登録${ST.favArtistNames().join("/")} 期待${want.length}枚 実際${got.length}枚`;
      }
    }
    check(
      `乱数${ROUNDS}通り（3タブ×お気に入り×並びの設定×絞り込み）で、一覧のカードの並びが仕様と1枚も違わない`,
      mismatches === 0 && nonEmptySections > ROUNDS * 0.3,
      mismatches ? first : `${nonEmptySections}通りでお気に入りの公演が出た`,
    );
    resetAll();
  }

  // 重さ: 200人を登録しても、一覧の描画とチップの集計が現実的な時間で終わる
  resetAll();
  const everyone = [...tally.values()].slice(0, ST.FAV_ARTIST_MAX);
  everyone.forEach((t) => ST.setFavArtist(t.name, true));
  const t0 = process.hrtime.bigint();
  draw("live");
  F.flagCounts(TABS.live, ST.STATES.live, D.ITEMS.live);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check(
    `${ST.favArtistCount()}人を登録しても、一覧とチップの集計が3秒以内に終わる`,
    ms < 3000,
    `${ms.toFixed(0)}ms`,
  );
  const t1 = process.hrtime.bigint();
  draw("live");
  F.flagCounts(TABS.live, ST.STATES.live, D.ITEMS.live);
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
  check(
    `2回目（覚えた答えを使う）も3秒以内に終わる`,
    ms2 < 3000,
    `${ms2.toFixed(0)}ms`,
  );
}

console.log(
  failures.length
    ? `\n失敗 ${failures.length}件:\n  - ${failures.join("\n  - ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
