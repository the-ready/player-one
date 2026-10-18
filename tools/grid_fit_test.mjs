/* 一覧グリッドの詰め方（grid-fit.js の planPacking）の回帰テスト。DOM不要。

   「開いたカードだけが伸びる」は、見た目では気づきにくい壊れ方をする
   （隣の列まで押し下げる・カード同士が重なる・閉じても元に戻らない）。
   位置の計算だけを切り出してあるので、その約束を数字で固定する。

   使い方（リポジトリのルートから）:
     node tools/grid_fit_test.mjs
*/

import { planPacking } from "../assets/js/grid-fit.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}${detail ? "  — " + detail : ""}`,
  );
  if (!ok) failed++;
};

const GAP = 26;
const card = (closed, extra = 0) => ({ full: false, closed, extra });
const full = (h) => ({ full: true, closed: h, extra: 0 });
const bottom = (p) => p.row + p.span;

// 1. 閉じているだけなら、行ごとに最大の高さへ揃い、各列は同じ位置から始まる
{
  const p = planPacking(
    [card(300), card(320), card(280), card(300), card(300), card(300)],
    3,
    GAP,
  );
  check(
    "閉じた状態: 1行目の3枚は同じ位置から始まる",
    p[0].row === p[1].row && p[1].row === p[2].row,
  );
  check(
    "閉じた状態: 行内の高さは最大に揃う",
    p[0].minHeight === 320 && p[2].minHeight === 320,
  );
  check(
    "閉じた状態: 2行目は1行目の高さの下から始まる",
    p[3].row === p[0].row + p[0].span,
  );
  check(
    "閉じた状態: 列は 1,2,3,1,2,3",
    p.map((x) => x.col).join() === "1,2,3,1,2,3",
  );
}

// 2. 1枚を開く。開いたカードだけが伸び、ほかの列の位置は変わらない
{
  const closed = planPacking(
    [card(300), card(300), card(300), card(300), card(300), card(300)],
    3,
    GAP,
  );
  const open = planPacking(
    [card(300), card(300), card(300, 200), card(300), card(300), card(300)],
    3,
    GAP,
  );
  check(
    "開く: 開いたカードの高さだけが増える",
    open[2].minHeight === 500 &&
      open.filter((x, i) => i !== 2).every((x, i) => x.minHeight === 300),
  );
  check(
    "開く: 同じ行の他の2枚は位置も高さも変わらない",
    [0, 1].every(
      (i) => open[i].row === closed[i].row && open[i].span === closed[i].span,
    ),
  );
  check(
    "開く: 同じ列の下のカードは開いた分だけ下がる",
    open[5].row - closed[5].row === 200,
  );
  check(
    "開く: ほかの列の下のカードは動かない",
    [3, 4].every((i) => open[i].row === closed[i].row),
  );
}

// 3. 開いたカードを閉じると、計算結果は完全に元へ戻る
{
  const items = [
    card(300),
    card(310),
    card(290),
    card(300),
    card(300),
    card(300),
    card(300),
  ];
  const a = planPacking(items, 3, GAP);
  const b = planPacking(
    items.map((x) => ({ ...x, extra: 0 })),
    3,
    GAP,
  );
  check("閉じ直す: 元と同じ配置", JSON.stringify(a) === JSON.stringify(b));
}

// 4. 同じ列に重ならない（どの列でも、前のカードの下端 ≤ 次のカードの上端）
{
  const items = [
    card(300, 120),
    card(310),
    card(290, 400),
    card(300),
    card(300, 80),
    card(300),
    card(300),
    card(300, 50),
    card(300),
  ];
  const p = planPacking(items, 3, GAP);
  let ok = true;
  for (let c = 1; c <= 3; c++) {
    const col = p.filter((x) => x.col === c);
    for (let i = 1; i < col.length; i++)
      if (col[i].row < bottom(col[i - 1])) ok = false;
  }
  check("重ならない: どの列でも上から順に積まれる", ok);
  check(
    "重ならない: span は高さ+間隔以上",
    p.every((x) => x.span >= x.minHeight + GAP),
  );
}

// 5. 全幅の要素（見出し・区切り）は、その時点でいちばん下の列の下に置く
{
  const items = [
    card(300, 200),
    card(300),
    card(300),
    full(40),
    card(300),
    card(300),
    card(300),
  ];
  const p = planPacking(items, 3, GAP);
  check("全幅: 開いた列の下端より下に置く", p[3].row >= bottom(p[0]));
  check("全幅: 全幅の要素は col を持たない", p[3].col === null);
  check(
    "全幅: 次の段は全列そろって全幅の下から始まる",
    [4, 5, 6].every((i) => p[i].row === bottom(p[3])),
  );
}

// 6. 論理行は全幅の要素ごとに数え直す（段の途中の枚数が cols で割り切れなくても崩れない）
{
  const items = [
    card(300),
    card(300),
    full(40),
    card(300),
    card(300),
    card(300),
    card(300),
  ];
  const p = planPacking(items, 3, GAP);
  check(
    "段の数え直し: 全幅のあとは1列目から始まる",
    p[3].col === 1 && p[4].col === 2 && p[5].col === 3 && p[6].col === 1,
  );
}

// 7. 2列・開いたカードが2枚（同じ列）
{
  const items = [card(300, 100), card(300), card(300, 150), card(300)];
  const p = planPacking(items, 2, GAP);
  check(
    "2列: 同じ列の2枚を開くと、足した分が積み上がる",
    p[2].row - (1 + 300 + 100 + GAP) === 0 && p[3].row === 1 + 300 + GAP,
  );
}

// 7b. 間隔が小数でも span は整数（小数の span は CSS が宣言ごと捨てるので、位置指定が効かなくなる）
{
  const p = planPacking(
    [card(300.4), card(300), full(40.2), card(300, 10.5)],
    2,
    25.6,
  );
  check(
    "小数: span と row がすべて整数",
    p.every((x) => Number.isInteger(x.span) && Number.isInteger(x.row)),
    JSON.stringify(p.map((x) => [x.row, x.span])),
  );
  check(
    "小数: 間隔ぶんを含む",
    p.every((x, i) => x.span >= (i === 2 ? 40.2 : x.minHeight) + 25.6),
  );
}

// 8. 空・1枚
{
  check("空", planPacking([], 3, GAP).length === 0);
  const p = planPacking([card(300, 50)], 3, GAP);
  check(
    "1枚だけ開く",
    p.length === 1 && p[0].minHeight === 350 && p[0].row === 1,
  );
}

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nすべて通りました");
