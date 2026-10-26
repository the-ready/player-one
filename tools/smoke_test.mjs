/* 画面のスモークテスト。
   3タブが描画されるか、絞り込みが件数を変えるか、URLが状態を持つか、
   キーボードでカレンダーが操作できるか、コンソールエラーが出ていないかを見る。
   細かい見た目までは見ない——「壊れているのに気づかないまま公開する」ことだけを防ぐ。

   使い方:
     python3 -m http.server 8000 &
     npm i -D playwright && npx playwright install chromium
     node tools/smoke_test.mjs                     # 既定 http://localhost:8000/
     BASE=https://example.github.io/repo/ node tools/smoke_test.mjs

   環境によっては Chromium の場所を明示する必要がある:
     PW_CHROME=/path/to/chrome node tools/smoke_test.mjs
*/

import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:8000/";
const launchOpts = process.env.PW_CHROME
  ? { executablePath: process.env.PW_CHROME }
  : {};

const failures = [];
// 表示中でないタブのデータは、表示のあとの空き時間に読み、読み終えると一覧を描き直す（main.js）。
// 描き直しは★のトーストを消すので、★を押す確認は読み終えてから行う（Pi では読み込みから約6秒かかり、
// 待たずに押すと、押した直後にトーストが消えて「先頭にまとめる」が押せなくなっていた）
const waitAllTabs = (p) =>
  p
    .waitForFunction(
      () =>
        ["movies.csv", "lives.csv", "lineups.csv"].every((f) =>
          performance
            .getEntriesByType("resource")
            .some((e) => e.name.includes(f) && e.responseEnd > 0),
        ),
      null,
      { timeout: 30000 },
    )
    .catch(() => {})
    .then(() => p.waitForTimeout(800));
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}${detail ? "  — " + detail : ""}`,
  );
  if (!ok) failures.push(name);
};

const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();

const consoleErrors = [];
const IGNORE =
  /fonts\.googleapis|fonts\.gstatic|tile\.openstreetmap|updated\.json/;
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (IGNORE.test(m.location()?.url || "")) return; // 外部リソースの不通は対象外
  consoleErrors.push(m.text());
});

console.log(`\n${BASE}\n`);
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// --- 3タブが描画される
const counts = {};
for (const [tab, btn, list] of [
  ["イベント", "#tabEventBtn", "#list"],
  ["映画", "#tabMovieBtn", "#movieList"],
  ["ライブ", "#tabLiveBtn", "#liveList"],
]) {
  await page.click(btn);
  await page.waitForTimeout(900);
  counts[tab] = await page.locator(`${list} .card`).count();
  check(`${tab}タブにカードが出る`, counts[tab] > 0, `${counts[tab]}件`);
}
await page.click("#tabEventBtn");
await page.waitForTimeout(500);

// --- 検索（日本語の正規化とAND）
const search = async (q) => {
  await page.fill("#q", q);
  await page.waitForTimeout(400);
  return page.locator("#list .card").count();
};
check("全角英字が半角に寄る", (await search("ｔｏｋｙｏ")) > 0);
check("スペース区切りがANDになる", (await search("東京 花火")) > 0);
await page.fill("#q", "");
await page.waitForTimeout(300);

// --- 絞り込みチップ
await page.click("#catBtn");
await page.waitForTimeout(300);
// 「お気に入りスポット／アーティストを先頭にまとめる」は絞り込みではなく見え方の設定なので件数を持たない
const chips = await page
  .locator(
    '#catBody .chip:not([data-key="__pinFav"]):not([data-key="__pinArtist"])',
  )
  .count();
check("絞り込みチップが出る", chips > 0, `${chips}個`);
check(
  "チップに件数が付く",
  (await page.locator("#catBody .chip-count").count()) === chips,
);
const target = page
  .locator("#catBody .chip-row[data-facet] .chip:not([disabled])")
  .first();
await target.click();
await page.waitForTimeout(400);
const filtered = await page.locator("#list .card").count();
check(
  "チップで件数が変わる",
  filtered > 0 && filtered < counts["イベント"],
  `${filtered}件`,
);
check(
  "適用中チップが出る",
  (await page.locator("#appliedBar .applied-chip").count()) === 1,
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(
  "URLにクエリが付く",
  new URL(page.url()).search.length > 1,
  new URL(page.url()).search,
);

// --- 適用中チップから1タップで外せる
await page.locator("#appliedBar .applied-chip").first().click();
await page.waitForTimeout(400);
check(
  "適用中チップを押すと外れる",
  (await page.locator("#list .card").count()) === counts["イベント"],
);

// --- カレンダーのキーボード操作
await page.click("#sortDateBtn");
await page.waitForTimeout(300);
check(
  "カレンダーのタブストップは1つ",
  (await page.locator('#calGrid .cal-day[tabindex="0"]').count()) === 1,
);
await page.locator('#calGrid .cal-day[tabindex="0"]').focus();
await page.keyboard.press("ArrowRight");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
const kept = await page.evaluate(() =>
  document.activeElement?.getAttribute("data-date"),
);
check("日付を選んでもフォーカスが残る", !!kept, kept || "フォーカスが外れた");
await page.keyboard.press("ArrowRight");
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
check(
  "期間が選べる",
  /〜/.test(await page.locator("#calSelectionText").textContent()),
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// --- リセット（適用中バーの「すべて解除」に一本化してある）
check("すべて解除が見える", await page.locator("#appliedClear").isVisible());
await page.locator("#appliedClear").click();
await page.waitForTimeout(400);
check(
  "リセットで全件に戻る",
  (await page.locator("#list .card").count()) === counts["イベント"],
);
check("リセットでURLも空になる", new URL(page.url()).search === "");

// --- 深いリンク
await page.goto(BASE + "?tab=live&pref=tokyo", { waitUntil: "networkidle" });
await page.waitForTimeout(1800);
check(
  "URLからタブが復元される",
  (await page.locator("#tabLiveBtn").getAttribute("aria-selected")) === "true",
);
check(
  "URLから絞り込みが復元される",
  (await page.locator("#appliedBar .applied-chip").count()) >= 1,
);

// --- ポップアップは非モーダル：開いたまま隣のボタンへ移れる
await page.click("#sortDateBtn");
await page.waitForTimeout(300);
await page.click("#sortLocBtn");
await page.waitForTimeout(300);
check(
  "日程を開いたままエリアへ切り替えられる",
  (await page.locator("#locPopoverBody").isVisible()) &&
    !(await page.locator("#datePopoverBody").isVisible()),
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// --- カードの操作ボタン（アイコンのみ、「くわしく」の右）とカレンダーの追加先えらび
// 行きたい・共有・カレンダーの3つは常に出る。Apple Music の♪はメインアーティストの
// リンクがある公演（フェスを除く。第12.11節・第12.12節）だけ、行きたいの左に追加で出る。
const card = page.locator("#liveList .card").first();
check("操作ボタンは3つ以上", (await card.locator(".act-btn").count()) >= 3);
check(
  "行きたい・共有ボタンに文字を持たせていない",
  (await card.locator('.act-btn[data-act="fav"]').innerText()).trim() === "" &&
    (await card.locator('.act-btn[data-act="share"]').innerText()).trim() ===
      "",
);
check(
  "操作ボタンが「くわしく」と同じ行にある",
  await card.evaluate((el) => {
    const actions = el.querySelector(".card-actions");
    return !!actions && !!actions.closest(".detail-row");
  }),
);
// 「くわしく」を開いたカードだけが伸び、同じ行・ほかの列は動かない（第5.6.1節）
{
  const r = await page.evaluate(() => {
    const grid = [...document.querySelectorAll(".grid")].find(
      (g) => g.offsetWidth > 0,
    );
    const cards = [...grid.querySelectorAll(".card")].slice(0, 12);
    const pos = () =>
      cards.map((c) => ({
        top: c.offsetTop,
        left: c.offsetLeft,
        h: c.offsetHeight,
      }));
    const cols = new Set(cards.map((c) => c.offsetLeft)).size;
    const i = cards.findIndex(
      (c, k) => k >= 3 && c.querySelector(".detail-toggle"),
    );
    if (cols < 2 || i < 0) return { skipped: true };
    const before = pos();
    cards[i].querySelector(".detail-toggle").click();
    const open = pos();
    cards[i].querySelector(".detail-toggle").click();
    const closed = pos();
    const grew = open[i].h - before[i].h;
    return {
      grew,
      othersKeepHeight: open.every(
        (p, k) => k === i || Math.abs(p.h - before[k].h) < 1.5,
      ),
      otherColumnsStay: open.every(
        (p, k) =>
          p.left === before[i].left || Math.abs(p.top - before[k].top) < 1.5,
      ),
      restored: closed.every(
        (p, k) =>
          Math.abs(p.top - before[k].top) < 1.5 &&
          Math.abs(p.h - before[k].h) < 1.5,
      ),
    };
  });
  if (r.skipped)
    check(
      "「くわしく」で開いたカードだけが伸びる（複数列のときのみ）",
      true,
      "スキップ",
    );
  else {
    check(
      "「くわしく」を開くとそのカードが伸びる",
      r.grew > 20,
      `+${r.grew}px`,
    );
    check(
      "「くわしく」を開いても他のカードの高さは変わらない",
      r.othersKeepHeight,
    );
    check("「くわしく」を開いても他の列のカードは動かない", r.otherColumnsStay);
    check("「くわしく」を閉じると元の配置に戻る", r.restored);
  }
}
check(
  "出典名をメタ欄にプレーンテキストで出さない（予約ボタンのラベルと重複するため）",
  (await page.locator("#liveList .src").count()) === 0,
);
check(
  "割引バッジをカード表面に出さない",
  (await page.locator("#liveList .discount-badge").count()) === 0,
);
const calBtn = card.locator('.act-btn[data-act="cal"]');
if (await calBtn.count()) {
  await calBtn.click();
  await page.waitForTimeout(300);
  check(
    "カレンダーの追加先を選べる",
    (await page.locator(".cal-menu [data-cal]").count()) === 2,
  );
  // どちらを選んでも、渡す前に日時を選ぶシートを必ず経由する（設計書 第5.10節）
  await page.locator('.cal-menu [data-cal="ics"]').click();
  await page.waitForTimeout(300);
  const calAddSheet = page.locator("#calAddSheet");
  check(
    "カレンダーに追加する前に日時を選ぶ画面が開く",
    (await calAddSheet.getAttribute("hidden")) === null &&
      (await page.locator("#calAddDate").inputValue()) !== "",
  );
  // 終日/時刻指定はモードを選ばせず、時刻欄が空かどうかで決める
  check(
    "時刻は任意の入力欄として常に出ている",
    (await page.locator("#calAddStart").count()) === 1 &&
      (await page.locator("#calAddEnd").count()) === 1 &&
      (await page.locator("#calAddSheet .preset-chip").count()) === 0,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check(
    "日時シートが閉じる",
    (await calAddSheet.getAttribute("hidden")) !== null,
  );
}

// --- お気に入りスポット（★）・駐車場（P）・管理シート（設計書 第5.11・5.12節）
await page.goto(BASE + "?tab=event", { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await waitAllTabs(page);
check(
  "会場名の左に☆が出る",
  (await page.locator("#list .star-btn").count()) > 0,
);
check(
  "お気に入りが空のうちは先頭セクションが出ない",
  (await page.locator("#list .fav-head").count()) === 0,
);
const star = page.locator("#list .star-btn").first();
const spotName = await star.getAttribute("data-star");
await star.click();
await page.waitForTimeout(300);
check(
  "☆を押すと押した状態になり、トーストが出る",
  (await star.getAttribute("aria-pressed")) === "true" &&
    (await page.locator("#favToast").isVisible()),
);
check(
  "押した瞬間には一覧を並べ替えない",
  (await page.locator("#list .fav-head").count()) === 0,
);
await page.locator("#favToast button.primary").click();
await page.waitForTimeout(500);
check(
  "「先頭にまとめる」で先頭セクションが出る",
  (await page.locator("#list .fav-head").count()) === 1 &&
    (await page.locator("#list .list-divider").count()) <= 1,
);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
check(
  "リロードしてもお気に入りが残る",
  (await page.locator("#list .fav-head").count()) === 1,
);
await page.locator('#list [data-fav-act="manage"]').click();
await page.waitForTimeout(300);
check(
  "管理シートがスポットを選んだ状態で開き、登録した場所が出る",
  (await page.locator("#favManage").isVisible()) &&
    (await page.locator("#favTabSpot").getAttribute("aria-selected")) ===
      "true" &&
    (await page.locator("#favManageRows .vr-name").first().innerText()) ===
      spotName,
);
// スポットも名前の入力欄から足せる。候補は名簿の場所だけ（名簿に無い名前は登録しない）
const spotRows = page.locator("#favManageRows li");
const spotsBefore = await spotRows.count();
await page.fill("#favManageInput", "ぜったいにない会場めい");
await page.press("#favManageInput", "Enter");
await page.waitForTimeout(250);
check(
  "名簿に無い場所は Enter でも登録されず、理由が出る",
  (await spotRows.count()) === spotsBefore &&
    /合う場所がありません/.test(
      await page.locator("#favManageStatus").innerText(),
    ),
);
await page.fill("#favManageInput", "ドーム");
await page.waitForTimeout(250);
check(
  "名簿の場所が候補に出て、先頭の候補に Enter の印が付く",
  (await page.locator("#favManageSugg .sugg-btn").count()) > 0 &&
    (await page
      .locator("#favManageSugg .sugg-btn")
      .first()
      .evaluate((e) => e.classList.contains("is-first"))),
);
await page.press("#favManageInput", "Enter");
await page.waitForTimeout(300);
check(
  "Enter で先頭の候補が登録され、切り替えの数も増える",
  (await spotRows.count()) === spotsBefore + 1 &&
    /を追加しました/.test(await page.locator("#favManageStatus").innerText()) &&
    (await page.locator("#favManageCountSpot").innerText()).trim() ===
      String(spotsBefore + 1),
);
await page.click("#favTabArtist");
await page.waitForTimeout(200);
check(
  "アーティストへ切り替えると、入力欄とヒントがアーティストのものになる",
  (await page.locator("#favManageInput").getAttribute("placeholder")) ===
    "アーティスト名を入力" &&
    (await page.locator("#favTabArtist").getAttribute("aria-selected")) ===
      "true",
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("管理シートが閉じる", !(await page.locator("#favManage").isVisible()));
await page.click("#catBtn");
await page.waitForTimeout(300);
await page.locator('#catBody .chip[data-key="favSpotOnly"]').click();
await page.waitForTimeout(300);
check(
  "「★お気に入りスポットだけ」で絞れて、URLに載る",
  (await page.locator("#list .card").count()) > 0 &&
    /f=favspot/.test(new URL(page.url()).search),
);
await page.keyboard.press("Escape");
await page.locator("#appliedClear").click();
await page.waitForTimeout(300);
check(
  "駐車場のバッジが出る行がある",
  (await page.locator("#list .card .pk").count()) > 0,
);
await page.evaluate(() => localStorage.clear());

// --- お気に入りアーティスト（人のボタン。設計書 第5.14節）
await page.goto(BASE + "?tab=live", { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#liveList .card");
await page.waitForTimeout(1500);
await waitAllTabs(page);
check(
  "出演者の横に人のボタンが出る（単独公演にも）",
  (await page.locator("#liveList .card .art-btn").count()) > 50,
);
check(
  "お気に入りが空のうちは先頭セクションが出ない",
  (await page.locator("#liveList .fav-head").count()) === 0,
);
check(
  "未登録・未読なら、一覧の先頭に使い方の案内が出る",
  (await page.locator("#liveList > .art-hint").count()) === 1 &&
    (await page.evaluate(() =>
      document
        .getElementById("liveList")
        .firstElementChild.classList.contains("art-hint"),
    )),
);
check(
  "件数の行に、お気に入り管理の入口が文字のリンクとして常にある（登録0件でも）",
  (await page.locator("#favEntry").isVisible()) &&
    (await page.locator("#favEntry").innerText()).replace(/\s+/g, "") ===
      "お気に入り管理›" &&
    (await page.evaluate(
      () =>
        document.getElementById("favEntry").parentElement ===
        document.getElementById("resultCount").parentElement,
    )),
);
check(
  "入口は日程・エリア・絞り込みのボタンの列には混ぜない（絞り込みではないため）",
  (await page.locator(".control-row #favEntry").count()) === 0 &&
    (await page.locator(".control-row .sort-btn").count()) === 3,
);
check(
  "件数の文字と入口の中央線が揃う（0.6px以内）",
  await page.evaluate(() => {
    const mid = (n) => {
      const r = document.createRange();
      r.selectNodeContents(n);
      const b = r.getBoundingClientRect();
      return (b.top + b.bottom) / 2;
    };
    return (
      Math.abs(
        mid(document.getElementById("resultCount")) -
          mid(document.querySelector("#favEntry .fe-label")),
      ) <= 0.6
    );
  }),
);
check(
  "人のボタンには「＋」「✓」の印を付けない",
  (await page
    .locator("#liveList .card .art-btn")
    .first()
    .evaluate((e) => getComputedStyle(e, "::before").content)) !== '"+"',
);
// 「ほか◯組」を押すと「くわしく」が開いて、全員の一覧が見える
const moreBtn = page.locator("#liveList .card button.art-more").first();
if (await moreBtn.count()) {
  await moreBtn.scrollIntoViewIfNeeded();
  await moreBtn.click();
  await page.waitForTimeout(500);
  const moreCard = moreBtn.locator("xpath=ancestor::article");
  check(
    "「ほか◯組」を押すと、全員の一覧（人のボタンつき）が開く",
    (await moreCard.locator(".detail-toggle").getAttribute("aria-expanded")) ===
      "true" &&
      (await moreCard.locator(".art-detail").isVisible()) &&
      (await moreCard.locator(".art-detail .art-btn").count()) >= 5,
  );
} else check("「ほか◯組」がボタンになっている", false);
// 公演の多い人を、画面のボタンから選ぶ（件数は毎週変わるので名前は決め打ちしない）
const artistName = await page.evaluate(() => {
  const n = new Map();
  document
    .querySelectorAll("#liveList .art-btn[data-artist]")
    .forEach((b) =>
      n.set(b.dataset.artist, (n.get(b.dataset.artist) || 0) + 1),
    );
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
});
const artBtn = page
  .locator(`#liveList .art-btn[data-artist="${artistName}"]`)
  .first();
await artBtn.scrollIntoViewIfNeeded();
await artBtn.click();
await page.waitForTimeout(300);
check(
  "人のボタンを押すと押した状態になり、トーストが出る",
  (await artBtn.getAttribute("aria-pressed")) === "true" &&
    (await page.locator("#favToast").isVisible()) &&
    /お気に入りアーティストにしました/.test(
      await page.locator("#favToast .ft-msg").innerText(),
    ),
);
check(
  "押した瞬間には一覧を並べ替えない",
  (await page.locator("#liveList .fav-head").count()) === 0,
);
await page.locator("#favToast button.primary").click();
await page.waitForTimeout(600);
check(
  "「先頭にまとめる」で先頭セクションが出て、カードの出演行に登録した人のかたまりが付く（「なぜ」の行は出ない）",
  (await page.locator("#liveList .fav-head.art").count()) === 1 &&
    (await page.locator("#liveList .lineup-line .art-item.is-fav").count()) >
      0 &&
    (await page.locator("#liveList .why-line").count()) === 0,
);
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#liveList .card");
await page.waitForTimeout(1500);
check(
  "リロードしても登録が残る",
  (await page.locator("#liveList .fav-head.art").count()) === 1,
);
await page
  .locator(`#liveList .art-link[data-artist-open="${artistName}"]`)
  .first()
  .click();
await page.waitForTimeout(400);
check(
  "名前を押すと出演予定のシートが開き、その人の公演が並ぶ",
  (await page.locator("#artistSheet").isVisible()) &&
    (await page.locator("#artistSheetTitle").innerText()) === artistName &&
    (await page.locator("#artistInfo li").count()) > 0,
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(
  "Escで出演予定のシートが閉じる",
  !(await page.locator("#artistSheet").isVisible()),
);
// 出演予定の行を押すと、シートを閉じてそのカードへ移る（行き止まりにしない）
await page
  .locator(`#liveList .art-link[data-artist-open="${artistName}"]`)
  .first()
  .click();
await page.waitForTimeout(400);
const goRow = page.locator("#artistInfo .vi-go").first();
const goKey = await goRow.getAttribute("data-go-key");
await goRow.click();
await page.waitForTimeout(1500);
check(
  "出演予定の行を押すと、シートが閉じて、その公演のカードが画面に出る",
  !(await page.locator("#artistSheet").isVisible()) &&
    (await page.evaluate((k) => {
      const e = document.querySelector(`.card[data-key="${k}"]`);
      if (!e) return false;
      const r = e.getBoundingClientRect();
      return r.top < innerHeight && r.bottom > 0 && e.offsetParent !== null;
    }, goKey)),
);
// 絞り込みの入口から管理シートを開き、名前を手入力で足す
await page.click("#catBtn");
await page.waitForTimeout(300);
check(
  "絞り込みに「お気に入りアーティストだけ」と管理の入口がある",
  (await page.locator('#catBody .chip[data-key="favArtistOnly"]').count()) ===
    1 && (await page.locator("#catBody [data-manage-fav]").count()) === 1,
);
await page.locator("#catBody [data-manage-fav]").click();
await page.waitForTimeout(400);
check(
  "管理シートが開き、登録した人が並ぶ",
  (await page.locator("#favManage").isVisible()) &&
    (await page.locator("#favManageRows .vr-name").first().innerText()) ===
      artistName,
);
const outRow = page.locator("#favManageRows li").first();
await outRow.locator(".vr-act").click();
await page.waitForTimeout(250);
check(
  "「外す」を押すと行が薄くなり、ボタンが「元に戻す」に変わる",
  (await outRow.evaluate((e) => e.classList.contains("is-off"))) &&
    (await outRow.locator(".vr-act").innerText()) === "元に戻す" &&
    /外しました/.test(await page.locator("#favManageStatus").innerText()),
);
await outRow.locator(".vr-act").click();
await page.waitForTimeout(250);
check(
  "「元に戻す」で登録に戻る",
  !(await outRow.evaluate((e) => e.classList.contains("is-off"))) &&
    (await outRow.locator(".vr-act").innerText()) === "外す",
);
await page.fill("#favManageInput", "まだデータに無い人");
await page.press("#favManageInput", "Enter");
await page.waitForTimeout(300);
check(
  "データに無い名前は Enter では登録されず、理由と「のまま登録」のボタンが出る（打ちかけの文字を登録しない）",
  !(await page.locator("#favManageRows .vr-name").allInnerTexts()).includes(
    "まだデータに無い人",
  ) &&
    /データに「まだデータに無い人」はありません/.test(
      await page.locator("#favManageStatus").innerText(),
    ) &&
    (await page.locator("#favManageSugg .sugg-raw").count()) === 1,
);
await page.locator("#favManageSugg .sugg-raw").click();
await page.waitForTimeout(300);
check(
  "データに無い名前も、「のまま登録」で登録でき、「いま予定なし」と出る",
  (await page.locator("#favManageRows .vr-name").allInnerTexts()).includes(
    "まだデータに無い人",
  ) &&
    /いま予定なし/.test(
      await page
        .locator("#favManageRows li", { hasText: "まだデータに無い人" })
        .innerText(),
    ),
);
await page.fill("#favManageInput", "まだデータに無い人");
await page.locator("#favManageSugg .sugg-raw").click();
await page.waitForTimeout(200);
check(
  "同じ名前は二重に登録されない",
  (await page.locator("#favManageRows .vr-name").allInnerTexts()).filter(
    (t) => t === "まだデータに無い人",
  ).length === 1 &&
    /すでに登録/.test(await page.locator("#favManageStatus").innerText()),
);
await page.locator("#favManageClose").click();
await page.waitForTimeout(500);
await page.click("#catBtn");
await page.waitForTimeout(300);
await page.locator('#catBody .chip[data-key="favArtistOnly"]').click();
await page.waitForTimeout(400);
check(
  "「お気に入りアーティストだけ」で絞れて、URLに載る",
  (await page.locator("#liveList .card").count()) > 0 &&
    (await page.locator("#liveList .fav-head").count()) === 0 &&
    /f=favartist/.test(new URL(page.url()).search),
);
await page.keyboard.press("Escape");
await page.click("#tabEventBtn");
await page.waitForTimeout(800);
check(
  "タブを移っても絞り込みが持ち越される",
  /f=favartist/.test(new URL(page.url()).search),
);
await page.locator("#appliedClear").click();
await page.waitForTimeout(300);
// フェスの出演者シートの中から登録できる
await page.click("#tabLiveBtn");
await page.waitForTimeout(600);
const lineupCard = page
  .locator("#liveList .card", { has: page.locator("button.lineup-btn") })
  .first();
if (await lineupCard.count()) {
  await lineupCard.locator("button.lineup-btn").scrollIntoViewIfNeeded();
  await lineupCard.locator("button.lineup-btn").click();
  await page.waitForTimeout(500);
  const luRow = page.locator("#lineupBody .lu-artist").nth(1);
  const luBtn = luRow.locator(".art-btn");
  await luBtn.click();
  await page.waitForTimeout(200);
  check(
    "出演者シートの人のボタンで登録でき、行が強調される",
    (await luBtn.getAttribute("aria-pressed")) === "true" &&
      (await luRow.getAttribute("class")).includes("is-art"),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check(
    "シートを閉じると一覧に反映される（組数が増える）",
    /[2-9]組/.test(
      (await page.locator("#liveList .fav-head.art").innerText()).replace(
        /\s+/g,
        " ",
      ),
    ),
  );
} else check("（出演者シートを持つフェスが無いのでスキップ）", true);
// イベント・映画の登壇者にも人のボタンが付く
for (const [btn, list, label] of [
  ["#tabEventBtn", "#list", "イベント"],
  ["#tabMovieBtn", "#movieList", "映画"],
]) {
  await page.click(btn);
  await page.waitForTimeout(700);
  const n = await page.locator(`${list} .guest-line .art-btn`).count();
  check(
    `${label}の登壇者にも人のボタンが付く（登壇者のいる公演があれば）`,
    n >= 0 &&
      (n === 0 ||
        (await page.locator(`${list} .guest-line .art-link`).count()) === n),
    `${n}件`,
  );
}
await page.evaluate(() => localStorage.clear());

/* 夜のカードの読みやすさ（第6.6節）。空モードの夜（太陽高度 -4° 未満）は、カードの色の道具を
   夜用に差し替える。差し替え漏れ（明るい地に明るい文字、暗い地に暗い文字）は見た目では
   気づきにくいので、3タブすべてのカードの文字を、実際の地の色との対比で機械的に調べる。
   「くわしく」の中身も見えるよう、すべて開いてから測る。昼は白いカードと白いタグ文字のままかだけを見る
   （昼の配色は今回の対象外。補助色の一部は 4.4:1 前後で、基準にわずかに届かない）。 */
async function scanCards(isoTime) {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const p = await ctx.newPage();
  const t = Date.parse(isoTime);
  await p.addInitScript((t) => {
    const real = Date.now.bind(Date);
    const off = t - real();
    Date.now = () => real() + off;
  }, t);
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.waitForSelector("#list .card");
  await p.waitForTimeout(1500);
  const out = {
    cls: await p.evaluate(() => document.documentElement.className),
    bad: [],
    n: 0,
  };
  for (const tab of ["#tabEventBtn", "#tabMovieBtn", "#tabLiveBtn"]) {
    await p.click(tab);
    await p.waitForTimeout(1200);
    const r = await p.evaluate(() => {
      // color-mix() は computed value が rgb() ではなく color(srgb 0.85 0.85 0.9) で返る。
      // 数字を r,g,b としてそのまま読むと 0〜1 の値になり「ほぼ黒」と誤判定するので、canvas で rgb に直す
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      const parse = (c) => {
        if (!/^rgba?\(/.test(c)) {
          cx.clearRect(0, 0, 1, 1);
          cx.fillStyle = "#000";
          cx.fillStyle = c;
          cx.fillRect(0, 0, 1, 1);
          const d = cx.getImageData(0, 0, 1, 1).data;
          return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
        }
        const m = c.match(/[\d.]+/g).map(Number);
        return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 };
      };
      const lin = (v) =>
        (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      const lum = (c) =>
        0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      const over = (t, b) => ({
        r: t.r * t.a + b.r * (1 - t.a),
        g: t.g * t.a + b.g * (1 - t.a),
        b: t.b * t.a + b.b * (1 - t.a),
        a: 1,
      });
      const bgOf = (el) => {
        const stack = [];
        for (let e = el; e; e = e.parentElement) {
          const c = parse(getComputedStyle(e).backgroundColor);
          if (c.a > 0) stack.push(c);
          if (c.a >= 1) break;
        }
        let acc = { r: 0, g: 0, b: 0, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
        return acc;
      };
      const bad = [];
      let n = 0;
      for (const card of document.querySelectorAll(".card")) {
        if (!card.offsetParent) continue;
        card.querySelectorAll(".desc").forEach((d) => d.classList.add("open"));
        for (const el of card.querySelectorAll("*")) {
          if (
            ![...el.childNodes].some(
              (c) => c.nodeType === 3 && c.textContent.trim(),
            )
          )
            continue;
          if (el.closest(".sr-only")) continue;
          const cs = getComputedStyle(el);
          const bg = bgOf(el);
          const fg = parse(cs.color);
          const f = fg.a < 1 ? over(fg, bg) : fg;
          const [hi, lo] = [lum(f), lum(bg)].sort((a, b) => b - a);
          const cr = (hi + 0.05) / (lo + 0.05);
          const size = parseFloat(cs.fontSize);
          const need =
            size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight) >= 700)
              ? 3
              : 4.5;
          n++;
          if (cr < need)
            bad.push(
              `${cr.toFixed(1)}:1 .${[...el.classList].join(".")} "${el.textContent.trim().slice(0, 12)}"`,
            );
        }
      }
      return { bad: [...new Set(bad)].slice(0, 6), n };
    });
    out.n += r.n;
    out.bad.push(...r.bad);
  }
  out.cardBg = await p.evaluate(
    () => getComputedStyle(document.querySelector(".card")).backgroundColor,
  );
  out.badgeColor = await p.evaluate(
    () => getComputedStyle(document.querySelector(".cat-badge")).color,
  );
  await ctx.close();
  return out;
}
{
  const night = await scanCards("2026-10-18T20:30:00+09:00");
  check("夜: 空モードの夜になっている", /sky-night/.test(night.cls), night.cls);
  check(
    "夜: 3タブすべてのカードの文字が読める（対比 4.5:1・大きい文字 3:1）",
    night.bad.length === 0,
    `${night.n}要素を走査 ${night.bad.join(" / ")}`,
  );
  check(
    "夜: カードは暗い藍（背景より明るい）",
    night.cardBg === "rgb(43, 51, 101)",
    night.cardBg,
  );
  const day = await scanCards("2026-10-18T12:00:00+09:00");
  check(
    "昼: カードは白のまま",
    day.cardBg === "rgb(255, 255, 255)",
    day.cardBg,
  );
  check(
    "昼: タグ・ボタンの文字は白のまま（--on-accent の既定値）",
    day.badgeColor === "rgb(255, 255, 255)",
    day.badgeColor,
  );
}

/* ポップアップ・シート・操作部品（第5.5節・第6.6節）。
   1) 日程・エリア・絞り込みは、ページの上端で開いても、スクロールしなくても全部見える
      （エリアは会場の一覧だけが中でスクロールする）。
   2) 空モードの昼と夜で、操作バー・3つのポップアップ・カードのメニュー・会場シート・
      お気に入り先頭セクション・調べたサイト一覧の文字が、実際の地の色との対比で読める。
      地の色は color-mix() が返す rgb() ではない形式のこともあるので、canvas で rgb に直して測る。 */
async function scanPanels(isoTime) {
  const ctx = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1280, height: 800 },
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  const t = Date.parse(isoTime);
  await p.addInitScript((t) => {
    const real = Date.now.bind(Date);
    const off = t - real();
    Date.now = () => real() + off;
  }, t);
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.waitForSelector("#list .card");
  await p.waitForTimeout(1500);
  const res = { bad: [], n: 0, fit: [], errs };
  const scan = async (label, sel) => {
    await p.waitForTimeout(400);
    const r = await p.evaluate((rootSel) => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      const parse = (c) => {
        if (!c || c === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
        if (!/^rgba?\(/.test(c)) {
          cx.clearRect(0, 0, 1, 1);
          cx.fillStyle = "#000";
          cx.fillStyle = c;
          cx.fillRect(0, 0, 1, 1);
          const d = cx.getImageData(0, 0, 1, 1).data;
          return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
        }
        const n = c.match(/[\d.]+/g).map(Number);
        return { r: n[0], g: n[1], b: n[2], a: n[3] ?? 1 };
      };
      const lin = (v) =>
        (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      const lum = (c) =>
        0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      const over = (t, b) => ({
        r: t.r * t.a + b.r * (1 - t.a),
        g: t.g * t.a + b.g * (1 - t.a),
        b: t.b * t.a + b.b * (1 - t.a),
        a: 1,
      });
      const bgOf = (el) => {
        const st = [];
        for (let e = el; e; e = e.parentElement) {
          const c = parse(getComputedStyle(e).backgroundColor);
          if (c.a > 0) st.push(c);
          if (c.a >= 1) break;
        }
        let acc = parse(getComputedStyle(document.body).backgroundColor);
        if (acc.a === 0) acc = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = st.length - 1; i >= 0; i--) acc = over(st[i], acc);
        return acc;
      };
      const root = document.querySelector(rootSel);
      if (!root) return { n: 0, bad: ["要素が見つからない " + rootSel] };
      const bad = [];
      let n = 0;
      for (const el of root.querySelectorAll("*")) {
        if (
          ![...el.childNodes].some(
            (c) => c.nodeType === 3 && c.textContent.trim(),
          )
        )
          continue;
        if (el.closest(".sr-only,[hidden],[disabled],[aria-disabled='true']"))
          continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden") continue;
        const bg = bgOf(el);
        const f0 = parse(cs.color);
        const f = f0.a < 1 ? over(f0, bg) : f0;
        const [hi, lo] = [lum(f), lum(bg)].sort((a, b) => b - a);
        const size = parseFloat(cs.fontSize);
        const need =
          size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight) >= 700)
            ? 3
            : 4.5;
        n++;
        const cr = (hi + 0.05) / (lo + 0.05);
        if (cr < need)
          bad.push(
            `${cr.toFixed(1)}:1 .${[...el.classList].join(".")} "${el.textContent.trim().slice(0, 10)}"`,
          );
      }
      return { n, bad: [...new Set(bad)].slice(0, 4) };
    }, sel);
    res.n += r.n;
    for (const b of r.bad) res.bad.push(`${label}: ${b}`);
  };
  const fits = async (label, expectInnerScroll = false) => {
    await p.waitForTimeout(700);
    const m = await p.evaluate(() => {
      const pn = document.getElementById("popoverPanel");
      const r = pn.getBoundingClientRect();
      return {
        open: !pn.hidden,
        ok: r.bottom <= innerHeight && r.top >= 0,
        inner: pn.scrollHeight - pn.clientHeight,
      };
    });
    if (!m.open || !m.ok || (!expectInnerScroll && m.inner > 1))
      res.fit.push(`${label}: ${JSON.stringify(m)}`);
  };
  await scan("ヘッダー", "#hdr");
  await scan("操作バー", ".controls");
  for (const [label, btn] of [
    ["日程", "#sortDateBtn"],
    ["エリア", "#sortLocBtn"],
    ["絞り込み", "#catBtn"],
  ]) {
    await p.evaluate(() => scrollTo(0, 0));
    await p.waitForTimeout(400);
    await p.click(btn);
    await fits(label, label === "エリア");
    await scan(label, "#popoverPanel");
    if (label === "絞り込み") {
      // 押した状態（色つきのチップは地の色が変わる）も測る。押すたびに作り直されるので番号で押す
      for (const i of [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]) {
        await p
          .locator("#catBody .chip:not([disabled])")
          .nth(i)
          .click({ timeout: 3000 })
          .catch(() => {});
        await p.waitForTimeout(150);
      }
      await scan("絞り込み（押した状態）", "#popoverPanel");
    }
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
  }
  await p.evaluate(() => document.getElementById("appliedClear")?.click());
  // 番号で押したチップの中に「お気に入りスポットを先頭にまとめる」の切り替えが含まれ、
  // 設定が変わっている。後の先頭セクションの確認のため、設定を消して読み込み直す
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForSelector("#list .card");
  await p.waitForTimeout(1200);
  await waitAllTabs(p);
  await p.evaluate(() =>
    document.querySelector('#list .card .act-btn[data-act="cal"]').click(),
  );
  await scan("カレンダー追加メニュー", ".cal-menu");
  await p.keyboard.press("Escape");
  await p.evaluate(() =>
    document.querySelector("#list .card .place-link[data-place]")?.click(),
  );
  await p.waitForTimeout(1200);
  await scan("会場シート", "#placeSheet");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  // 先頭の会場は、すでに一覧の先頭にあると「先頭にまとめる」が出ない。離れた会場を選ぶ
  await p.evaluate(() =>
    document.querySelectorAll("#list .star-btn")[12].click(),
  );
  // 負荷の高い環境では、トーストが出る前に押すと何も起きないので、出るのを待つ
  await p.waitForSelector("#favToast.show", { timeout: 8000 }).catch(() => {});
  await p.evaluate(() =>
    document.querySelector("#favToast button.primary")?.click(),
  );
  await p.waitForSelector("#list .fav-head", { timeout: 8000 }).catch(() => {});
  await scan("お気に入り先頭セクション", "#list .fav-head");
  await p.evaluate(() =>
    document.querySelector("section.directory").scrollIntoView(),
  );
  await scan("調べたサイト一覧", "section.directory");
  await scan("注記", "footer");
  res.cls = await p.evaluate(() => document.documentElement.className);
  // キーボードで上へ戻っても、フォーカスが操作バーの下に隠れない（2.4.11）。
  // 縮んだバーのまま、一覧の途中から Shift+Tab で戻り、隠れた回数を数える
  await p.evaluate(() => scrollTo(0, 2400));
  await p.waitForTimeout(800);
  await p.evaluate(() => {
    const t = [...document.querySelectorAll("#list .detail-toggle")].find(
      (e) => e.getBoundingClientRect().top > innerHeight / 2,
    );
    t?.focus({ preventScroll: true });
  });
  res.hidden = 0;
  for (let i = 0; i < 12; i++) {
    await p.keyboard.press("Shift+Tab");
    await p.waitForTimeout(250);
    res.hidden += await p.evaluate(() => {
      const a = document.activeElement;
      const bar = document.querySelector(".controls");
      if (!a || a === document.body || bar.contains(a)) return 0;
      const r = a.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return r.bottom > b.top && r.top < b.bottom ? 1 : 0;
    });
  }
  // ★を付けた人・現在地を使った人にだけ出る部品（チェーンの新作のまとめ行・「ほか◯件を表示」・
  // 現在地の案内）。文字色に --ink を使う部品が多く、夜は暗い地に暗い文字になりやすい
  const favNames = await p.evaluate(async () => {
    const { THEATERS } = await import(
      new URL("assets/js/data.js", location.href).href
    );
    const n = new Map();
    document
      .querySelectorAll("#list .star-btn[data-star]")
      .forEach((b) => n.set(b.dataset.star, (n.get(b.dataset.star) || 0) + 1));
    return [
      THEATERS.find((t) => t.chain)?.name,
      ...[...n.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map((x) => x[0]),
    ].filter(Boolean);
  });
  await p.evaluate(
    (n) => localStorage.setItem("eventboard.favspots.v1", JSON.stringify(n)),
    favNames,
  );
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.waitForSelector("#list .fav-head", { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(800);
  res.favMore = await p.locator("#list > .fav-more").count();
  await scan("先頭セクションの「ほか◯件を表示」", "#list > .fav-more");
  await p.evaluate(() => document.querySelector("#tabMovieBtn").click());
  await p
    .waitForSelector("#movieList > .chain-row", { timeout: 8000 })
    .catch(() => {});
  res.chain = await p.locator("#movieList > .chain-row").count();
  await scan("チェーンの新作のまとめ行", "#movieList > .chain-row");
  await p.evaluate(() => {
    document.querySelector("#tabEventBtn").click();
    navigator.geolocation.getCurrentPosition = (ok) =>
      ok({ coords: { latitude: 35.681, longitude: 139.767 } });
  });
  await p.waitForTimeout(800);
  await p.evaluate(() => document.querySelector("#sortLocBtn").click());
  await p.waitForTimeout(700);
  await p.evaluate(() => document.querySelector("#useMyLocationBtn").click());
  await p
    .waitForSelector("#locateMsg.ok.show", { timeout: 5000 })
    .catch(() => {});
  res.locate = await p.locator("#locateMsg.ok.show").count();
  await scan("エリア（現在地を取得した）", "#popoverPanel");
  await ctx.close();
  return res;
}
{
  for (const [name, iso, expectNight] of [
    ["昼", "2026-10-18T12:00:00+09:00", false],
    ["夕方（薄明）", "2026-10-18T17:36:00+09:00", false],
    ["朝", "2026-10-18T06:35:00+09:00", false],
    ["夜", "2026-10-18T20:30:00+09:00", true],
  ]) {
    const r = await scanPanels(iso);
    check(
      `${name}: 空モードの${expectNight ? "夜" : "昼"}になっている`,
      /sky-page/.test(r.cls) && /sky-night/.test(r.cls) === expectNight,
      r.cls,
    );
    check(
      `${name}: 日程・エリア・絞り込みが、先頭で開いてもスクロールなしで全部見える`,
      r.fit.length === 0,
      r.fit.join(" / "),
    );
    check(
      `${name}: 操作部品・ポップアップ・シート・先頭セクション・一覧の文字が読める`,
      r.bad.length === 0,
      `${r.n}要素を走査 ${r.bad.slice(0, 4).join(" / ")}`,
    );
    check(
      `${name}: ★を付けた状態の部品（まとめ行・ほか◯件を表示）と現在地の案内が出る（文字の走査の対象になっている）`,
      r.chain > 0 && r.favMore > 0 && r.locate > 0,
      `まとめ行 ${r.chain}・ほか◯件 ${r.favMore}・現在地 ${r.locate}`,
    );
    check(
      `${name}: キーボードで上へ戻っても、フォーカスが操作バーの下に隠れない`,
      r.hidden === 0,
      `隠れた ${r.hidden}回`,
    );
    check(`${name}: ページエラーが無い`, r.errs.length === 0, r.errs.join("|"));
  }
}

/* 操作バーの縮小（第4.4節）。縮んだ分を埋める余白が、バーと一覧の間の空白として見えないこと。
   余白はバーの元の位置（ヘッダーの真下）の下に付くので、バーがまだ張り付いていないうちに
   縮めたり、縮んだまま上へ戻ったりすると見える。描かれたコマごとに測る（rAF のあとの
   setTimeout で、そのコマの処理が終わった状態を見る）。縮小・復元で一覧がずれないことも併せて見る */
{
  const ctx = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.waitForSelector("#list .card");
  await p.waitForTimeout(1500);
  await p.evaluate(() => {
    window.__gaps = [];
    window.__shifts = [];
    const bar = document.querySelector(".controls");
    const main = document.getElementById("mainContent");
    let last = null;
    const tick = () => {
      const b = bar.getBoundingClientRect();
      const m = main.getBoundingClientRect().top;
      if (m - b.bottom > 1.5 && b.bottom < innerHeight)
        window.__gaps.push(`y=${scrollY} 空白${Math.round(m - b.bottom)}px`);
      const doc = m + scrollY;
      if (last !== null && Math.abs(doc - last) > 1.5)
        window.__shifts.push(`y=${scrollY} ${Math.round(doc - last)}px`);
      last = doc;
      requestAnimationFrame(() => setTimeout(tick, 0));
    };
    tick();
  });
  const wheel = async (dy, n, ms = 40) => {
    for (let i = 0; i < n; i++) {
      await p.mouse.wheel(0, dy);
      await p.waitForTimeout(ms);
    }
  };
  await wheel(30, 10); // バーが張り付く前後
  await wheel(-30, 5);
  await wheel(60, 20);
  await wheel(-3, 50, 20); // 指でゆっくり戻す
  await wheel(60, 20);
  await p.evaluate(() => scrollTo(0, 240)); // 縮んだまま一度に上へ飛ぶ
  await p.waitForTimeout(500);
  await wheel(5, 40, 20);
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => ({ g: window.__gaps, s: window.__shifts }));
  check(
    "スマホ: 操作バーが縮んでも、バーと一覧の間に空白が出ない",
    r.g.length === 0,
    r.g.slice(0, 3).join(" / "),
  );
  check(
    "スマホ: 操作バーの縮小・復元で一覧がずれない",
    r.s.length === 0,
    r.s.slice(0, 3).join(" / "),
  );
  // 先頭で開いたポップアップは、ページを送ってバーを縮め、パネルの高さを確保する
  await p.evaluate(() => scrollTo(0, 0));
  await p.waitForTimeout(600);
  await p.click("#catBtn");
  await p.waitForTimeout(900);
  check(
    "スマホ: 先頭で開いたポップアップでは操作バーが縮む",
    await p.evaluate(() =>
      document.querySelector(".controls").classList.contains("compact"),
    ),
  );
  await ctx.close();
}

check(
  "コンソールエラーが無い",
  consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(" / "),
);

await browser.close();
console.log(
  `\n${failures.length ? "失敗: " + failures.join(", ") : "すべて通過"}\n`,
);
process.exit(failures.length ? 1 : 0);
