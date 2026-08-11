#!/usr/bin/env python3
"""`tools/robots_rules.py` の判定を検証する（ネットワーク不要）。

    python3 tools/robots_test.py

robots.txt の解釈は「取得してよいか」を決める最後の砦なので、規則を散文で
決めただけにせず、ここで固定する。判定が緩む方向に壊れると、**拒否されている
ページを取りに行っても誰も気づかない**——CSVには「取れた」という結果しか残らない。

あわせて、実行中の Python の標準ライブラリと結果が一致するかも見る。割れた場合は
`urllib.robotparser` が古い（先頭一致・ワイルドカード非対応の）実装だという印で、
`robots_rules.py` を自前で持っている理由がそのまま現れたことになる。
"""

import os
import sys
from urllib.robotparser import RobotFileParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import robots_rules as rr                                    # noqa: E402

# (説明, robots.txt, UA, URL, 取得してよいか)
CASES = [
    # --- 最長一致（RFC 9309）。順序ではなくパターンの長さで決まる ---
    ("Disallow が先でも、長い Allow が勝つ",
     "User-agent: *\nDisallow: /search\nAllow: /search/help\n",
     "Claude-User", "https://x.jp/search/help", True),
    ("その Allow に外れるパスは Disallow のまま",
     "User-agent: *\nDisallow: /search\nAllow: /search/help\n",
     "Claude-User", "https://x.jp/search/other", False),
    ("全面 Disallow でも、部分 Allow が勝つ",
     "User-agent: *\nDisallow: /\nAllow: /event/\n",
     "Claude-User", "https://x.jp/event/1", True),
    ("順序を入れ替えても結果は同じ",
     "User-agent: *\nAllow: /event/\nDisallow: /\n",
     "Claude-User", "https://x.jp/event/1", True),
    ("長い Disallow は短い Allow に勝つ",
     "User-agent: *\nAllow: /a\nDisallow: /a/b/c\n",
     "Claude-User", "https://x.jp/a/b/c", False),
    ("同じ長さなら Allow を優先する",
     "User-agent: *\nDisallow: /x/\nAllow: /x/\n",
     "Claude-User", "https://x.jp/x/1", True),

    # --- ワイルドカード ---
    ("`*` と `$` で拡張子を閉じる",
     "User-agent: *\nDisallow: /*.pdf$\n",
     "Claude-User", "https://x.jp/doc/a.pdf", False),
    ("`$` は末尾固定なので、クエリが付けば一致しない",
     "User-agent: *\nDisallow: /*.pdf$\n",
     "Claude-User", "https://x.jp/doc/a.pdf?v=1", True),
    ("クエリ文字列も判定の対象に含む",
     "User-agent: *\nDisallow: /*?sort=\n",
     "Claude-User", "https://x.jp/list?sort=asc", False),

    # --- UA 群の選び方 ---
    ("個別指定がある UA は、`*` の群を見ない",
     "User-agent: *\nDisallow: /\n\nUser-agent: Claude-User\nAllow: /\n",
     "Claude-User", "https://x.jp/any", True),
    ("個別指定が無い UA は、`*` の群に落ちる",
     "User-agent: *\nDisallow: /\n\nUser-agent: Claude-User\nAllow: /\n",
     "Claude-SearchBot", "https://x.jp/any", False),
    ("UA 名の大文字小文字は区別しない",
     "User-agent: claude-user\nDisallow: /no/\n",
     "Claude-User", "https://x.jp/no/1", False),
    ("空の Disallow は「何も禁止しない」",
     "User-agent: *\nDisallow:\n",
     "Claude-User", "https://x.jp/any", True),
    ("ルールに一致しなければ許可（既定は許可）",
     "User-agent: *\nDisallow: /admin/\n",
     "Claude-User", "https://x.jp/event/1", True),
    ("ClaudeBot（学習用）への拒否は、この判定に影響しない",
     "User-agent: ClaudeBot\nDisallow: /\n",
     "Claude-User", "https://x.jp/any", True),
]

# decide() は2つのUAの厳しいほうを採る。ここはその合成の検証。
DECIDE_CASES = [
    ("片方だけ拒否でも、全体として取得しない",
     "User-agent: Claude-User\nAllow: /\n\nUser-agent: Claude-SearchBot\nDisallow: /\n",
     "https://x.jp/a", False),
    ("両方が許可していれば取得してよい",
     "User-agent: Claude-User\nAllow: /\n\nUser-agent: Claude-SearchBot\nAllow: /\n",
     "https://x.jp/a", True),
    ("crawl-delay は長いほうを採る",
     "User-agent: Claude-User\nCrawl-delay: 2\nDisallow:\n\n"
     "User-agent: Claude-SearchBot\nCrawl-delay: 9\nDisallow:\n",
     "https://x.jp/a", True),
]


def run():
    fails, stdlib_diff = 0, 0

    for name, txt, agent, url, want in CASES:
        got = rr.match(rr.parse(txt), agent, url)["allowed"]
        if got != want:
            print(f"✗ {name}\n    {url}  期待 {want} / 実際 {got}")
            fails += 1
        rp = RobotFileParser()
        rp.parse(txt.splitlines())
        if rp.can_fetch(agent, url) != want:
            stdlib_diff += 1

    for name, txt, url, want in DECIDE_CASES:
        groups = rr.parse(txt)
        allowed = all(rr.match(groups, a, url)["allowed"] for a in rr.AGENTS)
        if allowed != want:
            print(f"✗ {name}\n    {url}  期待 {want} / 実際 {allowed}")
            fails += 1

    # crawl-delay の合成（decide() が長いほうを採ること）
    groups = rr.parse(DECIDE_CASES[2][1])
    delays = [rr.match(groups, a, "https://x.jp/a")["crawl_delay"] for a in rr.AGENTS]
    if max(d for d in delays if d) != 9:
        print(f"✗ crawl-delay の合成が 9 にならない: {delays}")
        fails += 1

    total = len(CASES) + len(DECIDE_CASES) + 1
    print(f"\n{total - fails}/{total} 件が期待どおり")
    if stdlib_diff:
        print(f"※ この環境の urllib.robotparser は {stdlib_diff} 件で結果が異なる"
              f"（Python {sys.version.split()[0]}）。自前実装を持っている理由がこれ。")
    else:
        print(f"※ この環境の urllib.robotparser とは全件一致（Python {sys.version.split()[0]}）")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(run())
