/* 映画の同時開催のまとめの回帰テスト。DOM不要。

   シネマ歌舞伎のように、同じ作品を関東の複数館が同じ週に一斉上映する行は、`special` の
   `theater` が具体的な劇場名という規則のため1館1行で持つ。画面はこれを1枚にまとめる。
     1. series_id・題名・会期がすべて同じ行だけをまとめる（どれか1つでも違えばまとめない）
     2. 同じ series_id でも題名が違えば（特集上映の束ね）まとめない
     3. まとめたカードの「他の会場」に、同じカードの仲間を数えない
     4. 行は欠けない

   使い方（リポジトリのルートから）:
     node tools/movie_group_test.mjs
*/

import fs from "node:fs";

const SYNTH = new Map();
globalThis.fetch = async (p) => {
  const path = String(p).replace(/^\.\//, "");
  const text = SYNTH.has(path)
    ? SYNTH.get(path)
    : fs.existsSync(path)
      ? fs.readFileSync(path, "utf8")
      : null;
  if (text == null)
    return { ok: false, status: 404, headers: { get: () => null } };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const els = new Map();
const el = (k) => {
  if (!els.has(k))
    els.set(k, {
      hidden: true,
      textContent: "",
      innerHTML: "",
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute() {},
      // 一覧の差し替えを省くかの判定（render.js の setListHtml）が、開いたカードとフォーカスを見る
      querySelector: () => null,
      contains: () => false,
    });
  return els.get(k);
};
globalThis.document = {
  getElementById: el,
  querySelector: el,
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.window = {
  matchMedia: () => ({ matches: true }),
  addEventListener() {},
};

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}${detail ? "  — " + detail : ""}`,
  );
  if (!ok) failures.push(name);
};

const D = await import("../assets/js/data.js");
const ST = await import("../assets/js/state.js");
const F = await import("../assets/js/filters.js");
const R = await import("../assets/js/render.js");

const realHead = fs.readFileSync("data/movies.csv", "utf8").split(/\r?\n/)[0];
const COLS = realHead.split(",").map((c) => c.replace(/"/g, ""));
const day = (n) => {
  const d = new Date(D.TODAY() + "T00:00:00");
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
let nextId = 1;
const mvRow = (o) =>
  COLS.map((c) =>
    q(
      {
        id: nextId++,
        genre: "jp-live",
        screening_type: "special",
        pref: "saitama",
        area: "埼玉県・さいたま市",
        source: "公式サイト",
        release_date: day(1),
        end_date: day(7),
        ...o,
      }[c],
    ),
  ).join(",");

const rows = [
  // 同じ作品・同じ週に3館（まとまる）
  ...["A館", "B館", "C館"].map((t) =>
    mvRow({ title: "歌舞伎甲", theater: t, series_id: "s-kabuki" }),
  ),
  // 同じ series_id・同じ会期でも題名が違う（まとめない）
  mvRow({ title: "歌舞伎乙", theater: "A館", series_id: "s-kabuki" }),
  // 同じ題名・同じ series_id でも会期が違う（まとめない）
  mvRow({
    title: "歌舞伎甲",
    theater: "D館",
    series_id: "s-kabuki",
    release_date: day(20),
    end_date: day(26),
  }),
  // series_id が空（まとめない）
  mvRow({ title: "単独", theater: "A館" }),
  mvRow({ title: "単独", theater: "B館" }),
  // チェーン名だけの行（複数館で一斉上映する特別上映）。エリアは代表の1館のもの
  mvRow({
    title: "一斉上映",
    theater: "MOVIX|109シネマズ",
    area: "東京都・葛飾区",
    series_id: "s-chain",
  }),
];
SYNTH.set("data/movies.csv", [realHead, ...rows].join("\n") + "\n");
SYNTH.set("data/spots.csv", "name,kind,pref,area,lat,lng,url,parking,status\n");
SYNTH.set(
  "data/venues.csv",
  "venue,kind,pref,area,capacity,lat,lng,url,parking,status\n",
);
SYNTH.set(
  "data/theaters.csv",
  "chain,name,pref,area,lat,lng,url,parking,status\n" +
    "MOVIX,MOVIX亀有,tokyo,東京都・葛飾区,35.7653,139.8524,,,active\n" +
    "109シネマズ,109シネマズ湘南,kanagawa,神奈川県・藤沢市,35.339,139.446,,,active\n",
);
await Promise.all([D.loadSpots(), D.loadTheaters(), D.loadVenues()]);
await D.loadTab("movie");

ST.resetState("movie");
ST.setActiveTabKey("movie");
const vis = R.visibleItems("movie");
const entries = F.mergeSimultaneous(vis);
const kou = entries.filter(
  (e) => e.rep.title === "歌舞伎甲" && e.members.length > 1,
);
check(
  "題名・series_id・会期が同じ3館が1枚にまとまる",
  kou.length === 1 && kou[0].members.length === 3,
  kou.map((e) => e.members.length).join(","),
);
check(
  "会期が違う同題の行はまとめない",
  entries.filter((e) => e.rep.title === "歌舞伎甲").length === 2,
);
check(
  "同じ series_id・同じ会期でも題名が違えばまとめない",
  entries.filter((e) => e.rep.title === "歌舞伎乙").length === 1,
);
check(
  "series_id が空ならまとめない",
  entries.filter((e) => e.rep.title === "単独").length === 2,
);
check(
  "まとめても行は欠けない",
  entries.reduce((n, e) => n + e.members.length, 0) === vis.length,
  `${vis.length}行`,
);
const rep = kou[0].rep;
check(
  "他の会場に、同じカードの仲間を数えない",
  F.seriesSiblings(rep, kou[0].members).every(
    (s) => !kou[0].members.some((m) => m.key === s.key),
  ) && F.seriesSiblings(rep).length === 4,
  `${F.seriesSiblings(rep, kou[0].members).length}件`,
);

{
  const html = (() => {
    R.renderList();
    return els.get("movieList")?.innerHTML || "";
  })();
  const card = html.split("<article").find((c) => c.includes("一斉上映")) || "";
  check(
    "チェーン名だけの行は、代表の1館のエリアを出さない",
    card.includes("MOVIX") && !card.includes("東京都・葛飾区"),
    card ? "" : "カードが描かれていない",
  );
  const single =
    html.split("<article").find((c) => c.includes("歌舞伎乙")) || "";
  check(
    "具体的な劇場名の行は、エリアを出す（A館／エリア）",
    single.includes("A館") && single.includes("埼玉"),
  );
}

console.log(
  failures.length
    ? `\n失敗 ${failures.length}件:\n  - ${failures.join("\n  - ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
