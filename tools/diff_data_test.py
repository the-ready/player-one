#!/usr/bin/env python3
"""`tools/diff_data.py` のフェス名簿を使ったリネーム検知を検証する（ネットワーク不要）。

    python3 tools/diff_data_test.py

## なぜここを固定するのか

2026-08-29 の無人実行で、会場ベース調査が「ポムフェス2026（ポムポムプリン
30周年記念）」を「ポムフェス POMPOMPURIN FESTIVAL」という別表記で新規発見し、
既存の登録行と同一だと認識できなかった。タイトルの編集距離ベースの類似度
だけでは、大きく書き換わった表記を拾いきれない（`similarity()`は逆に
「FUJI ROCK」と「ROCK IN JAPAN」のような無関係な行を誤って高スコアにする
弱点もある）。`data/festivals.csv`（フェス名簿）に載っている名前をタイトルへの
部分文字列一致で照合し、同じフェスに属す gone/added のペアを強く結びつける
——この判定をここで固定する。
"""

import contextlib
import csv
import io
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import diff_data as dd                                        # noqa: E402


def _write_festivals(tmp, names):
    path = os.path.join(tmp, "festivals.csv")
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["name", "venue", "pref", "month_hint", "url", "status",
                    "first_seen", "last_hit", "hit_count", "note"])
        for n in names:
            w.writerow([n, "", "chiba", "9月", "", "active",
                        "2026-08-02", "2026-08-12", "3", ""])


def _row(title, venue="会場", start_date="2026-09-01"):
    return {"title": title, "venue": venue, "start_date": start_date, "end_date": start_date}


CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


@check("フェス名簿に載った名前で、書き換わったタイトルどうしを対にする")
def _():
    tmp = tempfile.mkdtemp(prefix="diff_data_test_")
    _write_festivals(tmp, ["ポムフェス"])
    orig = dd.DATA
    dd.DATA = tmp
    try:
        gone = {"g1": _row("ポムフェス2026（ポムポムプリン30周年記念）", venue="横浜赤レンガ倉庫")}
        added = {"a1": _row("ポムフェス POMPOMPURIN FESTIVAL", venue="横浜赤レンガ倉庫")}
        pairs = dd.fuzzy_pairs("lives.csv", gone, added)
    finally:
        dd.DATA = orig
    return pairs == [("g1", "a1", dd.FESTIVAL_MATCH_SCORE)] or f"対になっていない: {pairs}"


@check("フェス名簿に載っていても、一致しない行どうしは対にしない")
def _():
    tmp = tempfile.mkdtemp(prefix="diff_data_test_")
    _write_festivals(tmp, ["ROCK IN JAPAN FESTIVAL", "氣志團万博"])
    orig = dd.DATA
    dd.DATA = tmp
    try:
        gone = {"g1": _row("ROCK IN JAPAN FESTIVAL 2026 第1週")}
        added = {"a1": _row("氣志團万博2026 ～房総爆音リゾート～")}
        pairs = dd.fuzzy_pairs("lives.csv", gone, added)
    finally:
        dd.DATA = orig
    return pairs == [] or f"無関係な行を対にしてしまった: {pairs}"


@check("festivals.csv が無くても壊れない（events.csv 等）")
def _():
    tmp = tempfile.mkdtemp(prefix="diff_data_test_")   # festivals.csv を置かない
    orig = dd.DATA
    dd.DATA = tmp
    try:
        gone = {"g1": _row("ABC Live Tour 2026")}
        added = {"a1": _row("XYZ演奏会")}
        pairs = dd.fuzzy_pairs("lives.csv", gone, added)
    finally:
        dd.DATA = orig
    return pairs == [] or f"festivals.csv 不在で例外にならず変な結果: {pairs}"


@check("lives.csv 以外では festivals.csv 照合を行わない")
def _():
    tmp = tempfile.mkdtemp(prefix="diff_data_test_")
    _write_festivals(tmp, ["ポムフェス"])
    orig = dd.DATA
    dd.DATA = tmp
    try:
        gone = {"g1": _row("ポムフェス2026（ポムポムプリン30周年記念）")}
        added = {"a1": _row("ポムフェス POMPOMPURIN FESTIVAL")}
        pairs = dd.fuzzy_pairs("events.csv", gone, added)
    finally:
        dd.DATA = orig
    return pairs == [] or f"events.csv でもフェス名簿照合が効いてしまった: {pairs}"


@check("同じ枠を取り合うときは、真の完全一致がフェス名簿一致より優先される")
def _():
    tmp = tempfile.mkdtemp(prefix="diff_data_test_")
    _write_festivals(tmp, ["ポムフェス"])
    orig = dd.DATA
    dd.DATA = tmp
    try:
        # g1 は a1 と表記が完全一致。g2 は「ポムフェス」を含むだけの別行で、
        # フェス名簿経由でも a1 と対になりうるが、枠は g1 に取られるべき
        gone = {
            "g1": _row("ポムフェス2026（ポムポムプリン30周年記念）"),
            "g2": _row("ポムフェス OLD EVENT"),
        }
        added = {"a1": _row("ポムフェス2026（ポムポムプリン30周年記念）")}
        pairs = dd.fuzzy_pairs("lives.csv", gone, added)
    finally:
        dd.DATA = orig
    if len(pairs) != 1:
        return f"1対に絞れていない: {pairs}"
    return pairs[0][:2] == ("g1", "a1") or f"完全一致でない方が枠を取った: {pairs}"


def main():
    fails = 0
    for name, fn in CHECKS:
        try:
            got = fn()
        except Exception as e:                                # noqa: BLE001
            got = f"{type(e).__name__}: {e}"
        if got is not True:
            print(f"✗ {name}\n    {got}")
            fails += 1
    print(f"\n{len(CHECKS) - fails}/{len(CHECKS)} 件が期待どおり")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
