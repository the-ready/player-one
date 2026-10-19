/* 空モードのとき、ページ全体の背景色をヘッダーの空に合わせる（設計書 第6.5.1節）。
   DOM を触る部分と色を決める部分を分けてあり、色の計算は node でテストできる
   （tools/page_sky_test.mjs）。壁紙の毎分の更新（wallpaper.js の paint）から呼ばれる。

   昼〜薄明は、空の色を紙色で薄めて使う。黒インクの文字がそのまま読める明るさを
   保つのが役目で、空の色そのものを塗るわけではない。
   夜は深い藍にし、カード・ポップアップはそれより明るい藍にする（カードのほうが明るい見た目）。 */

const PAPER = "#fbf8f1";
// 夜の切り替えは、ヘッダーの文字が白に変わる太陽高度（wallpaper.js の wp-night）と同じ
export const NIGHT_ALT = -4;
// 地の上に直接のる文字の色（app.css の --page-text。昼は #3f3b36）
export const PAGE_TEXT_DAY = "#3f3b36";
export const PAGE_TEXT_NIGHT = "#e8e6f3";
// 昼〜薄明で、空の色を紙色へ寄せる追加の割合
const PALE = 0.65;
const NIGHT_BG = "#161b3a";
const NIGHT_BG2 = "#11152f";

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (c) =>
  "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => {
  const A = hex2rgb(a),
    B = hex2rgb(b);
  return rgb2hex(A.map((v, i) => v + (B[i] - v) * t));
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* sky: [天頂, 中ほど, 地平] の色（wallpaper.js の paletteAt が返すもの）。
   返り値: { night, bg, bg2 }。bg が本体の色、bg2 はページ上端側の色。 */
export function pageSky(sky, altDeg) {
  if (altDeg < NIGHT_ALT) return { night: true, bg: NIGHT_BG, bg2: NIGHT_BG2 };
  const [top, mid, bot] = sky;
  // 太陽が高いほど天頂の青を、低いほど地平近くの暖色を多く取る
  const hi = clamp(altDeg / 25, 0, 1);
  // 薄明は空そのものが暗いので、そのぶん紙色を多く混ぜる。地の上の文字が読める下限を守るため
  const paper = 0.42 + 0.14 * clamp((8 - altDeg) / 12, 0, 1);
  // ページ全体の背景は、その上にポップアップ・ボタン・カードが載る面なので、空の色みは
  // うっすら残る程度にとどめる。紙色へさらに6割5分寄せる（空の色 c に対し、
  // mix(mix(c, 紙, paper), 紙, 0.65) = mix(c, 紙, 1 - (1 - paper) * 0.35)）
  const faint = (p) => 1 - (1 - p) * (1 - PALE);
  return {
    night: false,
    bg: mix(mix(mid, top, hi), PAPER, faint(paper)),
    bg2: mix(mix(bot, mid, hi), PAPER, faint(paper + 0.08)),
  };
}

let animArmed = false;
export function applyPageSky(sky, altDeg, root = document.documentElement) {
  const p = pageSky(sky, altDeg);
  root.style.setProperty("--page-bg", p.bg);
  root.style.setProperty("--page-bg-2", p.bg2);
  root.classList.add("sky-page");
  root.classList.toggle("sky-night", p.night);
  // 色の遷移は最初の描画のあとから。読み込み直後に紙色から移る様子を見せない
  if (!animArmed) {
    animArmed = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => root.classList.add("sky-anim")),
    );
  }
}

// 水玉に戻したとき。クラスと変数を外せば、素の紙色に戻る
export function clearPageSky(root = document.documentElement) {
  root.style.removeProperty("--page-bg");
  root.style.removeProperty("--page-bg-2");
  root.classList.remove("sky-page", "sky-night", "sky-anim");
  animArmed = false;
}
