/* WCAG 2.2（AA）の色・フォーカス・押しどころの点検。画面を順に開き、部品ごとに
   「通常・触れた・フォーカス・押した」の4状態を測って、基準に届かない箇所を一覧する。
   見つかれば終了コード1。smoke_test.mjs は「壊れていないか」を見る道具で、
   こちらは「見えるか」を見る道具（1画面ごとに時間がかかるので run_all_tests.py には含めない）。

   測る基準:
     1.4.3  文字の対比（4.5:1。大きい文字 3:1）。::before/::after・半透明も実効の色で測る
     1.4.11 アイコンの対比・入力欄の輪郭（3:1）
     2.4.7 / 1.4.11  フォーカス表示（幅 2px 以上・周囲と 3:1）
     2.4.11 フォーカスが操作バーに隠れない（Tab／Shift+Tab で全部通して確かめる）
     2.5.8  押しどころ 24×24px（文中のリンク・★の当たり判定は例外。下の EXEMPT_SIZE）
   押せない部品（disabled）の文字は 1.4.3 の対象外なので数えない。

   使い方（要 playwright。smoke_test.mjs と同じく、先に静的サーバを立てる）:
     python3 -m http.server 8000 &
     node tools/wcag_audit.mjs <iso時刻> <名前> [幅] [高さ]
     例: node tools/wcag_audit.mjs 2026-10-18T20:30:00+09:00 night          # 夜・PC幅
         node tools/wcag_audit.mjs 2026-10-18T20:30:00+09:00 night-sp 390 844 # 夜・スマホ幅
         node tools/wcag_audit.mjs 2026-10-18T12:00:00+09:00 noon
         node tools/wcag_audit.mjs 2026-10-18T06:35:00+09:00 morning
         node tools/wcag_audit.mjs 2026-10-18T17:08:00+09:00 dusk
         WALL=static node tools/wcag_audit.mjs 2026-10-18T12:00:00+09:00 static # 壁紙を水玉にした画面
   BASE（既定 http://localhost:8000/）・PW_CHROME で場所を指定する。
   結果は temp/wcag/<名前>.json と、画面ごとの画像（temp/wcag/<名前>/）に残る。
   時刻は少しずつ進む時計にしてあるので、夕方の薄明は 17:08 から始めれば測っている間に夜へ変わらない。 */

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.BASE || "http://localhost:8000/";
const launchOpts = process.env.PW_CHROME
  ? { executablePath: process.env.PW_CHROME }
  : {};
const ISO = process.argv[2] || "2026-10-18T20:30:00+09:00";
const NAME = process.argv[3] || "night";
const W = +(process.argv[4] || 1280);
const H = +(process.argv[5] || 900);
const OUT = `temp/wcag`;
fs.mkdirSync(`${OUT}/${NAME}`, { recursive: true });

// 押しどころの例外。★は見た目が 24×22px だが、::after で当たり判定を広げてある（app.css の .star-btn::after）。
// 会場名・出演者名のリンクは文中の対象（2.5.8 の「文中」の例外）
const EXEMPT_SIZE = /\.star-btn|\.place-link|\.art-link/;

const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  serviceWorkers: "block",
});
const page = await ctx.newPage();
// 何本か並べて回すと、遅い端末では最初の読み込みが既定の30秒を超える
page.setDefaultNavigationTimeout(120000);
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
// 時計は、指定の時刻から実時間の 1/20 の速さで進める（測っている間に昼夜が変わらないように）
await page.addInitScript((t) => {
  const real = Date.now.bind(Date);
  const t0 = real();
  Date.now = () => t + (real() - t0) * 0.05;
}, Date.parse(ISO));
await page.addInitScript({
  path: new URL("./wcag_probe.js", import.meta.url).pathname,
});
// WALL=static で、壁紙を水玉（空の色を使わない紙色の画面）にして測る
if (process.env.WALL === "static")
  await page.addInitScript(() => {
    try {
      localStorage.setItem("eventboard.wallpaper.v1", "static");
    } catch {}
  });
await page.goto(BASE);
await page.waitForSelector("#list .card", {
  state: "attached",
  timeout: 120000,
});
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(2500);
await page.addStyleTag({
  content: ".grid.is-entering .card{animation:none;opacity:1}",
});
const cdp = await ctx.newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");

const report = {
  iso: ISO,
  cls: await page.evaluate(() => document.documentElement.className),
  contexts: [],
  extra: [],
};
async function audit(label, rootSel, shot = true) {
  await page.waitForTimeout(400);
  // ポップアップは開くとき不透明度が 0 → 1 に遷移する。負荷が高いと 400ms では終わらず、
  // 透けた状態を測って「文字が地と同じ色」と誤検出するので、終わるまで待つ
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate((s) => window.__wc.settled(s), rootSel)) >= 0.99)
      break;
    await page.waitForTimeout(150);
  }
  const textAll = await page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].flatMap((r) =>
        window.__wc.textIssues(r),
      ),
    rootSel,
  );
  const list = await page.evaluate((sel) => window.__wc.mark(sel), rootSel);
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const items = [];
  // 状態を強制した直後は遷移の途中の値が返る（.go-btn の影は 0.12s かけて変わり、負荷が高いと
  // 待っても終わらない）。測っている間だけ遷移を止めて、強制した状態の最終の値を読む
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.id = "__wc_nt";
    st.textContent = "*,*::before,*::after{transition:none!important}";
    document.head.append(st);
  });
  for (const it of list) {
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: `[data-wc="${it.i}"]`,
    });
    if (!nodeId) continue;
    const r = { ...it, states: {} };
    for (const state of ["default", "hover", "focus-visible", "active"]) {
      await cdp.send("CSS.forcePseudoState", {
        nodeId,
        forcedPseudoClasses:
          state === "default"
            ? []
            : state === "focus-visible"
              ? ["focus", "focus-visible"]
              : [state],
      });
      r.states[state] = await page.evaluate(
        ([i, s]) => window.__wc.check(i, s),
        [it.i, state],
      );
    }
    await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    items.push(r);
  }
  await page.evaluate(() => document.getElementById("__wc_nt")?.remove());
  if (shot)
    await page.screenshot({
      path: `${OUT}/${NAME}/${String(report.contexts.length).padStart(2, "0")}-${label}.jpg`,
      type: "jpeg",
      quality: 62,
    });
  report.contexts.push({ label, rootSel, textAll, items });
  console.log(`${label}: 部品 ${items.length}`);
}
const click = async (sel, wait = 500) => {
  await page.evaluate((s) => document.querySelector(s)?.click(), sel);
  await page.waitForTimeout(wait);
};
const top = async () => {
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(400);
};
// 地図は canvas に印を描くので、地図の上を格子状に押して吹き出しが開くところを探す
async function openMapPopup(mapSel, popupSel, from = 20) {
  const mb = await page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r && { x: r.x, y: r.y, w: r.width, h: r.height };
  }, mapSel);
  if (!mb) return false;
  for (let y = mb.y + from; y < mb.y + mb.h - 34; y += 9)
    for (let x = mb.x + 30; x < mb.x + mb.w - 30; x += 9) {
      // 出典のリンク（同じタブで別のページへ移る）と拡大縮小ボタンは押さない
      if (
        await page.evaluate(
          ([x, y]) =>
            !!document.elementFromPoint(x, y)?.closest("a, .leaflet-control"),
          [x, y],
        )
      )
        continue;
      await page.mouse.click(x, y);
      await page.waitForTimeout(50);
      if (await page.$(popupSel)) return true;
    }
  return false;
}

// 1. ヘッダー・操作バー・カード（閉じた状態）
await audit("ヘッダー", "#hdr");
await audit("操作バー", ".controls");
await audit("カード", "#list > .card:nth-child(-n+9)");
// 2. カードの状態：行きたい（押した）・くわしく（開いた）
await page.evaluate(() => {
  const cs = document.querySelectorAll("#list > .card");
  for (let i = 0; i < 9; i++) cs[i]?.querySelector(".detail-toggle")?.click();
  cs[0].querySelector('.act-btn[data-act="fav"]')?.click();
});
await page.waitForTimeout(600);
await page.evaluate(() =>
  document.querySelector("#favToast")?.setAttribute("hidden", ""),
);
await audit("カード（くわしく・行きたい）", "#list > .card:nth-child(-n+9)");
await page.evaluate(() => {
  const cs = document.querySelectorAll("#list > .card");
  for (let i = 0; i < 9; i++) cs[i]?.querySelector(".detail-toggle")?.click();
  cs[0].querySelector('.act-btn[data-act="fav"]')?.click();
});
// 3. ポップアップ
await top();
await click("#sortDateBtn", 900);
await audit("日程", "#popoverPanel");
await page.evaluate(() => {
  const d = [
    ...document.querySelectorAll("#popoverPanel .cal-day:not([disabled])"),
  ];
  d[8]?.click();
});
await page.waitForTimeout(300);
await page.evaluate(() => {
  const d = [
    ...document.querySelectorAll("#popoverPanel .cal-day:not([disabled])"),
  ];
  d[13]?.click();
});
await page.waitForTimeout(600);
if (await page.$("#popoverPanel[hidden]")) await click("#sortDateBtn", 900);
await audit("日程（期間を選んだ）", "#popoverPanel");
await page.keyboard.press("Escape");
await top();
await click("#sortLocBtn", 900);
await audit("エリア", "#popoverPanel");
await page.evaluate(() =>
  document.querySelector("#popoverPanel .region-chip")?.click(),
);
await page.waitForTimeout(600);
if (await page.$("#popoverPanel[hidden]")) await click("#sortLocBtn", 900);
await page.fill(".venue-search", "ホール").catch(() => {});
await page.waitForTimeout(500);
await audit("エリア（都県を選び会場を検索）", "#popoverPanel");
await page.fill(".venue-search", "").catch(() => {});
await page.keyboard.press("Escape");
await top();
await click("#catBtn", 900);
await audit("絞り込み", "#popoverPanel");
for (const i of [0, 3, 6, 9, 12, 15, 18]) {
  await page
    .locator("#catBody .chip:not([disabled])")
    .nth(i)
    .click({ timeout: 3000 })
    .catch(() => {});
  await page.waitForTimeout(200);
}
await audit("絞り込み（押した状態）", "#popoverPanel");
// チップを1つずつ押して、押した状態の文字を測る（色つきのチップは地の色が変わる）
report.extra.push(
  ...(await page.evaluate(async () => {
    const out = [];
    const n = document.querySelectorAll("#catBody .chip").length;
    for (let i = 0; i < n; i++) {
      const c0 = document.querySelectorAll("#catBody .chip")[i];
      if (!c0 || c0.disabled) continue;
      c0.click();
      await new Promise((r) => setTimeout(r, 60));
      const c = document.querySelectorAll("#catBody .chip")[i];
      for (const t of window.__wc.textIssues(c))
        out.push({ kind: "1.4.3 文字（押したチップ）", ...t });
      c.click();
      await new Promise((r) => setTimeout(r, 60));
    }
    return out;
  })),
);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await audit("操作バー（適用中）", ".controls");
await click("#appliedClear", 800);
// 4. カードのメニュー・シート
await top();
await page.evaluate(() =>
  document.querySelector('#list .card .act-btn[data-act="cal"]').click(),
);
await page.waitForTimeout(500);
await audit("カレンダー追加メニュー", ".cal-menu");
await click('.cal-menu [data-cal="ics"]', 800);
await audit("日時を選ぶシート", "#calAddSheet");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await click("#list .card .place-link[data-place]", 1500);
await audit("会場シート", "#placeSheet");
// 会場シートの地図の吹き出し（Leaflet 標準）
{
  const b = await page.evaluate(() => {
    const r = document
      .querySelector("#placeSheet .leaflet-container")
      ?.getBoundingClientRect();
    return r && { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  let opened = false;
  if (b)
    for (let dy = 0; dy <= 40 && !opened; dy += 5)
      for (let dx = -20; dx <= 20 && !opened; dx += 5) {
        await page.mouse.click(b.x + b.w / 2 + dx, b.y + b.h / 2 + dy);
        await page.waitForTimeout(150);
        opened = !!(await page.$("#placeSheet .leaflet-popup"));
      }
  if (opened) await audit("会場シートの吹き出し", "#placeSheet .leaflet-popup");
  else console.log("会場シートの吹き出し: 開けず");
}
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await top();
await click("#sortLocBtn", 800);
await click("#openMapBtn", 1800);
await audit("地図シート", "#mapSheet");
// 範囲をえらぶ地図の吹き出し：読める色か、枠の中に収まっているか（上端のピンで切れない）
if (
  await openMapPopup("#mapSheet .leaflet-container", "#mapPopup:not([hidden])")
) {
  await audit("地図の吹き出し", "#mapPopup");
  const bad = await page.evaluate(() => {
    const p = document.querySelector("#mapPopup").getBoundingClientRect();
    const c = document
      .querySelector("#mapPopup")
      .parentElement.getBoundingClientRect();
    return p.top < c.top - 1 ||
      p.bottom > c.bottom + 1 ||
      p.left < c.left - 1 ||
      p.right > c.right + 1
      ? {
          p: [p.top, p.right, p.bottom, p.left].map(Math.round),
          c: [c.top, c.right, c.bottom, c.left].map(Math.round),
        }
      : null;
  });
  if (bad)
    report.extra.push({
      kind: "吹き出しが地図の枠から出ている",
      el: "#mapPopup",
      note: JSON.stringify(bad),
    });
} else console.log("地図の吹き出し: 開けず");
// 上端に近いピンの吹き出し（上に収まらないので下に出る）
if (
  await openMapPopup(
    "#mapSheet .leaflet-container",
    "#mapPopup:not([hidden])",
    4,
  )
) {
  const bad = await page.evaluate(() => {
    const p = document.querySelector("#mapPopup").getBoundingClientRect();
    const c = document
      .querySelector("#mapPopup")
      .parentElement.getBoundingClientRect();
    return p.top < c.top - 1 ||
      p.bottom > c.bottom + 1 ||
      p.left < c.left - 1 ||
      p.right > c.right + 1
      ? {
          p: [p.top, p.right, p.bottom, p.left].map(Math.round),
          c: [c.top, c.right, c.bottom, c.left].map(Math.round),
        }
      : null;
  });
  if (bad)
    report.extra.push({
      kind: "吹き出しが地図の枠から出ている（上端のピン）",
      el: "#mapPopup",
      note: JSON.stringify(bad),
    });
}
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
// 5. ライブ：出演者シート・カード
await click("#tabLiveBtn", 1800);
await audit("ライブのカード", "#liveList > .card:nth-child(-n+9)");
await page.evaluate(() => {
  document
    .querySelectorAll("[data-wc-fest]")
    .forEach((e) => e.removeAttribute("data-wc-fest"));
  const b = document.querySelector("#liveList .lineup-btn");
  b?.closest(".card")?.setAttribute("data-wc-fest", "1");
});
await audit("フェスのカード（出演者ボタン）", "#liveList [data-wc-fest]");
if (await page.$("#liveList .lineup-btn")) {
  await click("#liveList .lineup-btn", 1000);
  await audit("出演者シート", "#lineupSheet");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}
await click("#tabMovieBtn", 1800);
await audit("映画のカード", "#movieList > .card:nth-child(-n+9)");
await click("#tabEventBtn", 1500);
// 6. お気に入り
await top();
await page.evaluate(() =>
  document.querySelectorAll("#list .star-btn")[12]?.click(),
);
await page.waitForSelector("#favToast.show", { timeout: 8000 }).catch(() => {});
await audit("お気に入りのトースト", "#favToast");
await page.evaluate(() =>
  document.querySelector("#favToast button.primary")?.click(),
);
await page.waitForTimeout(1200);
await audit("お気に入り先頭セクション", "#list .fav-head");
await click('[data-fav-act="manage"]', 800);
await audit("お気に入り管理シート", "#favSheet");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
// 6c. お気に入りアーティスト。人を登録した状態で開き直して測る。先頭セクション・「なぜ」の行・
//     「前回から追加」・トースト・出演予定のシート・出演者シートの人のボタンと日タブの印・管理シート。
//     登録した人がいないと出ない部品なので、状態を作れなかったときは「点検できず」で落とす
{
  await click("#tabLiveBtn", 1800);
  const names = await page.evaluate(async () => {
    const n = new Map();
    document
      .querySelectorAll("#liveList .art-btn[data-artist]")
      .forEach((b) =>
        n.set(b.dataset.artist, (n.get(b.dataset.artist) || 0) + 1),
      );
    // フェスの出演者は、カードの人のボタンには出ない（出演者シートの中にだけある）ので、
    // ラインナップの出演者を2人足して、出演者シートにお気に入りの行と日タブの印が出る状態を作る
    const D = await import(new URL("assets/js/data.js", location.href).href);
    const F = await import(new URL("assets/js/filters.js", location.href).href);
    const fes = D.ITEMS.live.find(
      (it) => D.lineupArtistNames(it.lineupId).length > 3 && !F.hasEnded(it),
    );
    const inFes = fes ? D.lineupArtistNames(fes.lineupId).slice(1, 3) : [];
    return [...n.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map((x) => x[0])
      .concat(inFes, ["いま予定が無い人"]);
  });
  await page.evaluate((n) => {
    localStorage.setItem("eventboard.favartists.v1", JSON.stringify(n));
    for (const k of [
      "eventboard.favartfold.v1",
      "eventboard.favartpin.v1",
      "eventboard.favartseen.v1",
    ])
      localStorage.removeItem(k);
  }, names);
  await page.goto(BASE + "?tab=live");
  await page.waitForSelector("#liveList .card", {
    state: "attached",
    timeout: 120000,
  });
  await page.waitForTimeout(2500);
  // 前回の訪問から公演が2件増えた記録を置いて読み直し、「前回から追加」を出す
  await page.evaluate(async () => {
    const D = await import(new URL("assets/js/data.js", location.href).href);
    const A = await import(new URL("assets/js/artists.js", location.href).href);
    const R = await import(new URL("assets/js/render.js", location.href).href);
    // 印が見えるよう、一覧の先頭（上限6件）に出る公演から選ぶ。終わった公演は一覧に出ない
    const hit = R.visibleItems("live")
      .filter((it) => A.isFavArtistItem(it))
      .slice(0, 2)
      .map((it) => it.uid);
    const base = D.ITEMS.live
      .map((it) => it.uid)
      .filter((u) => !hit.includes(u));
    localStorage.setItem(
      "eventboard.favartseen.v1",
      JSON.stringify({
        live: { base, cur: base, at: Date.now() - 5 * 3600 * 1000 },
      }),
    );
  });
  await page.goto(BASE + "?tab=live");
  await page.waitForSelector("#liveList .card", {
    state: "attached",
    timeout: 120000,
  });
  await page.waitForTimeout(2500);
  await page.addStyleTag({
    content: ".grid.is-entering .card{animation:none;opacity:1}",
  });
  await top();
  if (!(await page.$("#liveList > .fav-head.art")))
    cantCheck("ライブ: 人を登録しても先頭セクションが出ない");
  else {
    if (!(await page.$("#liveList .new-tag")))
      cantCheck("ライブ: 「前回から追加」の印が出ない");
    if (!(await page.$("#liveList .why-line")))
      cantCheck("ライブ: 「なぜ先頭か」の行が出ない");
    await audit(
      "お気に入りアーティスト先頭（ライブ）",
      "#liveList > :nth-child(-n+7)",
    );
    // 出演者が4組を超える公演の「くわしく」（全員の一覧）も開いて測る
    await page.evaluate(() => {
      const c = [...document.querySelectorAll("#liveList .card")].find((x) =>
        x.querySelector(".art-detail"),
      );
      if (c) {
        c.setAttribute("data-wc-more", "1");
        c.querySelector(".detail-toggle")?.click();
      }
    });
    if (await page.$("[data-wc-more]"))
      await audit("出演者の一覧（くわしく）", "#liveList [data-wc-more]");
    else cantCheck("ライブ: 出演者が4組を超えても一覧が出ない");
    // たたんだ状態
    await click('#liveList [data-art-act="fold"]', 900);
    await audit(
      "お気に入りアーティスト（たたんだ）",
      "#liveList > .fav-head.art",
    );
    await click('#liveList [data-art-act="fold"]', 900);
    // トースト（まだ登録していない人を押す）
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#liveList .art-btn")].find(
        (x) => x.getAttribute("aria-pressed") === "false",
      );
      b?.click();
    });
    await page
      .waitForSelector("#favToast.show", { timeout: 8000 })
      .catch(() => {});
    if (await page.$("#favToast.show"))
      await audit("お気に入りアーティストのトースト", "#favToast");
    else cantCheck("ライブ: 人のボタンを押してもトーストが出ない");
    await page.evaluate(() =>
      document.querySelector("#favToast button:last-child")?.click(),
    );
    await page.waitForTimeout(500);
    // 出演予定のシート
    await click("#liveList > .fav-head.art ~ .card .art-link", 1000);
    if (await page.$("#artistSheet:not([hidden])")) {
      await audit("出演予定のシート", "#artistSheet");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    } else
      cantCheck("ライブ: 出演者の名前を押しても出演予定のシートが開かない");
    // 出演者シート（人のボタン・お気に入りの行・日タブの印）。フェスは先頭の上限（6件）の
    // 外にあることがあるので、「ほか◯件を表示」で開いてから探す
    if (await page.$('#liveList [data-art-act="more"]')) {
      await click('#liveList [data-art-act="more"]', 900);
      await audit(
        "お気に入りアーティスト（ほかも表示）",
        "#liveList > .fav-more",
      );
    }
    await page.evaluate(() => {
      const c = [...document.querySelectorAll("#liveList .card")].find(
        (x) => x.querySelector(".why-line") && x.querySelector(".lineup-btn"),
      );
      c?.querySelector(".lineup-btn")?.click();
    });
    await page.waitForTimeout(900);
    if (await page.$("#lineupSheet:not([hidden]) .lu-artist.is-art")) {
      await audit("出演者シート（お気に入りの人）", "#lineupSheet");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    } else cantCheck("ライブ: 出演者シートにお気に入りの行が出ない");
    // 管理シート（候補・状態の行）
    await top();
    await click('#liveList [data-art-act="manage"]', 800);
    await page.fill("#favArtistInput", "あ");
    await page.waitForTimeout(500);
    await audit("お気に入りアーティスト管理シート", "#favArtistSheet");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    // 絞り込み（お気に入りアーティストのチップ）を押した状態
    await top();
    await click("#catBtn", 900);
    await click('#catBody .chip[data-key="favArtistOnly"]', 600);
    await audit("絞り込み（お気に入りアーティスト）", "#popoverPanel");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await click("#appliedClear", 800);
  }
  // 後続の点検はイベントタブを前提にしている。最後に見たタブは次の起動で開く（rememberTab）ので、
  // 保存を消す前にイベントタブへ戻しておく
  await click("#tabEventBtn", 1200);
  await page.evaluate(() => {
    for (const k of [
      "eventboard.favartists.v1",
      "eventboard.favartseen.v1",
      "eventboard.favartfold.v1",
      "eventboard.favartpin.v1",
    ])
      localStorage.removeItem(k);
  });
  await page.goto(BASE);
  await page.waitForSelector("#list .card", {
    state: "attached",
    timeout: 120000,
  });
  await page.waitForTimeout(1500);
  await page.addStyleTag({
    content: ".grid.is-entering .card{animation:none;opacity:1}",
  });
}
// 6b. 共有のトースト・スクロールした操作バー・終了したものの表示
await top();
await page.evaluate(() => {
  try {
    delete navigator.share;
  } catch {}
  document.querySelector('#list .act-btn[data-act="share"]')?.click();
});
await page.waitForTimeout(400);
if (await page.$("#toast.show")) await audit("共有のトースト", "#toast");
await page.evaluate(() => scrollTo(0, 2400));
await page.waitForTimeout(900);
await audit("操作バー（スクロール後）", ".controls");
// スマホ幅で縮んだバーから検索欄だけを開いた状態（PC幅では検索の入口が出ないので測らない）
if (await page.isVisible(".search-toggle")) {
  await click(".search-toggle", 700);
  await audit("操作バー（縮んだまま検索を開いた）", ".controls");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}
await top();
await click("#catBtn", 900);
await page.evaluate(() =>
  document.querySelector("#catBody .ended-chip")?.click(),
);
await page.waitForTimeout(500);
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
await page.evaluate(() => {
  document
    .querySelectorAll("[data-wc-end]")
    .forEach((e) => e.removeAttribute("data-wc-end"));
  [...document.querySelectorAll("#list > .card")]
    .filter(
      (c) =>
        c.querySelector(".closed-badge") ||
        /終了/.test(c.querySelector(".status-badge")?.textContent || ""),
    )
    .slice(0, 12)
    .forEach((c) => c.setAttribute("data-wc-end", "1"));
});
await audit("終了・状態バッジのあるカード", "#list [data-wc-end]");
await click("#appliedClear", 800);
// 7. 下部・空表示
await page.evaluate(() =>
  document.querySelector("section.directory").scrollIntoView(),
);
await page.waitForTimeout(500);
await audit(
  "調べたサイト一覧・注記",
  "#eventPane section.directory, #eventPane footer",
);
await top();
await page.fill('input[type="search"]', "zzzzzz");
await page.waitForTimeout(1200);
await audit("0件の表示", "#list");
await page.fill('input[type="search"]', "");
await page.waitForTimeout(800);

// 7b. 全カードの文字（部品の4状態は先頭9枚だけ測るので、文字の対比だけは全カード・3タブで測る）
for (const [tabBtn, listSel, label] of [
  ["#tabEventBtn", "#list", "全カードの文字（イベント）"],
  ["#tabMovieBtn", "#movieList", "全カードの文字（映画）"],
  ["#tabLiveBtn", "#liveList", "全カードの文字（ライブ）"],
]) {
  await click(tabBtn, 1800);
  const textAll = await page.evaluate((sel) => {
    const out = [];
    for (const c of document.querySelectorAll(`${sel} > .card`)) {
      c.querySelectorAll(".desc").forEach((d) => d.classList.add("open"));
      out.push(...window.__wc.textIssues(c));
    }
    return out;
  }, listSel);
  report.contexts.push({ label, rootSel: listSel, textAll, items: [] });
  console.log(`${label}: 指摘 ${textAll.length}`);
}
// 映画・ライブの「調べたサイト一覧・注記」（イベントの分は 7. で部品ごとに測っている）
for (const [tabBtn, pane, noun] of [
  ["#tabMovieBtn", "#moviePane", "映画"],
  ["#tabLiveBtn", "#livePane", "ライブ"],
]) {
  await click(tabBtn, 1200);
  await page.evaluate(
    (p) => document.querySelector(`${p} section.directory`)?.scrollIntoView(),
    pane,
  );
  await audit(
    `調べたサイト一覧・注記（${noun}）`,
    `${pane} section.directory, ${pane} footer`,
  );
}
await click("#tabEventBtn", 1500);

// 8. 2.4.11：Tab／Shift+Tab で通したとき、フォーカスが操作バーの下に隠れないか
{
  await top();
  await page.evaluate(() => document.activeElement?.blur());
  const probe = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body || a.closest(".controls")) return null;
      const r = a.getBoundingClientRect();
      const bar = document.querySelector(".controls").getBoundingClientRect();
      const covered = Math.max(
        0,
        Math.min(r.bottom, bar.bottom) - Math.max(r.top, bar.top),
      );
      if (covered <= 0) return null;
      return {
        el:
          a.tagName +
          "." +
          [...a.classList].join(".") +
          "「" +
          (a.getAttribute("aria-label") || a.textContent).trim().slice(0, 14) +
          "」",
        hidden: covered >= r.height - 1 ? "すべて" : "一部",
      };
    });
  // 操作バーは縮む・伸びるときに高さが遷移で変わる。途中の高さで測ると、遷移が終われば
  // 隠れない部品まで「隠れた」と誤検出するので、高さが落ち着いてから測る
  const settle = async () => {
    let last = -1;
    let same = 0;
    for (let i = 0; i < 60 && same < 3; i++) {
      const h = await page.evaluate(
        () => document.querySelector(".controls").offsetHeight,
      );
      same = h === last ? same + 1 : 0;
      last = h;
      await page.waitForTimeout(100);
    }
  };
  const hid = [];
  for (const key of ["Tab", "Shift+Tab"])
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press(key);
      await settle();
      const p = await probe();
      if (p) hid.push(p);
    }
  for (const h of hid.slice(0, 6))
    report.extra.push({
      kind: `2.4.11 フォーカスが操作バーに${h.hidden}隠れる`,
      el: h.el,
    });
  console.log(`2.4.11: 隠れた回数 ${hid.length}`);
}

// 9. 場所を★にした人にだけ出る部品（先頭セクションの見出し・「ほか◯件を表示」・チェーンの新作の
//    まとめ行・「そのほか」の区切り・条件で隠れたときの注記）。ここまでの画面には出てこないので、
//    ★を付けた状態で開き直して3タブとも測る。点検の漏れで、夜のまとめ行のボタンが読めないまま残っていた
const cantCheck = (what) => report.extra.push({ kind: "点検できず", el: what });
{
  const names = await page.evaluate(async () => {
    const { THEATERS } = await import(
      new URL("assets/js/data.js", location.href).href
    );
    // 劇場はチェーンを2つ（まとめ行が2本並ぶ）
    const chains = new Map();
    for (const t of THEATERS)
      if (t.chain && !chains.has(t.chain)) chains.set(t.chain, t.name);
    // イベント・ライブは、カードの★の多い場所から。イベントは先頭の上限（6件）を超えるまで足す
    const ranked = (sel) => {
      const n = new Map();
      document
        .querySelectorAll(`${sel} .star-btn[data-star]`)
        .forEach((b) =>
          n.set(b.dataset.star, (n.get(b.dataset.star) || 0) + 1),
        );
      return [...n.entries()].sort((a, b) => b[1] - a[1]);
    };
    const ev = [];
    let sum = 0;
    for (const [name, c] of ranked("#list")) {
      if (sum > 8) break;
      ev.push(name);
      sum += c;
    }
    return [
      ...[...chains.values()].slice(0, 2),
      ...ev,
      ...ranked("#liveList")
        .slice(0, 1)
        .map((x) => x[0]),
    ];
  });
  await page.evaluate((n) => {
    localStorage.setItem("eventboard.favspots.v1", JSON.stringify(n));
    localStorage.removeItem("eventboard.favfold.v1");
    localStorage.removeItem("eventboard.favpin.v1");
  }, names);
  await page.goto(BASE);
  await page.waitForSelector("#list .card", {
    state: "attached",
    timeout: 120000,
  });
  await page.waitForTimeout(2500);
  await page.addStyleTag({
    content: ".grid.is-entering .card{animation:none;opacity:1}",
  });
  for (const [btn, list, noun] of [
    ["#tabMovieBtn", "#movieList", "映画"],
    ["#tabLiveBtn", "#liveList", "ライブ"],
    ["#tabEventBtn", "#list", "イベント"],
  ]) {
    await click(btn, 1800);
    await top();
    if (!(await page.$(`${list} > .fav-head`))) {
      cantCheck(`${noun}: ★を付けても先頭セクションが出ない`);
      continue;
    }
    if (noun === "映画" && !(await page.$(`${list} > .chain-row`)))
      cantCheck("映画: チェーンの劇場を★にしてもまとめ行が出ない");
    await audit(
      `お気に入り先頭（${noun}）`,
      `${list} > :not(.card), ${list} > .card:nth-child(-n+4)`,
    );
  }
  if (await page.$("#list > .fav-more")) {
    await click('#list [data-fav-act="more"]', 900);
    await audit("お気に入り先頭（ほかも表示）", "#list > .fav-more");
    await click('#list [data-fav-act="more"]', 900);
  } else cantCheck("イベント: 先頭の上限を超えても「ほか◯件を表示」が出ない");
  await click('#list [data-fav-act="fold"]', 900);
  await audit("お気に入り先頭（たたんだ）", "#list > .fav-head");
  await click('#list [data-fav-act="fold"]', 900);
  // 条件で★の場所の催しが全部隠れたときの注記。★の無いカードの題名で検索して作る
  const q = await page.evaluate(
    () =>
      document
        .querySelector("#list > .list-divider ~ .card .title")
        ?.textContent.trim()
        .slice(0, 10) || "",
  );
  await page.fill('input[type="search"]', q);
  await page.waitForTimeout(1200);
  if (await page.$("#list > .fav-note"))
    await audit("お気に入り先頭（条件で隠れた注記）", "#list > .fav-note");
  else cantCheck(`イベント: 「${q}」で検索しても注記が出ない`);
  await page.fill('input[type="search"]', "");
  await page.waitForTimeout(800);
}

// 10. 現在地の案内（さがしている・失敗・取得できた）。位置情報は端末と許可に左右されるので、
//     getCurrentPosition を差し替えて3つの状態を順に作る
{
  await top();
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = (ok, err) => {
      window.__geo = { ok, err };
    };
  });
  await click("#sortLocBtn", 900);
  await click("#useMyLocationBtn", 600);
  if (await page.$("#locateMsg.show")) {
    await audit("エリア（現在地をさがしている）", "#popoverPanel");
    await page.evaluate(() =>
      window.__geo.err({ code: 1, PERMISSION_DENIED: 1, TIMEOUT: 3 }),
    );
    await page.waitForTimeout(400);
    await audit("エリア（現在地を取得できない）", "#popoverPanel");
    await page.evaluate(() => {
      navigator.geolocation.getCurrentPosition = (ok) =>
        ok({ coords: { latitude: 35.681, longitude: 139.767 } });
    });
    await click("#useMyLocationBtn", 1200);
    if (await page.$("#popoverPanel[hidden]")) await click("#sortLocBtn", 900);
    if (await page.$("#locateMsg.ok.show")) {
      await audit("エリア（現在地を取得した）", "#popoverPanel");
      await click("#clearLoc", 800);
    } else cantCheck("現在地: 取得できた案内が出ない");
  } else cantCheck("現在地: 「現在地から探す」を押しても案内が出ない");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

// 11. データの読み込み中・読み込めなかったときの表示（ライブのCSVを止めてから失敗させる）
{
  const held = [];
  await page.route("**/data/lives.csv*", (r) => held.push(r));
  await page.goto(BASE);
  await page.waitForSelector("#list .card", {
    state: "attached",
    timeout: 120000,
  });
  await page.waitForTimeout(1500);
  await click("#tabLiveBtn", 1200);
  if (await page.$("#liveList .empty-state"))
    await audit("ライブ（読み込み中）", "#liveList");
  else cantCheck("ライブ: CSVを止めても読み込み中の表示が出ない");
  for (const r of held.splice(0)) await r.abort();
  await page.unroute("**/data/lives.csv*");
  await page.waitForTimeout(1500);
  if (await page.$("#liveList .empty-state"))
    await audit("ライブ（読み込めなかった）", "#liveList");
  else cantCheck("ライブ: CSVの取得に失敗しても失敗の表示が出ない");
}

report.errors = errs;
fs.writeFileSync(`${OUT}/${NAME}.json`, JSON.stringify(report, null, 1));

// ---- 集計：同じ種類・同じ部品・同じ色の指摘はまとめる ----
const rows = [];
for (const c of report.contexts) {
  for (const t of c.textAll)
    if (!t.dis)
      rows.push({
        ctx: c.label,
        state: "通常",
        kind: "1.4.3 文字",
        el: t.el,
        ratio: t.ratio,
        need: t.need,
        fg: t.fg,
        bg: t.bg,
      });
  for (const it of c.items) {
    if (it.disabled) continue;
    for (const [st, res] of Object.entries(it.states)) {
      if (!res) continue;
      if (st !== "default")
        for (const t of res.text)
          if (!t.dis)
            rows.push({
              ctx: c.label,
              state: st,
              kind: "1.4.3 文字",
              el: t.el,
              ratio: t.ratio,
              need: t.need,
              fg: t.fg,
              bg: t.bg,
            });
      for (const t of res.icon)
        rows.push({
          ctx: c.label,
          state: st,
          kind: "1.4.11 アイコン",
          el: t.el,
          ratio: t.ratio,
          need: 3,
          fg: t.fg,
          bg: t.bg,
        });
      if (res.focus && !res.focus.ok)
        rows.push({
          ctx: c.label,
          state: st,
          kind: "2.4.7 フォーカス",
          el: res.focus.el,
          ratio: res.focus.vsParent,
          need: 3,
          fg: res.focus.color,
          bg: `${res.focus.kind} 幅${res.focus.width}`,
        });
      const b = res.boundary;
      if (
        b &&
        st === "default" &&
        Math.max(b.fillC, b.borderC) < 3 &&
        /^(input|textarea)/.test(it.desc)
      )
        rows.push({
          ctx: c.label,
          state: st,
          kind: "1.4.11 入力欄の輪郭",
          el: it.desc,
          ratio: Math.max(b.fillC, b.borderC),
          need: 3,
          fg: b.fill,
          bg: b.parent,
        });
    }
    if (!it.inline && (it.w < 24 || it.h < 24) && !EXEMPT_SIZE.test(it.desc))
      rows.push({
        ctx: c.label,
        state: "-",
        kind: "2.5.8 押しどころ",
        el: it.desc,
        ratio: `${it.w}x${it.h}`,
        need: "24x24",
        fg: "",
        bg: "",
      });
  }
}
for (const x of report.extra)
  rows.push({
    ctx: "-",
    state: "-",
    kind: x.kind,
    el: x.el,
    ratio: x.ratio ?? "",
    need: x.need ?? "",
    fg: x.fg ?? "",
    bg: x.bg ?? x.note ?? "",
  });
const groups = new Map();
for (const r of rows) {
  const key = [r.kind, r.el.split("「")[0], r.state, r.fg, r.bg].join("|");
  if (!groups.has(key)) groups.set(key, { ...r, ctxs: new Set() });
  groups.get(key).ctxs.add(r.ctx);
}
console.log(`\nclasses: ${report.cls}  ページエラー: ${errs.length}`);
for (const g of groups.values())
  console.log(
    `${g.kind} | ${g.state} | ${g.el} | ${g.ratio} (要${g.need}) | ${g.fg} on ${g.bg} | ${[...g.ctxs].join(", ").slice(0, 80)}`,
  );
console.log(
  `\n指摘 ${groups.size}件（${NAME}）${errs.length ? " ページエラー: " + errs.join("|") : ""}`,
);
await browser.close();
process.exit(groups.size || errs.length ? 1 : 0);
