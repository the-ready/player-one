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
// 「お気に入りスポットを先頭にまとめる」は絞り込みではなく見え方の設定なので件数を持たない
const chips = await page
  .locator('#catBody .chip:not([data-key="__pinFav"])')
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
  "管理シートに登録した場所が出る",
  (await page.locator("#favSheet").isVisible()) &&
    (await page.locator("#favSheetBody .vr-name").first().innerText()) ===
      spotName,
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("管理シートが閉じる", !(await page.locator("#favSheet").isVisible()));
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
