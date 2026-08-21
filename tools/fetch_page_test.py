#!/usr/bin/env python3
"""`tools/fetch_page.py` の抽出規則を検証する（ネットワーク不要）。

    python3 tools/fetch_page_test.py

このスクリプトが抜いた値は、そのまま `append_rows.py` に渡す候補になる。
**間違った日付や料金を「構造化データから取った」という顔で通すと、
このプロジェクトが一貫して禁じてきた「確認していない値を書く」に直結する。**
JSON-LD の値は文字列・辞書・配列のどれでも来るので、素直に見えるところほど
実装が揺れる。期待する形をここで固定しておく。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_page as fp                                       # noqa: E402

fails = 0


def check(desc, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"  {'OK  ' if ok else 'NG  '} {desc}")
    if not ok:
        print(f"        期待: {want!r}\n        実際: {got!r}")


# ---------------------------------------------------------------- JSON-LD

HTML = """<html><head><title>  企画展のご案内  </title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"ExhibitionEvent",
 "name":"やきもの名品紀行","startDate":"2026-08-15T10:00:00+09:00","endDate":"2026-10-12",
 "eventStatus":"https://schema.org/EventScheduled",
 "location":{"@type":"Place","name":"根津美術館",
   "address":{"@type":"PostalAddress","addressRegion":"東京都","addressLocality":"港区",
              "streetAddress":"南青山6-5-1"}},
 "offers":[{"@type":"Offer","price":"1500","priceCurrency":"JPY",
            "url":"https://example.jp/ticket","availability":"https://schema.org/InStock"},
           {"@type":"Offer","price":"1300","priceCurrency":"JPY"}],
 "url":"https://example.jp/exhibition"}
</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebSite","name":"サイト"},
  {"@type":["Event","MusicEvent"],"name":"中止になった公演",
   "startDate":"2026-09-01","eventStatus":"https://schema.org/EventCancelled",
   "location":"日比谷野外音楽堂"}]}
</script>
<script type="application/ld+json">{ これは壊れたJSON }</script>
<link rel="alternate" type="application/rss+xml" href="/news/feed">
</head><body>__NEXT_DATA__</body></html>"""

print("JSON-LD の取り出し")
blocks = fp.jsonld_blocks(HTML)
check("壊れた1本があっても他は読める", len(blocks), 3)
check("@graph が平らになる", sorted(t for b in blocks for t in fp.type_names(b)),
      ["Event", "ExhibitionEvent", "MusicEvent", "WebSite"])

print("Event の正規化")
ev = fp.normalize_events(blocks)
check("Event 系だけが残る（WebSite は落ちる）", len(ev), 2)
e = ev[0]
check("名前", e["name"], "やきもの名品紀行")
check("開始日は日付だけに切り詰める", e["start"], "2026-08-15")
check("終了日", e["end"], "2026-10-12")
check("会場名は location.name から", e["venue"], "根津美術館")
check("住所は address を組み立てる", e["address"], "東京都 港区 南青山6-5-1")
check("料金は複数 offers の安いほう", e["price"], 1300.0)
check("通貨", e["currency"], "JPY")
check("在庫", e["availability"], "InStock")
check("URL", e["url"], "https://example.jp/exhibition")
check("中止が eventStatus から取れる", ev[1]["status"], "EventCancelled")
check("location が文字列でも会場名として読める", ev[1]["venue"], "日比谷野外音楽堂")

print("値の型ゆれ")
check("配列の name", fp._txt(["A", "B"]), "A / B")
check("辞書の name", fp._txt({"name": "C"}), "C")
check("空白は畳む", fp._txt("  a\n  b "), "a b")
check("None は空文字", fp._txt(None), "")
check("offers が単数の辞書でも読める",
      fp._offer({"price": "2,300", "priceCurrency": "JPY"})[0], 2300.0)
check("offers が AggregateOffer（lowPrice）でも読める",
      fp._offer({"lowPrice": "800"})[0], 800.0)
check("offers が空なら価格は空文字", fp._offer(None)[0], "")

# ---------------------------------------------------------------- sitemap

SITEMAP = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
 <url><loc>https://example.jp/a</loc><lastmod>2026-08-18</lastmod></url>
 <url><loc>https://example.jp/b</loc><lastmod>2026-07-01T09:00:00+09:00</lastmod></url>
 <url><loc>https://example.jp/c</loc></url>
</urlset>"""

print("sitemap")
rows = fp.parse_sitemap(SITEMAP)
check("URLと lastmod の組", rows,
      [("https://example.jp/a", "2026-08-18"),
       ("https://example.jp/b", "2026-07-01"),
       ("https://example.jp/c", "")])
check("lastmod で絞れる（新着の検出に使う）",
      [u for u, m in rows if m and m >= "2026-08-01"], ["https://example.jp/a"])

INDEX = """<sitemapindex><sitemap><loc>https://example.jp/sitemap-1.xml</loc>
<lastmod>2026-08-01</lastmod></sitemap></sitemapindex>"""
check("sitemapindex も同じ形で読める", fp.parse_sitemap(INDEX),
      [("https://example.jp/sitemap-1.xml", "2026-08-01")])

# ---------------------------------------------------------------- ICS

ICS = """BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
SUMMARY:夏の特別展\r
 「土偶と縄文」\r
DTSTART;VALUE=DATE:20260801\r
DTEND;VALUE=DATE:20260930\r
LOCATION:歴史民俗博物館\r
STATUS:CONFIRMED\r
URL:https://example.jp/e1\r
END:VEVENT\r
BEGIN:VEVENT\r
SUMMARY:中止イベント\r
DTSTART:20260815T190000Z\r
STATUS:CANCELLED\r
END:VEVENT\r
END:VCALENDAR"""

print("ICS")
evs = fp.parse_ics(ICS)
check("VEVENT の件数", len(evs), 2)
check("折り返した SUMMARY が繋がる", evs[0]["summary"], "夏の特別展「土偶と縄文」")
check("DTSTART が ISO の日付になる", evs[0]["dtstart"], "2026-08-01")
check("DTEND", evs[0]["dtend"], "2026-09-30")
check("会場", evs[0]["location"], "歴史民俗博物館")
check("日時つき DTSTART でも日付を取れる", evs[1]["dtstart"], "2026-08-15")
check("中止が STATUS から取れる", evs[1]["status"], "CANCELLED")

# ---------------------------------------------------------------- 本文抽出

# `--text` が守るべきものは2つある。**雑音を落とすこと**と、
# **一覧の行と列の対応を壊さないこと**。後者は `--raw` が存在した理由そのもので、
# ここが崩れると「安くなったが読めない」道具になる。
TEXT_HTML = """<html><head><title>t</title>
<script>var ua = navigator.userAgent;</script>
<style>.a{color:red}</style></head>
<body>
<div>お知らせ</div>
<table>
<tr><th>日付</th><th>演目</th></tr>
<tr><td>8/01</td>
<td><p>国境の南</p><br>116分</td></tr>
</table>
<p>料金 &yen;1,300</p>
<a href="/detail?id=1">詳細</a><a href="#top">上へ</a><a href="/detail?id=1">重複</a>
<a href="https://other.example/x">外部</a>
</body></html>"""

print("本文抽出（--text）")
TXT = fp.extract_text(TEXT_HTML)
LINES = TXT.split("\n")
check("script の中身は残らない", "navigator" in TXT, False)
check("style の中身は残らない", "color:red" in TXT, False)
check("表の見出しが列のまま残る", "日付\t演目" in LINES, True)
check("セルに <p>/<br> があっても行が割れない", "8/01\t国境の南 116分" in LINES, True)
check("実体参照が戻る", "料金 ¥1,300" in LINES, True)
check("空行は残らない（トークンを食うだけで何も伝えない）", "" in LINES, False)

# `</td>` が行頭に置かれた書き方のページで、表が392セルまるごと消えたことがある。
# **原文の改行は行の区切りではない**（HTMLでは空白1つに畳まれる）という規則を固定する。
check("原文の改行は行を割らない",
      fp.extract_text("<table><tr>\n<td>A</td>\n<td>B</td>\n</tr></table>"), "A\tB")

print("リンク抽出（--links）")
LINKS = fp.extract_links(TEXT_HTML, "https://ex.jp/a/b.html")
check("相対URLが絶対になる", LINKS[0], ("詳細", "https://ex.jp/detail?id=1"))
check("# つきと重複は落ちる", len(LINKS), 2)
check("外部リンクは残る", LINKS[1][1], "https://other.example/x")

TOTAL = 40
print(f"\n{TOTAL - fails}/{TOTAL} 件が期待どおり")
sys.exit(1 if fails else 0)
