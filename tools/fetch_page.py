#!/usr/bin/env python3
"""robots.txt の判定と待機を通したうえでページ本体を取得し、機械可読な部分だけを抜く。

## なぜ要るのか

これまで、ページ本体を取る正規の手段は `WebFetch` しか無かった。`WebFetch` は
HTMLをmarkdown化してから渡すので、**一覧の構造が失われる**——日付と催し名の
対応がずれる、料金表が崩れる、といったことが実際に起きている
（`kanto-live-collector` のステップ1に警告として書いてある）。

そこでラインナップ収集だけは `curl` で生HTMLを取る手順になっていたが、これは
同じ文書が69行目で禁じている行為でもあった。**`curl` はフックを通らないので、
robots.txt の判定も `Crawl-delay` の消化も行われない。** 矛盾の原因は、
「ゲートを通して生HTMLを取る」手段が存在しなかったことにある。これがそれである。

## 何が得か —— 検索を1回も使わない

このスクリプトは `WebSearch` を消費しない。しかも構造化データが載っている
ページなら、**1回の取得から何十件もの行を機械的に取り出せる**。予算という
制約に対して、「節約する」以外の答えを出せる唯一の経路である。

  --raw       生HTML（既定で先頭 20,000 文字まで。--limit で変えられる）
  --sitemap   sitemap.xml からURLと lastmod を出す（新着ページの検出に使える）
  --jsonld    schema.org の JSON-LD を抜く
  --events    その中の Event 系を、CSVの列に近い形に正規化して出す
  --ics       ICS フィードから VEVENT を出す

`--events` が拾う `eventStatus` は、このプロジェクトが最も落としたくない
**中止・延期**（`EventCancelled` / `EventPostponed`）をそのまま持っている。
まとめサイトの文章から読み取るより確実で、しかも安い。

> **構造化データは、期待するほど普及していない。** 2026-08 に名簿の施設・劇場・
> 横断サイトを実測したところ、トップページに `Event` 型の JSON-LD を出していた
> 先はほとんど無く、あっても `WebSite` / `BreadcrumbList` / `Organization` 止まり
> だった（催しの詳細ページには載っていることがある）。**期待して総当たりしない
> こと。** 引数なしで実行すると「そのページから何が取れるか」だけを数行で返すので、
> まずそれを見て、載っていなければ `--raw` に切り替えればよい。
>
> 逆に言えば、このツールの主な取り分は JSON-LD ではなく次の2つである。
> **`--raw`**（`WebFetch` の markdown 化で崩れる一覧の構造が、そのまま読める）と
> **`--sitemap`**（`lastmod` で新着ページだけを絞れる）。どちらも検索を消費しない。

## UA と robots の関係（重要）

`fetch_gate.py` の判定は `Claude-User` と `Claude-SearchBot` の厳しいほうを採る。
だがこのスクリプトが名乗るのはそのどちらでもない。robots.txt に
`Claude-User: Allow: /` と `*: Disallow: /` が併記されていれば、
**`*` の側がこちらに適用される**——2つのUAだけを見る判定では取りこぼす。

そこでこのスクリプトは、ゲートの判定に加えて **`*` の群も個別に確認し、
3つすべてが許可しているときだけ取得する**。`WebFetch` 経由より厳しい側に倒れる。

使い方:
    python3 tools/fetch_page.py <URL>                 # 何が取れるページかを先に見る
    python3 tools/fetch_page.py <URL> --events
    python3 tools/fetch_page.py <URL> --jsonld --type Event
    python3 tools/fetch_page.py <URL> --sitemap --since 2026-08-01
    python3 tools/fetch_page.py <URL> --ics
    python3 tools/fetch_page.py <URL> --raw --limit 40000 --out temp/page.html
"""

import argparse
import gzip
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import budget                                                # noqa: E402
import fetch_gate                                            # noqa: E402
import robots_rules as rr                                    # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 名乗りは正直に書く。中身を偽ると、相手が robots.txt でこちらを名指しで
# 拒否する手段が無くなる——拒否できる相手であることが、取りに行ってよい条件である。
UA = "player-one-collector/1.0 (+https://github.com/the-ready/player-one; weekly event dashboard)"

TIMEOUT = 25
MAX_BYTES = 4 * 1024 * 1024      # これ以上は読まない。1ページで文脈を潰さないため
DEFAULT_LIMIT = 20000            # --raw の既定の出力文字数
DEFAULT_ROWS = 200                # --sitemap・--ics・--jsonld の既定の出力件数

# schema.org の Event とその下位型。名簿の施設が出しているのはたいていこの辺り。
EVENT_TYPES = {
    "event", "exhibitionevent", "screeningevent", "musicevent", "festival",
    "theaterevent", "socialevent", "childrensevent", "sportsevent",
    "foodevent", "educationevent", "comedyevent", "danceevent", "literaryevent",
    "visualartsevent", "businessevent", "publicationevent", "eventseries",
}


# ============================================================
# 取得
# ============================================================


def wildcard_allows(url):
    """`*` の群がこのURLを許可しているか。判定できないときは None。

    `fetch_gate` は Claude-User / Claude-SearchBot しか見ない。こちらは
    そのどちらでもない名前で名乗るので、`*` の群を別に確認する必要がある
    （冒頭「UA と robots の関係」）。robots.txt はキャッシュ済みなので
    追加のアクセスは発生しない。
    """
    state, text = rr.fetch_robots(url)
    if state != "ok":
        return None                     # none/forbidden/unknown はゲート側が既に判断している
    info = rr.match(rr.parse(text), "*", url)
    return bool(info["allowed"]), info.get("matched_rule")


def fetch(url):
    """ゲートを通してから取得する。戻り値は `(本文, Content-Type)`。"""
    # `fetch_gate.gate()` を直に呼ぶので、`WebFetch` のフック経路とは別に自分で
    # 計上する。取得はどの経路から出ても1回は1回で、予算表がそこを取りこぼすと
    # 「安い経路を通ったぶんだけ数字が小さく出る」という最も紛らわしい壊れ方をする。
    d = fetch_gate.gate(url)
    if not d["ok"]:
        budget.bump("blocked", waited=d.get("waited", 0.0))
        raise SystemExit(
            f"ERROR: robots.txt により取得できません: {url}\n"
            f"  {d['reason']}\n"
            "  このURLは開かず、別の情報源を当たってください。"
        )

    wc = wildcard_allows(url)
    if wc is not None and not wc[0]:
        # ゲートは通ったが `*` が閉じている。こちらは Claude-User ではないので、
        # 適用されるのは `*` の側である。厳しいほうに従う。
        budget.bump("blocked")
        raise SystemExit(
            f"ERROR: robots.txt の `User-agent: *` がこのURLを拒否しています: {url}\n"
            f"  適用された規則: {wc[1]}\n"
            "  このツールは Claude-User ではなく独自の名前で名乗るため、`*` の群が適用されます。\n"
            "  取得できません。WebFetch なら通ることもありますが、迂回に使わないでください。"
        )

    budget.bump("fetch", waited=d.get("waited", 0.0))

    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml,text/calendar;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en;q=0.8",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            raw = res.read(MAX_BYTES)
            if res.headers.get("Content-Encoding", "").lower() == "gzip":
                raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
            charset = res.headers.get_content_charset()
            ctype = (res.headers.get_content_type() or "").lower()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"ERROR: {url} が HTTP {e.code} を返しました")
    except Exception as e:                                   # noqa: BLE001
        raise SystemExit(f"ERROR: {url} を取得できませんでした: {type(e).__name__}: {e}")

    if not charset:
        # HTML内の宣言を見る。日本の施設サイトは Shift_JIS / EUC-JP が今も現役である。
        m = re.search(rb'charset=["\']?([\w\-]+)', raw[:4096], re.I)
        charset = m.group(1).decode("ascii", "ignore") if m else "utf-8"
    try:
        text = raw.decode(charset, errors="replace")
    except LookupError:
        text = raw.decode("utf-8", errors="replace")
    return text, ctype


# ============================================================
# 抽出
# ============================================================

LD_RE = re.compile(
    r'<script[^>]+type\s*=\s*["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.I | re.S)


def jsonld_blocks(html):
    """JSON-LD を全部集めて、@graph を平らにする。壊れた1本で全部を捨てない。"""
    out = []
    for m in LD_RE.finditer(html):
        body = m.group(1).strip()
        # 一部のCMSは JSON-LD を HTML コメントで囲む
        body = re.sub(r"^<!--|-->$", "", body).strip()
        try:
            data = json.loads(body)
        except ValueError:
            continue
        for item in (data if isinstance(data, list) else [data]):
            if not isinstance(item, dict):
                continue
            graph = item.get("@graph")
            out.extend(g for g in graph if isinstance(g, dict)) if isinstance(graph, list) \
                else out.append(item)
    return out


def type_names(obj):
    t = obj.get("@type") or obj.get("type") or ""
    return [str(x).split("/")[-1] for x in (t if isinstance(t, list) else [t]) if x]


def _txt(v, limit=None):
    """JSON-LD の値は文字列・辞書・配列のどれでも来る。素直に1本の文字列にする。"""
    if v is None:
        return ""
    if isinstance(v, list):
        return " / ".join(filter(None, (_txt(x) for x in v)))[: limit or 10**6]
    if isinstance(v, dict):
        for k in ("name", "@value", "text", "url"):
            if v.get(k):
                return _txt(v[k], limit)
        return ""
    s = re.sub(r"\s+", " ", str(v)).strip()
    return s[:limit] if limit else s


def _place(v):
    if isinstance(v, list):
        v = v[0] if v else None
    if not isinstance(v, dict):
        return _txt(v), ""
    name = _txt(v.get("name"))
    addr = v.get("address")
    if isinstance(addr, dict):
        addr = " ".join(filter(None, (
            _txt(addr.get("addressRegion")), _txt(addr.get("addressLocality")),
            _txt(addr.get("streetAddress")))))
    return name, _txt(addr)


def _offer(v):
    """料金は offers（単数・配列・AggregateOffer）のどれでも来る。安いほうを拾う。"""
    offers = v if isinstance(v, list) else [v] if isinstance(v, dict) else []
    prices, cur, url, avail = [], "", "", ""
    for o in offers:
        if not isinstance(o, dict):
            continue
        for key in ("price", "lowPrice"):
            raw = o.get(key)
            if raw not in (None, ""):
                try:
                    prices.append(float(str(raw).replace(",", "")))
                except ValueError:
                    pass
        cur = cur or _txt(o.get("priceCurrency"))
        url = url or _txt(o.get("url"))
        avail = avail or _txt(o.get("availability")).split("/")[-1]
    return (min(prices) if prices else ""), cur, url, avail


def normalize_events(blocks):
    """Event 系を、収集スキルが読める最小限の形にそろえる。"""
    out = []
    for b in blocks:
        if not any(t.lower() in EVENT_TYPES for t in type_names(b)):
            continue
        venue, addr = _place(b.get("location"))
        price, cur, offer_url, avail = _offer(b.get("offers"))
        out.append({
            "type": "|".join(type_names(b)),
            "name": _txt(b.get("name"), 120),
            "start": _txt(b.get("startDate"))[:10],
            "end": _txt(b.get("endDate"))[:10],
            # 中止・延期がここに入る。このプロジェクトが最も落としたくない情報で、
            # 文章から読み取るより確実に取れる。
            "status": _txt(b.get("eventStatus")).split("/")[-1],
            "attendance": _txt(b.get("eventAttendanceMode")).split("/")[-1],
            "venue": venue,
            "address": addr,
            "price": price,
            "currency": cur,
            "availability": avail,
            "url": _txt(b.get("url")) or offer_url,
            "desc": _txt(b.get("description"), 160),
        })
    return out


LOC_RE = re.compile(r"<loc>\s*(.*?)\s*</loc>", re.I | re.S)
MOD_RE = re.compile(r"<lastmod>\s*(.*?)\s*</lastmod>", re.I | re.S)
URL_BLOCK_RE = re.compile(r"<(?:url|sitemap)>(.*?)</(?:url|sitemap)>", re.I | re.S)


def parse_sitemap(xml):
    """sitemap.xml / sitemapindex.xml のどちらでも、(URL, lastmod) の並びを返す。"""
    out = []
    blocks = URL_BLOCK_RE.findall(xml)
    if not blocks:                                   # <url> で括られていない実装もある
        return [(u, "") for u in LOC_RE.findall(xml)]
    for b in blocks:
        loc = LOC_RE.search(b)
        if not loc:
            continue
        mod = MOD_RE.search(b)
        out.append((loc.group(1), (mod.group(1)[:10] if mod else "")))
    return out


def parse_ics(text):
    """VEVENT を抜く。折り返し（行頭スペースでの継続）を先に畳む。"""
    text = re.sub(r"\r?\n[ \t]", "", text)
    out = []
    for block in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", text, re.S | re.I):
        ev = {}
        for line in block.splitlines():
            if ":" not in line:
                continue
            key, _, val = line.partition(":")
            key = key.split(";")[0].strip().upper()
            if key in ("SUMMARY", "LOCATION", "URL", "STATUS", "DESCRIPTION"):
                ev[key.lower()] = val.strip().replace("\\,", ",").replace("\\n", " ")[:160]
            elif key in ("DTSTART", "DTEND"):
                digits = re.sub(r"\D", "", val)[:8]
                if len(digits) == 8:
                    ev[key.lower()] = f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"
        if ev.get("summary"):
            out.append(ev)
    return out


# ============================================================
# 出力
# ============================================================

TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
FEED_RE = re.compile(
    r'<link[^>]+(?:type=["\'](?:application/(?:rss\+xml|atom\+xml)|text/calendar)["\'])[^>]*>',
    re.I)
HREF_RE = re.compile(r'href\s*=\s*["\']([^"\']+)["\']', re.I)


def print_overview(url, html, ctype):
    """まず「このページから何が取れるか」だけを出す。

    いきなり生HTMLを出すと、それだけで文脈が埋まる。何が入っているかを先に
    数行で示し、次に打つ手（--events / --jsonld / --raw）を選べるようにする。
    """
    print(f"# {url}")
    print(f"#   Content-Type: {ctype or '不明'} / 本文 {len(html):,} 文字")
    t = TITLE_RE.search(html)
    if t:
        print(f"#   <title>: {re.sub(r'\s+', ' ', t.group(1)).strip()[:100]}")

    blocks = jsonld_blocks(html)
    if blocks:
        kinds = {}
        for b in blocks:
            for n in type_names(b) or ["(型なし)"]:
                kinds[n] = kinds.get(n, 0) + 1
        print(f"#   JSON-LD: {len(blocks)}件 — "
              + ", ".join(f"{k}×{v}" for k, v in sorted(kinds.items())))
        ev = normalize_events(blocks)
        if ev:
            print(f"#   → Event 系 {len(ev)}件。`--events` で取り出せます")
    else:
        print("#   JSON-LD: なし")

    if "__NEXT_DATA__" in html:
        print("#   __NEXT_DATA__ あり（Next.js。`--raw` で取り出してJSONを読めます）")

    feeds = [urllib.parse.urljoin(url, m.group(1))
             for tag in FEED_RE.findall(html) for m in [HREF_RE.search(tag)] if m]
    if feeds:
        print("#   フィード: " + " ".join(dict.fromkeys(feeds)))
    print(f"#   sitemap の候補: {urllib.parse.urljoin(url, '/sitemap.xml')}")
    print(f"# {budget.summary_line(budget.load())}")


def main():
    p = argparse.ArgumentParser(
        description="robots.txt を通してページ本体を取得し、機械可読な部分を抜く",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("url", help="取得するURL")
    p.add_argument("--jsonld", action="store_true", help="JSON-LD をそのまま出す")
    p.add_argument("--events", action="store_true", help="JSON-LD の Event 系を正規化して出す")
    p.add_argument("--sitemap", action="store_true", help="sitemap XML として読む")
    p.add_argument("--ics", action="store_true", help="ICS として読む")
    p.add_argument("--raw", action="store_true", help="生の本文を出す")
    p.add_argument("--type", help="--jsonld を @type で絞る（部分一致・大小無視）")
    p.add_argument("--since", help="--sitemap を lastmod で絞る YYYY-MM-DD")
    p.add_argument("--limit", type=int, default=None,
                   help=f"--raw の出力文字数（既定 {DEFAULT_LIMIT}）／"
                        f"--sitemap・--ics・--jsonld の件数（既定 {DEFAULT_ROWS}）")
    p.add_argument("--out", help="本文をこのファイルにも保存する（temp/ 配下を推奨）")
    args = p.parse_args()

    # `--limit` は用途によって単位が違う（--raw は文字数、他は件数）。
    # 以前は1つの既定値（20000）を両方に流用しており、件数として使う側では
    # 実質無効化されていた（`args.limit or 200` は 20000 が truthy なので
    # 常に 20000 のほうが勝ち、200 という既定が出番を持たなかった）。
    char_limit = args.limit if args.limit is not None else DEFAULT_LIMIT
    row_limit = args.limit if args.limit is not None else DEFAULT_ROWS

    text, ctype = fetch(args.url)

    if args.out:
        path = args.out if os.path.isabs(args.out) else os.path.join(ROOT, args.out)
        # realpath で `..` とシンボリックリンクを解決してから、リポジトリの外に
        # 出ていないか確認する。素通しすると `--out ../../etc/something` のような
        # 指定でリポジトリ外に書けてしまい、CLAUDE.md が定める「一時ファイルは
        # temp/ 配下に置く」という置き場所の規律をこのツールだけが破ることになる。
        real = os.path.realpath(path)
        if real != ROOT and not real.startswith(ROOT + os.sep):
            raise SystemExit(
                f"ERROR: --out はリポジトリ内のパスにしてください: {args.out!r}\n"
                f"  解決先: {real}\n"
                "  一時ファイルは temp/ 配下に置くこと（CLAUDE.md）。"
            )
        os.makedirs(os.path.dirname(real) or ".", exist_ok=True)
        with open(real, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"# 本文を {os.path.relpath(real, ROOT)} に保存しました（{len(text):,} 文字）")

    if args.sitemap:
        rows = parse_sitemap(text)
        if args.since:
            rows = [(u, m) for u, m in rows if m and m >= args.since]
        for u, m in rows[:row_limit]:
            print(f"{m or '-'}\t{u}")
        note = f"（lastmod {args.since} 以降）" if args.since else ""
        if len(rows) > row_limit:
            note += f" ※{len(rows)}件中{row_limit}件のみ（--limit で増やせます）"
        print(f"# {len(rows)}件{note}", file=sys.stderr)
        return 0

    if args.ics:
        evs = parse_ics(text)
        for ev in evs[:row_limit]:
            print(json.dumps(ev, ensure_ascii=False))
        if len(evs) > row_limit:
            print(f"# {len(evs)}件中{row_limit}件のみ出力しました（--limit で増やせます）",
                  file=sys.stderr)
        return 0

    if args.events:
        rows = normalize_events(jsonld_blocks(text))
        for r in rows:
            print(json.dumps(r, ensure_ascii=False))
        print(f"# Event 系 {len(rows)}件。"
              "日付・料金は必ず本文でも裏を取ること（構造化データが古いサイトがある）",
              file=sys.stderr)
        return 0

    if args.jsonld:
        blocks = jsonld_blocks(text)
        if args.type:
            want = args.type.lower()
            blocks = [b for b in blocks if any(want in t.lower() for t in type_names(b))]
        # 要素の**個数**で切る。以前は整形済み文字列を文字数で切っていたため、
        # 途中で閉じ括弧が来ずに壊れたJSONを黙って出すことがあった
        # （機械可読を謳う出力が、機械可読でなくなる）。個数で切れば、
        # 出力される分は常に構文として有効なJSONになる。
        shown = blocks[:row_limit]
        print(json.dumps(shown, ensure_ascii=False, indent=2))
        if len(blocks) > row_limit:
            print(f"# {len(blocks)}件中{row_limit}件のみ出力しました（--limit で増やせます）",
                  file=sys.stderr)
        else:
            print(f"# {len(blocks)}件", file=sys.stderr)
        return 0

    if args.raw:
        print(text[:char_limit])
        if len(text) > char_limit:
            print(f"\n# …{len(text) - char_limit:,}文字を省略しました"
                  "（--limit で増やせます。--out でファイルに落とすほうが安全です）",
                  file=sys.stderr)
        return 0

    print_overview(args.url, text, ctype)
    return 0


if __name__ == "__main__":
    sys.exit(main())
