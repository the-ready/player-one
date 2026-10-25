/* WCAG 2.2 の点検用に、ページの中へ差し込む計測器（tools/wcag_audit.mjs が読み込む）。
   測るのは「見え方」だけで、ページの動作には触れない。
     textIssues     文字の対比（1.4.3）。::before/::after の文字・半透明（opacity）も実効の色で測る
     placeholderIssue  入力欄の案内文字の対比（1.4.3）
     iconIssues     アイコン（SVG）の対比（1.4.11）。線で形が決まっている塗りは除く
     focusInfo      フォーカス表示（2.4.7／1.4.11）。外側の線は outline と box-shadow の両方を見る
     boundary       部品の輪郭（1.4.11）。塗りか縁か縁の外側の輪（box-shadow）が周囲と 3:1 あるか
   色は color-mix() や oklab が返す rgb() ではない形式のこともあるので、canvas で rgb に直す。 */
(() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const parse = (c) => {
    if (!c || c === "transparent" || c === "none")
      return { r: 0, g: 0, b: 0, a: 0 };
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
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (t, b) => ({
    r: t.r * t.a + b.r * (1 - t.a),
    g: t.g * t.a + b.g * (1 - t.a),
    b: t.b * t.a + b.b * (1 - t.a),
    a: 1,
  });
  const cr = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const hex = (c) =>
    "#" +
    [c.r, c.g, c.b]
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("");
  // 要素と祖先の opacity の積（押せない部品の .35 や .vo-sub の .8 など、半透明の文字を見落とさない）
  const opOf = (el) => {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement)
      o *= parseFloat(getComputedStyle(e).opacity);
    return o;
  };
  // 要素の背後に見えている色。祖先の背景を根から順に重ねる。self=true なら要素自身の背景も含める
  const bgOf = (el, self = true) => {
    const st = [];
    for (
      let e = self ? el : el.parentElement;
      e && e.nodeType === 1;
      e = e.parentElement
    ) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c.a > 0) st.push({ ...c, a: c.a * opOf(e) });
    }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = st.length - 1; i >= 0; i--) acc = over(st[i], acc);
    return acc;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return (
      cs.visibility !== "hidden" &&
      cs.display !== "none" &&
      !el.closest("[hidden]")
    );
  };
  const desc = (el) => {
    const cls = [...el.classList].join(".");
    const t = (
      el.getAttribute("aria-label") ||
      el.textContent ||
      el.value ||
      el.placeholder ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 16);
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}「${t}」`;
  };
  const need = (cs) => {
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight) >= 700;
    return size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
  };
  const isDisabled = (el) => !!el.closest('[disabled],[aria-disabled="true"]');

  const textIssues = (root) => {
    const out = [];
    const els = [root, ...root.querySelectorAll("*")];
    for (const el of els) {
      if (el.closest(".sr-only") || !visible(el)) continue;
      // 透明にして隠してある文字（縮んだ操作バーの件数など。読み上げのために残している）は、
      // 見える文字ではないので測らない
      if (opOf(el) < 0.05) continue;
      if (
        [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())
      ) {
        const cs = getComputedStyle(el);
        const bg = bgOf(el);
        const f0 = parse(cs.color);
        f0.a *= opOf(el);
        const f = f0.a < 1 ? over(f0, bg) : f0;
        const n = need(cs);
        const c = cr(f, bg);
        if (c < n)
          out.push({
            el: desc(el),
            ratio: +c.toFixed(2),
            need: n,
            fg: hex(f),
            bg: hex(bg),
            dis: isDisabled(el),
          });
      }
      // ::before / ::after の文字（▾・✓・件数など）
      for (const pe of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pe);
        const ct = ps.content;
        if (!ct || ct === "none" || ct === "normal") continue;
        if (!/[^"'\s]/.test(ct.replace(/^["']|["']$/g, ""))) continue;
        if (ps.display === "none" || ps.visibility === "hidden") continue;
        const bg0 = parse(ps.backgroundColor);
        const base = bgOf(el);
        const bg =
          bg0.a > 0 ? over({ ...bg0, a: bg0.a * opOf(el) }, base) : base;
        const f0 = parse(ps.color);
        f0.a *= opOf(el) * parseFloat(ps.opacity);
        const f = over(f0, bg);
        const n = need(ps);
        const c = cr(f, bg);
        if (c < n)
          out.push({
            el: desc(el) + pe + ct.slice(0, 8),
            ratio: +c.toFixed(2),
            need: n,
            fg: hex(f),
            bg: hex(bg),
            dis: isDisabled(el),
          });
      }
    }
    return out;
  };
  const placeholderIssue = (el) => {
    if (!el.placeholder) return null;
    const ps = getComputedStyle(el, "::placeholder");
    const bg = bgOf(el);
    const f0 = parse(ps.color);
    f0.a *= parseFloat(ps.opacity);
    const f = f0.a < 1 ? over(f0, bg) : f0;
    const c = cr(f, bg);
    return c < 4.5
      ? {
          el: desc(el) + "（プレースホルダー）",
          ratio: +c.toFixed(2),
          need: 4.5,
          fg: hex(f),
          bg: hex(bg),
          dis: isDisabled(el),
        }
      : null;
  };
  const iconIssues = (el) => {
    const out = [];
    const bg = bgOf(el);
    for (const g of el.querySelectorAll(
      "svg path, svg line, svg rect, svg circle, svg polyline, svg polygon",
    )) {
      if (!visible(g.closest("svg"))) continue;
      if (g.closest(".leaflet-control-attribution")) continue; // 出典表示のロゴ（第三者の商標）は 1.4.11 の対象外
      const cs = getComputedStyle(g);
      const sw = parseFloat(cs.strokeWidth || "0");
      const sc = parse(cs.stroke);
      // 線で形が決まっている図形の塗りは、形を読み取るのに要らない（線が 3:1 あればよい）
      const strokeDefinesShape =
        cs.stroke !== "none" &&
        sc.a > 0 &&
        sw >= 1 &&
        cr(sc.a < 1 ? over(sc, bg) : sc, bg) >= 3;
      for (const prop of ["stroke", "fill"]) {
        if (prop === "fill" && /^(line|polyline)$/i.test(g.tagName)) continue;
        if (prop === "fill" && strokeDefinesShape) continue;
        const v = cs[prop];
        if (!v || v === "none") continue;
        const c0 = parse(v);
        if (c0.a === 0) continue;
        if (prop === "stroke" && sw === 0) continue;
        const c = cr(c0.a < 1 ? over(c0, bg) : c0, bg);
        if (c < 3)
          out.push({
            el: desc(el) + `（アイコン${prop}）`,
            ratio: +c.toFixed(2),
            need: 3,
            fg: hex(c0),
            bg: hex(bg),
            dis: isDisabled(el),
          });
      }
    }
    return out.slice(0, 1);
  };
  // フォーカス表示。二重リング（白＋インク）は、どちらか一方が周囲と 3:1 あれば見える
  const focusInfo = (el) => {
    const cs = getComputedStyle(el);
    const parentBg = bgOf(el, false);
    const selfBg = bgOf(el, true);
    const rings = [];
    if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0)
      rings.push({
        kind: "outline",
        col: parse(cs.outlineColor),
        width: parseFloat(cs.outlineWidth),
      });
    if (cs.boxShadow && cs.boxShadow !== "none") {
      const re =
        /(rgba?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)|#[0-9a-f]+)\s+0px\s+0px\s+0px\s+([\d.]+)px/gi;
      let m;
      while ((m = re.exec(cs.boxShadow)))
        rings.push({ kind: "ring", col: parse(m[1]), width: parseFloat(m[2]) });
    }
    if (!rings.length)
      return {
        el: desc(el),
        kind: "なし",
        ok: false,
        note: "フォーカス表示が見つからない",
      };
    let best = null;
    for (const r of rings) {
      const c = r.col.a < 1 ? over(r.col, parentBg) : r.col;
      const v = cr(c, parentBg);
      const vs = cr(c, selfBg);
      if (!best || v > best.vsParent)
        best = {
          kind: r.kind,
          width: r.width,
          color: hex(c),
          vsParent: +v.toFixed(2),
          vsSelf: +vs.toFixed(2),
        };
    }
    return { el: desc(el), ...best, ok: best.width >= 2 && best.vsParent >= 3 };
  };
  const boundary = (el) => {
    const cs = getComputedStyle(el);
    const parentBg = bgOf(el, false);
    const fill = bgOf(el, true);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const bc = parse(cs.borderTopColor);
    const fillC = cr(fill, parentBg);
    const borderC =
      bw >= 1 && bc.a > 0
        ? cr(bc.a < 1 ? over(bc, parentBg) : bc, parentBg)
        : 0;
    // 縁の外側の輪（ずらし・ぼかしの無い box-shadow と outline）も輪郭になる。夜の検索欄・シートの
    // 入力欄は、縁を地に近い紺にして、生成りの輪で範囲を見せている（app.css）。文字を入れている間は
    // フォーカス中なので、輪の代わりに白い outline が範囲を見せる。どちらも数えないと、
    // 見えている輪郭を「無い」と誤って指摘する
    let ringC = 0;
    const ow = parseFloat(cs.outlineWidth) || 0;
    const oc = parse(cs.outlineColor);
    if (cs.outlineStyle !== "none" && ow >= 1 && oc.a > 0)
      ringC = cr(oc.a < 1 ? over(oc, parentBg) : oc, parentBg);
    if (cs.boxShadow && cs.boxShadow !== "none") {
      const re =
        /(rgba?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)|#[0-9a-f]+)\s+0px\s+0px\s+0px\s+([\d.]+)px/gi;
      let m;
      while ((m = re.exec(cs.boxShadow))) {
        const c = parse(m[1]);
        if (parseFloat(m[2]) < 1 || c.a === 0) continue;
        ringC = Math.max(ringC, cr(c.a < 1 ? over(c, parentBg) : c, parentBg));
      }
    }
    return {
      fillC: +fillC.toFixed(2),
      borderC: +borderC.toFixed(2),
      ringC: +ringC.toFixed(2),
      fill: hex(fill),
      parent: hex(parentBg),
      border: hex(bc),
    };
  };
  const interactiveSel =
    'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
  // 同じ見た目の部品は1つだけ調べる
  const sig = (el) =>
    [
      el.tagName,
      [...el.classList].sort().join("."),
      el.getAttribute("aria-pressed"),
      el.getAttribute("aria-selected"),
      el.getAttribute("aria-expanded"),
      el.disabled ? "D" : "",
      (el.getAttribute("style") || "").replace(/[\d.]+/g, "").slice(0, 60),
    ].join("|");
  // 開閉のアニメーション（opacity の遷移）が終わるまで待つための値。測る面の実効の不透明度の最小値
  const settled = (sel) =>
    Math.min(1, ...[...document.querySelectorAll(sel)].map((e) => opOf(e)));
  window.__wc = {
    settled,
    textIssues,
    placeholderIssue,
    iconIssues,
    focusInfo,
    boundary,
    desc,
    visible,
    cr,
    parse,
    hex,
    bgOf,
    mark(rootSel) {
      document
        .querySelectorAll("[data-wc]")
        .forEach((e) => e.removeAttribute("data-wc"));
      const roots = [...document.querySelectorAll(rootSel)];
      const seen = new Set();
      let i = 0;
      const list = [];
      for (const root of roots)
        for (const el of [root, ...root.querySelectorAll(interactiveSel)]) {
          if (!el.matches(interactiveSel) || !visible(el)) continue;
          const s = sig(el);
          if (seen.has(s)) continue;
          seen.add(s);
          el.setAttribute("data-wc", String(i));
          const r = el.getBoundingClientRect();
          list.push({
            i,
            desc: desc(el),
            cls:
              el.className && el.className.baseVal === undefined
                ? el.className
                : "",
            disabled:
              !!el.disabled || el.getAttribute("aria-disabled") === "true",
            w: Math.round(r.width),
            h: Math.round(r.height),
            // 文中のリンク・地図の出典表示は、2.5.8 の「文中の対象」の例外
            inline:
              (el.tagName === "A" &&
                !!el.closest("p, li, .meta, .desc-body, .ft-msg") &&
                getComputedStyle(el).display === "inline") ||
              !!el.closest(".leaflet-control-attribution"),
          });
          i++;
        }
      return list;
    },
    check(i, state) {
      const el = document.querySelector(`[data-wc="${i}"]`);
      if (!el) return null;
      const res = { text: textIssues(el), icon: iconIssues(el) };
      const ph = placeholderIssue(el);
      if (ph) res.text.push(ph);
      if (state === "focus-visible") res.focus = focusInfo(el);
      if (state === "default") res.boundary = boundary(el);
      return res;
    },
  };
})();
