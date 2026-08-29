#!/usr/bin/env python3
"""`tools/festival_gate.py`（festivals.csv と lives.csv の整合チェック）を検証する（ネットワーク不要）。

    python3 tools/festival_gate_test.py

## なぜここを固定するのか

2026-08-29 の無人実行では、festivals.csv に active 登録され直近まで
見つかっていたフェスが、今週の調査範囲から漏れて lives.csv からも消えた
ことに誰も気づけなかった。festival_gate.py はこの2つのファイルを突き合わせる
唯一の場所なので、判定規則（対象にするstatus・hit_count・直近何日か・
一致の取り方）をここで固定する。
"""

import contextlib
import io
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import festival_gate as fg                                    # noqa: E402

TODAY = date(2026, 8, 29)


def _fest(**kw):
    base = {"name": "テストフェス", "venue": "会場", "pref": "chiba",
            "month_hint": "9月", "url": "", "status": "active",
            "first_seen": "2026-08-01", "last_hit": "2026-08-12",
            "hit_count": "3", "note": ""}
    return base | kw


CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


@check("直近に確認済みで lives.csv に無いフェスは missing に入る")
def _():
    festivals = [_fest(name="ROCK IN JAPAN FESTIVAL")]
    missing = fg.find_missing(festivals, ["別の公演"], TODAY)
    return len(missing) == 1 or f"検知していない: {missing}"


@check("lives.csv のタイトルに部分文字列として含まれていれば missing に入らない")
def _():
    festivals = [_fest(name="ROCK IN JAPAN FESTIVAL")]
    titles = ["ROCK IN JAPAN FESTIVAL 2026 第1週"]
    missing = fg.find_missing(festivals, titles, TODAY)
    return missing == [] or f"見つかっているのに missing になった: {missing}"


@check("類似度が高いだけの無関係な名前を「見つかった」と誤認しない（部分文字列一致のみ使う）")
def _():
    # FUJI ROCK FESTIVAL は lives.csv に無いので本来 missing に入るべき。
    # 文字集合の類似度だけで判定すると「ROCK IN JAPAN FESTIVAL...」と
    # 誤って一致（＝見つかった扱い）してしまい missing から漏れる
    festivals = [_fest(name="FUJI ROCK FESTIVAL")]
    titles = ["ROCK IN JAPAN FESTIVAL 2026 第1週"]
    missing = fg.find_missing(festivals, titles, TODAY)
    return len(missing) == 1 or f"無関係な公演に誤って一致し、missingから漏れた: {missing}"


@check("hit_count=0 のフェスは対象外")
def _():
    festivals = [_fest(name="COUNTDOWN JAPAN", hit_count="0")]
    missing = fg.find_missing(festivals, ["別の公演"], TODAY)
    return missing == [] or f"hit_count=0 なのに検知した: {missing}"


@check("candidate ステータスは対象外")
def _():
    festivals = [_fest(name="a-nation", status="candidate")]
    missing = fg.find_missing(festivals, ["別の公演"], TODAY)
    return missing == [] or f"candidate なのに検知した: {missing}"


@check("retired ステータスは対象外")
def _():
    festivals = [_fest(name="SUPERSONIC", status="retired")]
    missing = fg.find_missing(festivals, ["別の公演"], TODAY)
    return missing == [] or f"retired なのに検知した: {missing}"


@check("blocked ステータスは対象に含める（公式サイトが見えないだけで名簿としては生きている）")
def _():
    festivals = [_fest(name="氣志團万博", status="blocked")]
    missing = fg.find_missing(festivals, ["別の公演"], TODAY)
    return len(missing) == 1 or f"blocked を対象から外してしまっている: {missing}"


@check("直近ヒットが古すぎる（RECENT_HIT_DAYSより前）フェスは対象外")
def _():
    festivals = [_fest(name="ROCK IN JAPAN FESTIVAL", last_hit="2026-01-01")]
    missing = fg.find_missing(festivals, ["別の公演"], TODAY)
    return missing == [] or f"古いヒットまで検知した: {missing}"


@check("last_hit が無いフェスは対象外（判定材料が無い）")
def _():
    festivals = [_fest(name="ROCK IN JAPAN FESTIVAL", last_hit="")]
    missing = fg.find_missing(festivals, ["別の公演"], TODAY)
    return missing == [] or f"last_hit が無いのに検知した: {missing}"


@check("--allow で承知したフェスは終了コード0")
def _():
    tmp_data = _tmp_data_dir([
        _fest(name="ROCK IN JAPAN FESTIVAL"),
    ], ["無関係な公演"])
    orig = fg.DATA
    fg.DATA = tmp_data
    try:
        out, err = io.StringIO(), io.StringIO()
        orig_argv = sys.argv
        sys.argv = ["festival_gate.py", "--today", TODAY.isoformat(),
                    "--allow", "ROCK IN JAPAN FESTIVAL"]
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = fg.main()
        finally:
            sys.argv = orig_argv
    finally:
        fg.DATA = orig
    return code == 0 or f"--allow を渡しても落ちた: {out.getvalue()}{err.getvalue()}"


@check("承知していない不足があれば終了コード1")
def _():
    tmp_data = _tmp_data_dir([
        _fest(name="ROCK IN JAPAN FESTIVAL"),
    ], ["無関係な公演"])
    orig = fg.DATA
    fg.DATA = tmp_data
    try:
        out, err = io.StringIO(), io.StringIO()
        orig_argv = sys.argv
        sys.argv = ["festival_gate.py", "--today", TODAY.isoformat()]
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = fg.main()
        finally:
            sys.argv = orig_argv
    finally:
        fg.DATA = orig
    if code != 1:
        return f"不足があるのに通った: code={code} {out.getvalue()}"
    return "ROCK IN JAPAN FESTIVAL" in out.getvalue() or f"不足の名前が出ていない: {out.getvalue()}"


def _tmp_data_dir(festivals, live_titles):
    import csv
    import tempfile
    tmp = tempfile.mkdtemp(prefix="festival_gate_test_")
    fest_headers = ["name", "venue", "pref", "month_hint", "url", "status",
                     "first_seen", "last_hit", "hit_count", "note"]
    with open(os.path.join(tmp, "festivals.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(fest_headers)
        for row in festivals:
            w.writerow([row.get(h, "") for h in fest_headers])
    with open(os.path.join(tmp, "lives.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(["title"])
        for t in live_titles:
            w.writerow([t])
    return tmp


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
