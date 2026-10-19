/* 空モードのページ背景（page-sky.js の pageSky）の回帰テスト。DOM不要。

   背景は空から決まるが、黒インクの文字が読めなくなっては意味が無い。昼〜薄明の背景が
   十分明るいこと、夜はヘッダーの文字色の切り替え（太陽高度 -4°）と同じ所で変わることを固定する。

   使い方（リポジトリのルートから）:
     node tools/page_sky_test.mjs
*/

import {
  pageSky,
  NIGHT_ALT,
  PAGE_TEXT_DAY,
  PAGE_TEXT_NIGHT,
} from "../assets/js/page-sky.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}${detail ? "  — " + detail : ""}`,
  );
  if (!ok) failed++;
};

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (v) =>
  (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const lum = (h) => {
  const [r, g, b] = rgb(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// wallpaper.js の PALETTE から、代表的な高度の空（天頂・中ほど・地平）を写したもの
const SKIES = {
  noon: [45, ["#a9d0e2", "#d5e5e2", "#f3ecd9"]],
  morning: [4.6, ["#8fabcd", "#e5b79f", "#f7d9ae"]],
  sunset: [-1, ["#4a5c93", "#9a7099", "#e0908a"]],
  dusk: [-3.9, ["#2b3566", "#5a4d84", "#9a6a86"]],
};
const HEX = /^#[0-9a-f]{6}$/;

for (const [name, [alt, sky]] of Object.entries(SKIES)) {
  const p = pageSky(sky, alt);
  check(
    `${name}: 昼扱い・色は #rrggbb`,
    !p.night && HEX.test(p.bg) && HEX.test(p.bg2),
    `${p.bg} ${p.bg2}`,
  );
  check(
    `${name}: 地の上の文字が読める明るさ（4.5:1 以上）`,
    contrast(p.bg, PAGE_TEXT_DAY) >= 4.5 &&
      contrast(p.bg2, PAGE_TEXT_DAY) >= 4.5,
    `${contrast(p.bg, PAGE_TEXT_DAY).toFixed(1)} / ${contrast(p.bg2, PAGE_TEXT_DAY).toFixed(1)}`,
  );
}

// 朝・昼・夕・薄明の背景は、ポップアップやボタンが載る面として十分淡い（紙色に近い）
for (const [name, [alt, sky]] of Object.entries(SKIES)) {
  const p = pageSky(sky, alt);
  check(
    `${name}: 背景は淡い（相対輝度 0.7 以上）`,
    lum(p.bg) >= 0.7 && lum(p.bg2) >= 0.7,
    `${lum(p.bg).toFixed(2)} / ${lum(p.bg2).toFixed(2)}`,
  );
}

// 夜への切り替えは、ヘッダーの文字が白に変わる高度と同じ
const sky = SKIES.dusk[1];
check(
  "切り替え: -4° ちょうどはまだ昼",
  pageSky(sky, NIGHT_ALT).night === false,
);
check(
  "切り替え: -4° を下回ると夜",
  pageSky(sky, NIGHT_ALT - 0.01).night === true,
);
check("切り替え: wallpaper.js の wp-night と同じ高度", NIGHT_ALT === -4);

// 夜: 地の上の明るい文字が読め、カード（夜の藍 #2b3365）が背景より明るい
const n = pageSky(sky, -30);
check(
  "夜: 地の上の文字（#e8e6f3）が読める（4.5:1 以上）",
  contrast(n.bg, PAGE_TEXT_NIGHT) >= 4.5 &&
    contrast(n.bg2, PAGE_TEXT_NIGHT) >= 4.5,
  `${contrast(n.bg, PAGE_TEXT_NIGHT).toFixed(1)}`,
);
check(
  "夜: カード（#2b3365）は背景より明るい（カードが浮いて見える）",
  lum("#2b3365") > lum(n.bg) && contrast(n.bg, "#2b3365") >= 1.3,
  `${contrast(n.bg, "#2b3365").toFixed(2)}:1`,
);
check(
  "夜: 高度が変わっても色は一定",
  JSON.stringify(pageSky(sky, -10)) === JSON.stringify(pageSky(sky, -60)),
);

// 昼: 高度が上がるほど天頂の青に寄る（正午の背景は朝の背景より青い＝R が小さい）
check(
  "昼: 正午は朝より青みが強い",
  rgb(pageSky(SKIES.noon[1], 45).bg)[0] <
    rgb(pageSky(SKIES.morning[1], 4.6).bg)[0],
);

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nすべて通りました");
