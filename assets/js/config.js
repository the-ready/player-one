/* 表示のための定義テーブルと、3つのタブの宣言。
   「イベント／映画／ライブ・フェスで何が違うのか」をここ1か所のデータに寄せることで、
   描画・絞り込み・地図・会場ピッカーの実装を1本に統一できるようにしている。
   タブに機能を足すときは、原則としてこのファイルの宣言だけを触る。 */

import { txt, num, int, list, bool } from "./util.js";

/* ---------- 共有の見た目テーブル ---------- */

export const NEUTRAL_BADGE = { c: "var(--ink)", bg: "#EFEFF2" };
export const NEUTRAL_CAT = { label: "その他", c: "var(--ink)", t: "#EFEFF2" };

export const CATS = {
  art: { label: "展示・アート", c: "var(--grape)" },
  exp: { label: "体験・アクティビティ", c: "var(--sunny)" },
  food: { label: "グルメ", c: "var(--tangerine)" },
  ent: { label: "アニメ・エンタメ", c: "var(--pink)" },
  fam: { label: "ファミリー・キッズ", c: "var(--lime)" },
  tech: { label: "IT・カンファレンス", c: "var(--sky)" },
  sport: { label: "スポーツ", c: "var(--coral)" },
  fest: { label: "祭り・花火", c: "var(--teal)" },
};

export const MOVIE_GENRES = {
  anime: { label: "アニメ", c: "var(--pink)" },
  "jp-live": { label: "邦画(実写)", c: "var(--tangerine)" },
  foreign: { label: "洋画", c: "var(--sky)" },
  doc: { label: "ドキュメンタリー", c: "var(--lime)" },
  fam: { label: "ファミリー・キッズ", c: "var(--sunny)" },
  tokusatsu: { label: "特撮・ヒーロー", c: "var(--coral)" },
  music: { label: "音楽・ライブ映画", c: "var(--grape)" },
};
export const SCREENING_TYPES = {
  new: { label: "新作公開", c: "var(--pink)" },
  revival: { label: "名画座・リバイバル", c: "var(--grape)" },
  outdoor: { label: "野外上映・ドライブイン", c: "var(--teal)" },
  special: { label: "特別上映", c: "var(--sunny)" },
  festival: { label: "映画祭", c: "var(--coral)" },
};

// ライブ・フェス。ジャンル(genre)と公演形態(live_type)を直交する2軸に分けるのは
// 映画の「ジャンル×上映形態」と同じ理由で、同じロックバンドでもワンマンと
// 野外フェスでは体験がまったく違うため。
export const LIVE_GENRES = {
  rock: { label: "ロック・バンド", c: "var(--coral)" },
  pop: { label: "J-POP・ポップス", c: "var(--pink)" },
  idol: { label: "アイドル", c: "var(--tangerine)" },
  kpop: { label: "K-POP・アジア", c: "var(--grape)" },
  hiphop: { label: "ヒップホップ・R&B", c: "var(--ink)" },
  dance: { label: "ダンス・EDM", c: "var(--sky)" },
  jazz: { label: "ジャズ・ソウル", c: "var(--sunny)" },
  classical: { label: "クラシック", c: "var(--teal)" },
  anime: { label: "アニメ・ゲーム", c: "var(--lime)" },
  other: { label: "その他・多ジャンル", c: "var(--text-soft)" },
};
export const LIVE_TYPES = {
  fes: { label: "音楽フェス", c: "var(--teal)" },
  oneman: { label: "ワンマン・ツアー", c: "var(--pink)" },
  event: { label: "対バン・イベント", c: "var(--grape)" },
  classic: { label: "クラシック公演", c: "var(--sky)" },
  free: { label: "入場無料", c: "var(--lime)" },
};

/* 開催状況のバッジ。**並び順がそのまま rank（並べ替えの優先度）になる**ので、
   「いま行ける順」に並べておくこと。ラベルは schedule.js が日付から毎回選ぶ。 */
export const EVENT_STATUS_STYLE = {
  本日開催: { c: "#fff", bg: "var(--coral)" },
  本日予備日: { c: "#fff", bg: "var(--tangerine)" },
  まもなく開催: { c: "#fff", bg: "var(--sunny)" },
  開催中: { c: "#fff", bg: "var(--grape)" },
  本日は休み: { c: "var(--ink)", bg: "var(--sunny-tint)" },
  発売中: { c: "#fff", bg: "var(--sky)" },
  通年予約可: { c: "var(--ink)", bg: "#EFEFF2" },
  終了: { c: "var(--text-soft)", bg: "#E6E6EA" },
};
export const MOVIE_STATUS_STYLE = {
  本日が最終上映: { c: "#fff", bg: "var(--coral)" },
  本日予備日: { c: "#fff", bg: "var(--tangerine)" },
  まもなく公開: { c: "#fff", bg: "var(--sunny)" },
  上映中: { c: "#fff", bg: "var(--grape)" },
  本日は上映なし: { c: "var(--ink)", bg: "var(--sunny-tint)" },
  前売り券発売中: { c: "#fff", bg: "var(--sky)" },
  上映終了: { c: "var(--text-soft)", bg: "#E6E6EA" },
};
export const LIVE_STATUS_STYLE = {
  本日開催: { c: "#fff", bg: "var(--coral)" },
  本日予備日: { c: "#fff", bg: "var(--tangerine)" },
  まもなく開催: { c: "#fff", bg: "var(--sunny)" },
  開催中: { c: "#fff", bg: "var(--grape)" },
  本日は公演なし: { c: "var(--ink)", bg: "var(--sunny-tint)" },
  公演予定: { c: "#fff", bg: "var(--sky)" },
  終了: { c: "var(--text-soft)", bg: "#E6E6EA" },
};

/* 日程から求めた「いまどの段階か」（schedule.js の schedulePhase が返す）を、
   タブごとの言い回しに割り当てる表。CSVに書かれた status ではなく**これ**が
   画面に出るので、データを差し替えなくても日付をまたげば表示が変わる。

     ended   … 終了日を過ぎた
     backup  … 今日が予備日（本開催が流れていれば今日やる）
     last    … 今日が最終日（単日開催なら「今日」そのもの）
     opening … 今日が初日で、まだ続く
     ongoing … 会期の途中
     gap     … 会期の中だが、今日は開催日でない（`dates` を持つ飛び日程だけ）
     openrun … 始まっているが終了日が未定
     soon    … 開始まで SOON_DAYS 日以内
     far     … それより先 */
export const STATUS_BY_PHASE = {
  event: {
    ended: "終了",
    backup: "本日予備日",
    last: "本日開催",
    opening: "開催中",
    ongoing: "開催中",
    gap: "本日は休み",
    openrun: "開催中",
    soon: "まもなく開催",
    far: "発売中",
  },
  movie: {
    ended: "上映終了",
    backup: "本日予備日",
    last: "本日が最終上映",
    opening: "上映中",
    ongoing: "上映中",
    gap: "本日は上映なし",
    openrun: "上映中",
    soon: "まもなく公開",
    far: "前売り券発売中",
  },
  // 複数日開催のフェスは初日と最終日を「本日開催」、中日を「開催中」と呼び分ける。
  live: {
    ended: "終了",
    backup: "本日予備日",
    last: "本日開催",
    opening: "本日開催",
    ongoing: "開催中",
    gap: "本日は公演なし",
    openrun: "開催中",
    soon: "まもなく開催",
    far: "公演予定",
  },
};

// 「まもなく」と呼ぶ範囲。収集スキルの rank の定義（2週間以内）に合わせてある。
export const SOON_DAYS = 14;

/* 日程欄に出す時刻の呼び方。組み立ての規則（`開場◯／開演◯`）は3タブで同じで、
   語だけがタブごとに違う。 */
export const TIME_WORDS = {
  event: { open: "開場", start: "開始" },
  movie: { open: "開場", start: "上映" },
  live: { open: "開場", start: "開演" },
};

// 会場マスターの種別。エリアpopoverの会場ピッカーで候補を絞るのに使う。
export const VENUE_KINDS = {
  dome: "ドーム・スタジアム",
  arena: "アリーナ",
  hall: "ホール",
  livehouse: "ライブハウス",
  outdoor: "野外・フェス会場",
};
// 映画の劇場ピッカー用。theaters.csv に載っているチェーンかどうかで二分する。
export const THEATER_KINDS = {
  chain: "シネコンチェーン",
  single: "名画座・特設会場",
};

export const PREFS = [
  { key: "tokyo", label: "東京都" },
  { key: "kanagawa", label: "神奈川県" },
  { key: "saitama", label: "埼玉県" },
  { key: "chiba", label: "千葉県" },
  { key: "ibaraki", label: "茨城県" },
  { key: "tochigi", label: "栃木県" },
  { key: "gunma", label: "群馬県" },
  { key: "other", label: "関東以外" },
];

export const PRESETS = [
  { key: "today", label: "今日" },
  { key: "weekend", label: "今週末" },
  { key: "7d", label: "1週間" },
  { key: "month", label: "今月" },
  { key: "3m", label: "3ヶ月" },
];

// 受付が閉じていることを表す語（onsale_label に入りうる値）。
export const CLOSED_ONSALE = ["SOLD OUT", "受付終了", "販売終了", "完売"];

// rank 未設定の行が rank 付きの行より前に来ないよう、十分大きい既定値に寄せる。
export const RANK_FALLBACK = Number.MAX_SAFE_INTEGER;

// カード上部に出す出演者の最大数（ライブ）。
export const LINEUP_VISIBLE = 4;
// 会場モーダルに並べる「これからの予定」の最大件数。
export const PLACE_UPCOMING_MAX = 8;

export const DEFAULT_CENTER = [35.6812, 139.7671]; // 東京駅

/* ---------- 表引き（未知の値でも落ちない） ---------- */
export const catMeta = (k) => CATS[k] || NEUTRAL_CAT;
export const tableMeta = (tbl, k) => tbl[k] || { label: k, c: "var(--ink)" };
export const statusMeta = (tbl, k) => tbl[k] || NEUTRAL_BADGE;

/* ---------- CSVの列マッピング ----------
   { 出力プロパティ: [CSVの列名, 変換関数] }。
   3タブで意味が同じ列は同じプロパティ名にそろえてあるので、
   日程・地図・距離・受付期間・お気に入りなどの処理を1本で書ける。 */

// 3タブに共通で入る列。ここに足せば3タブすべてで使えるようになる。
const COMMON_COLUMNS = {
  id: ["id", int],
  title: ["title", txt],
  kana: ["kana", txt],
  area: ["area", txt],
  pref: ["pref", txt],
  endDate: ["end_date", txt],
  // 日程の構造化列。表示文字列も開催ステータスもここから毎回組み立てる（schedule.js）。
  // date だけは例外で、ISOの日付に落とせない日程を書き残すための自由記述。
  date: ["date", txt],
  dates: ["dates", list], // 飛び日程の実開催日（連続した会期なら空）
  openTime: ["open_time", txt],
  startTime: ["start_time", txt],
  endTime: ["end_time", txt],
  dateNote: ["date_note", txt],
  // 予備日（雨天順延の候補日）。会期には含めない——本開催で終わればこの日は使われない。
  // カードの日付欄ではなく「くわしく」の中に出す。
  backupDate: ["backup_date", list],
  // status / rank は日付から計算する。CSVの値は「日付を持たない行」の予備でしかない
  // ので、そのまま status / rank と名乗らせない（data.js で同名のゲッタを生やす）。
  csvStatus: ["status", txt],
  csvRank: ["rank", int],
  announcedDate: ["announced_date", txt],
  isAdditional: ["is_additional", bool],
  onsaleLabel: ["onsale_label", txt],
  onsaleStart: ["onsale_start", txt],
  onsaleStartTime: ["onsale_start_time", txt],
  onsaleEnd: ["onsale_end", txt],
  onsaleEndTime: ["onsale_end_time", txt],
  limitedSale: ["limited_sale", txt],
  price: ["price", txt],
  source: ["source", txt],
  url: ["url", txt],
  officialUrl: ["official_url", txt],
  venueUrl: ["venue_url", txt],
  lat: ["lat", num],
  lng: ["lng", num],
  desc: ["desc", txt],
  note: ["note", txt],
};

// 価格比較レイヤー（イベントと映画。ライブはチケットが定価固定なので持たない）。
const PRICE_COLUMNS = {
  priceOfficial: ["price_official", int],
  priceBest: ["price_best", int],
  discountPct: ["discount_pct", int],
  bestSource: ["best_source", txt],
  couponNote: ["coupon_note", txt],
  priceChecked: ["price_checked", txt],
  // 「auマンデー」「毎月1日」のような適用条件。条件付きの割引を無条件に
  // 見せると、出さないより有害になるため、条件が書けない割引は載せない。
  priceCondition: ["price_condition", txt],
};

const EVENT_COLUMNS = {
  ...COMMON_COLUMNS,
  ...PRICE_COLUMNS,
  cats: ["cats", list],
  venue: ["venue", txt],
  startDate: ["start_date", txt],
  seriesId: ["series_id", txt],
  // 会場マスターを持たないイベント固有の会場補足情報（第3.4.1節）。
  parking: ["parking", txt],
  nearestStation: ["nearest_station", txt],
};

const MOVIE_COLUMNS = {
  ...COMMON_COLUMNS,
  ...PRICE_COLUMNS,
  genre: ["genre", list],
  screeningType: ["screening_type", list],
  venue: ["theater", txt],
  venues: ["theater", list],
  startDate: ["release_date", txt],
  seriesId: ["series_id", txt],
  posterUrl: ["poster_url", txt],
  posterSource: ["poster_source", txt],
  theaterUrl: ["theater_url", txt],
};

const LIVE_COLUMNS = {
  ...COMMON_COLUMNS,
  artists: ["artists", list],
  genre: ["genre", list],
  liveType: ["live_type", list],
  venue: ["venue", txt],
  startDate: ["start_date", txt],
  // ツアー＝巡回。イベントの巡回展・映画の特集上映と同じ「同一シリーズの他会場」
  seriesId: ["tour_id", txt],
  parking: ["parking", txt],
  nearestStation: ["nearest_station", txt],
  // メインアーティストの Apple Music アーティストページ（第13.11節）。
  appleMusicUrl: ["apple_music_url", txt],
};

/* ---------- 絞り込み軸（ファセット）の宣言 ----------
   すべて「配列 × OR、軸どうしは AND」に統一する。status は値が1つしかないが、
   配列に寄せることで実装を1本にできる。 */

function facet(id, label, get, meta, keys) {
  return { id, label, get, meta, keys };
}
const pillMeta = (tbl) => (k) => {
  const m = tableMeta(tbl, k);
  return { text: m.label, c: m.c, tx: "#fff" };
};
const statusChipMeta = (tbl) => (k) => {
  const m = statusMeta(tbl, k);
  return { text: k, c: m.bg, tx: m.c };
};
// 既知の並び順を優先しつつ、CSVにしか無い値も末尾に拾う（チップから漏らさないため）。
const presentKeys = (tbl, getter) => (items) => {
  const present = new Set();
  items.forEach((it) => getter(it).forEach((v) => present.add(v)));
  return Object.keys(tbl)
    .filter((k) => present.has(k))
    .concat([...present].filter((k) => !(k in tbl)));
};
const statusOf = (it) => (it.status ? [it.status] : []);

/* ---------- 特別チップ（真偽値）の宣言 ----------
   label はタブごとに言い回しが変わるので、タブ宣言を受け取る関数にしてある
   （ライブは「発売前」、映画は「前売り発売前」）。
   test(item, h) の h には filters.js が判定ヘルパ（受付状態・新着・お気に入り）を渡す。
   exclusive は「同時に立つと必ず0件になる組み合わせ」を UI 側で外すための宣言。 */
const FLAG_NEW = {
  id: "newOnly",
  group: "注目",
  cls: "add-chip",
  label: (t) => `新着・${t.additionalLabel}だけ`,
  test: (it, h) => it.isAdditional || h.isNewlyAnnounced(it),
};
const FLAG_ONSALE = {
  id: "onsaleOnly",
  group: "注目",
  cls: "onsale-chip",
  exclusive: ["beforeOnly"],
  label: (t) => `${t.onsaleWords.open}のものだけ`,
  test: (it, h) => h.onsaleState(it) === "open",
};
const FLAG_BEFORE = {
  id: "beforeOnly",
  group: "注目",
  cls: "before-chip",
  exclusive: ["onsaleOnly"],
  label: (t) => `${t.onsaleWords.before}のものだけ`,
  test: (it, h) => h.onsaleState(it) === "before",
};
const FLAG_LIMITED = {
  id: "limitedOnly",
  group: "注目",
  cls: "limited-chip",
  label: () => "限定・追加販売あり",
  test: (it) => !!it.limitedSale,
};
const FLAG_DEALS = {
  id: "dealsOnly",
  group: "おトク",
  cls: "deal-chip",
  label: () => "割引・クーポンがあるものだけ",
  test: (it) => !!(it.discountPct || it.couponNote),
};
const FLAG_FAV = {
  id: "favOnly",
  group: "保存",
  cls: "fav-chip",
  label: () => "お気に入りだけ",
  test: (it, h) => h.isFav(it),
};

/* ---------- タブ宣言 ---------- */

export const TAB_ORDER = ["event", "movie", "live"];

export const TABS = {
  event: {
    key: "event",
    label: "イベント",
    noun: "イベント", // 「◯件のイベント」「該当するイベントが…」
    csv: "./data/events.csv",
    columns: EVENT_COLUMNS,
    keyPrefix: "e",
    paneId: "eventPane",
    listId: "list",
    btnId: "tabEventBtn",
    dirGridId: "dirGrid",
    dirCountId: "dirCount",
    placeholder: "イベント名・会場・エリアで検索",
    catTitle: "イベントをしぼる",
    emptyTitle: "該当するイベントが見つかりません",
    statusTable: EVENT_STATUS_STYLE,
    cardClass: "",
    bodyClass: "card-body",
    // カード上部の意匠（イベントは絵柄を持たない）
    header: null,
    cta: {
      suffix: "で予約する",
      fallback: "予約ページを開く",
      ariaWith: "で予約する",
      ariaWithout: "予約ページを開く",
    },
    officialLabel: "公式サイトを見る",
    additionalLabel: "追加開催",
    seriesLabel: "この巡回展の他の会場",
    onsaleWords: { before: "受付前", open: "受付中", closed: "受付終了" },
    onsaleNoun: "申込",
    hasPrice: true,
    place: {
      pickerLabel: "会場・施設でしぼる",
      searchLabel: "会場・施設名で検索",
      searchPlaceholder: "会場名を入力（例：ビッグサイト）",
      upcomingLabel: "この会場のこれからのイベント",
      kinds: null, // イベントにはマスターが無いので種別で絞らない
    },
    facets: [
      facet(
        "cats",
        "カテゴリ",
        (it) => it.cats,
        pillMeta(CATS),
        () => Object.keys(CATS),
      ),
      facet(
        "statuses",
        "開催状況",
        statusOf,
        statusChipMeta(EVENT_STATUS_STYLE),
        presentKeys(EVENT_STATUS_STYLE, statusOf),
      ),
    ],
    flags: [
      FLAG_DEALS,
      FLAG_NEW,
      FLAG_ONSALE,
      FLAG_BEFORE,
      FLAG_LIMITED,
      FLAG_FAV,
    ],
  },

  movie: {
    key: "movie",
    label: "映画",
    noun: "映画",
    csv: "./data/movies.csv",
    columns: MOVIE_COLUMNS,
    keyPrefix: "m",
    paneId: "moviePane",
    listId: "movieList",
    btnId: "tabMovieBtn",
    dirGridId: "movieDirGrid",
    dirCountId: "movieDirCount",
    placeholder: "映画名・劇場名・エリアで検索",
    catTitle: "映画をしぼる",
    emptyTitle: "該当する映画が見つかりません",
    statusTable: MOVIE_STATUS_STYLE,
    cardClass: "ticket-card",
    bodyClass: "card-body ticket-body",
    header: "poster",
    cta: {
      suffix: "で上映情報を見る",
      fallback: "上映情報を見る",
      ariaWith: "で上映情報を見る",
      ariaWithout: "上映情報を見る",
    },
    officialLabel: "作品公式サイトを見る",
    additionalLabel: "上映延長",
    seriesLabel: "この特集の他の上映",
    onsaleWords: {
      before: "前売り発売前",
      open: "前売り発売中",
      closed: "前売り終了",
    },
    onsaleNoun: "前売り",
    hasPrice: true,
    place: {
      pickerLabel: "劇場でしぼる",
      searchLabel: "劇場名で検索",
      searchPlaceholder: "劇場名を入力（例：TOHO）",
      upcomingLabel: "この劇場で上映予定の作品",
      kinds: THEATER_KINDS,
    },
    facets: [
      facet(
        "genres",
        "ジャンル",
        (it) => it.genre,
        pillMeta(MOVIE_GENRES),
        () => Object.keys(MOVIE_GENRES),
      ),
      facet(
        "screeningTypes",
        "上映形態",
        (it) => it.screeningType,
        pillMeta(SCREENING_TYPES),
        () => Object.keys(SCREENING_TYPES),
      ),
      facet(
        "statuses",
        "上映状況",
        statusOf,
        statusChipMeta(MOVIE_STATUS_STYLE),
        presentKeys(MOVIE_STATUS_STYLE, statusOf),
      ),
    ],
    flags: [
      FLAG_DEALS,
      FLAG_NEW,
      FLAG_ONSALE,
      FLAG_BEFORE,
      FLAG_LIMITED,
      FLAG_FAV,
    ],
  },

  live: {
    key: "live",
    label: "ライブ・フェス",
    noun: "公演",
    csv: "./data/lives.csv",
    columns: LIVE_COLUMNS,
    keyPrefix: "l",
    paneId: "livePane",
    listId: "liveList",
    btnId: "tabLiveBtn",
    dirGridId: "liveDirGrid",
    dirCountId: "liveDirCount",
    placeholder: "アーティスト名・公演名・会場で検索",
    catTitle: "公演をしぼる",
    emptyTitle: "該当する公演が見つかりません",
    statusTable: LIVE_STATUS_STYLE,
    cardClass: "",
    bodyClass: "card-body",
    header: null,
    cta: {
      suffix: "でチケットを見る",
      fallback: "チケットページを開く",
      ariaWith: "でチケットを見る",
      ariaWithout: "チケットページを開く",
    },
    officialLabel: "公演公式サイトを見る",
    additionalLabel: "追加公演",
    seriesLabel: "このツアーの他の公演",
    onsaleWords: { before: "発売前", open: "受付中", closed: "受付終了" },
    onsaleNoun: "チケット",
    hasPrice: false,
    place: {
      pickerLabel: "ライブ会場でしぼる",
      searchLabel: "ライブ会場名で検索",
      searchPlaceholder: "会場名を入力（例：Zepp）",
      upcomingLabel: "この会場のこれからの公演",
      kinds: VENUE_KINDS,
    },
    facets: [
      facet(
        "genres",
        "ジャンル",
        (it) => it.genre,
        pillMeta(LIVE_GENRES),
        () => Object.keys(LIVE_GENRES),
      ),
      facet(
        "liveTypes",
        "公演形態",
        (it) => it.liveType,
        pillMeta(LIVE_TYPES),
        () => Object.keys(LIVE_TYPES),
      ),
      facet(
        "statuses",
        "開催状況",
        statusOf,
        statusChipMeta(LIVE_STATUS_STYLE),
        presentKeys(LIVE_STATUS_STYLE, statusOf),
      ),
    ],
    flags: [FLAG_NEW, FLAG_ONSALE, FLAG_BEFORE, FLAG_LIMITED, FLAG_FAV],
  },
};

// カードの色分けに使う「主ジャンル」の表（ライブのラインナップ帯の色）。
export const GENRE_TABLE_BY_TAB = {
  event: CATS,
  movie: MOVIE_GENRES,
  live: LIVE_GENRES,
};

/** そのアイテムが持つ会場名の配列（映画は複数館ありうる）。 */
export function venueNames(it) {
  if (it.venues && it.venues.length)
    return it.venues.filter((v) => v && v !== "-");
  return it.venue && it.venue !== "-" ? [it.venue] : [];
}
