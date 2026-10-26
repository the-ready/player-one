/* お気に入りアーティストの操作。人のボタンを押したときの反応・取り消し・
   その人の出演予定のシート。登録の管理シート（手入力・外す）は、スポットと1枚にまとめて
   ui-favmanage.js が持つ。

   人のボタンを押した瞬間には一覧を並べ替えない。★（ui-favspot.js）と同じ理由で、押した指の
   下でカードが動くと、続けて別の人を押そうとして押し間違えるため。トーストで「何が起きたか」を
   知らせ、並べ直したいときだけボタンで反映させる。シートの中での付け外しは、閉じたときに
   まとめて反映する。トーストの部品は★と共用する（画面に出る案内は1つだけにするため）。 */

import { esc, safeUrl, artistKey, artistHead, EXT_ICON } from "./util.js";
import { TABS, TAB_ORDER, venueNames } from "./config.js";
import { ITEMS, lineupRows } from "./data.js";
import { hasEnded, byDateThenRank } from "./filters.js";
import {
  activeTab,
  curState,
  isFavArtist,
  toggleFavArtist,
  setFavArtist,
  favArtistCount,
  pinFavArtists,
  FAV_ARTIST_MAX,
} from "./state.js";
import { performersOf, upcomingDaysOf, reconcileSeen } from "./artists.js";
import { artistBtnHtml, dayLabel } from "./cards.js";
import { visibleItems, refreshNow, onRefresh } from "./render.js";
import {
  setBackgroundInert,
  trapTab,
  closePopover,
  openerElement,
} from "./ui-popover.js";
import { showToast, hideToast, revealFav } from "./ui-favspot.js";

const el = {}; // 出演予定のシート
let pendingReorder = false; // 人の状態に、画面の並びがまだ追いついていない
let sheetReturn = null;
let sheetBack = null; // 出演予定のシートを閉じたあとに戻る先（管理シートから開いたとき）
let goToItem = null; // 公演の行を押したとき、そのカードへ移る処理（main.js から渡される）

const UPCOMING_MAX = 30; // シートの出演予定の件数。超えた分は「ほか◯件」

/* ---------- 人のボタンの見た目をそろえる ----------
   同じ人のボタンは、カード・出演者シート・管理シート・出演予定のシートに同時に出ていることが
   ある。どれを押しても全部が同じ状態になるよう、DOM上のボタンをまとめて塗り直す。 */
export function syncArtistButtons(root = document) {
  root.querySelectorAll("[data-artist]").forEach((b) => {
    const on = isFavArtist(b.dataset.artist);
    b.setAttribute("aria-pressed", String(on));
    if (b.classList.contains("art-big")) {
      const t = b.querySelector("[data-artist-text]");
      if (t)
        t.textContent = on
          ? "お気に入りアーティスト（登録済み）"
          : "お気に入りアーティストにする";
    } else {
      b.title = on
        ? "お気に入りアーティストから外す"
        : "お気に入りアーティストにする";
    }
    // 出演者シートの行は、お気に入りの人を地色で見分けさせる
    const row = b.closest(".lu-artist");
    if (row) row.classList.toggle("is-art", on);
    // カードの出演行は、人のボタンだけでなく名前にも地色を付ける
    const item = b.closest(".art-item");
    if (item) item.classList.toggle("is-fav", on);
  });
}

/* ---------- 付け外し ---------- */

/** このタブで、いまの絞り込みのもとに、その人の公演が何件あるか。 */
function affectedCount(name) {
  const key = artistKey(name);
  return visibleItems(activeTab).filter((it) => performersOf(it).has(key))
    .length;
}

function applyReorder() {
  pendingReorder = false;
  hideToast();
  // 出演予定・管理のシートから付けた場合、開いたままだと並び替わった結果が背面に隠れて見えない
  closePopover();
  refreshNow({ url: false });
  revealFav("art");
}

/** 人を登録する／外す。silent は、シートの中など「閉じたときにまとめて反映する」場面向け。
    登録できなかった（上限）ときは null を返す。 */
export function toggleArtist(name, { silent = false } = {}) {
  const head = artistHead(name);
  if (!isFavArtist(head) && favArtistCount() >= FAV_ARTIST_MAX) {
    showToast(
      `お気に入りアーティストは${FAV_ARTIST_MAX}組までです。使わない人を外してから追加してください。`,
      [{ label: "とじる", primary: true, run: hideToast }],
    );
    return null;
  }
  const was = isFavArtist(head);
  const on = toggleFavArtist(head);
  // 空の名前など、保存できない名前では状態が変わらない。変わったかのように案内しない
  if (on === was) {
    if (!silent)
      showToast(`「${head}」は登録できませんでした。`, [
        { label: "とじる", primary: true, run: hideToast },
      ]);
    return null;
  }
  reconcileSeen();
  syncArtistButtons();
  pendingReorder = true;
  if (silent) return on;

  const n = affectedCount(head);
  const undo = {
    label: "元に戻す",
    run: () => {
      toggleArtist(head, { silent: true });
      hideToast();
    },
  };
  const reorder = {
    label: on ? "先頭にまとめる" : "並べ直す",
    primary: true,
    run: applyReorder,
  };
  // 外したときは、いま先頭にいるカードが戻る先（元の並び）があるときだけ並べ直しを案内する
  const canReorder = (n > 0 || !on) && pinFavArtists();
  const msg = on
    ? `「${head}」をお気に入りアーティストにしました。${
        n > 0
          ? `このタブに${n}件あります。`
          : "いまの条件では、このタブに予定がありません。"
      }`
    : `「${head}」をお気に入りアーティストから外しました。`;
  showToast(msg, canReorder ? [reorder, undo] : [undo]);
  return on;
}

/** 管理シートから人を登録する（並べ替えは閉じたときにまとめて反映する）。
    保存できない名前では false。上限の判定は呼び出し側で先に行う。 */
export function registerArtist(name) {
  if (!setFavArtist(name, true)) return false;
  reconcileSeen();
  pendingReorder = true;
  syncArtistButtons();
  return true;
}

/** 閉じたときなど、保留していた並べ替えを反映する。 */
export function flushArtistChange() {
  if (!pendingReorder) return;
  pendingReorder = false;
  hideToast();
  refreshNow({ url: false });
}

/* ---------- 出演予定の集計 ---------- */

/** その人がこれから出る公演（終わったものを除く）。全タブ。日付順。 */
export function upcomingOf(key) {
  const st = curState();
  const rows = [];
  TAB_ORDER.forEach((tab) =>
    ITEMS[tab].forEach((it) => {
      if (!hasEnded(it) && performersOf(it).has(key)) rows.push(it);
    }),
  );
  return rows.sort(byDateThenRank(st));
}

/** タブごとの件数の文（「ライブ・フェス5件・イベント1件」）。無ければ空。 */
export function countsText(key) {
  return TAB_ORDER.map((tab) => [
    TABS[tab].label,
    ITEMS[tab].filter((it) => !hasEnded(it) && performersOf(it).has(key))
      .length,
  ])
    .filter(([, n]) => n > 0)
    .map(([l, n]) => `${l}${n}件`)
    .join("・");
}

/* ---------- 出演予定のシート ---------- */

/* Apple Music。収集時に実在を確かめたアーティストページがあればそこへ、無ければ検索結果へ
   （出演者シートの ♪ と同じ2段。遷移先が違うので、文言でも区別する。第12.11節）。 */
function appleMusicLink(head, key) {
  let verified = null;
  for (const it of ITEMS.live) {
    if (
      it.appleMusicUrl &&
      it.artists &&
      it.artists[0] &&
      artistKey(it.artists[0]) === key
    ) {
      verified = it.appleMusicUrl;
      break;
    }
    if (it.lineupId) {
      const hit = lineupRows(it.lineupId).find(
        (r) => r.appleMusicUrl && artistKey(r.artist) === key,
      );
      if (hit) {
        verified = hit.appleMusicUrl;
        break;
      }
    }
  }
  const href =
    safeUrl(verified) ||
    `https://music.apple.com/jp/search?term=${encodeURIComponent(head)}`;
  return `<p class="vi-site"><a class="vi-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${verified ? "Apple Musicで聴く" : "Apple Musicで検索する"}${EXT_ICON}</a></p>`;
}

/** back: 閉じたあとに戻る先（管理シートの名前から開いたとき）。 */
export function openArtistSheet(name, { back = null } = {}) {
  if (!el.sheet) return;
  const head = artistHead(name);
  const key = artistKey(head);
  if (!key) return;
  sheetReturn = openerElement();
  sheetBack = back;
  closePopover();

  const rows = upcomingOf(key);
  const shown = rows.slice(0, UPCOMING_MAX);
  el.title.textContent = head;
  el.help.textContent =
    "この人がこれから出る公演です（3タブをまとめて数えています）。";
  el.info.innerHTML = `
    <p class="vi-star">${artistBtnHtml(head, { big: true })}</p>
    ${appleMusicLink(head, key)}
    <p class="vi-facts">これからの公演（${rows.length}件）</p>
    ${
      shown.length
        ? `<ul class="vi-list">${shown
            .map((it) => {
              const days = upcomingDaysOf(it, key)
                .slice(0, 3)
                .map(dayLabel)
                .join("・");
              const place = venueNames(it).join("・");
              const text = [it.dateText, it.title].filter(Boolean).join("　");
              return `<li><button type="button" class="vi-go" data-go-tab="${esc(it.tab)}" data-go-key="${esc(it.key)}"><span class="vi-go-body"><span class="vi-tag">${esc(TABS[it.tab].label)}</span>${esc(text)}${place ? `<small class="vi-place">${esc(place)}</small>` : ""}${days ? `<small class="vi-day">${esc(days)}に出演</small>` : ""}</span><span class="vi-chev" aria-hidden="true">›</span></button></li>`;
            })
            .join("")}</ul>
         ${rows.length > shown.length ? `<p class="venue-empty">ほか${rows.length - shown.length}件</p>` : ""}`
        : `<p class="venue-empty">いまは予定が見つかりません。登録しておくと、公演が見つかったときに一覧の先頭に出ます。</p>`
    }`;
  el.sheet.hidden = false;
  document.body.style.overflow = "hidden";
  setBackgroundInert(true, [document.querySelector(".controls")]);
  el.body.scrollTop = 0;
  el.close.focus();
}

/** noBack: 管理シートへは戻らない（タブ切替など、別の画面へ移るとき）。
    go: 公演のカードへ移るために閉じる。移った先でフォーカスと位置を決めるので、
    開いた元のボタンへは戻さない（戻すと、元の位置へスクロールしてしまう）。 */
export function closeArtistSheet({ noBack = false, go = false } = {}) {
  if (!el.sheet || el.sheet.hidden) return;
  el.sheet.hidden = true;
  document.body.style.overflow = "";
  setBackgroundInert(false, [document.querySelector(".controls")]);
  const returnTo = sheetBack;
  sheetBack = null;
  /* 反映の再描画で、開いた元のボタンが消えることがある。戻り先の判定より先に反映し、
     行き場が無ければ操作バーの「絞り込み」へ逃がす（フォーカスを迷子にしない）。 */
  flushArtistChange();
  if (go) {
    sheetReturn = null;
    return;
  }
  if (returnTo && !noBack) {
    sheetReturn = null;
    returnTo();
    return;
  }
  const back =
    sheetReturn && sheetReturn.isConnected && sheetReturn.offsetParent !== null
      ? sheetReturn
      : document.getElementById("catBtn");
  if (back && typeof back.focus === "function") back.focus();
  sheetReturn = null;
}
export const isArtistSheetOpen = () => !!el.sheet && !el.sheet.hidden;

/* ---------- 起動 ---------- */

export function initFavArtists({ onGoToItem = null } = {}) {
  goToItem = onGoToItem;
  el.sheet = document.getElementById("artistSheet");
  el.title = document.getElementById("artistSheetTitle");
  el.help = document.getElementById("artistSheetHelp");
  el.info = document.getElementById("artistInfo");
  el.body = document.getElementById("artistBody");
  el.close = document.getElementById("artistSheetClose");

  // 絞り込みなどで一覧が描き直されたら、並びは追いついている
  onRefresh(() => {
    pendingReorder = false;
  });

  if (el.sheet) {
    el.close.addEventListener("click", () => closeArtistSheet());
    el.sheet.addEventListener("click", (e) => {
      if (e.target === el.sheet) closeArtistSheet();
      // 公演の行は、シートを閉じてそのカードへ移る（行き止まりにしない）
      const go = e.target.closest("button[data-go-key]");
      if (go && goToItem) {
        closeArtistSheet({ go: true });
        goToItem(go.dataset.goTab, go.dataset.goKey);
        return;
      }
      const b = e.target.closest("button[data-artist]");
      if (b) toggleArtist(b.dataset.artist, { silent: true });
    });
    el.sheet.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeArtistSheet();
        return;
      }
      trapTab(el.sheet, e);
    });
  }
}
