/* ヘッダーの壁紙。水玉（static）と、明石の実際の太陽・月の位置を
   端末の時計から描く空（dynamic）を切り替えられる。既定は dynamic。

   位置はすべて % 指定で、ヘッダーの高さ・幅が変わっても比率で追従する。
   動かすのは transform / opacity と、CSS 側で @property 登録した色変数だけ。
   JS の再計算は毎分1回。requestAnimationFrame のループは持たない。

   数式・かたち・可読性まわりの設計判断は
   temp/ で行ったプロトタイプ検証（audit-contrast.mjs 等）で
   648時点・3幅・3季節の組み合わせを実測して詰めたもの。同じ考え方はここでも変えていない。 */

/* ==========================================================
   #region SKY-MATH
   明石の空を求める。SunCalc と同じ低精度式（Meeus 由来）。
   太陽は数十秒、月は数分の誤差。壁紙の用途には十分で、
   テーブルも外部依存も持たずに済む。
   ========================================================== */
const RAD = Math.PI / 180;
const OBL = 23.4397 * RAD; // 黄道傾斜角
const AKASHI = { lat: 34.6494, lon: 134.9927 }; // 明石市立天文科学館
const DAY_MS = 86400000;

// Unix ミリ秒 → J2000 からの日数。2451545.0(J2000) - 2440587.5(Unix元期) = 10957.5
const toJ2000 = (ms) => ms / DAY_MS - 10957.5;

const decl = (l, b) =>
  Math.asin(
    Math.sin(b) * Math.cos(OBL) + Math.cos(b) * Math.sin(OBL) * Math.sin(l),
  );
const ra = (l, b) =>
  Math.atan2(
    Math.sin(l) * Math.cos(OBL) - Math.tan(b) * Math.sin(OBL),
    Math.cos(l),
  );
const siderealTime = (d, lonDeg) =>
  RAD * (280.16 + 360.9856235 * d) + lonDeg * RAD;

// 角度を -π..π に畳む。時角は日付をまたぐと 2π ずれるので必須。
const wrapPi = (x) => {
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
};

function sunEq(d) {
  const M = RAD * (357.5291 + 0.98560028 * d); // 平均近点角
  const C =
    RAD *
    (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)); // 中心差
  const L = M + C + RAD * 102.9372 + Math.PI; // 黄経
  return { ra: ra(L, 0), dec: decl(L, 0), dist: 149598000 };
}

function moonEq(d) {
  const L = RAD * (218.316 + 13.176396 * d); // 平均黄経
  const M = RAD * (134.963 + 13.064993 * d); // 平均近点角
  const F = RAD * (93.272 + 13.22935 * d); // 平均昇交点離角
  const l = L + RAD * 6.289 * Math.sin(M);
  const b = RAD * 5.128 * Math.sin(F);
  const dist = 385001 - 20905 * Math.cos(M); // km
  return { ra: ra(l, b), dec: decl(l, b), dist };
}

// 赤道座標 → 高度・時角
function horiz(eq, d, lat, lon) {
  const H = wrapPi(siderealTime(d, lon) - eq.ra);
  const phi = lat * RAD;
  const alt = Math.asin(
    Math.sin(phi) * Math.sin(eq.dec) +
      Math.cos(phi) * Math.cos(eq.dec) * Math.cos(H),
  );
  return { H, alt, dec: eq.dec };
}

// その日・その天体の半日弧（時角の絶対値の上限）。沈まない/昇らない日は null。
function halfArc(dec, latDeg, h0Deg) {
  const phi = latDeg * RAD;
  const c =
    (Math.sin(h0Deg * RAD) - Math.sin(phi) * Math.sin(dec)) /
    (Math.cos(phi) * Math.cos(dec));
  if (c <= -1 || c >= 1) return null;
  return Math.acos(c);
}

export function sunAt(ms, site = AKASHI) {
  const d = toJ2000(ms);
  const p = horiz(sunEq(d), d, site.lat, site.lon);
  return {
    altDeg: p.alt / RAD,
    H: p.H,
    H0: halfArc(p.dec, site.lat, -0.833), // 大気差＋視半径ぶん沈めた地平
    maxAltDeg: 90 - Math.abs(site.lat - p.dec / RAD),
  };
}

export function moonAt(ms, site = AKASHI) {
  const d = toJ2000(ms);
  const p = horiz(moonEq(d), d, site.lat, site.lon);
  return {
    altDeg: p.alt / RAD,
    H: p.H,
    H0: halfArc(p.dec, site.lat, 0.125),
    maxAltDeg: 90 - Math.abs(site.lat - p.dec / RAD),
  };
}

// 月相。輝面比と満ち欠けの向き。
function moonPhase(ms) {
  const d = toJ2000(ms);
  const s = sunEq(d),
    m = moonEq(d);
  const dRa = s.ra - m.ra;
  const elong = Math.acos(
    Math.sin(s.dec) * Math.sin(m.dec) +
      Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(dRa),
  );
  const inc = Math.atan2(
    s.dist * Math.sin(elong),
    m.dist - s.dist * Math.cos(elong),
  );
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(dRa),
    Math.sin(s.dec) * Math.cos(m.dec) -
      Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(dRa),
  );
  const phase = 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI; // 0=新月 0.5=満月
  return {
    fraction: (1 + Math.cos(inc)) / 2, // 輝面比
    phase,
    waxing: phase < 0.5,
    age: phase * 29.530588853, // 月齢（近似）
  };
}
/* #endregion SKY-MATH */

/* ==========================================================
   壁紙エンジン
   ========================================================== */

/* ---- 空・雲・文字の色。太陽高度をキーにした表を線形補間する ----
   「何時か」ではなく「太陽が何度にいるか」で決めるので、
   夏と冬で夕焼けの長さが自然に変わる。 */
const PALETTE = [
  {
    alt: -18,
    sky: ["#0f1730", "#1a2144", "#2b2a50"],
    // 夜の雲は「暗い塊」ではなく「月と地明かりで下から照らされた面」。
    // 空より少しだけ明るくして、輪郭も空より濃い色を残す。
    cloud: ["#5a628f", "#2a2f52", "#434a76"],
    haze: "#2b2a50",
    glow: "#3b4a86",
  },
  {
    alt: -12,
    sky: ["#152142", "#2a2e5c", "#4a3c6a"],
    cloud: ["#676d9b", "#2d3157", "#4d5382"],
    haze: "#5b4270",
    glow: "#6a5a9a",
  },
  {
    alt: -6,
    sky: ["#2b3566", "#5a4d84", "#9a6a86"],
    cloud: ["#8c85ae", "#3a3560", "#6f6894"],
    haze: "#b06f83",
    glow: "#c07d84",
  },
  {
    alt: -2,
    sky: ["#4a5c93", "#9a7099", "#e0908a"],
    cloud: ["#c298a4", "#4d3d5c", "#a37f92"],
    haze: "#ef9d78",
    glow: "#ffb072",
  },
  {
    alt: 0,
    sky: ["#6e83b4", "#d0899a", "#f3b184"],
    cloud: ["#e5aca3", "#6b4550", "#c9928f"],
    haze: "#ffab63",
    glow: "#ffbf6d",
  },
  {
    alt: 5,
    sky: ["#8fabcd", "#e5b79f", "#f7d9ae"],
    cloud: ["#fbe3cf", "#7a5140", "#ecc7ab"],
    haze: "#ffd08a",
    glow: "#ffd98a",
  },
  {
    alt: 14,
    sky: ["#a4c8dd", "#dbdfd2", "#f4e7cd"],
    cloud: ["#fffaf2", "#4a443c", "#ece2d0"],
    haze: "#f6e2b6",
    glow: "#ffe6a8",
  },
  {
    alt: 32,
    sky: ["#a9d0e2", "#d5e5e2", "#f3ecd9"],
    cloud: ["#ffffff", "#33302b", "#e7e0d2"],
    haze: "#f7edd2",
    glow: "#ffeeb6",
  },
  {
    alt: 78,
    sky: ["#9ecbe1", "#cfe3e4", "#f2ecdc"],
    cloud: ["#ffffff", "#33302b", "#e7e0d2"],
    haze: "#f7edd2",
    glow: "#ffeeb6",
  },
];

const hex2rgb = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const rgb2hex = (c) =>
  "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mixHex = (a, b, t) => {
  const A = hex2rgb(a),
    B = hex2rgb(b);
  return rgb2hex([0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * t));
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

export function paletteAt(altDeg) {
  const a = clamp(altDeg, PALETTE[0].alt, PALETTE[PALETTE.length - 1].alt);
  let i = 0;
  while (i < PALETTE.length - 2 && PALETTE[i + 1].alt < a) i++;
  const p = PALETTE[i],
    q = PALETTE[i + 1];
  const t = clamp((a - p.alt) / (q.alt - p.alt), 0, 1);
  return {
    sky: [0, 1, 2].map((k) => mixHex(p.sky[k], q.sky[k], t)),
    cloud: [0, 1, 2].map((k) => mixHex(p.cloud[k], q.cloud[k], t)),
    haze: mixHex(p.haze, q.haze, t),
    glow: mixHex(p.glow, q.glow, t),
  };
}

/* ---- 位置の写像 ----
   x: 時角 H を半日弧 H0 で割る → 日の出 -1、南中 0、日の入り +1
   y: 高度をその日の南中高度で割る → 地平 0、南中 1
   「日の出は左下・正午は中央上・日の入りは右下」を式として持つ。
   高度をその日の南中高度で正規化しているので、放物線を固定で描くのと違って
   夏と冬で弧の“形”が変わる。ただし正規化だけだと南中の高さが年中同じに
   なってしまうので、弧の高さ自体にも季節をかける（下の season）。 */
const X_MIN = 8,
  X_MAX = 92; // 端に寄せすぎると角で切れるので少し内側

// 地平線の位置。弧はヘッダー全体を使う（全面レイアウト）ので、
// 地平線＝ヘッダーの下端、弧の高さはほぼ全高。
function horizon() {
  return { y: 97, arc: 72 };
}

function project(body) {
  const H0 = body.H0 ?? Math.PI / 2;
  const u = clamp(body.H / H0, -1.35, 1.35); // -1=出 0=南中 +1=入
  const v = clamp(body.altDeg / Math.max(body.maxAltDeg, 1), -0.25, 1);
  // 南中高度が低い季節は弧も低く。0.80〜1.00 に収めて
  // 「正午＝中央のてっぺん」という約束は崩さない。
  const season = clamp(0.8 + (0.2 * body.maxAltDeg) / 79, 0.8, 1);
  const hz = horizon();
  return {
    x: lerp(X_MIN, X_MAX, (u + 1) / 2),
    y: hz.y - v * hz.arc * season,
    u,
    v,
  };
}

/* 天体が文字の帯にかかっている度合い（1=かかっていない）。
   x座標だけで判定すると、南中前後の高い位置（弧の頂点、実際には
   文字から遠い）まで x=32〜45% 付近を通るというだけで薄めてしまい、
   正午の太陽が不必要にくすんだ。y座標も見て、実際に文字の高さに
   近いときだけ x の判定を効かせる。 */
export function hazeOverText(xPct, yPct) {
  const lines = textLines();
  if (!lines.length) return 1;
  // 天体は点ではない。実際に描画されているサイズから半径を測る。
  const hdrBox = wp.getBoundingClientRect();
  const orbBox = sunEl.getBoundingClientRect();
  const rY =
    hdrBox.height > 0 ? ((orbBox.height / hdrBox.height) * 100) / 2 : 10;
  const rX = hdrBox.width > 0 ? ((orbBox.width / hdrBox.width) * 100) / 2 : 10;
  let worst = 1;
  for (const ln of lines) {
    if (yPct < ln.y0 - rY || yPct > ln.y1 + rY) continue;
    /* 中心ではなく「天体の左端が文字の右端をどれだけ越えたか」で測る。
       中心基準だと、左端（＝天体のいちばん左側の縁）がまだ文字の内側に
       かぶっている段階でも中心は十分右にあるため明るさがほぼ戻ってしまい、
       実際に幾何学的に重なっているのに暗まらなかった（実測 2.65:1）。
       越えていない（gap<0 、＝まだ重なっている）あいだは常に最も暗いままにする。 */
    /* 下限は 0.22。太陽・月の存在が消えて見えないほど暗めると
       壁紙としての意味が無くなるため、AA を満たす範囲で
       できるだけ高く（0.28〜0.30 あたりから NG が出始める）取っている。 */
    const leftEdge = xPct - rX;
    const gap = leftEdge - ln.x1;
    const xFade = lerp(0.22, 1, clamp(gap / (rX * 1.6), 0, 1));
    if (xFade < worst) worst = xFade;
  }
  return worst;
}

/* ---- 乱数（種つき）。雲と星は再現できたほうがデバッグしやすい ---- */
export function rngFrom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ============================================================
   かたち
   ------------------------------------------------------------
   真円と、半円をつないだ雲は図形として正しいが無個性になる。
   線そのものに手の痕跡を持たせる方向で作っている:
     - 輪郭は閉じた1本の曲線。極座標で半径を僅かに揺らして引く
     - 雲は円の和集合をやめ、山と谷（切れ込み）を持つ稜線として描く。
       和集合は必ず滑らかにつながってしまい、それが均質さの正体だった
     - 内側にもう1本、稜線を追いかける線を入れる。版画の彫り跡に当たる
     - サイトの chip と同じ「3px ずらした影」を版ズレとして雲に効かせる
   揺らぎは種つき乱数なので、毎分の更新で形が踊ることはない。
   ============================================================ */
const nf = (n) => Math.round(n * 100) / 100;

// 点列を閉じた滑らかな曲線にする（Catmull-Rom を3次ベジェへ）
function closedSpline(pts) {
  const n = pts.length;
  let d = `M ${nf(pts[0][0])} ${nf(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n],
      b = pts[i],
      c = pts[(i + 1) % n],
      e = pts[(i + 2) % n];
    d +=
      ` C ${nf(b[0] + (c[0] - a[0]) / 6)} ${nf(b[1] + (c[1] - a[1]) / 6)}` +
      ` ${nf(c[0] - (e[0] - b[0]) / 6)} ${nf(c[1] - (e[1] - b[1]) / 6)}` +
      ` ${nf(c[0])} ${nf(c[1])}`;
  }
  return d + " Z";
}

// 手で描いた丸。真円にせず、半径を少しずつ狂わせる
function organicDisc(r, rng, wob = 0.055, n = 11, squash = 1) {
  const pts = [];
  const phase = rng() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const k = 1 + (rng() - 0.5) * 2 * wob;
    pts.push([Math.cos(a) * r * k, Math.sin(a) * r * k * squash]);
  }
  return closedSpline(pts);
}

/* ---- 雲 ----
   山（ふくらみ）と谷（切れ込み）が交互に来る稜線として引く。
   谷を浅く残すのが要点で、ここが埋まると途端に「和集合の雲」に戻る。
   下辺はまっすぐではなく、ゆるい波にする。 */
export function buildCloud(rng, scale) {
  const n = 3 + Math.floor(rng() * 2); // 3〜4の山
  // 山の「高さ」と「幅」を別々に持つのが要点。
  // 円から作ると高さ＝幅に縛られ、山を並べた時点で必ず平たくなる
  // （横に間延びした波にしか見えない）。雲は横:縦がだいたい 2.5:1。
  const baseH = 34 * scale;
  const lobes = [];
  const peak = 0.28 + rng() * 0.44; // いちばん高い山の位置。左右非対称にする
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const f = 1 - Math.abs(t - peak) * 0.8;
    const h = baseH * clamp(f * (0.8 + rng() * 0.42), 0.42, 1.12);
    // 山は縦長ぎみに。半幅を高さの半分あたりにすると、頂きが丸く立つ。
    // ここを広げると隣とだらだらつながって、雲ではなく塊になる。
    const w = h * (0.62 + rng() * 0.16);
    // 中心の間隔。狭めて深く重ねる
    const x =
      i === 0
        ? 0
        : lobes[i - 1].x + (lobes[i - 1].w + w) * (0.54 + rng() * 0.13);
    lobes.push({ x, w, h });
  }

  /* 輪郭は点のリングを1本の閉曲線でなぞる（太陽・月と同じやり方）。
     接線を自分で決めずに済むぶん、線が自然にふくらむ。
     肩の点を必ず入れるのが効く。ここが無いと、稜線が下辺に直接
     突き当たって端が楔形になり、雲ではなく岩山に見える。 */
  const first = lobes[0],
    last = lobes[n - 1];
  const maxLobeH = Math.max(...lobes.map((l) => l.h));
  const ring = [];

  ring.push([first.x - first.w * 0.5, 0]); // 左の接地点
  ring.push([first.x - first.w * 1.02, -first.h * 0.34]); // 左肩
  for (let i = 0; i < n; i++) {
    const lb = lobes[i];
    const apex = [lb.x + (rng() - 0.5) * lb.w * 0.22, -lb.h];
    // 頂きの左右にも点を置く。頂点を1点で通すと、そこで向きが変わって
    // 尖った山になる（雲ではなく山脈に見えていた原因）。
    ring.push([apex[0] - lb.w * 0.5, -lb.h * 0.78]);
    ring.push(apex);
    ring.push([apex[0] + lb.w * 0.5, -lb.h * 0.78]);
    if (i < n - 1) {
      const hm = Math.min(lobes[i].h, lobes[i + 1].h);
      const ha = (lobes[i].h + lobes[i + 1].h) / 2;
      const v = [
        (lobes[i].x +
          lobes[i].w * 0.5 +
          lobes[i + 1].x -
          lobes[i + 1].w * 0.5) /
          2,
        /* 谷の深さ。低いほうの山だけを見ると、高さの差が大きい隣どうしで
           深い裂け目になる。二つの平均も見て浅いほうを採る。
           ただし低いほうの頂きは越えさせない（越えると山が反転する）。 */
        -Math.min(hm * 0.86, ha * (0.58 + rng() * 0.14)),
      ];
      ring.push(v);
    }
  }
  ring.push([last.x + last.w * 1.02, -last.h * 0.34]); // 右肩
  ring.push([last.x + last.w * 0.5, 0]); // 右の接地点

  // 下辺。まっすぐ引かず、ゆるい起伏を持たせて戻る
  const Lx = first.x - first.w * 0.5,
    Rx = last.x + last.w * 0.5;
  const waves = 2 + Math.floor(rng() * 2);
  for (let i = 1; i < waves; i++) {
    const y = (rng() - 0.3) * 3.2;
    ring.push([lerp(Rx, Lx, i / waves), y]);
  }
  const d = closedSpline(ring);

  /* 内側の線。最初は稜線をなぞらせたが、山と谷を追うぶん波打って
     ただの落書きに見えた。浮世絵の雲がそうであるように、下のほうに
     短い線を数本入れるだけにする（霞の線）。 */
  let inner = "";
  const strokes = 1 + Math.floor(rng() * 2);
  const span = Rx - Lx;
  for (let i = 0; i < strokes; i++) {
    const y = -maxLobeH * (0.16 + i * 0.17 + rng() * 0.05);
    const len = span * (0.3 + rng() * 0.22);
    const sx = Lx + span * (0.12 + rng() * 0.3);
    const dip = 1.2 + rng() * 1.6; // 気持ちだけ反らせる
    inner +=
      ` M ${nf(sx)} ${nf(y)}` +
      ` Q ${nf(sx + len / 2)} ${nf(y + dip)} ${nf(sx + len)} ${nf(y)}`;
  }

  /* viewBox は点から出す。手で足し引きすると、曲線が点の外へ
     少し膨らむぶん（Catmull-Rom のオーバーシュート）と、
     版ズレの影 3px ぶんを取りこぼして端が切れる。 */
  const pad = 8; // 線幅・オーバーシュート・版ズレの影の逃げ
  const xs = ring.map((p) => p[0]),
    ys = ring.map((p) => p[1]);
  const x0 = Math.min(...xs) - pad,
    x1 = Math.max(...xs) + pad + 3;
  const y0 = Math.min(...ys) - pad,
    y1 = Math.max(...ys) + pad + 3.5;
  return {
    path: d,
    inner,
    vb: [x0, y0, x1 - x0, y1 - y0],
    w: x1 - x0,
    h: y1 - y0,
  };
}

/* ---- 月の形 ----
   欠け際は「短半径 R|1-2f| の楕円」。半月で直線、満月で円に連続的に変わる。
   幾何はそのままに、円弧2本ではなく点を拾って手描きの曲線としてつなぐ。
   位相の正しさ（実際の離角から出した輝面比）は保ったまま、
   輪郭だけを版画の線にしたい。 */
export function moonOutline(R, f, waxing, rng) {
  const fr = clamp(f, 0.045, 0.995);
  const rx = R * Math.abs(1 - 2 * fr);
  const bulge = fr < 0.5 ? 1 : -1; // 三日月は明るい側へ、凸月は逆へ張り出す
  const dir = waxing ? 1 : -1; // 明るいのが右か左か
  const N = 13;
  const pts = [];
  // 明るい側の縁（上→下）
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI;
    const k = 1 + (rng() - 0.5) * 0.07;
    pts.push([dir * R * Math.sin(t) * k, -R * Math.cos(t) * k]);
  }
  // 欠け際（下→上）。両端は縁と共有するので内側だけ
  for (let i = N - 1; i >= 1; i--) {
    const t = (i / N) * Math.PI;
    const k = 1 + (rng() - 0.5) * 0.06;
    pts.push([dir * bulge * rx * Math.sin(t) * k, -R * Math.cos(t) * k]);
  }
  return closedSpline(pts);
}

/* ---- DOM ---- */
const $ = (s) => document.querySelector(s);
const hdr = $("#hdr"),
  wp = $("#wp"),
  sunEl = $("#sun"),
  moonEl = $("#moon"),
  cloudsEl = $("#clouds"),
  starsEl = $("#stars"),
  toggleBtn = $("#wpToggleBtn"),
  toggleIconDynamic = $("#wpToggleIconDynamic"),
  toggleIconStatic = $("#wpToggleIconStatic");
const SVGNS = "http://www.w3.org/2000/svg";

let cloudSeed = Math.floor(Math.random() * 1e9);
let starSeed = Math.floor(Math.random() * 1e9);
let starNodes = [];

const CLOUD_ZOOM = 1.62; // viewBox の単位 → 実ピクセル

/* 文字が実際に占めている場所を、行（要素）ごとに測る。
   1つの矩形にまとめると、いちばん右まで伸びる行（たいてい見出し）に
   引きずられて、その行が無い高さまで「文字あり」と誤判定する。
   実測すると見出しの右端は画面幅によらず93〜96%まで達するが、それは
   見出しの高さの範囲だけの話で、リード文・注記の高さでは右端はもっと
   手前で終わる。固定の1本の閾値では両方を正しく扱えない。 */
function textLines() {
  const hdrBox = wp.getBoundingClientRect();
  if (hdrBox.width <= 0 || hdrBox.height <= 0) return [];
  const lines = [];
  for (const el of document.querySelectorAll(
    ".header-inner h1, .header-inner .pop-sub, .header-inner .pop-disclaimer",
  )) {
    /* el.getBoundingClientRect() は要素の「箱」を返す。h1 も p も
       block要素で幅いっぱいに広がる箱を持つため、"イベントボード"の
       実際の文字が x=7〜36% にしか無いのに、箱としては x1=93% まで
       測ってしまう。文字を Range で拾い、行ごとの実際のインクの
       範囲だけを使う。 */
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (!n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 2 || r.height < 2) continue;
        lines.push({
          x0: ((r.left - hdrBox.left) / hdrBox.width) * 100,
          x1: ((r.right - hdrBox.left) / hdrBox.width) * 100,
          y0: ((r.top - hdrBox.top) / hdrBox.height) * 100,
          y1: ((r.bottom - hdrBox.top) / hdrBox.height) * 100,
        });
      }
    }
  }
  return lines;
}

export function regions() {
  return { lines: textLines() };
}

export function layoutClouds(seed) {
  const rng = rngFrom(seed);
  cloudsEl.textContent = "";
  const boxW = cloudsEl.clientWidth || 1280,
    boxH = cloudsEl.clientHeight || 420;
  const reg = regions();
  const count = 3 + Math.floor(rng() * 4); // 3〜6個。毎回最低3個は出す
  const LINES = reg.lines; // ここに雲を置くと字が読みにくいので避ける
  const placed = [];

  /* 1つ置く。relaxStack は、通常の「重なりは2枚まで」を諦めて
     とにかく置き切るための最終手段（下の第2パス専用）。
     スマホ幅では安全な余白が狭く、300回の試行でも3個に届かない
     組み合わせのシードが実測で見つかったため、最低3個は必ず出す
     という約束のほうを優先する。 */
  function placeOne(relaxStack) {
    const scale = 0.6 + rng() * 0.9;
    const cloud = buildCloud(rng, scale);
    // 実際に描かれる大きさから箱を出す。ここを目分量にすると
    // 見出しを避けたつもりの雲が字にかかる。
    const wPct = ((cloud.w * CLOUD_ZOOM) / boxW) * 100;
    const hPct = ((cloud.h * CLOUD_ZOOM) / boxH) * 100;
    // 横位置は雲の幅を見て決める。固定の範囲から選ぶと、
    // 大きい雲が画面の端で断ち切られる（切り口が直線なので事故に見える）。
    // 端から少しだけはみ出すのは、流れていく様子として自然なので許す。
    const margin = wPct / 2 - 5;
    const cx = clamp(
      4 + rng() * 92,
      Math.min(margin, 50),
      Math.max(100 - margin, 50),
    );
    const cy = 9 + rng() * 48; // % 上側の帯に置く
    const box = {
      x0: cx - wPct / 2,
      x1: cx + wPct / 2,
      y0: cy - hPct / 2,
      y1: cy + hPct / 2,
    };
    const overlaps = (a, b) =>
      a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    if (LINES.some((ln) => overlaps(box, ln))) return false;
    // 重なりは2枚まで。すでに重なっている雲にはもう重ねない。
    let partner = null,
      ok = true;
    for (const p of placed) {
      if (!overlaps(box, p.box)) continue;
      if (!relaxStack && (partner || p.stacked || Math.abs(cy - p.cy) < 6)) {
        ok = false;
        break;
      }
      partner = p;
    }
    if (!ok) return false;
    if (partner) partner.stacked = true;

    const wrap = document.createElement("div");
    wrap.className = "cloud";
    wrap.style.left = cx + "%";
    wrap.style.top = cy + "%";
    wrap.style.setProperty("--dur", (110 + rng() * 130).toFixed(0) + "s");
    wrap.style.setProperty("--dly", (-rng() * 60).toFixed(0) + "s");
    wrap.style.setProperty("--amp", (10 + rng() * 16).toFixed(0) + "px");
    // 手前の雲ほど大きく・濃く。奥は小さく・薄く（空気遠近）
    wrap.style.opacity = (0.72 + scale * 0.24).toFixed(2);

    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", cloud.vb.join(" "));
    svg.setAttribute("width", (cloud.w * CLOUD_ZOOM).toFixed(1));
    svg.setAttribute("height", (cloud.h * CLOUD_ZOOM).toFixed(1));
    const gid = "cg" + placed.length + "-" + (seed % 9973);
    svg.innerHTML =
      `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="var(--wp-cloud-fill)"/>` +
      `<stop offset="1" stop-color="var(--wp-cloud-shade)"/>` +
      `</linearGradient></defs>` +
      // 版ズレの影。サイトの chip の box-shadow: 3px 3px 0 と同じ考え方
      `<path d="${cloud.path}" transform="translate(3 3.5)"` +
      ` fill="var(--wp-cloud-line)" opacity="0.18"/>` +
      `<path d="${cloud.path}" fill="url(#${gid})" ` +
      `stroke="var(--wp-cloud-line)" stroke-width="2.4" stroke-linejoin="round"/>` +
      // 内側の線。稜線を追いかける1本だけ入れて、彫りの気配を出す
      (cloud.inner
        ? `<path d="${cloud.inner}" fill="none" stroke="var(--wp-cloud-line)"` +
          ` stroke-width="1.5" stroke-linecap="round" opacity="0.34"/>`
        : "");
    wrap.appendChild(svg);
    cloudsEl.appendChild(wrap);
    placed.push({ box, cy, stacked: false, el: wrap });
    return true;
  }

  let tries = 0;
  while (placed.length < count && tries++ < 300) placeOne(false);
  // 通常の試行で3個に届かなかった幅・シードの保険。重なり2枚までの
  // 制約だけ緩め、文字の上には引き続き置かない。
  tries = 0;
  while (placed.length < 3 && tries++ < 300) placeOne(true);
  return placed.length;
}

export function layoutStars(seed) {
  const rng = rngFrom(seed);
  starsEl.textContent = "";
  starNodes = [];
  const n = 76;
  for (let i = 0; i < n; i++) {
    const x = rng() * 100;
    const y = rng() * 88;
    const big = rng() < 0.1;
    const size = big ? 5 + rng() * 4 : 1.4 + rng() * 1.9;
    // 低いほど薄い（地平の靄）。上のほうがよく見える。
    let baseA = clamp(1 - y / 118, 0.28, 1) * (0.55 + rng() * 0.45);
    // 文字が載る行の近くでは消す。夜の文字はクリーム色なので、白い星が
    // 字の裏に来ると同系色で潰れる。太陽・月と同じ判定を流用する。
    baseA *= hazeOverText(x, y);
    if (baseA < 0.04) continue;
    let el;
    if (big) {
      el = document.createElementNS(SVGNS, "svg");
      el.setAttribute("class", "sparkle");
      el.setAttribute("viewBox", "-10 -10 20 20");
      el.setAttribute("width", size * 2.4);
      el.setAttribute("height", size * 2.4);
      // 四芒星。曲線でくびれさせると、点よりも「きらっ」と見える。
      el.innerHTML =
        '<path d="M0 -9 Q1.4 -1.4 9 0 Q1.4 1.4 0 9 Q-1.4 1.4 -9 0 Q-1.4 -1.4 0 -9 Z" fill="' +
        (rng() < 0.5 ? "#fff6de" : "#dfe6ff") +
        '"/>';
    } else {
      el = document.createElement("div");
      el.className = "star";
      el.style.width = el.style.height = size.toFixed(1) + "px";
      el.style.setProperty(
        "--c",
        rng() < 0.22 ? "#ffe9c2" : rng() < 0.5 ? "#dfe6ff" : "#fffaf0",
      );
    }
    el.style.left = x + "%";
    el.style.top = y + "%";
    el.style.opacity = baseA;
    if (rng() < 0.45) {
      el.classList.add("tw");
      el.style.setProperty("--dur", (2.6 + rng() * 4.5).toFixed(1) + "s");
      el.style.setProperty("--dly", (-rng() * 6).toFixed(1) + "s");
    }
    starsEl.appendChild(el);
    starNodes.push({ el, x, y, baseA });
  }
}

/* ---- 太陽 ----
   ☀️ と同じく光条を持たせる。ただし等間隔の三角形を放射状に置くと、
   いかにも図形を並べた記号になる。
     - 角度・長さ・太さを一本ずつ散らす（同じものが二本と無い）
     - 側面は直線ではなく、付け根から先へ向かってふくらむ曲線にする
     - 付け根は本体の内側に隠す。輪郭が本体と光条で二重にならない
   本体は真円をやめた手描きの丸のまま。サイトの chip が持っている
   「3px ずらしたインクの影」を版ズレとして重ねるのも同じ。 */
function drawSun() {
  const rng = rngFrom(31337);
  const R = 26; // 光条を出すぶん、本体は小さめに
  const disc = organicDisc(R, rng, 0.045, 13);
  const bleed = organicDisc(R * 1.16, rngFrom(1729), 0.06, 11);

  const N = 10; // 光条の本数
  const pt = (ang, rad) => [Math.cos(ang) * rad, Math.sin(ang) * rad];
  const rays = [];
  for (let i = 0; i < N; i++) {
    // 角度を少しずらす。きっちり等分だと機械が置いたように見える
    const a = (i / N) * Math.PI * 2 + (rng() - 0.5) * 0.14;
    const len = R * (0.42 + rng() * 0.22); // 長さもばらす
    // 細くすると輪郭のインクだけが目立ち、光条が黒い棘に見える。
    // 塗りが残る太さを確保する
    const halfW = (Math.PI / N) * (0.66 + rng() * 0.18);
    const base = R * 0.9; // 付け根は本体の内側
    const b1 = pt(a - halfW, base),
      b2 = pt(a + halfW, base);
    const tip = pt(a + (rng() - 0.5) * 0.05, R + len);
    // 制御点を軸寄りに置くと、先へ向かって細くなる花弁のような形になる
    const c1 = pt(a - halfW * 0.72, R + len * 0.42);
    const c2 = pt(a + halfW * 0.72, R + len * 0.42);
    rays.push(
      `M ${nf(b1[0])} ${nf(b1[1])}` +
        ` Q ${nf(c1[0])} ${nf(c1[1])} ${nf(tip[0])} ${nf(tip[1])}` +
        ` Q ${nf(c2[0])} ${nf(c2[1])} ${nf(b2[0])} ${nf(b2[1])} Z`,
    );
  }
  // 光条＋本体をまとめて1つの塗りにするための並び
  const rayPaths = (attrs) =>
    rays.map((d) => `<path d="${d}" ${attrs}/>`).join("");

  sunEl.innerHTML =
    `<defs><radialGradient id="sunFill" cx="34%" cy="28%" r="82%">` +
    `<stop offset="0" stop-color="var(--wp-sun-1, #ffeeb6)"/>` +
    `<stop offset="0.55" stop-color="var(--wp-sun-2, #ffca5c)"/>` +
    `<stop offset="1" stop-color="var(--wp-sun-3, #f2a03c)"/>` +
    `</radialGradient></defs>` +
    // 刷りのにじみ。輪郭の外にわずかに色が出ている状態
    `<path d="${bleed}" fill="var(--wp-sun-2, #ffca5c)" opacity="0.2"/>` +
    // 版ズレの影。光条ごとずらす
    `<g transform="translate(3.5 3.5)" fill="var(--wp-sun-line, #33302b)" opacity="0.16">` +
    rayPaths("") +
    `<path d="${disc}"/></g>` +
    // 光条。本体より先に描いて、付け根を本体で隠す
    rayPaths(
      `fill="var(--wp-sun-2, #ffca5c)" stroke="var(--wp-sun-line, #33302b)"` +
        ` stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"`,
    ) +
    `<path d="${disc}" fill="url(#sunFill)"` +
    ` stroke="var(--wp-sun-line, #33302b)" stroke-width="3" stroke-linejoin="round"/>` +
    // 照り返し。これも真円にしない
    `<path transform="translate(-8.5 -10) rotate(-24)"` +
    ` d="${organicDisc(7, rngFrom(4423), 0.16, 9, 0.72)}" fill="#fff" opacity="0.32"/>`;
}

let lastMoonKey = "";
function drawMoon(ph, sp, mp) {
  // 欠け際の向きは「画面に投影した太陽の方向」に合わせる。
  // 実際の空でも明るい側は必ず太陽を向いているので、これで破綻しない。
  const vx = (sp.x - mp.x) * 1.0;
  const vy = (sp.y - mp.y) * 0.34; // 横長ヘッダーぶんの補正
  // 描画の既定は「右が明るい」。そこからのずれを回転で与える。
  let rot = (Math.atan2(vy, vx) * 180) / Math.PI;
  if (!ph.waxing) rot -= 180; // 左が明るい側になるので基準を反転
  rot = clamp(rot, -78, 78);
  const key = ph.fraction.toFixed(3) + ph.waxing + Math.round(rot / 3) * 3;
  if (key === lastMoonKey) return;
  lastMoonKey = key;
  const R = 33;
  // 形の揺らぎは種を固定する。更新のたびに引き直すと、
  // 月が1分ごとに身じろぎしてしまう。
  const rng = rngFrom(48271);
  const d = moonOutline(R, ph.fraction, ph.waxing, rng);
  // 海。整った楕円をやめて、それぞれ歪んだ形にする。
  // 位置は実際の月の模様（晴れの海・静かの海のあたり）をゆるく写している。
  const seaRng = rngFrom(90210);
  const seas = [
    [-9, -10, 9.5],
    [6.5, 5, 7],
    [-3, 14, 4.6],
    [13, -13, 4.2],
    [-13, 4, 3.4],
  ]
    .map(
      ([cx, cy, r]) =>
        `<path transform="translate(${cx} ${cy})" d="${organicDisc(r, seaRng, 0.2, 8, 0.82)}"/>`,
    )
    .join("");
  moonEl.innerHTML =
    `<g transform="rotate(${(ph.waxing ? rot : rot + 180).toFixed(1)})">` +
    `<defs><clipPath id="mclip"><path d="${d}"/></clipPath>` +
    `<radialGradient id="mfill" cx="36%" cy="30%" r="82%">` +
    `<stop offset="0" stop-color="#fffdf2"/><stop offset="1" stop-color="#efe1bd"/>` +
    `</radialGradient></defs>` +
    // 地球照。新月に近いほど、暗い側がうっすら見える。
    `<path d="${organicDisc(R, rngFrom(7919), 0.04)}" fill="#c9c9e6"` +
    ` opacity="${(0.16 * (1 - ph.fraction)).toFixed(3)}"/>` +
    `<path d="${d}" fill="url(#mfill)" stroke="#2a2f52" stroke-width="2.6" stroke-linejoin="round"/>` +
    // 海（クレーター）。明るい側からはみ出さないよう切り抜く。
    // 濃くすると土くれのように見えるので、あくまで気配だけ。
    `<g clip-path="url(#mclip)" fill="#e6dabd" opacity="0.42">${seas}</g>` +
    `</g>`;
}

/* ---- 1回の更新（毎分これだけ動く） ---- */
export function paint(ms) {
  const s = sunAt(ms);
  const pal = paletteAt(s.altDeg);
  const sp = project(s);

  wp.style.setProperty("--wp-sky-top", pal.sky[0]);
  wp.style.setProperty("--wp-sky-mid", pal.sky[1]);
  wp.style.setProperty("--wp-sky-bot", pal.sky[2]);
  wp.style.setProperty("--wp-cloud-fill", pal.cloud[0]);
  wp.style.setProperty("--wp-cloud-line", pal.cloud[1]);
  wp.style.setProperty("--wp-cloud-shade", pal.cloud[2]);
  wp.style.setProperty("--wp-haze", pal.haze);
  wp.style.setProperty("--wp-glow", pal.glow);
  // 光条ぶん見かけが広がるので、円板だけだった頃より少し大きくてよい
  wp.style.setProperty("--wp-orb", "clamp(74px, 9.8vw, 128px)");

  // 太陽。地平線の少し下からフェードさせる（ぱっと消えると安っぽい）
  const sunA = clamp((s.altDeg + 2.2) / 2.6, 0, 1) * hazeOverText(sp.x, sp.y);
  wp.style.setProperty("--wp-sun-a", sunA.toFixed(3));
  wp.style.setProperty("--wp-sun-x", sp.x.toFixed(2) + "%");
  wp.style.setProperty("--wp-sun-y", sp.y.toFixed(2) + "%");
  // 低いほど赤く、大きく光る
  const low = clamp(1 - s.altDeg / 16, 0, 1);
  wp.style.setProperty("--wp-sun-1", mixHex("#ffeeb6", "#fff0c8", low));
  wp.style.setProperty("--wp-sun-2", mixHex("#ffca5c", "#ff9d5a", low));
  wp.style.setProperty("--wp-sun-3", mixHex("#f2a03c", "#e8663f", low));
  wp.style.setProperty("--wp-sun-line", mixHex("#33302b", "#6d3730", low));
  wp.style.setProperty(
    "--wp-sun-glow-a",
    (sunA * (0.32 + low * 0.5)).toFixed(3),
  );
  wp.style.setProperty(
    "--wp-haze-a",
    (clamp(1 - Math.abs(s.altDeg) / 16, 0, 1) * 0.9).toFixed(3),
  );
  /* 霞の色はその時の空から作る。固定色だと、薄明の紫やピンクの空に
     紺色をかぶせることになり、霞のかかった側が「別の空」に見える。
     同じ色相の濃淡なら陰影として読める。昼の覆いは空にあまり寄せない。
     役目は「背景を明るい側へ押し上げて黒インクを読ませる」ことなので、
     空（薄明では暗い）に寄せると逆に暗くなって役目を果たさなくなる。 */
  const rgbOf = (hex) => hex2rgb(hex).map(Math.round).join(", ");
  wp.style.setProperty(
    "--wp-veil-night-rgb",
    rgbOf(mixHex(pal.sky[1], "#070912", 0.72)),
  );
  wp.style.setProperty(
    "--wp-veil-day-rgb",
    rgbOf(mixHex(pal.sky[2], "#fffdf6", 0.86)),
  );
  /* 覆いの濃さ。太陽が高いうちは空自体が明るく、黒インクとの
     コントラストは足りているので薄くてよい。薄明に近づくほど濃くする。
     横方向には一様（左右で濃さが変わらない）なので、どの濃さでも
     空の明暗差＝太陽の方向は保たれる——濃さで可読性を上げても向きは壊れない。 */
  wp.style.setProperty(
    "--wp-veil-flat-a",
    lerp(0.26, 0.72, clamp((22 - s.altDeg) / 26, 0, 1)).toFixed(3),
  );

  // 星。市民薄明（-6°）を過ぎたあたりから出て、-14°で出そろう
  const starA = clamp((-s.altDeg - 4) / 10, 0, 1);
  wp.style.setProperty("--wp-star-a", starA.toFixed(3));

  /* 地明かり。日没直後の暖かい残照は天文薄明の終わり(-18°)までに消え、
     そのあとは街明かりぶんだけがうっすら残る。
     日の入り前に出さないよう、-2°から-6°で立ち上げる。 */
  const cityA =
    (0.14 + 0.86 * clamp((s.altDeg + 18) / 12, 0, 1)) *
    clamp((-s.altDeg - 2) / 4, 0, 1);
  wp.style.setProperty("--wp-city-a", cityA.toFixed(3));

  // 月。夜（太陽が地平下）かつ月が地平の上にいるときだけ。
  const m = moonAt(ms);
  const ph = moonPhase(ms);
  const mp = project(m);
  const moonUp = clamp((m.altDeg + 1.2) / 2.4, 0, 1);
  const moonA =
    moonUp * clamp((-s.altDeg - 1) / 6, 0, 1) * hazeOverText(mp.x, mp.y);
  wp.style.setProperty("--wp-moon-a", moonA.toFixed(3));
  wp.style.setProperty("--wp-moon-x", mp.x.toFixed(2) + "%");
  wp.style.setProperty("--wp-moon-y", mp.y.toFixed(2) + "%");
  drawMoon(ph, sp, mp);

  // 月の近くの星は隠す（「月がないところに星」）
  const moonRPct = 4.6; // 画面幅に対する月の見かけ半径のおおよそ
  for (const st of starNodes) {
    const dx = (st.x - mp.x) / (moonRPct * 2.1);
    const dy = (st.y - mp.y) / (moonRPct * 2.1 * 3.2); // ヘッダーは横長なので縦だけ換算
    const near = Math.hypot(dx, dy) < 1;
    st.el.style.opacity = near && moonA > 0.2 ? 0 : st.baseA;
  }

  // 文字色。空の明るさから判定すると薄明の途中で中間色になり、
  // 黒でも白でも読みにくい瞬間ができる。実際の事象（太陽高度）で切る。
  // -4°＝日の入りのおよそ20分後。「暗くなってきたな」と感じる頃。
  hdr.classList.toggle("wp-night", s.altDeg < -4);
  return { s, m, ph, sp, mp, starA, pal };
}

/* ---- static/dynamic の切り替え。既定は dynamic、選ぶと端末に残す ---- */
const MODE_KEY = "eventboard.wallpaper.v1";

function storedMode() {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "static" || v === "dynamic" ? v : null;
  } catch {
    return null;
  }
}
function rememberMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* 保存できなくても表示切り替え自体は続けられる */
  }
}

let dynTimer = null;
function startDynamicUpdates() {
  paint(Date.now());
  if (dynTimer) return;
  dynTimer = setInterval(() => {
    if (document.visibilityState === "visible") paint(Date.now());
  }, 60000);
}
function stopDynamicUpdates() {
  if (dynTimer) clearInterval(dynTimer);
  dynTimer = null;
}

export function setMode(next) {
  const dyn = next === "dynamic";
  wp.hidden = !dyn;
  hdr.classList.toggle("wp-on", dyn);
  if (!dyn) hdr.classList.remove("wp-night");
  document.querySelectorAll(".blob").forEach((b) => (b.hidden = dyn));
  toggleBtn.setAttribute("aria-pressed", String(dyn));
  toggleBtn.setAttribute(
    "aria-label",
    dyn ? "壁紙を水玉に切り替える" : "壁紙を空に切り替える",
  );
  // SVG要素は .hidden プロパティが属性に反映されない実装があるため
  // （HTMLElement の IDL 拡張で、SVGElement には効かないケースがある）、
  // setAttribute/removeAttribute で直接切り替える。
  toggleIconStatic.toggleAttribute("hidden", dyn);
  toggleIconDynamic.toggleAttribute("hidden", !dyn);
  if (dyn) {
    layoutClouds(cloudSeed);
    layoutStars(starSeed);
    startDynamicUpdates();
  } else {
    stopDynamicUpdates();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && dynTimer) paint(Date.now());
});

toggleBtn.addEventListener("click", () => {
  const next = hdr.classList.contains("wp-on") ? "static" : "dynamic";
  setMode(next);
  rememberMode(next);
});

/* ---- 起動 ---- */
drawSun();
layoutClouds(cloudSeed);
layoutStars(starSeed);
setMode(storedMode() ?? "dynamic");
