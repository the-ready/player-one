#!/usr/bin/env python3
"""`tools/roster.py` の、行の会場表記から名簿へ収穫を紐づける規則を検証する（ネットワーク不要）。

    python3 tools/roster_test.py

## なぜ固定するのか

収穫の記録は `append_rows.py` が機械的に付け、`--gc` はその数字だけを見て名簿を
降格・退役させる。紐づけが漏れると「催しが載り続けている施設」が収穫ゼロに見えて
外され、逆に緩すぎると別の施設の収穫を横取りして、本当に収穫の無い施設を延命させる。
どちらも無音で起きるので、規則をここで固定する。
"""

import csv
import os
import sys
import tempfile
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import roster                                                 # noqa: E402

ROWS = [{"name": n} for n in (
    "東京国立博物館", "国立競技場", "東京ミッドタウン", "東京ミッドタウン日比谷",
    "東京ディズニーランド", "東京ディズニーシー", "東京ビッグサイト", "東京ビッグサイト南展示棟",
    "東京ドームシティ", "東京ドームシティ アトラクションズ",
)]


def names(venue):
    return [r["name"] for r in roster.match_venue(ROWS, "name", venue)]


CHECKS = []


def check(desc):
    def deco(fn):
        CHECKS.append((desc, fn))
        return fn
    return deco


@check("完全一致は従来どおり引ける（全角・半角・大文字小文字の揺れを吸収）")
def _():
    return names("東京国立博物館") == ["東京国立博物館"] and names("ＴＯＫＹＯ") == [] \
        or f"{names('東京国立博物館')}"


@check("館内の会場まで書いた表記（空白・括弧の後ろ）は、その施設に紐づく")
def _():
    got = (names("東京国立博物館 平成館"), names("国立競技場（MUFGスタジアム）"))
    return got == (["東京国立博物館"], ["国立競技場"]) or f"{got}"


@check("区切りが無い前方一致は紐づけない（東京ミッドタウン が 日比谷 を横取りしない）")
def _():
    got = names("東京ミッドタウン日比谷 アトリウム")
    return got == ["東京ミッドタウン日比谷"] or f"{got}"


@check("前方一致は、いちばん長い名簿名を選ぶ")
def _():
    got = names("東京ビッグサイト南展示棟 4ホール")
    return got == ["東京ビッグサイト南展示棟"] or f"{got}"


@check("／ で区切った複数施設は、それぞれに紐づく")
def _():
    got = sorted(names("東京ディズニーランド／東京ディズニーシー"))
    return got == ["東京ディズニーシー", "東京ディズニーランド"] or f"{got}"


@check("名簿の名前に空白を含んでも、その後ろの区切りで紐づく")
def _():
    got = names("東京ドームシティ アトラクションズ 特設会場")
    return got == ["東京ドームシティ アトラクションズ"] or f"{got}"


@check("名簿に無い施設が、名簿の名前で始まるだけなら紐づけない（八重洲 を六本木に付けない）")
def _():
    got = names("東京ミッドタウン八重洲")
    return got == [] or f"{got}"


@check("区切りの付く候補が複数あれば、いちばん長い名前を選ぶ（並び順に依らない）")
def _():
    got = names("東京ドームシティ アトラクションズ 特設会場")
    return got == ["東京ドームシティ アトラクションズ"] or f"{got}"


@check("名簿に無い会場は紐づけない")
def _():
    return names("千葉市立動物公園") == [] or f"{names('千葉市立動物公園')}"


@check("record_hits: 表記ゆれの行でも収穫が付き、同じ日の二重計上はしない")
def _():
    tmp = tempfile.mkdtemp(prefix="roster_test_")
    path = os.path.join(tmp, "spots.csv")
    head = ["name", "kind", "pref", "area", "lat", "lng", "url", "status", "closed_until",
            "first_seen", "last_hit", "hit_count", "note"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=head)
        w.writeheader()
        for n in ("東京国立博物館", "東京ディズニーランド", "東京ディズニーシー"):
            w.writerow({"name": n, "status": "active", "hit_count": "0"})
    orig = roster.DATA
    roster.DATA = tmp
    try:
        hits, misses = roster.record_hits(
            "spots", ["東京国立博物館 平成館", "東京国立博物館", "東京ディズニーランド／東京ディズニーシー",
                      "どこにも無い会場"], today=date(2026, 10, 1))
        with open(path, newline="", encoding="utf-8") as f:
            counts = {r["name"]: r["hit_count"] for r in csv.DictReader(f)}
    finally:
        roster.DATA = orig
    want = {"東京国立博物館": "1", "東京ディズニーランド": "1", "東京ディズニーシー": "1"}
    if counts != want:
        return f"hit_count={counts}"
    return misses == ["どこにも無い会場"] or f"misses={misses}"


def main():
    fails = 0
    for desc, fn in CHECKS:
        try:
            got = fn()
        except Exception as e:                                # noqa: BLE001
            got = f"{type(e).__name__}: {e}"
        if got is not True:
            print(f"✗ {desc}\n    {got}")
            fails += 1
    print(f"\n{len(CHECKS) - fails}/{len(CHECKS)} 件が期待どおり")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
