/* 小さな純粋関数だけを置く。ここは他のどのモジュールにも依存しない。 */

/* CSVの値はそのままHTMLに差し込むので、必ず esc() を通す。タイトルに " を含む行
   （例:『… "World 2"』）があると、素の埋め込みでは aria-label が途中で切れて
   壊れた属性が生えるため。 */
export function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

/* href に入れてよいURLだけを通す。CSVは自分たちで書くものだが、
   javascript: や data: が1行混ざるだけでクリックが実行になるため、
   スキームの許可リストで塞いでおく（表示側で吸収するという第3.5節の契約の一部）。
   相対パス・ルート相対も許可する（自サイト内リンクを将来書けるように）。 */
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;
export function safeUrl(u) {
  const s = (u == null ? "" : String(u)).trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return SAFE_SCHEME.test(s) ? s : null;
  if (s.startsWith("//")) return null; // プロトコル相対は出どころが読めないので落とす
  return s.startsWith("/") || s.startsWith("./") || s.startsWith("#")
    ? s
    : null;
}

// CSVの欠損・想定外の値を吸収するための小さなヘルパ。
// 空文字とパース不能をどちらも null に寄せて、以降の判定を「null かどうか」に統一する。
export const txt = (v) => {
  const s = (v == null ? "" : String(v)).trim();
  return s ? s : null;
};
export const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
export const int = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
export const list = (v) => {
  const s = txt(v);
  return s
    ? s
        .split("|")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
};
// "0" や "false" を真と誤認しないよう、明示的に真を表す値だけを拾う。
export const bool = (v) =>
  ["1", "true", "yes"].includes(
    String(v == null ? "" : v)
      .trim()
      .toLowerCase(),
  );

export const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const DAY_MS = 86400000;
export const WD = ["日", "月", "火", "水", "木", "金", "土"];

export function fmtDateDots(ymd) {
  if (!ymd) return null;
  const [y, m, d] = String(ymd).split("-");
  if (!y || !m || !d) return null;
  return `${y}.${parseInt(m, 10)}.${parseInt(d, 10)}`;
}
export function fmtDateJa(ymd) {
  if (!ymd) return null;
  const [y, m, d] = String(ymd).split("-");
  if (!y || !m || !d) return null;
  return `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}
export function fmtDateWd(ymd) {
  const base = fmtDateDots(ymd);
  if (!base) return null;
  const t = new Date(ymd + "T00:00:00");
  return isNaN(t.getTime()) ? base : `${base}(${WD[t.getDay()]})`;
}
// 日付＋時刻。時刻が未登録の行では日付だけを出す（0:00と書いて嘘をつかない）。
export function fmtWhen(ymd, hm) {
  const d = fmtDateWd(ymd);
  if (!d) return null;
  return hm ? `${d} ${hm}` : d;
}

/* ---------- 日程の表示文字列 ----------
   CSVには ISO の日付しか置かず、画面に出す文字列はここで毎回組み立てる。
   曜日を書き置きしないのはこのためで、書き置くと「日付を直したのに曜日が
   前のまま」という、読み手には気づけない嘘が残る。 */

// 2つ目以降の日付は、前の日付と重なる部分を落として短くする。
// 「2026.9.19(土)〜2026.9.20(日)」は年も月も繰り返していて、読む手間だけが増える。
export function fmtDateWdShort(ymd, prev) {
  const full = fmtDateWd(ymd);
  if (!full || !prev) return full;
  const [y, m, d] = String(ymd).split("-");
  const [py, pm] = String(prev).split("-");
  if (y !== py) return full;
  const wd = full.slice(full.indexOf("("));
  return m === pm
    ? `${parseInt(d, 10)}${wd}`
    : `${parseInt(m, 10)}.${parseInt(d, 10)}${wd}`;
}

// 飛び日程をそのまま全部並べるとカードの1行に収まらないので、この数で打ち切る。
export const SPAN_MAX_DAYS = 8;

/**
 * 会期の表示。days（飛び日程の実開催日）があればそちらが優先で、
 * 無ければ start〜end の連続した会期として扱う。
 * end が空なのは「終了日が未定」の意味なので、開いた範囲（`〜` で終わる）にする。
 */
export function fmtSpan(start, end, days) {
  if (days && days.length) {
    const shown =
      days.length > SPAN_MAX_DAYS ? days.slice(0, SPAN_MAX_DAYS - 1) : days;
    const rest = days.length - shown.length;
    const body = shown
      .map((d, i) => (i === 0 ? fmtDateWd(d) : fmtDateWdShort(d, shown[i - 1])))
      .filter(Boolean)
      .join("・");
    return rest > 0 ? `${body}・ほか${rest}日` : body;
  }
  if (start && end && start !== end)
    return `${fmtDateWd(start)}〜${fmtDateWdShort(end, start)}`;
  if (start && !end) return `${fmtDateWd(start)}〜`;
  if (start) return fmtDateWd(start);
  if (end) return `〜${fmtDateWd(end)}`;
  return null;
}

/**
 * 時刻の表示。開場・開演の呼び方はタブごとに違う（公演は「開演」、上映は「上映」）ので
 * 語だけを words で受け取り、組み立ての規則は3タブで1つに保つ。
 * 未登録の時刻は書かない——0:00 と書くのは、書かないより悪い。
 */
export function fmtTimes(open, start, end, words) {
  const seg = [];
  if (open) seg.push(`${words.open}${open}`);
  if (start) seg.push(`${words.start}${start}${end ? `〜${end}` : ""}`);
  else if (end) seg.push(`〜${end}`);
  return seg.length ? seg.join("／") : null;
}
export function fmtKm(km) {
  return km < 10 ? `${km.toFixed(1)}km` : `${Math.round(km)}km`;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180,
    dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ---------- 日本語検索のための正規化 ----------
   「ｚｅｐｐ」で「Zepp」が、「でぃずにー」で「ディズニー」が引けないのは
   検索が使えないのと同じなので、照合の前に次の3つをそろえる。
     1. NFKC（全角英数→半角、半角カナ→全角カナ）
     2. カタカナ→ひらがな（どちらで打っても当たるように）
     3. 長音記号・ダッシュ類の統一と、空白の畳み込み

   ハイライトのために「正規化後の位置 → 元の文字列の位置」を保てるよう、
   文字単位（半角カナ＋濁点は2文字で1単位）で畳んで対応表を作る。
   全体を一括で normalize すると "ﾃﾞ"(2文字) → "デ"(1文字) のような
   長さの変化で位置がずれ、ハイライトが1文字ずつ後ろへ流れていく。 */
const HALFWIDTH_KANA = /[ｦ-ﾝ]/;
const VOICED_MARK = /[ﾞﾟ]/;

function foldUnit(u) {
  let s = u.normalize("NFKC").toLowerCase();
  // カタカナ→ひらがな（ヴ・小書きも含む可視範囲）
  s = s.replace(/[ァ-ヶ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60),
  );
  // 長音・ダッシュ・ハイフン類を1つに寄せる（範囲指定にならないよう1文字ずつ並べる）
  s = s.replace(/[ー‐‑‒–—―−－-]/g, "-");
  return s;
}

/** 元文字列 → {text: 正規化後, map: 正規化後の各文字が元文字列のどこ由来か} */
export function foldWithMap(src) {
  const s = String(src == null ? "" : src);
  let text = "";
  const map = []; // map[i] = 元文字列のインデックス
  for (let i = 0; i < s.length; i++) {
    let unit = s[i],
      consumed = 1;
    // 半角カナ＋濁点/半濁点は2文字で1文字ぶん。先に合成しないと "ﾃﾞ" が "て゛" になる
    if (
      HALFWIDTH_KANA.test(unit) &&
      i + 1 < s.length &&
      VOICED_MARK.test(s[i + 1])
    ) {
      unit = s[i] + s[i + 1];
      consumed = 2;
    }
    const folded = foldUnit(unit);
    for (const ch of folded) {
      text += ch;
      map.push(i);
    }
    if (consumed === 2) i++;
  }
  return { text, map, src: s };
}

/** 照合用にだけ使う軽い正規化（位置対応が要らない場面向け）。 */
export function fold(src) {
  return foldWithMap(src).text;
}

/** 検索語をAND条件の配列に割る。「横浜 ロック」→ ["よこはま","ろっく"] */
export function searchTerms(q) {
  return fold(q)
    .split(/[\s　]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 元の文字列を HTML エスケープしつつ、terms に当たる箇所を <mark> で包む。
 * 一致判定は正規化後の文字列で行い、対応表で元の文字位置へ戻す。
 */
export function highlight(src, terms) {
  const s = String(src == null ? "" : src);
  if (!terms || !terms.length) return esc(s);
  const { text, map } = foldWithMap(s);
  if (!text) return esc(s);

  const hits = new Array(s.length).fill(false);
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(term, from);
      if (at < 0) break;
      for (let k = at; k < at + term.length && k < map.length; k++)
        hits[map[k]] = true;
      from = at + term.length;
    }
  }
  let out = "",
    open = false;
  for (let i = 0; i < s.length; i++) {
    if (hits[i] && !open) {
      out += "<mark>";
      open = true;
    } else if (!hits[i] && open) {
      out += "</mark>";
      open = false;
    }
    out += esc(s[i]);
  }
  return open ? out + "</mark>" : out;
}

/** 会場名はボタンに収まらない長さのことがある（「国立代々木競技場第一体育館」など）。 */
export function shortLabel(s, max = 7) {
  const v = String(s == null ? "" : s);
  return v.length > max ? v.slice(0, max) + "…" : v;
}

/** 安定したキーを作る。CSVの行順や id の付け替えに左右されないようにする
    （お気に入りが週次更新のたびに別の行へ移らないため）。 */
export function stableUid(parts) {
  const s = parts.filter(Boolean).join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    if (!ms) {
      fn(...args);
      return;
    }
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
