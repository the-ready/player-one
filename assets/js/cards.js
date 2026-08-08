/* カード1枚のHTMLを組み立てる。
   以前は renderList / renderMovieList / renderLiveList にほぼ同じ内容が3つあり、
   片方だけ直す事故が起きやすかったので、共通部分をここに1本化して
   タブごとの違い（上部の意匠・CTAの文言・受付の呼び方）だけを差し替える形にした。 */

import {
  esc,
  safeUrl,
  highlight,
  fmtDateWd,
  fmtDateWdShort,
  fmtWhen,
  haversineKm,
} from "./util.js";
import {
  LINEUP_VISIBLE,
  GENRE_TABLE_BY_TAB,
  SCREENING_TYPES,
  LIVE_TYPES,
  tableMeta,
  statusMeta,
  catMeta,
  venueNames,
} from "./config.js";
import { venueMeta, isKnownChain, theaterMeta } from "./data.js";
import {
  onsaleState,
  onsaleInDays,
  deadlineDays,
  isNewlyAnnounced,
  seriesSiblings,
  seriesHighlights,
} from "./filters.js";
import { schedulePhase, nextOpenDay } from "./schedule.js";
import { isFav } from "./state.js";

/* ---------- 小さな部品 ---------- */

export const ICON = {
  heart: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20s-7-4.6-7-9.4A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.6C19 15.4 12 20 12 20z"/></svg>`,
  share: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 13v6h14v-6"/></svg>`,
  device: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><line x1="10.5" y1="18.5" x2="13.5" y2="18.5"/></svg>`,
  google: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.2 9h17.6M3.2 15h17.6"/><path d="M12 3a15 15 0 0 0 0 18a15 15 0 0 0 0-18z"/></svg>`,
  cal: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>`,
};

// source が空だと「で予約する」のように動詞だけが残るので、その場合は主語なしの文言にする。
const ctaLabel = (source, cta) =>
  source ? `${source}${cta.suffix}` : cta.fallback;
const ctaAria = (title, source, cta) =>
  source
    ? `${title}を${source}${cta.ariaWith}`
    : `${title}の${cta.ariaWithout}`;

/* 出典名（it.source）は go-btn のラベル（「◯◯公式で予約する」）に既に出ているので、
   meta 欄にもう一度プレーンテキストで出すと同じ名前が2回現れる。
   代わりにこの行では「公式サイトを見る」のリンクを出す。official_url が url と
   同じ行では、同じ遷移先のリンクがカードに2つ並ぶので出さない。 */
function officialLinkHtml(it, label) {
  const href = safeUrl(it.officialUrl);
  if (!href || it.officialUrl === it.url) return "";
  return `<a class="official-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(it.title)}の公式サイトを開く">${esc(label)}</a>`;
}

/* price が空のとき、空の .price-txt が余白だけ残さないようにする。
   「要問合せ」の類は書いてあっても何も伝えていない（結局リンク先を見るしかない）ので、
   1行ぶんの余白を使ってまで出さない。 */
const NO_PRICE = ["要問合せ", "要問い合わせ", "要確認", "未定", "-", "—"];
const priceTxtHtml = (p) =>
  p && !NO_PRICE.includes(p.trim())
    ? `<span class="price-txt">${esc(p)}</span>`
    : "";

// 距離バッジ。現在地ソート中は現在地から、地図で範囲指定中はその中心からの距離を出す。
function distBadgeHtml(it, st) {
  if (st.sortBy === "location" && st.userLoc && isFinite(it._dist))
    return `<span class="dist-badge">現在地から ${it._dist.toFixed(1)}km</span>`;
  if (st.mapArea && it.lat != null && it.lng != null) {
    const d = haversineKm(st.mapArea.lat, st.mapArea.lng, it.lat, it.lng);
    return `<span class="dist-badge">中心から ${d.toFixed(1)}km</span>`;
  }
  return "";
}

function pillList(keys, table) {
  return (keys || [])
    .map((k) => {
      const m = tableMeta(table, k);
      return `<span class="pill-cat" style="background:${m.c};color:#fff">${esc(m.label)}</span>`;
    })
    .join("");
}

/* ---------- 上部の意匠 ---------- */

function posterMarkup(mv) {
  const src = safeUrl(mv.posterUrl);
  if (src) {
    // onerror はインライン属性ではなくJS側で拾う（将来CSPを入れたときに壊れないように）。
    return `<div class="ticket-poster">
      <img src="${esc(src)}" alt="${esc(mv.title)}のポスター" loading="lazy" decoding="async" data-poster>
    </div>`;
  }
  return `<div class="ticket-poster no-poster" aria-hidden="true"></div>`;
}

/* ライブ・フェスカードは映画の帯を流用せず、イベントと同じ装飾なしの構造にした
   （権利者が写真の無断転載・直リンクを明示的に禁じているため。docs/DESIGN.md 第7.1節、
   帯を廃止した経緯は第13.5節）。単独公演はタイトルに出演者名が出るので何も出さず、
   複数出演（フェス・共演）のときだけ、タイトル直下に本文の一部として出演者を並べる。 */
function artistLineHtml(lv, terms) {
  const names = lv.artists || [];
  if (names.length < 2) return "";
  const shown = names.slice(0, LINEUP_VISIBLE);
  const rest = names.length - shown.length;
  return `<p class="lineup-line">出演：${shown.map((n) => highlight(n, terms)).join("・")}${rest > 0 ? `　ほか${rest}組` : ""}</p>`;
}

/* ---------- 会場行 ---------- */

// その名前で会場モーダル（地図＋これからの予定）が開けるか。
function hasPlaceInfo(name, it) {
  return (
    isKnownChain(name) ||
    !!venueMeta(name) ||
    !!theaterMeta(name) ||
    (it.lat != null && it.lng != null)
  );
}

function placeLineHtml(tab, it, terms) {
  const names = venueNames(it);
  if (!names.length) return highlight(it.area || "", terms);

  const siteUrl = safeUrl(it.venueUrl || it.theaterUrl);
  const rendered = names
    .map((v) => {
      if (hasPlaceInfo(v, it)) {
        return `<button type="button" class="place-link" data-place="${esc(v)}" aria-label="${esc(v)}の場所とこれからの予定を見る">${highlight(v, terms)}</button>`;
      }
      // 単一会場の行だけリンクにする。複数会場を1つのURLでまとめて代表させると、
      // どの会場のサイトなのか分からなくなるため。
      if (siteUrl && names.length === 1) {
        return `<a class="place-link" href="${esc(siteUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(v)}の会場サイトを開く">${highlight(v, terms)}</a>`;
      }
      return highlight(v, terms);
    })
    .join("・");

  // 新作(チェーン名)の行は「チェーン名」だけで足り、エリアを足すと冗長になる。
  const showArea = it.area && !(names.length === 1 && isKnownChain(names[0]));
  return `${rendered}${showArea ? "／" + highlight(it.area, terms) : ""}`;
}

// 会場の規模。同じアーティストでもドームとライブハウスでは体験が違い、
// チケットの取りやすさの目安にもなる。マスターに無い会場では何も出さない。
function venueCapHtml(it) {
  const names = venueNames(it);
  if (names.length !== 1) return "";
  const v = venueMeta(names[0]);
  if (!v) return "";
  const kindLabel = v.kind ? VENUE_KIND_LABEL[v.kind] || v.kind : null;
  const parts = [
    kindLabel,
    v.capacity ? `約${v.capacity.toLocaleString()}人` : null,
  ].filter(Boolean);
  return parts.length
    ? `<br><span class="venue-cap">${esc(parts.join("／"))}</span>`
    : "";
}
// 循環importを避けるため、ラベルだけここに置く（config.js の VENUE_KINDS と同じ内容）。
const VENUE_KIND_LABEL = {
  dome: "ドーム・スタジアム",
  arena: "アリーナ",
  hall: "ホール",
  livehouse: "ライブハウス",
  outdoor: "野外・フェス会場",
};

/* ---------- 受付情報ブロック（カード表面） ----------
   受付の状態と発売日時は「くわしく」を開かずに読めなければ意味がない。
   最初に知りたいのは「そもそも今からでも申し込めるのか」で、それが折りたたまれて
   いると、開かなかった人には無いのと同じになる。 */
function ticketBlockHtml(tab, it) {
  const onsale = onsaleState(it); // ここで state という名前を使わない（絞り込み状態と紛れるため）
  const hi = seriesHighlights(it);
  if (onsale === "unknown" && !it.limitedSale && !hi.limited && !hi.before)
    return "";

  const words = tab.onsaleWords;
  const rows = [];
  if (onsale === "before") {
    const n = onsaleInDays(it);
    const when = fmtWhen(it.onsaleStart, it.onsaleStartTime);
    if (when)
      rows.push(
        `<span class="ti-row"><b>${esc(when)}</b> 受付開始${n != null ? `（${n === 0 ? "本日" : `あと${n}日`}）` : ""}</span>`,
      );
    const endWhen = fmtWhen(it.onsaleEnd, it.onsaleEndTime);
    if (endWhen)
      rows.push(`<span class="ti-row ti-sub">締切 ${esc(endWhen)}</span>`);
  } else if (onsale === "open") {
    const startWhen = fmtWhen(it.onsaleStart, it.onsaleStartTime);
    if (startWhen)
      rows.push(
        `<span class="ti-row ti-sub">${esc(startWhen)} より受付中</span>`,
      );
    const d = deadlineDays(it);
    const endWhen = fmtWhen(it.onsaleEnd, it.onsaleEndTime);
    if (endWhen)
      rows.push(
        `<span class="ti-row">締切 <b>${esc(endWhen)}</b>${d != null ? `（${d === 0 ? "本日開催" : `あと${d}日`}）` : ""}</span>`,
      );
  }
  if (it.limitedSale)
    rows.push(
      `<span class="ti-row ti-limited">限定・追加販売：${esc(it.limitedSale)}</span>`,
    );

  // シリーズ内の他会場にだけ出ている枠を知らせる。**この行に無いものだけ**を出す。
  // 自分も同じ状態なのに「他N件が発売前」と書くと、他にだけ何かあるように読めてしまう。
  const notes = [];
  if (hi.limited && !it.limitedSale)
    notes.push(`他${hi.limited}件に限定・追加販売あり`);
  if (hi.before && onsale !== "before")
    notes.push(`他${hi.before}件が${words.before}`);
  if (notes.length)
    rows.push(
      `<span class="ti-row ti-sub">${esc(tab.seriesLabel.replace(/の他の.*$/, ""))}：${esc(notes.join("／"))}</span>`,
    );

  // 受付終了は右上のバッジ列（cardHtml側）で伝えるので、他に出す情報が無い
  // 受付終了だけの行では、ラベルだけの帯をカード中央にもう一つ作らない。
  if (onsale === "closed" && !rows.length) return "";

  const urgent = onsale === "open" && deadlineDays(it) != null;
  return `<div class="ticket-info ${onsale}${urgent ? " urgent" : ""}">
      <span class="ti-head">
        ${onsale !== "unknown" && onsale !== "closed" ? `<span class="ti-badge">${esc(words[onsale])}</span>` : ""}
        ${it.onsaleLabel && onsale !== "closed" ? `<span class="ti-label">${esc(it.onsaleLabel)}</span>` : ""}
      </span>
      ${rows.join("")}
    </div>`;
}

/* シリーズの他会場は、日付と会場だけでなく受付の状態も並べる。
   「東京は完売だが仙台はこれから発売」を、1枚のカードから把握できるようにする。 */
function seriesOthersHtml(tab, it) {
  const others = seriesSiblings(it);
  if (!others.length) return "";
  const words = tab.onsaleWords;
  return `<div class="series-others">
      <span class="series-head">${esc(tab.seriesLabel)}（${others.length}件）</span>
      <ul>${others
        .map((o) => {
          const s = onsaleState(o);
          const tag =
            s === "unknown"
              ? ""
              : `<span class="ts-tag ${s}">${esc(words[s])}</span>`;
          const lim = o.limitedSale
            ? `<span class="ts-tag limited">限定・追加販売</span>`
            : "";
          return `<li>${esc([fmtDateWd(o.startDate) || o.dateText, ...venueNames(o)].filter(Boolean).join("／"))}${tag}${lim}</li>`;
        })
        .join("")}</ul>
    </div>`;
}

/* 会場のくわしい情報（駐車場・最寄り駅）。venue列と違い会場マスターを持たない
   イベント・ライブ双方で使える、行ごとの補足情報として持たせてある。
   どちらか一方だけでも出す。両方空なら行自体を出さない（3.5節の欠損耐性と同じ扱い）。 */
function venueDetailHtml(it) {
  const rows = [];
  if (it.nearestStation)
    rows.push(
      `<span class="vd-row"><span class="vd-label">最寄り駅</span>${esc(it.nearestStation)}</span>`,
    );
  if (it.parking)
    rows.push(
      `<span class="vd-row"><span class="vd-label">駐車場</span>${esc(it.parking)}</span>`,
    );
  return rows.length ? `<p class="venue-detail">${rows.join("")}</p>` : "";
}

/* 日程の補足（予備日・次の開催日）。カード表面の日付欄ではなく「くわしく」に置く。

   予備日を日付欄に出さないのは、**多くの場合それが使われずに終わる日**だからである。
   「2026.8.8(土)（予備日8.9）」と並べて書くと、本開催の日付と同じ強さで目に入り、
   8/9も何かある日のように読める。予備日が意味を持つのは荒天のときだけで、そのときは
   利用者はどのみち公式サイトを見に行く。カードの一等地は「いつ行くか」に使う。 */
function scheduleDetailHtml(it) {
  const rows = [];
  const next = schedulePhase(it) === "gap" ? nextOpenDay(it) : null;
  if (next)
    rows.push(
      `<span class="vd-row"><span class="vd-label">次の開催</span>${esc(fmtDateWd(next))}</span>`,
    );
  const backup = it.backupDate || [];
  if (backup.length) {
    const txt = backup
      .map((d, i) =>
        i === 0 ? fmtDateWd(d) : fmtDateWdShort(d, backup[i - 1]),
      )
      .filter(Boolean)
      .join("・");
    if (txt)
      rows.push(
        `<span class="vd-row"><span class="vd-label">予備日</span>${esc(txt)}（荒天などで順延された場合）</span>`,
      );
  }
  return rows.length ? `<p class="fact-list">${rows.join("")}</p>` : "";
}

/* ライブ・フェスのメインアーティストの Apple Music アーティストページへのリンク。
   appleMusicUrl は events.csv / movies.csv には列が無く常に undefined → safeUrl(undefined) は
   null になるため、tab を判定しなくてもライブ以外では自然に何も出ない。 */
function appleMusicLinkHtml(it) {
  const href = safeUrl(it.appleMusicUrl);
  if (!href) return "";
  return `<p class="apple-music-link"><a href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(it.title)}のApple Musicアーティストページを開く">Apple Musicでアーティストを見る</a></p>`;
}

/* 価格の内訳。検証済みの値が揃っているときだけ描画する。
   片方しかない場合に割引率を推定して表示することは絶対にしない。
   price_condition（「au会員・月曜のみ」など）がある行は必ず条件を併記する——
   条件付きの価格を無条件に見せるのは、値段を出さないより有害なため。 */
function priceBlock(it) {
  const cond = it.priceCondition
    ? `<span class="pc-cond">適用条件：${esc(it.priceCondition)}</span>`
    : "";
  if (it.priceOfficial && it.priceBest && it.bestSource) {
    const saved = it.priceOfficial - it.priceBest;
    return `<p class="price-compare">
      <span class="pc-row"><span class="pc-label">通常</span><s>${it.priceOfficial.toLocaleString()}円</s></span>
      <span class="pc-row"><span class="pc-label">${esc(it.bestSource)}</span><b>${it.priceBest.toLocaleString()}円</b>
        ${saved > 0 ? `<span class="pc-saved">${saved.toLocaleString()}円お得</span>` : ""}</span>
      ${cond}
      ${it.priceChecked ? `<span class="pc-checked">${esc(it.priceChecked)} 時点・大人1名</span>` : ""}
    </p>`;
  }
  if (it.priceOfficial) {
    return `<p class="price-compare">
      <span class="pc-row"><span class="pc-label">通常</span><b>${it.priceOfficial.toLocaleString()}円</b></span>
      ${cond}
      <span class="pc-checked">他サイトの価格は未確認${it.priceChecked ? `／${esc(it.priceChecked)} 時点` : ""}</span>
    </p>`;
  }
  return "";
}

/* ---------- カレンダー連携 ---------- */

const icsDate = (ymd) => String(ymd || "").replace(/-/g, "");
function icsEscape(s) {
  return String(s == null ? "" : s)
    .replace(/[\\;,]/g, (m) => "\\" + m)
    .replace(/\r?\n/g, "\\n");
}
/** 終日イベントとして .ics を組む。DTEND は排他なので終了日の翌日にする。 */
export function buildIcs(it) {
  const start = it.startDate || it.endDate;
  if (!start) return null;
  const endSrc = it.endDate || it.startDate;
  const end = new Date(endSrc + "T00:00:00");
  if (isNaN(end.getTime())) return null;
  end.setDate(end.getDate() + 1);
  const dtEnd = icsDate(
    `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`,
  );
  const where = [...venueNames(it), it.area].filter(Boolean).join(" ");
  const url = safeUrl(it.url || it.officialUrl) || "";
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//eventboard//JP",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${it.uid}@eventboard`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${icsDate(start)}`,
    `DTEND;VALUE=DATE:${dtEnd}`,
    `SUMMARY:${icsEscape(it.title)}`,
    where ? `LOCATION:${icsEscape(where)}` : "",
    `DESCRIPTION:${icsEscape([it.desc, url].filter(Boolean).join("\n"))}`,
    url ? `URL:${icsEscape(url)}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}

export function gcalUrl(it) {
  const start = it.startDate || it.endDate;
  if (!start) return null;
  const endSrc = it.endDate || it.startDate;
  const end = new Date(endSrc + "T00:00:00");
  if (isNaN(end.getTime())) return null;
  end.setDate(end.getDate() + 1);
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: it.title,
    dates: `${icsDate(start)}/${icsDate(`${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`)}`,
    details: [it.desc, safeUrl(it.url || it.officialUrl)]
      .filter(Boolean)
      .join("\n"),
    location: [...venueNames(it), it.area].filter(Boolean).join(" "),
  });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

/* ---------- カード本体 ---------- */

export function cardHtml(tab, it, st, terms) {
  const badge = statusMeta(tab.statusTable, it.status);
  const onsale = onsaleState(it);
  const href = safeUrl(it.url || it.officialUrl);
  const cta = ctaLabel(it.source, tab.cta);
  const fav = isFav(it);
  const mainCat =
    tab.key === "event" && it.cats && it.cats.length
      ? catMeta(it.cats[0])
      : tab.key === "live" && it.genre && it.genre.length
        ? tableMeta(GENRE_TABLE_BY_TAB.live, it.genre[0])
        : null;
  const officialLink = officialLinkHtml(it, tab.officialLabel);

  const header =
    tab.header === "poster"
      ? posterMarkup(it) +
        `<div class="film-strip" aria-hidden="true"></div><div class="ticket-tear" aria-hidden="true"></div>`
      : "";

  // mainCat（左上floatバッジ）は cats[0] / genre[0] を使っているので、
  // 同じ値をこの下のピル一覧にもう一度出さない（バッジと本文で同じタグが二重表示されるのを防ぐ）。
  const pills =
    tab.key === "event"
      ? pillList(
          (it.cats || []).slice(mainCat ? 1 : 0),
          GENRE_TABLE_BY_TAB.event,
        )
      : tab.key === "movie"
        ? pillList(it.screeningType, SCREENING_TYPES) +
          pillList(it.genre, GENRE_TABLE_BY_TAB.movie)
        : pillList(it.liveType, LIVE_TYPES) +
          pillList(
            (it.genre || []).slice(mainCat ? 1 : 0),
            GENRE_TABLE_BY_TAB.live,
          );

  const detailBody = [
    it.desc ? `<p class="desc-body">${highlight(it.desc, terms)}</p>` : "",
    scheduleDetailHtml(it),
    appleMusicLinkHtml(it),
    venueDetailHtml(it),
    tab.hasPrice ? priceBlock(it) : "",
    it.couponNote
      ? `<p class="coupon-note"><span class="coupon-tag">クーポン</span>${esc(it.couponNote)}</p>`
      : "",
    seriesOthersHtml(tab, it),
    it.note
      ? `<p class="coupon-note"><span class="coupon-tag">注意</span>${esc(it.note)}</p>`
      : "",
    it.posterUrl && it.posterSource
      ? `<p class="poster-credit">ポスター画像出典：${esc(it.posterSource)}</p>`
      : "",
  ].join("");

  const descId = `desc-${it.key}`;
  const toggle = detailBody.trim()
    ? `<button type="button" class="detail-toggle" data-target="${descId}" data-title="${esc(it.title)}" aria-expanded="false" aria-controls="${descId}" aria-label="${esc(it.title)}のくわしい説明を見る">くわしく ▾</button>`
    : "";
  // 行きたい・共有・カレンダーは「くわしく」と同じ行の右側に置く。
  const actions = `<div class="card-actions">
      <button type="button" class="act-btn fav-btn" data-act="fav" aria-pressed="${fav}" title="${fav ? "行きたいリストから外す" : "行きたいリストに追加"}" aria-label="${esc(it.title)}を行きたいリストに${fav ? "登録済み。外す" : "追加する"}">${ICON.heart}</button>
      <button type="button" class="act-btn" data-act="share" title="共有" aria-label="${esc(it.title)}を共有する">${ICON.share}</button>
      ${buildIcs(it) ? `<button type="button" class="act-btn" data-act="cal" title="カレンダーに追加" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(it.title)}をカレンダーに追加する">${ICON.cal}</button>` : ""}
    </div>`;
  const detail = `<div class="detail-row">${toggle}${actions}</div>
      ${detailBody.trim() ? `<div class="desc" id="${descId}">${detailBody}</div>` : ""}`;

  return `
  <article class="card ${tab.cardClass}" data-key="${esc(it.key)}">
    ${mainCat ? `<span class="cat-badge" style="background:${mainCat.c};color:#fff">${esc(mainCat.label)}</span>` : ""}
    ${isNewlyAnnounced(it) ? `<span class="new-badge">NEW</span>` : ""}
    ${header}
    <div class="${tab.bodyClass}">
      <div class="top-row">
        <span class="date-txt${tab.key === "live" ? " live-date" : ""}">${esc(it.dateText || "")}</span>
        <span class="badge-stack">
          ${it.isAdditional ? `<span class="add-badge">${esc(tab.additionalLabel)}</span>` : ""}
          ${it.status ? `<span class="status-badge" style="background:${badge.bg};color:${badge.c}">${esc(it.status)}</span>` : ""}
          ${onsale === "closed" ? `<span class="status-badge closed-badge">${esc(tab.onsaleWords.closed)}</span>` : ""}
        </span>
      </div>
      <h3 class="title">${highlight(it.title, terms)}</h3>
      ${tab.key === "live" ? artistLineHtml(it, terms) : ""}
      <p class="meta">${placeLineHtml(tab, it, terms)}${venueCapHtml(it)}${officialLink ? `<br>${officialLink}` : ""}${distBadgeHtml(it, st)}</p>
      <div class="cats">${pills}</div>
      ${ticketBlockHtml(tab, it)}
      ${detail}
      ${priceTxtHtml(it.price)}
      ${
        href
          ? `<a class="go-btn${tab.key === "movie" ? " ticket-btn" : ""}" href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(ctaAria(it.title, it.source, tab.cta))}">${
              tab.key === "movie"
                ? `<span class="ticket-btn-end" aria-hidden="true"></span><span class="ticket-btn-main"><span class="ticket-btn-label">${esc(cta)}</span></span><span class="ticket-btn-end" aria-hidden="true"></span>`
                : esc(cta)
            }</a>`
          : ""
      }
    </div>
  </article>`;
}
