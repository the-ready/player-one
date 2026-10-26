/* お気に入りの管理シート。アーティスト（人）とスポット（場所）を1枚にまとめ、上の切り替えで行き来する。

   同じ「自分の保存」を2枚のシートで別々に持っていた。入口もシートの形も違い（人は名前の入力欄と
   「外す」ボタン、場所は★を押して外す）、どちらも同じ場所で管理できるほうが探しやすいため。
   行の形は2つとも「左に印・名前・右に外す／元に戻す」にそろえ、名前の入力欄も両方に付ける。

   外しても、シートを閉じるまで行は残す（押し間違えても「元に戻す」で戻せるように）。
   一覧の並べ替えは、シートの中では保留して、閉じたときにまとめて反映する（背面のカードを動かさない。
   理由は ui-favspot.js / ui-favartist.js の冒頭）。 */

import { esc, artistKey, spotKey, PERSON_ICON } from "./util.js";
import { TABS, TAB_ORDER } from "./config.js";
import { ITEMS } from "./data.js";
import { hasEnded } from "./filters.js";
import {
  isFavArtist,
  isFavSpot,
  favArtistCount,
  favArtistNames,
  favSpotCount,
  cleanArtistName,
  FAV_ARTIST_MAX,
  FAV_ARTIST_NAME_MAX,
} from "./state.js";
import { knownArtists, suggestArtists, planAdd } from "./artists.js";
import {
  spotByName,
  spotsOfItem,
  favSpotEntries,
  spotFacts,
  suggestSpots,
  planAddSpot,
} from "./spots.js";
import { ICON } from "./cards.js";
import {
  setBackgroundInert,
  trapTab,
  closePopover,
  openerElement,
} from "./ui-popover.js";
import { hideToast, toggleSpot, flushFavChange } from "./ui-favspot.js";
import {
  toggleArtist,
  registerArtist,
  upcomingOf,
  countsText,
  openArtistSheet,
  flushArtistChange,
} from "./ui-favartist.js";
import { openPlaceSheet } from "./ui-map.js";

const mg = {};
let kind = "artist"; // 開いているほう。次に開くときの既定にもなる
let listed = { artist: [], spot: [] }; // 開いている間に並べる名前（外しても閉じるまで残す）
let known = []; // いまのデータにある出演者（アーティストの候補の材料）
let composing = false; // かな漢字変換の途中は、確定するまで追加しない
let manageReturn = null;

const spotLabel = (name) => (spotByName(name) || { name }).name;

/* ---------- 2つのほうの違い ---------- */

/** その場所のこれからの催し（全タブ・終わったものを除く）の件数。 */
function spotCount(e) {
  return TAB_ORDER.reduce(
    (n, k) =>
      n +
      ITEMS[k].filter((it) => !hasEnded(it) && spotsOfItem(it).includes(e))
        .length,
    0,
  );
}
function spotCountsText(e) {
  return TAB_ORDER.map((k) => [
    TABS[k].label,
    ITEMS[k].filter((it) => !hasEnded(it) && spotsOfItem(it).includes(e))
      .length,
  ])
    .filter(([, n]) => n > 0)
    .map(([l, n]) => `${l}${n}件`)
    .join("・");
}

const isOn = (k, name) =>
  k === "artist" ? isFavArtist(name) : isFavSpot(name);

function rowSub(k, name, on) {
  if (!on) return "外しました";
  if (k === "artist") return countsText(artistKey(name)) || "いま予定なし";
  const e = spotByName(name);
  if (!e) return "名簿に見つかりません（名前が変わった可能性があります）";
  return (
    [spotFacts(e), spotCountsText(e) || "いま予定なし"]
      .filter(Boolean)
      .join("　") || ""
  );
}

/* 外す操作は、行の右の文字のボタンにする。左の印だけでは、押すと外れることが読めず、外したあとも
   行が残るので、外れたのかどうかも分からなかった。名前を押すと、その人の出演予定・その場所の
   情報のシートが開き、閉じるとこのシートへ戻る。 */
function rowHtml(k, name) {
  const on = isOn(k, name);
  const icon =
    k === "artist"
      ? `<span class="vr-ico" aria-hidden="true">${PERSON_ICON}</span>`
      : `<span class="vr-ico is-spot" aria-hidden="true">${ICON.star}</span>`;
  const nameHtml = `<span class="vr-name">${esc(name)}</span><small>${esc(rowSub(k, name, on))}</small>`;
  // 名簿に無い場所は、開く先が無い
  const openable = k === "artist" || !!spotByName(name);
  const main = openable
    ? `<button type="button" class="vr-main vr-open" data-fm-open="${esc(name)}" aria-label="${esc(name)}の${k === "artist" ? "出演予定" : "場所と予定"}を見る">${nameHtml}</button>`
    : `<span class="vr-main">${nameHtml}</span>`;
  return `<li class="vr-row${on ? "" : " is-off"}" data-name="${esc(name)}">${icon}${main}<button type="button" class="vr-act" data-fm-toggle="${esc(name)}">${on ? "外す" : "元に戻す"}</button></li>`;
}

/** 外す・元に戻すのあと、その行だけを塗り直す（作り直すと、押したボタンのフォーカスが消える）。 */
function paintRow(li) {
  const name = li.dataset.name;
  const on = isOn(kind, name);
  li.classList.toggle("is-off", !on);
  li.querySelector("small").textContent = rowSub(kind, name, on);
  li.querySelector("[data-fm-toggle]").textContent = on ? "外す" : "元に戻す";
}

function updateCounts() {
  mg.countArtist.textContent = favArtistCount();
  mg.countSpot.textContent = favSpotCount();
}

function renderRows() {
  const names = listed[kind];
  mg.help.textContent = names.length
    ? `この端末の中だけに保存されます。「外す」を押すと外れ、「元に戻す」で戻せます。名前を押すと${kind === "artist" ? "出演予定" : "場所と予定"}が開きます。`
    : kind === "artist"
      ? "まだ登録がありません。カードの出演者の横の人のマークか、下の入力欄から登録できます。"
      : "まだ登録がありません。カードの会場名の左の☆か、下の入力欄から登録できます。登録した場所の催しは、一覧の先頭にまとまります。";
  mg.rows.innerHTML = names.map((n) => rowHtml(kind, n)).join("");
  mg.rows.hidden = !names.length;
}

function say(text) {
  mg.status.textContent = text;
}

// 空白だけの入力は、候補を出さない
const squashed = (s) => String(s || "").replace(/\s+/g, "");

/* 打った文字に合う候補。先頭の候補は、Enter で登録されるものとして印を付ける。
   アーティストは、データに無い名前（発表前の人など）を「このまま登録」で意図して登録できる。
   場所は名簿の名前でしか催しに当たらないので、名簿に無い名前は登録させない。 */
function renderSuggestions() {
  const raw = mg.input.value;
  if (!squashed(raw)) {
    mg.sugg.hidden = true;
    mg.sugg.innerHTML = "";
    return;
  }
  mg.sugg.hidden = false;
  mg.sugg.innerHTML =
    kind === "artist" ? artistSuggHtml(raw) : spotSuggHtml(raw);
}

function artistSuggHtml(raw) {
  const hits = suggestArtists(raw, known, isFavArtist);
  const typed = cleanArtistName(raw);
  const exact = typed && known.some((k) => k.key === artistKey(typed));
  return `${
    hits.length
      ? `<p class="hint">いまのデータにある名前（押すと登録。Enter は先頭の候補）</p>
         <ul>${hits
           .map(
             (k, i) =>
               `<li><button type="button" class="sugg-btn${i === 0 ? " is-first" : ""}" data-fm-add="${esc(k.name)}">${esc(k.name)}<small>${esc(k.count ? `これから${k.count}件` : "いま予定なし")}</small></button></li>`,
           )
           .join("")}</ul>`
      : ""
  }${
    typed && !exact
      ? `<p class="hint">${hits.length ? "候補に無い名前でも、" : "データに同じ名前はありません。発表前の人などは、"}下のボタンで登録できます（公演が見つかると先頭に出ます）。</p><button type="button" class="sugg-raw" data-fm-add-raw="${esc(typed)}">「${esc(typed)}」のまま登録</button>`
      : ""
  }`;
}

function spotSuggHtml(raw) {
  const hits = suggestSpots(raw, isFavSpot);
  if (!hits.length)
    return `<p class="hint">名簿に「${esc(raw.trim())}」に合う場所がありません。会場・施設・映画館の名前の一部を入れてください（名簿に無い場所は登録できません）。</p>`;
  return `<p class="hint">名簿にある会場・施設（押すと登録。Enter は先頭の候補）</p>
    <ul>${hits
      .map((e, i) => {
        // 補足はアーティストの候補と同じく件数だけにする（種類の名前が長い場所は、場所の名前が折り返される）
        const n = spotCount(e);
        return `<li><button type="button" class="sugg-btn${i === 0 ? " is-first" : ""}" data-fm-add="${esc(e.name)}">${esc(e.name)}<small>${esc(n ? `これから${n}件` : "いま予定なし")}</small></button></li>`;
      })
      .join("")}</ul>`;
}

/* ---------- 追加 ---------- */

function afterAdd(name, n, noneText) {
  mg.input.value = "";
  renderRows();
  renderSuggestions();
  updateCounts();
  say(
    `「${name}」を追加しました。${n > 0 ? `これから${n}件${kind === "artist" ? "の公演" : "の催し"}があります。` : noneText}`,
  );
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
  if (!registerArtist(name)) return false;
  if (!listed.artist.some((n) => artistKey(n) === key))
    listed.artist.push(name);
  afterAdd(
    name,
    upcomingOf(key).length,
    "いまは予定が見つからないので、公演が見つかると一覧の先頭に出ます。",
  );
  return true;
}

function addSpot(name) {
  const e = spotByName(name);
  if (!e) {
    say(`名簿に「${name}」はありません。`);
    return false;
  }
  if (isFavSpot(e.name)) {
    say(`「${e.name}」はすでに登録されています。`);
    return false;
  }
  toggleSpot(e.name, { silent: true });
  if (!listed.spot.some((n) => spotKey(n) === spotKey(e.name)))
    listed.spot.push(e.name);
  afterAdd(
    e.name,
    spotCount(e),
    "いまは予定が見つからないので、催しが見つかると一覧の先頭に出ます。",
  );
  return true;
}

/* Enter（「追加」）。打ちかけの文字をそのまま登録しない（artists.js の planAdd・spots.js の planAddSpot）。 */
function submitTyped() {
  if (kind === "artist") {
    const plan = planAdd(mg.input.value, known, isFavArtist);
    if (plan.kind === "empty") say("名前を入れてください。");
    else if (plan.kind === "invalid")
      say(`${FAV_ARTIST_NAME_MAX}文字までの名前を入れてください。`);
    else if (plan.kind === "raw")
      say(
        `データに「${plan.typed}」はありません。登録するときは、下のボタンを押してください。`,
      );
    else addArtist(plan.name);
    return;
  }
  const plan = planAddSpot(mg.input.value, isFavSpot);
  if (plan.kind === "empty") say("会場・施設の名前を入れてください。");
  else if (plan.kind === "dup")
    say(`「${spotLabel(plan.name)}」はすでに登録されています。`);
  else if (plan.kind === "none")
    say(`名簿に「${plan.typed}」に合う場所がありません。`);
  else addSpot(plan.name);
}

/* ---------- 切り替え ---------- */

const PANES = {
  artist: {
    placeholder: "アーティスト名を入力",
    inputLabel: "追加するアーティスト名",
  },
  spot: {
    placeholder: "会場・施設名を入力",
    inputLabel: "追加する会場・施設名",
  },
};

function showPane(k) {
  kind = k;
  mg.tabs.forEach((t) => {
    const on = t.dataset.fmTab === k;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    if (on) mg.panel.setAttribute("aria-labelledby", t.id);
  });
  mg.input.placeholder = PANES[k].placeholder;
  mg.input.setAttribute("aria-label", PANES[k].inputLabel);
  mg.input.value = "";
  say("");
  updateCounts();
  renderRows();
  renderSuggestions();
}

/* ---------- 開閉 ---------- */

/** want: 開くほう（"artist" か "spot"）。省くと、前回開いていたほう。
    keep: 出演予定・場所のシートから戻るとき。最初に開いた元のボタンを覚えたままにする。 */
export function openFavManage({ kind: want = null, keep = false } = {}) {
  if (!mg.sheet) return;
  if (!keep) manageReturn = openerElement();
  closePopover();
  hideToast();
  known = knownArtists((it) => !hasEnded(it));
  listed = {
    artist: favArtistNames(),
    spot: favSpotEntries().map((e) => e.name),
  };
  showPane(want === "artist" || want === "spot" ? want : kind);
  mg.sheet.hidden = false;
  document.body.style.overflow = "hidden";
  setBackgroundInert(true, [document.querySelector(".controls")]);
  mg.close.focus();
}

/** pass: 出演予定・場所のシートへ移るために閉じる（フォーカスは戻さず、元のボタンも覚えたままにする）。 */
export function closeFavManage({ pass = false } = {}) {
  if (!mg.sheet || mg.sheet.hidden) return;
  mg.sheet.hidden = true;
  document.body.style.overflow = "";
  setBackgroundInert(false, [document.querySelector(".controls")]);
  known = [];
  listed = { artist: [], spot: [] };
  // 反映の再描画で、開いた元のボタンが消えることがある。戻り先の判定より先に反映する
  flushArtistChange();
  flushFavChange();
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
export const isFavManageOpen = () => !!mg.sheet && !mg.sheet.hidden;

/* ---------- 起動 ---------- */

export function initFavManage() {
  mg.sheet = document.getElementById("favManage");
  if (!mg.sheet) return; // マークアップが無い版でも他の機能は動かす
  mg.close = document.getElementById("favManageClose");
  mg.panel = document.getElementById("favManagePanel");
  mg.help = document.getElementById("favManageHelp");
  mg.form = document.getElementById("favManageForm");
  mg.input = document.getElementById("favManageInput");
  mg.status = document.getElementById("favManageStatus");
  mg.sugg = document.getElementById("favManageSugg");
  mg.rows = document.getElementById("favManageRows");
  mg.tabs = [...mg.sheet.querySelectorAll("[data-fm-tab]")];
  mg.countArtist = document.getElementById("favManageCountArtist");
  mg.countSpot = document.getElementById("favManageCountSpot");

  mg.close.addEventListener("click", () => closeFavManage());
  mg.sheet.addEventListener("click", (e) => {
    if (e.target === mg.sheet) closeFavManage();
    const tab = e.target.closest("[data-fm-tab]");
    if (tab) {
      if (tab.dataset.fmTab !== kind) showPane(tab.dataset.fmTab);
      return;
    }
    const tg = e.target.closest("button[data-fm-toggle]");
    if (tg) {
      const name = tg.dataset.fmToggle;
      let now;
      if (kind === "artist") {
        now = toggleArtist(name, { silent: true });
        if (now === null)
          say(`登録できませんでした（上限は${FAV_ARTIST_MAX}組です）。`);
      } else now = toggleSpot(name, { silent: true });
      if (now !== null)
        say(`「${name}」を${now ? "元に戻しました" : "外しました"}。`);
      paintRow(tg.closest("li"));
      renderSuggestions();
      updateCounts();
      return;
    }
    // 名前を押すと、その人の出演予定・その場所の情報のシート。閉じるとこのシートへ戻る
    const open = e.target.closest("button[data-fm-open]");
    if (open) {
      const name = open.dataset.fmOpen;
      const k = kind;
      closeFavManage({ pass: true });
      const back = () => openFavManage({ kind: k, keep: true });
      if (k === "artist") openArtistSheet(name, { back });
      else openPlaceSheet(name, { back });
      return;
    }
    const add = e.target.closest("button[data-fm-add]");
    if (add) {
      if (kind === "artist") addArtist(add.dataset.fmAdd);
      else addSpot(add.dataset.fmAdd);
      return;
    }
    const raw = e.target.closest("button[data-fm-add-raw]");
    if (raw) addArtist(raw.dataset.fmAddRaw);
  });
  mg.sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeFavManage();
      return;
    }
    // 切り替えは左右キーで移る（タブは Tab 1回で入り、選んでいるほうだけが Tab の対象）
    const onTab = e.target.closest && e.target.closest("[data-fm-tab]");
    if (onTab && /^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) {
      e.preventDefault();
      const i = mg.tabs.indexOf(onTab);
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? mg.tabs.length - 1
            : (i + (e.key === "ArrowRight" ? 1 : -1) + mg.tabs.length) %
              mg.tabs.length;
      showPane(mg.tabs[next].dataset.fmTab);
      mg.tabs[next].focus();
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
    if (e.key === "Enter" && (composing || e.isComposing || e.keyCode === 229))
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
