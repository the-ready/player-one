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
const chips = await page.locator("#catBody .chip").count();
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
const card = page.locator("#liveList .card").first();
check("操作ボタンは3つ", (await card.locator(".act-btn").count()) === 3);
check(
  "操作ボタンに文字を持たせていない",
  (await card.locator(".act-btn").first().innerText()).trim() === "",
);
check(
  "操作ボタンが「くわしく」と同じ行にある",
  await card.evaluate((el) => {
    const actions = el.querySelector(".card-actions");
    return !!actions && !!actions.closest(".detail-row");
  }),
);
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
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("メニューが閉じる", (await page.locator(".cal-menu").count()) === 0);
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
