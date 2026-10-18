/* 一覧グリッドの詰め方。「くわしく」を開いたカードだけを縦に伸ばし、同じ行の
   ほかのカードは伸ばさない（設計書 第5.6.1節）。

   CSS Grid の行は、その行にいちばん背の高いカードに合わせて全員を引き伸ばす。
   これを避けるには、列ごとに独立して積む（masonry）必要があるが、`grid-template-rows:
   masonry` はまだ主要ブラウザに無い。そこで行を 1px の細い行に刻み、カードごとに
   「何行ぶん使うか」を JS が指定する。

   - 閉じたカードの高さは、今まで通り「論理的な行」のいちばん高いものに揃える
     （ボタンの下辺が横一列に並ぶ約束を守るため）。
   - 開いたカードには、開いた分（説明の高さ）だけを足す。ほかの列は動かない。
   - 全列にまたがる要素（お気に入りの見出し・区切り・空表示）は、その時点の
     いちばん下の列の下に置く。
   - 1列表示（スマホ）では何もしない。そもそも縦に1枚ずつ積むので、開いたカードが
     伸びるだけで済む。 */

/* 計算だけを切り出してある。DOM を持たないので node でテストできる（tools/grid_fit_test.mjs）。
   items: [{ full, closed, extra }]
     full   … 全列にまたがる要素か。そのとき closed はマージン込みの高さ
     closed … 閉じた状態の高さ（px）
     extra  … 開いた分の増加（px）。閉じているカードは 0
   返り値: items と同じ順の [{ col, row, span, minHeight }]（col は 1 始まり、full は null）。
   row は 1px 行の開始位置（1 始まり）、span は行数（gap を含む）。 */
export function planPacking(items, cols, gap) {
  const bottoms = new Array(cols).fill(1);
  const out = new Array(items.length);

  // 全幅の要素で区切った「段」ごとに、cols 枚ずつを1つの論理行として扱う
  let seg = [];
  const flush = () => {
    if (!seg.length) return;
    for (let r = 0; r < seg.length; r += cols) {
      const row = seg.slice(r, r + cols);
      const base = Math.max(...row.map((i) => items[i].closed));
      row.forEach((i, c) => {
        const h = base + items[i].extra;
        // grid-row の span は整数しか受け付けない（小数だと宣言ごと捨てられる）。gap は rem 由来で小数になる
        const span = Math.ceil(h + gap);
        out[i] = { col: c + 1, row: bottoms[c], span, minHeight: h };
        bottoms[c] += span;
      });
      // 論理行の途中で終わる最後の行は、使われなかった列の位置を進めない
    }
    seg = [];
  };

  items.forEach((it, i) => {
    if (!it.full) {
      seg.push(i);
      return;
    }
    flush();
    const top = Math.max(...bottoms);
    const span = Math.ceil(it.closed + gap);
    out[i] = { col: null, row: top, span, minHeight: 0 };
    bottoms.fill(top + span);
  });
  flush();
  return out;
}

/* ---------- DOM ---------- */

const FALLBACK_GAP = 26; // 1.6rem（16px 基準）
const lastWidth = new WeakMap();
// 直前に測った結果。「くわしく」の開閉では、そのカード1枚だけを測り直して使い回す
// （全カードを測り直すと、一覧全体のレイアウトを2回走らせることになり重い）
const measured = new WeakMap();

function columnCount(grid) {
  const tracks = getComputedStyle(grid)
    .gridTemplateColumns.split(/\s+/)
    .filter((t) => /^[\d.]+px$/.test(t));
  return tracks.length;
}

// 行の間隔は CSS の --row-gap（rem）が持つ。詰めている間は row-gap を 0 にして
// カードごとの span に含めるので、JS が値を読み出す。
function rowGapPx(grid) {
  const v = getComputedStyle(grid).getPropertyValue("--row-gap").trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return FALLBACK_GAP;
  if (v.endsWith("rem")) {
    return n * parseFloat(getComputedStyle(document.documentElement).fontSize);
  }
  return n;
}

function clear(el) {
  el.style.gridColumn = "";
  el.style.gridRow = "";
  el.style.minHeight = "";
}

export function unpackGrid(grid) {
  measured.delete(grid);
  if (!grid.classList.contains("is-packed")) return;
  grid.classList.remove("is-packed");
  for (const k of grid.children) clear(k);
}

function apply(kids, plan, prev) {
  kids.forEach((k, i) => {
    const p = plan[i];
    const col = p.col ? String(p.col) : "1 / -1";
    const row = `${p.row} / span ${p.span}`;
    const min = p.minHeight ? `${p.minHeight}px` : "";
    const q = prev?.[i];
    if (!q || q.col !== col) k.style.gridColumn = col;
    if (!q || q.row !== row) k.style.gridRow = row;
    if (!q || q.min !== min) k.style.minHeight = min;
  });
  return plan.map((p) => ({
    col: p.col ? String(p.col) : "1 / -1",
    row: `${p.row} / span ${p.span}`,
    min: p.minHeight ? `${p.minHeight}px` : "",
  }));
}

export function fitGrid(grid) {
  // 非表示のタブは幅が 0。列数が読めないので、表示されたとき（ResizeObserver）に引き直す
  if (!grid.offsetWidth) return;
  const kids = [...grid.children];
  if (!kids.some((k) => k.classList.contains("card"))) {
    unpackGrid(grid);
    return;
  }
  // 列数は、指定済みの位置を外してから数える。幅が狭まったあとに前回の「3列目」の指定が
  // 残っていると、そのために暗黙の列が作られ、列数が前のままに見えてしまう
  for (const k of kids) clear(k);
  const cols = columnCount(grid);
  if (cols < 2) {
    unpackGrid(grid);
    return;
  }
  const gap = rowGapPx(grid);

  grid.classList.add("is-packed");

  // 測る（ここで1回だけレイアウトが走る）。開いているカードだけ、閉じた高さも測る
  const items = kids.map((k) => {
    if (!k.classList.contains("card")) {
      const cs = getComputedStyle(k);
      return {
        full: true,
        closed:
          k.offsetHeight +
          (parseFloat(cs.marginTop) || 0) +
          (parseFloat(cs.marginBottom) || 0),
        extra: 0,
      };
    }
    return { full: false, closed: k.offsetHeight, extra: 0 };
  });
  kids.forEach((k, i) => {
    const desc = k.querySelector(".desc.open");
    if (!desc || items[i].full) return;
    const opened = items[i].closed;
    desc.classList.remove("open");
    items[i].closed = k.offsetHeight;
    desc.classList.add("open");
    items[i].extra = Math.max(0, opened - items[i].closed);
  });

  const plan = planPacking(items, cols, gap);
  const applied = apply(kids, plan, null);
  measured.set(grid, { kids, items, cols, gap, applied });
  lastWidth.set(grid, grid.offsetWidth);
}

/* 「くわしく」を押したカード1枚だけを測り直して、位置を計算し直す。
   直前の測定が使えないとき（一覧が差し替わった・列数が変わった）は全体を引き直す。 */
export function refitCard(grid, card) {
  const m = measured.get(grid);
  const i = m ? m.kids.indexOf(card) : -1;
  if (
    i < 0 ||
    grid.children.length !== m.kids.length ||
    columnCount(grid) !== m.cols
  ) {
    fitGrid(grid);
    return;
  }
  const item = m.items[i];
  if (card.querySelector(".desc.open")) {
    card.style.minHeight = ""; // 自然な高さを測るため、指定した高さを外す
    m.applied[i] = { ...m.applied[i], min: null }; // 外したので、次の書き込みを必ず通す
    item.extra = Math.max(0, card.offsetHeight - item.closed);
  } else {
    item.extra = 0;
  }
  m.applied = apply(m.kids, planPacking(m.items, m.cols, m.gap), m.applied);
}

/* 一覧の中身が差し替わったとき・幅が変わったとき・Webフォントが届いたときに引き直す。
   中身の差し替え（innerHTML）は描画前に走るマイクロタスクで拾うので、
   詰める前の並びが一瞬映ることはない。 */
export function watchGrid(grid) {
  new MutationObserver(() => fitGrid(grid)).observe(grid, { childList: true });
  new ResizeObserver(() => {
    // 自分が高さを変えたときの通知は無視する（幅が変わったときだけ引き直す）
    if (grid.offsetWidth !== lastWidth.get(grid)) fitGrid(grid);
  }).observe(grid);
  document.fonts?.ready?.then(() => fitGrid(grid));
  fitGrid(grid);
}
