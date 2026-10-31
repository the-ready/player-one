/* 一覧の描画。3タブとも同じ経路を通る（以前は renderList / renderMovieList /
   renderLiveList の3本があり、どれか1つだけ直す事故が起きやすかった）。 */

import {
  esc,
  safeUrl,
  fmtDateDots,
  fmtKm,
  searchTerms,
  debounce,
  PERSON_ICON,
  EXT_ICON,
} from "./util.js";
import { TABS, TAB_ORDER, PREFS, venueNames } from "./config.js";
import { ITEMS, LOAD, SOURCES, updatedFor, dataStatus } from "./data.js";
import {
  matchesFilters,
  matchesBaseFilters,
  mergeSimultaneous,
  hasEnded,
  withinArea,
  withDistances,
  sortItems,
  facetCounts,
  flagCounts,
} from "./filters.js";
import { cardHtml, chainRowHtml, ICON as CAL_ICON } from "./cards.js";
import {
  STATES,
  activeTab,
  curTab,
  curState,
  toggleFav,
  hasAnyFilter,
  hasSharedFilter,
  carryPlan,
  syncUrl,
  favSpotCount,
  pinFavSpots,
  isFavSecMoreOpen,
  setFavSecMoreOpen,
  favArtistCount,
  pinFavArtists,
  isArtHintSeen,
  markArtHintSeen,
  isArtSecMoreOpen,
  setArtSecMoreOpen,
} from "./state.js";
import {
  isFavSpotItem,
  favChainGroups,
  chainNamesOf,
} from "./spots.js";
import { isFavArtistItem, performersOf } from "./artists.js";
import { schedulePhase } from "./schedule.js";
import { fitGrid, refitCard, watchGrid } from "./grid-fit.js";

/* ---------- 通知（共有のフォールバックなど） ---------- */
export function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 3200);
}

/* カードのフェードインは、その一覧を初めて描いたときだけ。絞り込みや検索の
   たびに innerHTML を作り直すので、毎回animationを走らせるとグリッド全体が点滅する。 */
const entered = new WeakSet();
function markEntering(listEl) {
  if (entered.has(listEl)) return;
  entered.add(listEl);
  listEl.classList.add("is-entering");
  setTimeout(() => listEl.classList.remove("is-entering"), 700);
}

/* ---------- 一覧 ---------- */

let lastVisible = []; // 直前に描いたカードの並び（カード内の操作から元データを引くのに使う）
// 同時開催でまとめたカード（セール）の、代表の行のキー -> まとめた全行
let lastMerged = new Map();

export function visibleItems(tabKey = activeTab) {
  const tab = TABS[tabKey],
    st = STATES[tabKey];
  const items = ITEMS[tabKey].filter((it) => matchesFilters(tab, st, it));
  return sortItems(withDistances(items, st), st);
}

export function renderList() {
  const tab = curTab(),
    st = curState();
  const listEl = document.getElementById(tab.listId);
  if (!listEl) return;
  const all = ITEMS[tab.key];
  const items = visibleItems(tab.key);
  lastVisible = items;
  // 同じ series_id・同じ会期のセールは1枚にまとめる（filters.js の mergeSimultaneous）
  const entries = mergeSimultaneous(items);
  lastMerged = new Map(
    entries
      .filter((e) => e.members.length > 1)
      .map((e) => [e.rep.key, e.members]),
  );
  // お気に入りスポットの先頭セクション／まとめ行を出す場面か（設定でまとめない人、
  // 「★お気に入りスポットだけ」で絞っている人、お気に入りが空の人では出さない）。
  const favBlocks =
    favSpotCount() > 0 && (pinFavSpots() || st.flags.favSpotOnly);
  // お気に入りアーティストの先頭セクションも同じ考え方（スポットとは別の設定で出し分ける）
  const artBlocks =
    favArtistCount() > 0 && (pinFavArtists() || st.flags.favArtistOnly);
  const chainRows = favBlocks ? chainRowsFor(tab, st) : [];

  const countEl = document.getElementById("resultCount");
  if (countEl)
    countEl.textContent = all.length
      ? `${all.length}件中 ${items.length}件を表示`
      : "";

  if (!items.length && !chainRows.length) {
    const load = LOAD[tab.key];
    if (load.state === "loading" || load.state === "idle") {
      setListHtml(
        listEl,
        `<div class="empty-state"><span class="big">読み込み中…</span></div>`,
      );
      return;
    }
    if (load.state === "error") {
      setListHtml(
        listEl,
        `<div class="empty-state">
        <span class="big">${esc(tab.label)}のデータを読み込めませんでした</span>
        <p>${esc(tab.csv.replace("./", ""))} を置いた状態で、Webサーバー経由で開いてください（${esc(load.error || "")}）。</p></div>`,
      );
      return;
    }
    // 行き止まりで押せる出口を必ず置く。文章で「解除してみてください」と
    // 言うだけでは、押せるものがどこにも無い画面になる。
    // 他のタブから持ち越した日程やエリアが原因のことが多いので、検索語やこのタブ固有の
    // 絞り込みを残したまま共通の条件だけ外せる出口を、全解除とは別に用意する。
    const shared = hasSharedFilter(st, tab);
    setListHtml(
      listEl,
      `<div class="empty-state">
      <span class="big">${esc(tab.emptyTitle)}</span>
      <p>条件を減らすか、絞り込みをまとめて解除してください。</p>
      <div class="empty-actions">
        ${shared ? `<button type="button" class="empty-reset" data-act="reset-shared">日程・エリアなど共通の条件をはずす</button>` : ""}
        ${hasAnyFilter() ? `<button type="button" class="empty-reset" data-act="reset">すべての絞り込みを解除</button>` : ""}
      </div>
    </div>`,
    );
    return;
  }

  const terms = searchTerms(st.q);
  markEntering(listEl);
  const card = (e) => cardHtml(tab, e.rep, st, terms, e.members);
  const pinned = (e, section) =>
    cardHtml(tab, e.rep, st, terms, e.members, section);
  setListHtml(
    listEl,
    artHintHtml(entries) +
      (favBlocks || artBlocks
        ? favListHtml(tab, st, entries, chainRows, card, {
            spot: favBlocks,
            artist: artBlocks,
            pinned,
          })
        : entries.map(card).join("")),
  );
}

/* 人のボタンの使い方の案内。人の形は「アカウント」に読めて、お気に入りの入口だと気づかれにくい
   ので、まだ1人も登録しておらず、案内を閉じてもいない人にだけ、一覧の先頭に1度だけ出す。
   登録した時点で（state.js の setFavArtist が）既読にするので、使い方を知った人には二度と出ない。
   人のボタンを持つ行が一覧に無いとき（出演者のいない絞り込み結果など）は、指す相手が無いので出さない。 */
function artHintHtml(entries) {
  if (isArtHintSeen() || favArtistCount() > 0) return "";
  if (!entries.some((e) => performersOf(e.rep).size > 0)) return "";
  return `<div class="art-hint" role="note"><span class="ah-ico" aria-hidden="true">${PERSON_ICON}</span><p>出演者の横の<b>人のマーク</b>を押すと、お気に入りアーティストに登録できます。登録した人が出る公演は、一覧の先頭にまとまります。</p><button type="button" class="mini-btn" data-art-hint="close">わかった</button></div>`;
}

/* 一覧の差し替えは、組み立てたHTMLが前回と同じなら行わない。
   約500枚の一覧は、差し替えるたびにパースとレイアウトをやり直すことになり、遅い端末では
   1回に数秒かかる。起動時（裏で別タブを読み終えたときの描き直し）や、結果の変わらない
   チップの付け外しでは、同じものを描き直していただけだった。
   ただし、差し替えれば閉じるはずの状態がDOMに残っているときは差し替える。
   「くわしく」を開いたカードや、一覧の中のフォーカスがそれにあたる。
   スキップしたときのDOMが、差し替えた直後のDOMと同じになる場合に限るためである。
   描画以外でDOMの属性を直接書き換える操作（♡・★の付け外し）は、モデルの状態も
   変えるため、次に組み立てるHTMLは前回と違う。したがって必ず差し替わる。 */
const lastListHtml = new WeakMap();
function setListHtml(listEl, html) {
  if (
    lastListHtml.get(listEl) === html &&
    !listEl.querySelector(".desc.open") &&
    !listEl.contains(document.activeElement)
  )
    return;
  listEl.innerHTML = html;
  lastListHtml.set(listEl, html);
}

/* ---------- お気に入りの先頭セクション ----------
   お気に入りスポットの催し・お気に入りアーティストの公演を、一覧の先頭にまとめて、後ろに
   「そのほかの◯◯」の区切りを置く。並べ替えるだけにしない理由は、「なぜこの順なのか」が
   区切りで分かること（日付順のつもりで見た人が、遠い日付のカードが先頭にあって混乱しない）。
   セクションの見出しは持たない（下の artistSectionHtml）。絞り込みはセクションの内外どちらにも
   効き、並び順（日付・新着・現在地）もセクションの中でそのまま効く。 */

const FAV_CAP = 6; // スマホで「そのほか」が遠くならない量。超えた分は「ほか◯件を表示」
const NOW_PHASES = new Set(["opening", "ongoing", "last", "openrun"]);

/* お気に入りの劇場が、いまのエリアの条件に入っているか。会場でしぼっているときは
   一覧がすでにその会場に限られているので、チェーンのまとめ行は出さない（出すと
   押した結果と同じものが重複する）。 */
function spotInArea(st, e) {
  if (st.mapArea) return withinArea(e, st.mapArea);
  if (st.pref) return e.pref === st.pref;
  return true;
}

function chainRowsFor(tab, st) {
  if (st.venue) return [];
  // 「★お気に入りスポットだけ」を立てていても、チェーンの新作は数えたい。
  // 劇場単位では判定できない行なので、このフラグだけ外した状態で数える。
  const base = { ...st, flags: { ...st.flags, favSpotOnly: false } };
  const rows = [];
  favChainGroups().forEach((g) => {
    const theaters = g.theaters.filter((t) => spotInArea(st, t));
    if (!theaters.length) return;
    const hits = ITEMS[tab.key].filter(
      (it) =>
        chainNamesOf(it).includes(g.chain) && matchesBaseFilters(tab, base, it),
    );
    if (!hits.length) return;
    rows.push({
      group: { chain: g.chain, theaters },
      count: hits.length,
      now: hits.filter((it) => NOW_PHASES.has(schedulePhase(it))).length,
    });
  });
  return rows;
}

/* 先頭セクションは、お気に入りアーティスト → お気に入りスポット → そのほか の順に並べる。
   人のほうを上にするのは、「この人が出る」は「この場所である」より狭い条件で、探している
   公演に当たる確率が高いため。同じカードを2回は出さず、両方に当たる公演は上（人）に1枚だけ
   出す（その場所の★は、カードの会場名の★で見える）。

   「◯◯だけ」で絞っているときは、絞り込みの結果そのものを区切りなしで並べる。区切ると、
   すでに全件が該当しているのに「そのほか」が残るように見えるため。
   pinned は、先頭に出すカードの描き方（どちらのセクションかの目印 data-fav を付ける）。 */
function favListHtml(
  tab,
  st,
  entries,
  chainRows,
  card,
  { spot, artist, pinned },
) {
  const chainHtml = chainRows
    .map((r) => chainRowHtml(r.group, r.count, r.now))
    .join("");
  if (st.flags.favSpotOnly || st.flags.favArtistOnly)
    return chainHtml + entries.map(card).join("");

  // まとめたカード（同時開催のセール）は、どれか1施設がお気に入りなら先頭側に出す
  const art = [];
  const fav = [];
  const rest = [];
  entries.forEach((e) => {
    if (artist && e.members.some(isFavArtistItem)) art.push(e);
    else if (spot && e.members.some(isFavSpotItem)) fav.push(e);
    else rest.push(e);
  });

  const shownKeys = new Set(
    entries.flatMap((e) => e.members.map((m) => m.key)),
  );
  const artHtml = artist ? artistSectionHtml(tab, art, pinned, shownKeys) : "";
  const spotHtml = spot
    ? spotSectionHtml(tab, st, fav, chainRows, chainHtml, pinned, shownKeys)
    : "";
  if (!artHtml && !spotHtml) return rest.map(card).join("");
  const divider = rest.length
    ? `<p class="list-divider"><span>そのほかの${esc(tab.noun)}</span><span class="n">${rest.length}件</span></p>`
    : "";
  return artHtml + spotHtml + divider + rest.map(card).join("");
}

/* 先頭セクションの出し方。見出し（「お気に入りアーティスト 2組・5件」など）は出さない。
   お気に入りの公演が先頭にまとまっていることは、カードの登録した人の帯・会場名の★と、
   後ろの「そのほかの◯◯」の区切りで読める。見出しの「管理」は件数の行の「お気に入り管理」が、
   「たたむ」は「先頭にまとめる」の設定が受け持つので、見出しは持たない。

   先頭のカードには data-fav を付ける（"art"＝人・"spot"＝場所）。見た目には何も足さず、
   「先頭にまとめる」のあとにそのカードへ移る（ui-favspot.js の revealFav）目印と、
   どのセクションに出たかの判定（tools/*_test.mjs）に使う。 */
const moreBtn = (act, more, total) =>
  `<div class="fav-more"><button type="button" class="mini-btn" data-${act}="more" aria-expanded="${more}">${more ? "お気に入りの表示をへらす" : `お気に入りのほか${total - FAV_CAP}件を表示`}</button></div>`;

function artistSectionHtml(tab, art, pinned, shownKeys) {
  // お気に入りがあるのに先頭が空のとき、条件で隠れているのか、そもそも予定が無いのかを
  // 区別する（スポットと同じ。条件のせいなら一言添え、予定が無いだけなら何も出さない）。
  let hidden = 0;
  if (!art.length && hasAnyFilter(tab.key))
    hidden = ITEMS[tab.key].filter(
      (it) => isFavArtistItem(it) && !hasEnded(it) && !shownKeys.has(it.key),
    ).length;
  if (!art.length && !hidden) return "";

  const more = isArtSecMoreOpen(tab.key);
  const shown = more ? art : art.slice(0, FAV_CAP);
  let body = "";
  if (hidden)
    body = `<p class="fav-note">お気に入りアーティストの${esc(tab.noun)}が${hidden}件ありますが、いまの絞り込みに合うものがありません。条件を外すと表示されます。</p>`;
  body += shown.map((e) => pinned(e, "art")).join("");
  if (art.length > FAV_CAP) body += moreBtn("art-act", more, art.length);
  return body;
}

function spotSectionHtml(tab, st, fav, chainRows, chainHtml, pinned, shownKeys) {
  // お気に入りがあるのに先頭が空のとき、条件で隠れているのか、そもそも予定が無いのかを
  // 区別する。条件のせいなら一言添える（理由が無いと、設定が効いていないように見える）。
  // そもそも予定が無い（別のタブの場所だけを登録している等）なら何も出さない。
  // すでに別のセクション（お気に入りアーティスト）に出ている公演は、隠れているとは言わない。
  let hidden = 0;
  if (!fav.length && !chainRows.length && hasAnyFilter(tab.key))
    hidden = ITEMS[tab.key].filter(
      (it) => isFavSpotItem(it) && !hasEnded(it) && !shownKeys.has(it.key),
    ).length;
  if (!fav.length && !chainRows.length && !hidden) return "";

  const more = isFavSecMoreOpen(tab.key);
  const shown = more ? fav : fav.slice(0, FAV_CAP);
  let body = "";
  if (hidden)
    body = `<p class="fav-note">お気に入りスポットの${esc(tab.noun)}が${hidden}件ありますが、いまの絞り込みに合うものがありません。条件を外すと表示されます。</p>`;
  body += shown.map((e) => pinned(e, "spot")).join("");
  if (fav.length > FAV_CAP) body += moreBtn("fav-act", more, fav.length);
  return body + chainHtml;
}

/** カード内の操作から元データを引く。 */
function itemFromEl(el) {
  const card = el.closest(".card");
  if (!card) return null;
  const key = card.dataset.key;
  const it =
    lastVisible.find((x) => x.key === key) ||
    ITEMS[activeTab].find((x) => x.key === key) ||
    null;
  // まとめたカードの共有・カレンダー追加は、代表の施設だけでなく全施設を場所として渡す。
  // 代表の行を写して venues だけ差し替える（uid・日程・題名は代表のままなので、♡も代表に付く）
  const members = it && lastMerged.get(it.key);
  if (members)
    return Object.create(it, {
      venues: {
        value: members.map((m) => venueNames(m)[0]).filter(Boolean),
        enumerable: true,
      },
    });
  return it;
}

/* ---------- カード内の操作（委譲で1度だけ束ねる） ---------- */

export function bindList(
  listEl,
  {
    onOpenPlace,
    onOpenLineup,
    onCalAdd,
    onReset,
    onResetShared,
    onToggleSpot,
    onToggleArtist,
    onOpenArtist,
    onChainFilter,
  },
) {
  // 「くわしく」で開いたカードだけを伸ばすための詰め直し（grid-fit.js）
  watchGrid(listEl);
  listEl.addEventListener("click", (e) => {
    const toggle = e.target.closest(".detail-toggle");
    if (toggle) {
      const desc = document.getElementById(toggle.dataset.target);
      if (!desc) return;
      const open = desc.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute(
        "aria-label",
        open
          ? `${toggle.dataset.title}の説明をとじる`
          : `${toggle.dataset.title}のくわしい説明を見る`,
      );
      toggle.textContent = open ? "とじる ▴" : "くわしく ▾";
      refitCard(listEl, toggle.closest(".card"));
      return;
    }
    const star = e.target.closest("button[data-star]");
    if (star) {
      onToggleSpot(star.dataset.star);
      return;
    }
    const hint = e.target.closest("button[data-art-hint]");
    if (hint) {
      markArtHintSeen();
      hint.closest(".art-hint")?.remove();
      // 詰めて並べたカードの位置は案内の高さを見込んでいるので、消したあとに引き直す
      fitGrid(listEl);
      // 押したボタンごと案内が消えるので、フォーカスを行き場のある所へ移す
      listEl.querySelector(".art-btn")?.focus({ preventScroll: true });
      return;
    }
    // 「ほか◯組」。「くわしく」を開いて、隠れていた人の一覧へ移る
    const moreOpen = e.target.closest("button[data-more-open]");
    if (moreOpen) {
      const card = moreOpen.closest(".card");
      const opener = card && card.querySelector(".detail-toggle");
      if (!opener) return;
      if (opener.getAttribute("aria-expanded") !== "true") opener.click();
      const calm = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      card.querySelector(".art-detail")?.scrollIntoView({
        block: "nearest",
        behavior: calm ? "auto" : "smooth",
      });
      return;
    }
    const person = e.target.closest("button[data-artist]");
    if (person) {
      onToggleArtist(person.dataset.artist);
      return;
    }
    const personOpen = e.target.closest("button[data-artist-open]");
    if (personOpen) {
      onOpenArtist(personOpen.dataset.artistOpen);
      return;
    }
    const artAct = e.target.closest("button[data-art-act]");
    if (artAct) {
      const key = activeTab;
      if (artAct.dataset.artAct === "more") {
        setArtSecMoreOpen(key, !isArtSecMoreOpen(key));
        refreshNow({ url: false });
      }
      return;
    }
    const favAct = e.target.closest("button[data-fav-act]");
    if (favAct) {
      const key = activeTab;
      if (favAct.dataset.favAct === "more") {
        setFavSecMoreOpen(key, !isFavSecMoreOpen(key));
        refreshNow({ url: false });
      }
      return;
    }
    const chainBtn = e.target.closest("button[data-chain-filter]");
    if (chainBtn) {
      onChainFilter(chainBtn.dataset.chainFilter);
      return;
    }
    const place = e.target.closest("button.place-link[data-place]");
    if (place) {
      onOpenPlace(place.dataset.place);
      return;
    }
    const lineup = e.target.closest("button.lineup-btn");
    if (lineup) {
      const item = itemFromEl(lineup);
      if (item) onOpenLineup(item);
      return;
    }

    const act = e.target.closest(".act-btn, .empty-reset");
    if (!act) return;
    const kind = act.dataset.act;
    if (kind === "reset") {
      onReset();
      return;
    }
    if (kind === "reset-shared") {
      onResetShared();
      return;
    }
    const item = itemFromEl(act);
    if (!item) return;
    if (kind === "fav") doFav(item, act);
    else if (kind === "share") doShare(item);
    else if (kind === "cal") openCalMenu(act, item, onCalAdd);
  });
}

function doFav(item, btn) {
  const now = toggleFav(item);
  btn.setAttribute("aria-pressed", String(now));
  btn.setAttribute(
    "aria-label",
    `${item.title}を行きたいリストに${now ? "登録済み。外す" : "追加する"}`,
  );
  btn.setAttribute(
    "title",
    now ? "行きたいリストから外す" : "行きたいリストに追加",
  );
  toast(now ? "行きたいリストに追加しました" : "行きたいリストから外しました");
  // 「お気に入りだけ」で絞っている最中に外したら、その場で消えるのが自然。
  if (curState().flags.favOnly) refresh();
  else syncFilterChips();
}

async function doShare(item) {
  const url = safeUrl(item.url || item.officialUrl) || location.href;
  const text = [item.dateText, venueNames(item).join("・") || item.area]
    .filter(Boolean)
    .join(" / ");
  const payload = { title: item.title, text: `${item.title}（${text}）`, url };
  try {
    if (navigator.share) {
      await navigator.share(payload);
      return;
    }
    await navigator.clipboard.writeText(`${payload.text}\n${url}`);
    toast("リンクをコピーしました");
  } catch (err) {
    if (err && err.name === "AbortError") return; // 共有シートを閉じただけ
    toast("共有できませんでした。リンクを長押ししてコピーしてください");
  }
}

/* カレンダーは端末のアプリ（.ics）と Googleカレンダーで手順がまったく違う。
   どちらかに決め打ちすると、片方の利用者には毎回ムダな往復が生まれるので選ばせる。
   カード内に置くと端で切れるため、body 直下に fixed で出してビューポートに収める。
   選んだ後の実処理（日時を選ぶシートを開く）は onCalAdd（ui-caladd.js）に
   委ねる。render.js は一覧の描画が役目で、シートの開閉までは持たない。 */
let calMenuEl = null;
let calMenuScrollY = 0;
export function closeCalMenu() {
  if (!calMenuEl) return;
  calMenuEl.owner?.setAttribute("aria-expanded", "false");
  calMenuEl.remove();
  calMenuEl = null;
}
function openCalMenu(btn, item, onCalAdd) {
  if (calMenuEl && calMenuEl.owner === btn) {
    closeCalMenu();
    btn.focus();
    return;
  }
  closeCalMenu();
  const menu = document.createElement("div");
  menu.className = "cal-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `${item.title}をカレンダーに追加`);
  menu.innerHTML = `
    <button type="button" role="menuitem" data-cal="ics">${CAL_ICON.device}<span>端末のカレンダーに追加</span></button>
    <button type="button" role="menuitem" data-cal="google">${CAL_ICON.google}<span>Googleカレンダーに追加</span></button>`;
  menu.owner = btn;
  document.body.appendChild(menu);
  calMenuEl = menu;

  // ボタンの下、画面からはみ出すときは上／内側へ寄せる
  const r = btn.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const pad = 8;
  let left = Math.min(Math.max(pad, r.left), window.innerWidth - m.width - pad);
  let top = r.bottom + 6;
  if (top + m.height > window.innerHeight - pad)
    top = Math.max(pad, r.top - m.height - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  btn.setAttribute("aria-expanded", "true");
  calMenuScrollY = window.scrollY;
  menu.querySelector("button").focus();

  menu.addEventListener("click", (e) => {
    const choice = e.target.closest("[data-cal]");
    if (!choice) return;
    const kind = choice.dataset.cal;
    closeCalMenu();
    // シート側が「開いた瞬間の activeElement」へ戻り先を控えるので、
    // シートを開く前に一旦ボタンへ戻しておく（メニュー削除後は body に落ちるため）。
    btn.focus();
    onCalAdd(item, kind);
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCalMenu();
      btn.focus();
      return;
    }
    const items = [...menu.querySelectorAll("[data-cal]")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length].focus();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length].focus();
    }
  });
}
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!calMenuEl) return;
    if (calMenuEl.contains(e.target) || calMenuEl.owner.contains(e.target))
      return;
    closeCalMenu();
  },
  true,
);
/* スクロールしたら閉じる（メニューは fixed なのでボタンから離れてしまう）。
   ただし、ボタンを画面内へ入れるための自動スクロールで即座に閉じないよう、
   開いた位置からある程度動いたときだけにする。 */
window.addEventListener(
  "scroll",
  () => {
    if (calMenuEl && Math.abs(window.scrollY - calMenuScrollY) > 24)
      closeCalMenu();
  },
  { passive: true },
);
window.addEventListener("resize", () => closeCalMenu());

/* ---------- 調査元サイトの一覧 ---------- */

function dirCardHtml(s) {
  const href = safeUrl(s.url);
  if (!href) return "";
  return `<a class="dir-card" href="${esc(href)}" target="_blank" rel="noopener noreferrer">
      <div class="dir-name">${esc(s.name)}${EXT_ICON}</div>
      <div class="dir-role">${esc(s.role)}</div>
    </a>`;
}
export function renderDirectories() {
  TAB_ORDER.forEach((key) => {
    const tab = TABS[key];
    const grid = document.getElementById(tab.dirGridId);
    const count = document.getElementById(tab.dirCountId);
    if (count) count.textContent = SOURCES[key].length;
    if (grid) grid.innerHTML = SOURCES[key].map(dirCardHtml).join("");
  });
}

/* ---------- 絞り込みチップ（件数つき） ----------
   「押したら0件だった」を防ぐため、選択肢ごとに件数を出し、0件は無効化する。
   件数はいま効いている他の条件を反映して毎回変わるので、開いたまま押しても
   次に何が残るかが読める。 */

function chipButton({
  key,
  text,
  count,
  pressed,
  color,
  textColor,
  cls,
  icon,
}) {
  const dead = count === 0 && !pressed;
  return `<button type="button" class="chip${cls ? " " + cls : ""}" data-key="${esc(key)}"
      aria-pressed="${pressed}"${dead ? " disabled" : ""}
      style="${pressed && color ? `--chip-c:${color};--chip-tx:${textColor || "var(--on-accent)"}` : ""}"
    >${icon ? `<span class="chip-ico" aria-hidden="true">${icon}</span>` : ""}${esc(text)}<span class="chip-count" aria-hidden="true">${count}</span><span class="sr-only">（${count}件）</span></button>`;
}

/* 先頭にまとめるかどうかは「絞り込み」ではなく見え方の設定なので、件数も URL も持たない
   （state.js の pinFav）。他の特別チップと同じ並びに置くのは、探す場所を1つにするため。 */
function pinChipHtml() {
  return `<button type="button" class="chip flag-chip favartist-chip" data-key="__pinArtist" aria-pressed="${pinFavArtists()}">お気に入りアーティストを先頭にまとめる</button><button type="button" class="chip flag-chip favspot-chip" data-key="__pinFav" aria-pressed="${pinFavSpots()}">お気に入りスポットを先頭にまとめる</button>`;
}
/* 「保存」の絞り込み（行きたい・お気に入りスポット・お気に入りアーティスト）の並びにも、
   お気に入りの管理シートへの入口を置く。件数の行の「お気に入り管理」を知らない人も、
   お気に入りで絞る場所でなら見つけられる。
   押すと状態が変わるチップではなく、シートを開くだけのボタンなので .chip にはしない。
   絞り込みのチップと同じ丸い形だと、押すと絞り込まれるように見えるので、「›」を付けた
   別の形（.manage-link）にして、別の画面が開くことが形で分かるようにする。 */
function manageFavBtnHtml() {
  return `<button type="button" class="manage-link" data-manage-fav="1" aria-haspopup="dialog">${CAL_ICON.star}<span>お気に入り管理</span><span aria-hidden="true">›</span></button>`;
}

export function renderFilterChips() {
  const tab = curTab(),
    st = curState();
  const items = ITEMS[tab.key];
  const fCounts = facetCounts(tab, st, items);
  const gCounts = flagCounts(tab, st, items);
  const body = document.getElementById("catBody");
  if (!body) return;

  // 特別チップ（おトク／注目／保存）はグループごとに1行にまとめる
  const groups = [];
  tab.flags.forEach((f) => {
    let g = groups.find((x) => x.name === f.group);
    if (!g) {
      g = { name: f.group, flags: [] };
      groups.push(g);
    }
    g.flags.push(f);
  });

  const flagRows = groups
    .map(
      (g) => `
    <div class="chip-row">
      <span class="chip-label">${esc(g.name)}</span>
      ${g.flags
        .map((f) =>
          chipButton({
            key: f.id,
            text: f.label(tab),
            count: gCounts[f.id],
            pressed: st.flags[f.id],
            cls: `flag-chip ${f.cls}`,
            icon: f.icon,
          }),
        )
        .join(
          "",
        )}${g.name === "保存" ? manageFavBtnHtml() : ""}${g.name === "表示" ? pinChipHtml() : ""}
    </div>`,
    )
    .join("");

  const facetRows = tab.facets
    .map((f) => {
      const keys = f.keys(items);
      if (!keys.length) return "";
      return `<div class="chip-row" data-facet="${esc(f.id)}">
      <span class="chip-label">${esc(f.label)}</span>
      ${keys
        .map((k) => {
          const meta = f.meta(k);
          return chipButton({
            key: k,
            text: meta.text,
            count: fCounts[f.id][k] || 0,
            pressed: st.sets[f.id].has(k),
            color: meta.c,
            textColor: meta.tx,
            cls: "facet-chip",
          });
        })
        .join("")}
    </div>`;
    })
    .join("");

  // 開いたまま押されるので、押していたチップにフォーカスを戻す
  const focusKey =
    document.activeElement && body.contains(document.activeElement)
      ? document.activeElement.dataset.key
      : null;
  body.innerHTML = flagRows + facetRows;
  if (focusKey) {
    const back = body.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (back && !back.disabled) back.focus();
  }
}
// 件数だけを塗り直したいとき（お気に入りの増減など）
export const syncFilterChips = () => renderFilterChips();

/* ---------- 適用中の絞り込み ----------
   何が効いているかは常に見えていて、1タップで外せる必要がある。
   以前はボタンのラベルにしか出ておらず、カテゴリの選択は popover を
   開き直さないと分からなかった。 */

export function appliedFilters() {
  const tab = curTab(),
    st = curState();
  const out = [];
  if (st.q) out.push({ type: "q", label: `「${st.q}」` });
  if (st.rangeStart && st.rangeEnd)
    out.push({
      type: "range",
      label: `${fmtDateDots(st.rangeStart)}〜${fmtDateDots(st.rangeEnd)}`,
    });
  if (st.sortBy === "announced") out.push({ type: "sort", label: "新着順" });
  if (st.sortBy === "location")
    out.push({ type: "sort", label: "現在地から近い順" });
  if (st.pref)
    out.push({
      type: "pref",
      label: (PREFS.find((p) => p.key === st.pref) || {}).label || st.pref,
    });
  if (st.venue) out.push({ type: "venue", label: st.venue });
  if (st.mapArea)
    out.push({ type: "map", label: `地図 半径${fmtKm(st.mapArea.radiusKm)}` });
  tab.facets.forEach((f) =>
    st.sets[f.id].forEach((k) =>
      out.push({ type: "facet", facet: f.id, key: k, label: f.meta(k).text }),
    ),
  );
  tab.flags.forEach((f) => {
    if (st.flags[f.id])
      out.push({ type: "flag", key: f.id, label: f.label(tab) });
  });
  return out;
}

export function renderAppliedBar() {
  const bar = document.getElementById("appliedBar");
  if (!bar) return;
  const applied = appliedFilters();
  bar.hidden = !applied.length;
  if (!applied.length) {
    bar.innerHTML = "";
    return;
  }
  bar.innerHTML =
    `<span class="applied-label">絞り込み中</span>` +
    applied
      .map(
        (
          a,
        ) => `<button type="button" class="applied-chip" data-type="${esc(a.type)}"
        data-facet="${esc(a.facet || "")}" data-key="${esc(a.key || "")}"
        aria-label="${esc(a.label)}の絞り込みを外す">${esc(a.label)}<span aria-hidden="true">×</span></button>`,
      )
      .join("") +
    `<button type="button" class="applied-clear" id="appliedClear">すべて解除</button>`;
}

/* ---------- タブの件数バッジ ----------
   検索語・日程・エリア・特別チップは切替先へ持ち越されるので（state.js の carryPlan）、
   いまの条件のまま他のタブを開くと何件見えるかを、開き直さずに気づけるようにする。
   0件のタブに入ってから理由を探すのを避けるための表示である。
   他のタブの数字は「切り替えた後のそのタブの状態」（carryPlan の結果）で数えているので、
   出る数字は切り替えたら実際に見える枚数と一致する
   ——いまの state のまま数えると、持ち越される条件ぶん食い違う。 */
const TAB_COUNT_IDS = {
  event: "tabEventCount",
  movie: "tabMovieCount",
  live: "tabLiveCount",
};
export function syncTabCounts() {
  const cur = curState();
  // 持ち越される条件が1つも無ければ、どのタブも件数を持ち越しで変えないので出さない
  const show = !!cur.q || hasSharedFilter(cur, curTab());
  TAB_ORDER.forEach((k) => {
    const el = document.getElementById(TAB_COUNT_IDS[k]);
    if (!el) return;
    // 未読み込みのタブは0件ではなく「まだ分からない」なので出さない
    // （裏で読み込みが終わったら main.js が改めて呼ぶ）。
    if (!show || LOAD[k].state !== "done") {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    const st = k === activeTab ? STATES[k] : carryPlan(activeTab, k).next;
    const n = ITEMS[k].filter((it) => matchesFilters(TABS[k], st, it)).length;
    el.hidden = false;
    el.textContent = String(n);
  });
}

/* ---------- ヘッダーの最終更新日 ---------- */
const TAB_DATA_NOUNS = {
  event: "イベント",
  movie: "映画",
  live: "ライブ・フェス",
};
/* 収集はタブごとに別の曜日に走らせているので、次の更新日もタブに合わせて出す。
   3タブぶんをまとめて「毎週◯曜日」と1つ書くと、必ず2タブぶんが嘘になる。 */
const TAB_UPDATE_DAYS = {
  event: "水曜日",
  movie: "木曜日",
  live: "金曜日",
};
export function syncUpdatedLabel() {
  const day = document.getElementById("statUpdateDay");
  if (day && TAB_UPDATE_DAYS[activeTab]) {
    day.textContent = TAB_UPDATE_DAYS[activeTab];
  }
  const el = document.getElementById("statUpdated");
  if (!el) return;
  const shown = fmtDateDots(updatedFor(activeTab)) || "–";
  el.textContent = shown;
  document
    .getElementById("statUpdatedChip")
    ?.setAttribute(
      "aria-label",
      `今週のボードを開く（${TAB_DATA_NOUNS[activeTab] || ""}データの最終更新日 ${shown}）`,
    );
  const off = document.getElementById("offlineNote");
  if (off) off.hidden = !dataStatus.offline;
}

/* ---------- まとめて塗り直す ----------
   件数が増えたときだけ打鍵ごとの全再描画が重くなるので、そのときだけ間引く。
   件数が少ないうちは即時のほうが手応えが良いため、既定では遅延させない。 */
let scheduled = null;
export function refresh(opts = {}) {
  const n = ITEMS[activeTab].length;
  const delay = n > 250 ? 150 : 0;
  if (scheduled) scheduled.cancel();
  scheduled = debounce(() => doRefresh(opts), delay);
  scheduled();
}
export function refreshNow(opts = {}) {
  if (scheduled) scheduled.cancel();
  doRefresh(opts);
}

const uiHooks = [];
export function onRefresh(fn) {
  uiHooks.push(fn);
}

function doRefresh(opts) {
  renderList();
  renderFilterChips();
  renderAppliedBar();
  syncTabCounts();
  uiHooks.forEach((fn) => fn());
  if (opts.url !== false) syncUrl(!!opts.push);
}
