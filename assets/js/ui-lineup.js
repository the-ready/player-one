/* フェスの日割りラインナップのシート（設計書 第12.12節）。

   カード上の出演者行は主要4組までしか出さない（第12.5節）。単独公演ならそれで
   足りるが、フェスは複数日にわたって百組単位が出演するので、「出演：A・B・C・D
   ほか148組」は**実質的に何も伝えていない**。畳んだ先を見せる場所がこのシート。

   会場シート（ui-map.js）と同じ .map-sheet の骨格を使い回している。並列に開く
   ものではない（カード1枚の中身を掘り下げるだけ）ので、日程・エリアのポップアップ
   と違ってこちらは aria-modal のシートでよい。 */

import { esc, safeUrl, fmtDateWd, WD } from "./util.js";
import { lineupRows, lineupCount } from "./data.js";
import { setBackgroundInert, trapTab, closePopover } from "./ui-popover.js";
import { TODAY } from "./schedule.js";

const el = {};
let returnFocus = null;
let groups = []; // 表示中のフェスの日ごとのまとまり
let activeDay = 0;

/* ---------- 日 → ステージ → アーティストに畳む ---------- */

/* CSVの行の並びをそのまま使う。ラインナップの並びは主催者が決めた序列
   （ヘッドライナーが先頭、以下出演順）で、五十音順に直すとその情報が消える。 */
function groupRows(rows) {
  const byDate = new Map();
  rows.forEach((r) => {
    const key = r.date || ""; // 空 = 日割り未発表
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(r);
  });

  const dated = [...byDate.keys()].filter(Boolean).sort();
  const keys = byDate.has("") ? [...dated, ""] : dated;

  return keys.map((date) => {
    const dayRows = byDate.get(date);
    const byStage = new Map();
    dayRows.forEach((r) => {
      const s = r.stage || "";
      if (!byStage.has(s)) byStage.set(s, []);
      byStage.get(s).push(r);
    });
    return {
      date,
      // 「日割り未発表」は日付が無いので、タブの見出しも本文の見出しも言葉で出す
      label: date ? shortDay(date) : "日割り未発表",
      longLabel: date ? fmtDateWd(date) : "日割り未発表のアーティスト",
      count: new Set(dayRows.map((r) => r.artist)).size,
      stages: [...byStage.entries()].map(([stage, list]) => ({ stage, list })),
    };
  });
}

// タブは横に何個も並ぶので「8/14(金)」まで詰める（fmtDateWd は年から出る）。
function shortDay(ymd) {
  const d = new Date(`${ymd}T00:00:00`);
  if (isNaN(d.getTime())) return ymd;
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
}

/* ---------- Apple Music リンク ---------- */

/* apple_music_url があればアーティストページへ直行する（収集時に iTunes Search API で
   実在を確かめた、ヘッドライナー級の行だけが持つ。第12.11節）。

   無い行は Apple Music の検索URLをその場で組み立てる。百組ぶんのアーティストIDを
   毎週引き直すのは収集予算に対して現実的でなく、**リンクが無い行を大量に作るくらい
   なら検索結果に着地させるほうが目的（曲を聴いて行くか決める）を果たす**ためである。
   遷移先が違うので、ラベルと見た目でも区別する。 */
function musicLink(r) {
  const verified = safeUrl(r.appleMusicUrl);
  const href =
    verified ||
    `https://music.apple.com/jp/search?term=${encodeURIComponent(r.artist)}`;
  const label = verified
    ? `${r.artist}のApple Musicアーティストページを開く`
    : `${r.artist}をApple Musicで検索する`;
  return `<a class="lu-am${verified ? " verified" : ""}" href="${esc(href)}"
    target="_blank" rel="noopener noreferrer"
    title="${esc(verified ? "Apple Musicで聴く" : "Apple Musicで検索")}"
    aria-label="${esc(label)}">♪</a>`;
}

/* ---------- 描画 ---------- */

function artistItem(r) {
  return `<li class="lu-artist${r.isHeadliner ? " headliner" : ""}">
    <span class="lu-name">${esc(r.artist)}</span>
    ${r.note ? `<span class="lu-note">${esc(r.note)}</span>` : ""}
    ${musicLink(r)}
  </li>`;
}

function dayHtml(g) {
  // 見出し（h3）がこの節の名前になるので aria-label は付けない（付けると二重に読まれる）
  return `<section class="lu-day">
    <h3 class="lu-day-head">${esc(g.longLabel)}<span class="lu-day-count">${g.count}組</span></h3>
    ${g.stages
      .map(
        (s) => `<div class="lu-stage">
          ${s.stage ? `<h4 class="lu-stage-head">${esc(s.stage)}</h4>` : ""}
          <ul class="lu-artists">${s.list.map(artistItem).join("")}</ul>
        </div>`,
      )
      .join("")}
  </section>`;
}

function renderTabs() {
  // 1日しかないフェス（＝実質タブが要らない）ではタブ列そのものを出さない
  if (groups.length < 2) {
    el.tabs.hidden = true;
    el.tabs.innerHTML = "";
    return;
  }
  el.tabs.hidden = false;
  el.tabs.innerHTML = groups
    .map(
      (g, i) =>
        `<button type="button" class="lu-tab" role="tab" id="luTab${i}"
          aria-selected="${i === activeDay}" aria-controls="lineupBody"
          tabindex="${i === activeDay ? 0 : -1}" data-day="${i}"
        >${esc(g.label)}<span class="lu-tab-count">${g.count}</span></button>`,
    )
    .join("");
}

function renderBody() {
  el.body.innerHTML = groups.length
    ? dayHtml(groups[activeDay])
    : `<p class="venue-empty">出演者の日割りはまだ登録されていません。</p>`;
  /* 日タブを出していないとき（1日開催・日割り未発表だけ）は tabpanel を名乗らない。
     タブの無いタブパネルは支援技術に「どこかにタブがある」と誤って伝える。 */
  if (groups.length > 1) {
    el.body.setAttribute("role", "tabpanel");
    el.body.setAttribute("aria-labelledby", `luTab${activeDay}`);
  } else {
    el.body.removeAttribute("role");
    el.body.removeAttribute("aria-labelledby");
  }
}

function selectDay(i, focus) {
  if (i < 0 || i >= groups.length) return;
  activeDay = i;
  renderTabs();
  renderBody();
  el.body.scrollTop = 0;
  if (focus) el.tabs.querySelector(`[data-day="${i}"]`)?.focus();
}

/* 開いた瞬間に見たいのは「今日の出演者」である。会期中に開かれたら今日の日を、
   それ以外（会期前・会期後）は初日を選ぶ。 */
function initialDay() {
  const today = TODAY();
  const hit = groups.findIndex((g) => g.date === today);
  return hit >= 0 ? hit : 0;
}

/* ---------- 開閉 ---------- */

export function initLineupSheet() {
  el.sheet = document.getElementById("lineupSheet");
  el.title = document.getElementById("lineupSheetTitle");
  el.help = document.getElementById("lineupSheetHelp");
  el.tabs = document.getElementById("lineupDayTabs");
  el.body = document.getElementById("lineupBody");
  el.close = document.getElementById("lineupSheetClose");
  if (!el.sheet) return;

  el.close.addEventListener("click", closeLineupSheet);
  el.sheet.addEventListener("click", (e) => {
    if (e.target === el.sheet) closeLineupSheet();
  });
  el.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".lu-tab");
    if (btn) selectDay(Number(btn.dataset.day), true);
  });
  // タブ列は左右キーで移動する（tablist の作法。Tabキーは中身へ抜ける）
  el.tabs.addEventListener("keydown", (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[
      e.key
    ];
    if (d == null) return;
    e.preventDefault();
    const next = !isFinite(d)
      ? d < 0
        ? 0
        : groups.length - 1
      : (activeDay + d + groups.length) % groups.length;
    selectDay(next, true);
  });
  el.sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeLineupSheet();
      return;
    }
    trapTab(el.sheet, e);
  });
}

export function openLineupSheet(item) {
  const rows = lineupRows(item && item.lineupId);
  if (!el.sheet || !rows.length) return;
  returnFocus = document.activeElement;
  closePopover();

  groups = groupRows(rows);
  activeDay = initialDay();

  el.title.textContent = `${item.title} の出演者`;
  const site = safeUrl(item.officialUrl || item.url);
  const countHtml = `<b>発表済みの出演者 ${lineupCount(item.lineupId)}組${
    groups.length > 1 ? `／${groups.filter((g) => g.date).length}日間` : ""
  }</b>`;
  el.help.innerHTML = `${countHtml}。${
    site
      ? `<a class="vi-link" href="${esc(site)}" target="_blank" rel="noopener noreferrer">公式のタイムテーブルを見る ↗</a><br>`
      : ""
  }♪をタップすると Apple Music に移動します。`;

  el.sheet.hidden = false;
  document.body.style.overflow = "hidden";
  setBackgroundInert(true, [document.querySelector(".controls")]);
  renderTabs();
  renderBody();
  el.close.focus();
}

export function closeLineupSheet() {
  if (!el.sheet || el.sheet.hidden) return;
  el.sheet.hidden = true;
  document.body.style.overflow = "";
  setBackgroundInert(false, [document.querySelector(".controls")]);
  // 開いている間に一覧が再描画されると元のボタンはDOMから消えている
  // （closePlaceSheet と同じ事情）。行き場が無ければ検索窓へ逃がす。
  const back =
    returnFocus && returnFocus.offsetParent !== null
      ? returnFocus
      : document.getElementById("q");
  if (back && typeof back.focus === "function") back.focus();
  returnFocus = null;
}

export const isLineupSheetOpen = () => el.sheet && !el.sheet.hidden;
