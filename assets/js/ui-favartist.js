/* お気に入りアーティストの操作。人のボタンを押したときの反応・取り消し・
   その人の出演予定のシート・登録の管理シート（手入力）。

   人のボタンを押した瞬間には一覧を並べ替えない。★（ui-favspot.js）と同じ理由で、押した指の
   下でカードが動くと、続けて別の人を押そうとして押し間違えるため。トーストで「何が起きたか」を
   知らせ、並べ直したいときだけボタンで反映させる。シートの中での付け外しは、閉じたときに
   まとめて反映する。トーストの部品は★と共用する（画面に出る案内は1つだけにするため）。 */

import {
  esc,
  safeUrl,
  artistKey,
  artistHead,
  EXT_ICON,
  PERSON_ICON,
} from "./util.js";
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
  suggestArtists,
  planAdd,
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

/* ---------- 管理シート ---------- */

let listed = []; // このシートを開いている間に並べる名前。外しても、閉じるまで行は残す（押し戻せるように）
let known = []; // いまのデータにある出演者（候補の材料）
let composing = false; // かな漢字変換の途中は、確定するまで追加しない

/* 外す操作は、行の右の文字のボタンにする。左の人のアイコンだけでは、押すと外れることが
   読めず、外したあとも行が残るので、外れたのかどうかも分からなかった。名前を押すと、その人の
   出演予定のシートが開く（行の「ライブ・フェス2件」の中身を見られるように）。 */
function rowHtml(name) {
  const on = isFavArtist(name);
  return `<li class="vr-row${on ? "" : " is-off"}" data-name="${esc(name)}"><span class="vr-ico" aria-hidden="true">${PERSON_ICON}</span><button type="button" class="vr-main vr-open" data-artist-open="${esc(name)}" aria-label="${esc(name)}の出演予定を見る"><span class="vr-name">${esc(name)}</span><small>${esc(rowSub(name, on))}</small></button><button type="button" class="vr-act" data-art-toggle="${esc(name)}">${on ? "外す" : "元に戻す"}</button></li>`;
}
const rowSub = (name, on) =>
  on ? countsText(artistKey(name)) || "いま予定なし" : "外しました";

/** 外す・元に戻すのあと、その行だけを塗り直す（作り直すと、押したボタンのフォーカスが消える）。 */
function paintRow(li) {
  const name = li.dataset.name;
  const on = isFavArtist(name);
  li.classList.toggle("is-off", !on);
  li.querySelector("small").textContent = rowSub(name, on);
  li.querySelector("[data-art-toggle]").textContent = on ? "外す" : "元に戻す";
}

function renderRows() {
  mg.help.textContent = listed.length
    ? "この端末の中だけに保存されます。「外す」を押すと外れ、「元に戻す」で戻せます。名前を押すと出演予定が開きます。"
    : "まだ登録がありません。カードの出演者の横の人のボタンか、下の入力欄から登録できます。";
  mg.rows.innerHTML = listed.map(rowHtml).join("");
  mg.rows.hidden = !listed.length;
}

function say(text) {
  mg.status.textContent = text;
}

/* 打った文字に合う候補（artists.js の suggestArtists）。先頭の候補は、Enter で登録される
   ものとして印を付ける。データに無い名前は、候補の下の「このまま登録」で、意図して登録する。 */
function renderSuggestions() {
  const raw = mg.input.value;
  if (!squashed(raw)) {
    mg.sugg.hidden = true;
    mg.sugg.innerHTML = "";
    return;
  }
  const hits = suggestArtists(raw, known, isFavArtist);
  const typed = cleanArtistName(raw);
  const exact = typed && known.some((k) => k.key === artistKey(typed));
  mg.sugg.hidden = false;
  mg.sugg.innerHTML = `${
    hits.length
      ? `<p class="hint">いまのデータにある名前（押すと登録。Enter は先頭の候補）</p>
         <ul>${hits
           .map(
             (k, i) =>
               `<li><button type="button" class="sugg-btn${i === 0 ? " is-first" : ""}" data-add="${esc(k.name)}">${esc(k.name)}<small>${esc(k.count ? `これから${k.count}件` : "いま予定なし")}</small></button></li>`,
           )
           .join("")}</ul>`
      : ""
  }${
    typed && !exact
      ? `<p class="hint">${hits.length ? "候補に無い名前でも、" : "データに同じ名前はありません。発表前の人などは、"}下のボタンで登録できます（公演が見つかると先頭に出ます）。</p><button type="button" class="sugg-raw" data-add-raw="${esc(typed)}">「${esc(typed)}」のまま登録</button>`
      : ""
  }`;
}
// 空白だけの入力は、候補を出さない
const squashed = (s) => String(s || "").replace(/\s+/g, "");

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

/* Enter（「追加」）。打ちかけの文字をそのまま登録しない（artists.js の planAdd）。 */
function submitTyped() {
  const plan = planAdd(mg.input.value, known, isFavArtist);
  if (plan.kind === "empty") say("名前を入れてください。");
  else if (plan.kind === "invalid")
    say(`${FAV_ARTIST_NAME_MAX}文字までの名前を入れてください。`);
  else if (plan.kind === "raw")
    say(
      `データに「${plan.typed}」はありません。登録するときは、下のボタンを押してください。`,
    );
  else addArtist(plan.name);
}

/** keep: 出演予定のシートから戻るとき。最初に開いた元のボタンを覚えたままにする。 */
export function openArtistManage({ keep = false } = {}) {
  if (!mg.sheet) return;
  if (!keep) manageReturn = openerElement();
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

/** pass: 出演予定のシートへ移るために閉じる（フォーカスは戻さず、元のボタンも覚えたままにする）。 */
export function closeArtistManage({ pass = false } = {}) {
  if (!mg.sheet || mg.sheet.hidden) return;
  mg.sheet.hidden = true;
  document.body.style.overflow = "";
  setBackgroundInert(false, [document.querySelector(".controls")]);
  known = [];
  listed = [];
  flushArtistChange();
  if (pass) return;
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

export function initFavArtists({ onGoToItem = null } = {}) {
  goToItem = onGoToItem;
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

  if (mg.sheet) {
    mg.close.addEventListener("click", () => closeArtistManage());
    mg.sheet.addEventListener("click", (e) => {
      if (e.target === mg.sheet) closeArtistManage();
      const tg = e.target.closest("button[data-art-toggle]");
      if (tg) {
        const name = tg.dataset.artToggle;
        const now = toggleArtist(name, { silent: true });
        if (now === null)
          say(`登録できませんでした（上限は${FAV_ARTIST_MAX}組です）。`);
        else say(`「${name}」を${now ? "元に戻しました" : "外しました"}。`);
        paintRow(tg.closest("li"));
        renderSuggestions();
        return;
      }
      // 名前を押すと、その人の出演予定のシート。閉じると管理シートへ戻る
      const open = e.target.closest("button[data-artist-open]");
      if (open) {
        closeArtistManage({ pass: true });
        openArtistSheet(open.dataset.artistOpen, {
          back: () => openArtistManage({ keep: true }),
        });
        return;
      }
      const add = e.target.closest("button[data-add]");
      if (add) {
        addArtist(add.dataset.add);
        return;
      }
      const raw = e.target.closest("button[data-add-raw]");
      if (raw) addArtist(raw.dataset.addRaw);
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
      submitTyped();
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
