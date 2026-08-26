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


# ------------------------------------------------------------ 日程行の絞り込み
#
# `--schedule` は本文を**捨てる**処理なので、外れ方が2つある。
#   - 落としすぎ: 公演が一覧から消え、そのぶん静かな欠落になる
#   - 残しすぎ  : 絞る意味が無くなる（トークンが減らない）
#
# とくに落としすぎは実際に起きた。最初の実装は「日付行の次の1行だけ残す」
# だったが、東京国際フォーラムのイベントカレンダーは1つの日付の下に
# 「区分ラベル／公演名」が交互に最大8行ぶら下がる形で、**残るのが区分ラベルの
# 「一般」だけ、公演名は全部落ちる**という結果になった。下の CAL は実物と
# 同じ形にしてある。

CAL = "\n".join([
    "トップ",                          # 最初の日付より前＝落ちる
    "9月",                             # 月だけの見出しは日付にしない（月選択のナビ）
    "10月",
    "2026年08月01日（土）",
    "一般",
    "ものづくり・匠の技の祭典2026",
    "一般",
    "ブロードウェイミュージカル『ピーター・パン』",
    "2026年08月02日（日）",
    "一般",
    "SBI証券 夏休み自由研究フェス2026",
])

FORMATS = "\n".join([
    "09.02 水",
    "東京ヴェルディ×ヴィッセル神戸",
    "10/3",
    "サカナクション SAKANAQUARIUM",
    "2026-11-08\tUru Tour 2026\t全席指定",
    "20日（土）",
    "菊池桃子 ライブ",
])


def run_schedule_checks():
    keep, dropped = fp.schedule_lines(CAL, limit=12)

    # いちばん守りたいところ：日付の下にぶら下がる公演名が全部残る
    check("日付の下の公演名が最後まで残る（区切りは行数ではなく次の日付）",
          [l for l in keep if "ピーター・パン" in l or "匠の技" in l],
          ["ものづくり・匠の技の祭典2026", "ブロードウェイミュージカル『ピーター・パン』"])
    check("次の日付行そのものも残る", "2026年08月02日（日）" in keep, True)
    check("最初の日付より前の行は落ちる", "トップ" in keep, False)
    check("月だけの見出し（9月）は日付として扱わない", "9月" in keep, False)
    check("落とした行数を返す",
          dropped, len([l for l in CAL.split("\n") if l.strip()]) - len(keep))

    # 日付の書き方のばらつき
    fmt, _ = fp.schedule_lines(FORMATS, limit=12)
    check("ドット表記（09.02 水）を拾う", "09.02 水" in fmt, True)
    check("スラッシュ表記（10/3）を拾う", "10/3" in fmt, True)
    check("タブ区切り行の中の 2026-11-08 を拾う",
          "2026-11-08\tUru Tour 2026\t全席指定" in fmt, True)
    check("月を持たない日セル（20日（土））を拾う", "20日（土）" in fmt, True)

    # limit の上限が効く（日付が1つだけ紛れ込んだページで末尾まで残さない）
    runaway = "\n".join(["2026年9月20日"] + [f"雑音{i}" for i in range(30)])
    capped, _ = fp.schedule_lines(runaway, limit=3)
    check("limit を超えてぶら下げない", len(capped), 4)

    # 日付を1つも持たない本文は全部落ちる（＝--text に戻すべきだと分かる）
    none, dropped_all = fp.schedule_lines("会社概要\nプライバシーポリシー", limit=12)
    check("日付が無い本文では1行も残らない", (none, dropped_all), ([], 2))


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

# HTML仕様では `</td>` `</tr>` はどちらも省略できる。実在のサイトで実際に
# 省略されており、以前は対応するセルが1件も見つからず**行が丸ごと消えた**
# （392セルのスケジュール表が0行になった実例）。開きタグの位置だけで区切る
# 実装に直したので、閉じタグの有無で結果が変わらないことをここで固定する。
check("</td> が省略されていても列が割れる",
      fp.extract_text("<table><tr><td>A<td>B</tr><tr><td>C<td>D</tr></table>"), "A\tB\nC\tD")
check("</tr> が省略されていても行が割れる",
      fp.extract_text("<table><tr><td>A</td><td>B</td><tr><td>C</td><td>D</td></table>"),
      "A\tB\nC\tD")
check("<th> と <td> が混在し、かつ両方とも閉じタグ省略",
      fp.extract_text("<table><tr><th>日付<th>演目<tr><td>8/01<td>映画A</table>"),
      "日付\t演目\n8/01\t映画A")

print("リンク抽出（--links）")
LINKS = fp.extract_links(TEXT_HTML, "https://ex.jp/a/b.html")
check("相対URLが絶対になる", LINKS[0], ("詳細", "https://ex.jp/detail?id=1"))
check("# つきと重複は落ちる", len(LINKS), 2)
check("外部リンクは残る", LINKS[1][1], "https://other.example/x")

# 計測用パラメータ違いだけの同一ページを別リンクとして数えない。
# 出力するURL自体は正規化せず、最初に見つかった元のURLをそのまま返す。
TRACK_LINKS = fp.extract_links(
    '<a href="/x?utm_source=a&id=1">A</a><a href="/x?utm_source=b&id=1">B</a>'
    '<a href="/x?id=2">C</a>',
    "https://ex.jp/")
check("utm_* 違いは重複として1件に畳まれる", len(TRACK_LINKS), 2)
check("残る側は最初に見つかった元のURLのまま", TRACK_LINKS[0][1], "https://ex.jp/x?utm_source=a&id=1")

print("日程行の絞り込み（--schedule）")
run_schedule_checks()

TOTAL = 54
print(f"\n{TOTAL - fails}/{TOTAL} 件が期待どおり")
sys.exit(1 if fails else 0)
