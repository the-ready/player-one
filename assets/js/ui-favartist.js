/* お気に入りアーティストの操作。人のボタンを押したときの反応・取り消し・
   その人の出演予定のシート・登録の管理シート（手入力）。

   人のボタンを押した瞬間には一覧を並べ替えない。★（ui-favspot.js）と同じ理由で、押した指の
   下でカードが動くと、続けて別の人を押そうとして押し間違えるため。トーストで「何が起きたか」を
   知らせ、並べ直したいときだけボタンで反映させる。シートの中での付け外しは、閉じたときに
   まとめて反映する。トーストの部品は★と共用する（画面に出る案内は1つだけにするため）。 */

import { esc, safeUrl, artistKey, artistHead, fold, EXT_ICON } from "./util.js";
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
  favArtistNames,
  cleanArtistName,
  pinFavArtists,
  FAV_ARTIST_MAX,
  FAV_ARTIST_NAME_MAX,
} from "./state.js";
import {
  performersOf,
  upcomingDaysOf,
  knownArtists,
  reconcileSeen,
} from "./artists.js";
import { artistBtnHtml, dayLabel } from "./cards.js";
import { visibleItems, refreshNow, onRefresh } from "./render.js";
import {
  setBackgroundInert,
  trapTab,
  closePopover,
  openerElement,
} from "./ui-popover.js";
import { showToast, hideToast, revealFavHead } from "./ui-favspot.js";

const el = {}; // 出演予定のシート
const mg = {}; // 管理シート
let pendingReorder = false; // 人の状態に、画面の並びがまだ追いついていない
let sheetReturn = null;
let manageReturn = null;

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
  revealFavHead(".fav-head.art");
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

/** 閉じたときなど、保留していた並べ替えを反映する。 */
export function flushArtistChange() {
  if (!pendingReorder) return;
  pendingReorder = false;
  hideToast();
  refreshNow({ url: false });
}

/* ---------- 出演予定の集計 ---------- */

/** その人がこれから出る公演（終わったものを除く）。全タブ。日付順。 */
function upcomingOf(key) {
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
function countsText(key) {
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

export function openArtistSheet(name) {
  if (!el.sheet) return;
  const head = artistHead(name);
  const key = artistKey(head);
  if (!key) return;
  sheetReturn = openerElement();
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
        ? `<ul>${shown
            .map((it) => {
              const days = upcomingDaysOf(it, key)
                .slice(0, 3)
                .map(dayLabel)
                .join("・");
              const place = venueNames(it).join("・");
              const text = [it.dateText, it.title].filter(Boolean).join("　");
              return `<li><span class="vi-tag">${esc(TABS[it.tab].label)}</span>${esc(text)}${place ? `<small class="vi-place">${esc(place)}</small>` : ""}${days ? `<small class="vi-day">${esc(days)}に出演</small>` : ""}</li>`;
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

export function closeArtistSheet() {
  if (!el.sheet || el.sheet.hidden) return;
  el.sheet.hidden = true;
  document.body.style.overflow = "";
  setBackgroundInert(false, [document.querySelector(".controls")]);
  /* 反映の再描画で、開いた元のボタンが消えることがある。戻り先の判定より先に反映し、
     行き場が無ければ操作バーの「絞り込み」へ逃がす（フォーカスを迷子にしない）。 */
  flushArtistChange();
  const back =
    sheetReturn && sheetReturn.isConnected && sheetReturn.offsetParent !== null
      ? sheetReturn
      : document.getElementById("catBtn");
  if (back && typeof back.focus === "function") back.focus();
  sheetReturn = null;
}
export const isArtistSheetOpen = () => !!el.sheet && !el.sheet.hidden;

/* ---------- 管理シート ---------- */

let listed = []; // このシートを開いている間に並べる名前。外しても、閉じるまで行は残す（押し戻せるように）
let known = []; // いまのデータにある出演者（候補の材料）
let composing = false; // かな漢字変換の途中は、確定するまで追加しない

function rowHtml(name) {
  const key = artistKey(name);
  const sub = countsText(key) || "いま予定なし";
  return `<li>${artistBtnHtml(name)}<span class="vr-main"><span class="vr-name">${esc(name)}</span><small>${esc(sub)}</small></span></li>`;
}

function renderRows() {
  mg.help.textContent = listed.length
    ? "この端末の中だけに保存されます。人のボタンを押すと外れ、もう一度押すと戻ります。"
    : "まだ登録がありません。カードの出演者の横の人のボタンか、下の入力欄から登録できます。";
  mg.rows.innerHTML = listed.map(rowHtml).join("");
  mg.rows.hidden = !listed.length;
  syncArtistButtons(mg.rows);
}

function say(text) {
  mg.status.textContent = text;
}

/* 打った文字に合う候補。かな・全角半角・大小の違いと空白は検索と同じ畳み込みで吸収する。
   すでに登録した人は候補に出さない。前方が合うものを先に、同じ並びの中では予定の多い人を先に。 */
function squash(s) {
  return fold(s).replace(/\s+/g, "");
}
function renderSuggestions() {
  const q = squash(mg.input.value);
  if (!q) {
    mg.sugg.hidden = true;
    mg.sugg.innerHTML = "";
    return;
  }
  const hits = known
    .map((k) => ({ k, f: squash(k.name) }))
    .filter(({ k, f }) => f.includes(q) && !isFavArtist(k.name))
    .sort(
      (a, b) =>
        Number(b.f.startsWith(q)) - Number(a.f.startsWith(q)) ||
        b.k.count - a.k.count ||
        a.f.localeCompare(b.f, "ja"),
    )
    .slice(0, 8)
    .map(({ k }) => k);
  const typed = cleanArtistName(mg.input.value);
  const exact = typed && known.some((k) => k.key === artistKey(typed));
  mg.sugg.hidden = false;
  mg.sugg.innerHTML = `${
    hits.length
      ? `<p class="hint">いまのデータにある名前（押すとそのまま登録）</p>
         <ul>${hits
           .map(
             (k) =>
               `<li><button type="button" class="sugg-btn" data-add="${esc(k.name)}">${esc(k.name)}<small>${esc(k.count ? `これから${k.count}件` : "いま予定なし")}</small></button></li>`,
           )
           .join("")}</ul>`
      : ""
  }${
    typed && !exact
      ? `<p class="hint">${hits.length ? "一致する名前が無くても" : "データに同じ名前はありません。"}「${esc(typed)}」のまま登録できます（公演が見つかると先頭に出ます）。</p>`
      : ""
  }`;
}

/** 名前を登録する。登録できたら true。理由は say() で伝える。 */
function addArtist(raw) {
  const typed = cleanArtistName(raw);
  if (!typed) {
    say(
      String(raw || "").trim()
        ? `${FAV_ARTIST_NAME_MAX}文字までの名前を入れてください。`
        : "名前を入れてください。",
    );
    return false;
  }
  const key = artistKey(typed);
  // データにある名前と同じなら、データの表記（大文字小文字など）で登録する
  const name = (known.find((k) => k.key === key) || {}).name || typed;
  if (isFavArtist(name)) {
    say(`「${name}」はすでに登録されています。`);
    return false;
  }
  if (favArtistCount() >= FAV_ARTIST_MAX) {
    say(`お気に入りアーティストは${FAV_ARTIST_MAX}組までです。`);
    return false;
  }
  if (!setFavArtist(name, true)) return false;
  reconcileSeen();
  pendingReorder = true;
  if (!listed.some((n) => artistKey(n) === key)) listed.push(name);
  mg.input.value = "";
  renderRows();
  renderSuggestions();
  syncArtistButtons();
  const n = upcomingOf(key).length;
  say(
    `「${name}」を追加しました。${
      n > 0
        ? `これから${n}件の公演があります。`
        : "いまは予定が見つからないので、公演が見つかると一覧の先頭に出ます。"
    }`,
  );
  return true;
}

export function openArtistManage() {
  if (!mg.sheet) return;
  manageReturn = openerElement();
  closePopover();
  hideToast();
  known = knownArtists((it) => !hasEnded(it));
  listed = favArtistNames();
  mg.input.value = "";
  say("");
  renderRows();
  renderSuggestions();
  mg.sheet.hidden = false;
  document.body.style.overflow = "hidden";
  setBackgroundInert(true, [document.querySelector(".controls")]);
  mg.close.focus();
}

export function closeArtistManage() {
  if (!mg.sheet || mg.sheet.hidden) return;
  mg.sheet.hidden = true;
  document.body.style.overflow = "";
  setBackgroundInert(false, [document.querySelector(".controls")]);
  known = [];
  listed = [];
  flushArtistChange();
  const back =
    manageReturn &&
    manageReturn.isConnected &&
    manageReturn.offsetParent !== null
      ? manageReturn
      : document.getElementById("catBtn");
  if (back && typeof back.focus === "function") back.focus();
  manageReturn = null;
}
export const isArtistManageOpen = () => !!mg.sheet && !mg.sheet.hidden;

/* ---------- 起動 ---------- */

export function initFavArtists() {
  el.sheet = document.getElementById("artistSheet");
  el.title = document.getElementById("artistSheetTitle");
  el.help = document.getElementById("artistSheetHelp");
  el.info = document.getElementById("artistInfo");
  el.body = document.getElementById("artistBody");
  el.close = document.getElementById("artistSheetClose");
  mg.sheet = document.getElementById("favArtistSheet");
  mg.help = document.getElementById("favArtistHelp");
  mg.form = document.getElementById("favArtistForm");
  mg.input = document.getElementById("favArtistInput");
  mg.status = document.getElementById("favArtistStatus");
  mg.sugg = document.getElementById("favArtistSugg");
  mg.rows = document.getElementById("favArtistRows");
  mg.close = document.getElementById("favArtistClose");

  // 絞り込みなどで一覧が描き直されたら、並びは追いついている
  onRefresh(() => {
    pendingReorder = false;
  });

  if (el.sheet) {
    el.close.addEventListener("click", closeArtistSheet);
    el.sheet.addEventListener("click", (e) => {
      if (e.target === el.sheet) closeArtistSheet();
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

  if (mg.sheet) {
    mg.close.addEventListener("click", closeArtistManage);
    mg.sheet.addEventListener("click", (e) => {
      if (e.target === mg.sheet) closeArtistManage();
      const b = e.target.closest("button[data-artist]");
      if (b) {
        if (toggleArtist(b.dataset.artist, { silent: true }) === null)
          say(`登録できませんでした（上限は${FAV_ARTIST_MAX}組です）。`);
        else say("");
        renderSuggestions();
        return;
      }
      const add = e.target.closest("button[data-add]");
      if (add) addArtist(add.dataset.add);
    });
    mg.sheet.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeArtistManage();
        return;
      }
      trapTab(mg.sheet, e);
    });
    mg.form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (composing) return;
      addArtist(mg.input.value);
    });
    mg.input.addEventListener("input", () => {
      say("");
      if (!composing) renderSuggestions();
    });
    /* かな漢字変換を確定する Enter で、フォームが送られてしまうのを止める。
       Safari は確定の Enter の keydown を compositionend のあとに送るので、composing の
       旗だけでは足りず、keyCode 229（変換中の印）も見る。 */
    mg.input.addEventListener("keydown", (e) => {
      if (
        e.key === "Enter" &&
        (composing || e.isComposing || e.keyCode === 229)
      )
        e.preventDefault();
    });
    mg.input.addEventListener("compositionstart", () => {
      composing = true;
    });
    mg.input.addEventListener("compositionend", () => {
      composing = false;
      renderSuggestions();
    });
  }
}
