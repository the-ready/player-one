/* フェスの日割りラインナップ（設計書 第12.12節）の回帰テスト。

   smoke_test.mjs はブラウザ（Playwright）を要求するが、この層で壊れやすいのは
   描画ではなく**データの繋ぎ**である——lives.csv と lineups.csv の参照、検索の索引、
   カードのボタンに出す組数。そこはDOMなしで確かめられるので、Nodeだけで走らせる。

   使い方（リポジトリのルートから）:
     node tools/lineup_test.mjs
*/

import fs from "node:fs";

/* ブラウザの fetch をローカルのファイル読み出しに差し替える。
   data.js は `./data/*.csv` を相対パスで取りに行くので、ルートから走らせること。 */
globalThis.fetch = async (p) => {
  const path = String(p).replace(/^\.\//, "");
  if (!fs.existsSync(path))
    return { ok: false, status: 404, headers: { get: () => null } };
  const text = fs.readFileSync(path, "utf8");
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};

/* 最小のDOMスタブ。どのidを引いても同じ形の偽要素を返し、innerHTML だけ本物として保持する。
   シートは「何を組み立てたか」が見られれば十分で、レイアウトはここでは見ない。 */
const make = () => ({
  hidden: true,
  innerHTML: "",
  textContent: "",
  style: {},
  scrollTop: 0,
  dataset: {},
  offsetParent: {},
  addEventListener() {},
  removeAttribute() {},
  setAttribute() {},
  focus() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  contains: () => false,
  closest: () => null,
  getBoundingClientRect: () => ({ left: 0, width: 0 }),
});
const els = new Map();
const el = (k) => {
  if (!els.has(k)) els.set(k, make());
  return els.get(k);
};
globalThis.document = {
  getElementById: el,
  querySelector: el,
  querySelectorAll: () => [],
  addEventListener() {},
  body: { style: {} },
  activeElement: null,
};
globalThis.window = {
  matchMedia: () => ({ matches: true }),
  addEventListener() {},
  scrollY: 0,
};

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}${detail ? "  — " + detail : ""}`,
  );
  if (!ok) failures.push(name);
};

const { loadTab, ITEMS, lineupRows, lineupArtistNames } =
  await import("../assets/js/data.js");
const { TABS } = await import("../assets/js/config.js");
const { cardHtml } = await import("../assets/js/cards.js");
const { searchTerms } = await import("../assets/js/util.js");
const { initPopover } = await import("../assets/js/ui-popover.js");
const { initLineupSheet, openLineupSheet } =
  await import("../assets/js/ui-lineup.js");

await loadTab("live");
initPopover({});
initLineupSheet();

const st = { sortBy: "date", flags: {} };
const fes = ITEMS.live.filter((i) => i.lineupId);

console.log("\n--- 参照 ---");
check("lineup_id を持つ公演がある", fes.length > 0, `${fes.length}件`);
for (const f of fes) {
  const rows = lineupRows(f.lineupId);
  const days = [...new Set(rows.map((r) => r.date))].filter(Boolean);
  // 会期の外の日付は、開催しない日のタブを作ってしまう（validate_data.py も同じ検査をする）
  const outside = days.filter(
    (d) => d < f.startDate || d > (f.endDate || f.startDate),
  );
  check(
    `${f.lineupId}`,
    rows.length > 0 && outside.length === 0,
    `${lineupArtistNames(f.lineupId).length}組 ${days.length}日` +
      (outside.length ? ` 会期外の日付 ${outside}` : ""),
  );
}

console.log("\n--- カード ---");
const big = fes.reduce((a, b) =>
  lineupArtistNames(a.lineupId).length > lineupArtistNames(b.lineupId).length
    ? a
    : b,
);
const total = lineupArtistNames(big.lineupId).length;
const line = cardHtml(TABS.live, big, st, []).match(
  /<p class="lineup-line">[\s\S]*?<\/p>/,
)[0];
check("ボタンが出る", line.includes("lineup-btn"), big.lineupId);
check(
  "組数がラインナップの総数",
  line.includes(`全${total}組`),
  `全${total}組`,
);
// 検索していないときは出演者を列挙せず、ボタンだけを出す（第12.12節）
check("出演者を列挙しない（ボタンだけ）", !line.includes("出演："));

const solo = ITEMS.live.find(
  (i) => !i.lineupId && (i.artists || []).length < 2,
);
check(
  "単独公演にはボタンが出ない",
  solo && !cardHtml(TABS.live, solo, st, []).includes("lineup-btn"),
);

console.log("\n--- 検索 ---");
/* この層の主目的。artists 列の8組に入っていないアーティストで検索して、
   カードが出ること／その名前が出演者行の先頭に繰り上がること。 */
const deep = lineupArtistNames(big.lineupId).find(
  (n) => !(big.artists || []).includes(n) && /^[\w.\- ]{4,}$/.test(n),
);
const terms = searchTerms(deep);
check(
  "ラインナップのアーティスト名が索引に入る",
  terms.every((t) => big._fold.includes(t)),
  deep,
);
check(
  "検索語に当たる出演者が先頭に繰り上がる",
  /<mark>/.test(
    cardHtml(TABS.live, big, st, terms).match(
      /<p class="lineup-line">[\s\S]*?<\/p>/,
    )[0],
  ),
);

console.log("\n--- シート ---");
openLineupSheet(big);
const body = el("lineupBody").innerHTML;
const tabs = el("lineupDayTabs");
check("日タブが出る", !tabs.hidden && tabs.innerHTML.includes('role="tab"'));
check(
  "選択中の日が1つだけ",
  (tabs.innerHTML.match(/aria-selected="true"/g) || []).length === 1,
);
check("出演者が並ぶ", (body.match(/lu-name/g) || []).length > 0);
// ♪ は必ず出る。検証済みURLが無い行は表示側が検索URLを組み立てるため
check(
  "全員に Apple Music リンクが出る",
  (body.match(/lu-am/g) || []).length === (body.match(/lu-name/g) || []).length,
);
check("検索URLに落ちる行がある", body.includes("music.apple.com/jp/search"));

console.log(
  failures.length
    ? `\nNG ${failures.length}件: ${failures.join(", ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
