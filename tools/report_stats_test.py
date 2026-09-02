#!/usr/bin/env python3
"""`tools/report_stats.py` の `--check`（都県の網羅性ゲート）を検証する（ネットワーク不要）。

    python3 tools/report_stats_test.py

## なぜここを固定するのか

report_stats.py は「数字を出すだけで良し悪しは判定しない」設計で、pref の
不足はこれまでも WARNING として出ていた（2026-08-29 の回にも実際に出ていた）。
だが誰も見ない・止まらないので、千葉・群馬が調査範囲から漏れたまま最後まで
気づかれなかった。`--check` はこの同じ集計を、終了工程のゲートが使える形
（終了コード）に変える追加の入口であって、既定の出力は変えていないことを
ここで固定する。
"""

import contextlib
import csv
import io
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prev_rows as pr                                        # noqa: E402
import report_stats as rs                                     # noqa: E402
from validate_data import EXPECTED_HEADERS                    # noqa: E402

HEADERS = EXPECTED_HEADERS["lives.csv"]


def _row(**kw):
    base = {"title": "公演", "venue": "会場", "pref": "tokyo",
            "start_date": "2026-09-01", "end_date": "2026-09-01"}
    return base | kw


def _write_csv(path, headers, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(headers)
        for r in rows:
            w.writerow([r.get(h, "") for h in headers])


@contextlib.contextmanager
def _isolated(rows):
    """一時ディレクトリに lives.csv（と空の前回スナップショット）だけを置く。

    前回スナップショットを空でも明示的に置くのは、`load_prev` が
    スナップショット不在時に `git show HEAD:...`（本物のリポジトリの
    lives.csv）へフォールバックするため。置かないとテストの結果が
    実行環境のコミット内容に左右されてしまう。
    """
    tmp = tempfile.mkdtemp(prefix="report_stats_test_")
    prev_dir = os.path.join(tmp, ".prev")
    os.makedirs(prev_dir, exist_ok=True)
    orig = (rs.DATA, pr.DATA, pr.PREV)
    rs.DATA, pr.DATA, pr.PREV = tmp, tmp, prev_dir
    try:
        _write_csv(os.path.join(tmp, "lives.csv"), HEADERS, rows)
        _write_csv(os.path.join(prev_dir, "lives.csv"), HEADERS, [])
        yield tmp
    finally:
        rs.DATA, pr.DATA, pr.PREV = orig


def _analyse(rows):
    with _isolated(rows):
        return rs.analyse("lives.csv")


def _run_main(rows, argv):
    with _isolated(rows):
        orig_argv = sys.argv
        sys.argv = ["report_stats.py"] + argv
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = rs.main()
        finally:
            sys.argv = orig_argv
        return code, out.getvalue(), err.getvalue()


CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


@check("都県が足りている週は coverage_issues が空")
def _():
    prefs = ["tokyo", "kanagawa", "saitama", "chiba", "ibaraki", "tochigi", "gunma"]
    rows = [_row(title=f"公演{i}", pref=p) for p in prefs for i in range(3)]
    res = _analyse(rows)
    return res["coverage_issues"] == [] or f"issues が残っている: {res['coverage_issues']}"


@check("都県が3件未満だと floor の coverage_issue が付く")
def _():
    prefs = ["tokyo", "kanagawa", "saitama", "chiba", "ibaraki", "tochigi"]
    rows = [_row(title=f"公演{i}", pref=p) for p in prefs for i in range(3)]
    # gunma だけ0件のまま
    res = _analyse(rows)
    kinds = {(i["kind"], i["pref"]) for i in res["coverage_issues"]}
    return ("floor", "gunma") in kinds or f"gunma の不足を検知していない: {res['coverage_issues']}"


@check("隣接5県（pref=other）が多すぎると adjacent_heavy が付く")
def _():
    core = ["tokyo", "kanagawa", "saitama", "chiba", "ibaraki", "tochigi", "gunma"]
    rows = [_row(title=f"公演{i}", pref=p) for p in core for i in range(3)]
    rows += [_row(title=f"隣接{i}", pref="other") for i in range(10)]
    res = _analyse(rows)
    kinds = {(i["kind"], i["pref"]) for i in res["coverage_issues"]}
    return ("adjacent_heavy", "other") in kinds or f"検知していない: {res['coverage_issues']}"


# ---------------------------------------------------------------- events の価格
#
# 「今週あらたに書いた行」だけを見る判定を、**持ち越し行が混ざらないこと**を軸に
# 固定する。混ざると、`carry-rest` が書き戻した前回値が「今週調べた料金」として
# 数えられ、2026-09-02 の失敗（新規90件の price が32%なのに全体は58%に見える）が
# そのまま再現する。

EVENT_HEADERS = EXPECTED_HEADERS["events.csv"]


def _erow(**kw):
    base = {"title": "催し", "venue": "会場", "pref": "tokyo", "cats": "art",
            "start_date": "2026-09-01", "end_date": "2026-09-30"}
    return base | kw


@contextlib.contextmanager
def _isolated_events(rows, prev_rows_):
    tmp = tempfile.mkdtemp(prefix="report_stats_events_test_")
    prev_dir = os.path.join(tmp, ".prev")
    os.makedirs(prev_dir, exist_ok=True)
    orig = (rs.DATA, pr.DATA, pr.PREV)
    rs.DATA, pr.DATA, pr.PREV = tmp, tmp, prev_dir
    try:
        _write_csv(os.path.join(tmp, "events.csv"), EVENT_HEADERS, rows)
        _write_csv(os.path.join(prev_dir, "events.csv"), EVENT_HEADERS, prev_rows_)
        yield tmp
    finally:
        rs.DATA, pr.DATA, pr.PREV = orig


def _analyse_events(rows, prev_rows_):
    with _isolated_events(rows, prev_rows_):
        return rs.analyse("events.csv")


def _run_events(rows, prev_rows_, argv):
    with _isolated_events(rows, prev_rows_):
        orig_argv = sys.argv
        sys.argv = ["report_stats.py"] + argv
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = rs.main()
        finally:
            sys.argv = orig_argv
        return code, out.getvalue(), err.getvalue()


# 前回20件（全部 price 入り）＋今週の新規20件、という形を共通の土台にする。
#
# 都県を5つに散らしてあるのは、**pref の網羅性ゲートを踏まないようにするため**。
# 踏むと `--check` が1を返し、「価格の下限で落ちた」のか「都県で落ちた」のかが
# 区別できず、この検証が価格のゲートを見ていることにならない。
EVENT_PREFS = ["tokyo", "kanagawa", "saitama", "chiba", "ibaraki"]
PREV20 = [_erow(title=f"継続{i}", pref=EVENT_PREFS[i % 5], price="1000円")
          for i in range(20)]


def _events_week(new_with_price):
    """継続20件（price あり）＋新規20件（うち new_with_price 件だけ price あり）"""
    rows = list(PREV20)
    rows += [_erow(title=f"新規{i}", pref=EVENT_PREFS[i % 5],
                   price=("800円" if i < new_with_price else ""))
             for i in range(20)]
    return rows


@check("events: 新規行の price が下限を割ると thin_issues が付く")
def _():
    res = _analyse_events(_events_week(4), PREV20)      # 4/20 = 20%
    cols = {i["column"] for i in res["thin_issues"]}
    return "price" in cols or f"検知していない: {res['thin_issues']} / {res['fresh']}"


@check("events: 新規行の price が下限を満たせば thin_issues は空")
def _():
    res = _analyse_events(_events_week(18), PREV20)     # 18/20 = 90%
    return res["thin_issues"] == [] or f"誤検知: {res['thin_issues']}"


@check("events: 継続行の price を新規の充足率に数えない")
def _():
    # 継続20件は全部 price あり・新規20件は全部空。全体では50%だが、新規は0%。
    res = _analyse_events(_events_week(0), PREV20)
    fresh = res["fresh"]
    if fresh["count"] != 20:
        return f"新規の件数が合わない: {fresh}"
    col = next(c for c in fresh["columns"] if c["column"] == "price")
    return col["pct"] == 0 or f"持ち越しが混ざっている: {col}"


@check("events: 新規が数件しかない週は判定しない")
def _():
    rows = list(PREV20) + [_erow(title=f"新規{i}", pref=EVENT_PREFS[i % 5])
                           for i in range(3)]
    res = _analyse_events(rows, PREV20)
    return res["thin_issues"] == [] or f"標本が足りないのに判定した: {res['thin_issues']}"


@check("events: --check は薄い週を終了コード1で返す")
def _():
    code, out, err = _run_events(_events_week(4), PREV20, ["events", "--check"])
    if code != 1:
        return f"薄いのに通った: code={code} {out}"
    return "price" in out or f"どの列かが出ていない: {out}"


@check("events: --allow-thin price で承知したことにできる")
def _():
    code, out, err = _run_events(_events_week(4), PREV20,
                                 ["events", "--check", "--allow-thin", "price"])
    return code == 0 or f"承知しても落ちた: code={code} {out}"


@check("events: --check-fresh は都県の不足では落ちない（収集していないデータセットを巻き込まない）")
def _():
    # 全件 tokyo（＝都県の網羅性は明確に不足）だが、新規行の price は満たしている
    rows = [_erow(title=f"継続{i}", price="1000円") for i in range(20)]
    rows += [_erow(title=f"新規{i}", price="800円") for i in range(20)]
    prev = [_erow(title=f"継続{i}", price="1000円") for i in range(20)]
    code, out, err = _run_events(rows, prev, ["events", "--check-fresh"])
    return code == 0 or f"都県の不足で落ちた: code={code} {out}"


@check("events: --check-fresh は新規行が薄ければ終了コード1")
def _():
    code, out, err = _run_events(_events_week(4), PREV20, ["events", "--check-fresh"])
    return code == 1 or f"薄いのに通った: code={code} {out}"


@check("events: --check を付けなければ薄くても終了コード0（既定の動作を変えない）")
def _():
    code, out, err = _run_events(_events_week(4), PREV20, ["events"])
    return code == 0 or f"--check なしで落ちた: {out}{err}"


SHORT_ROWS = [_row(title=f"公演{i}", pref="tokyo") for i in range(3)]
SHORT_PREFS = "kanagawa,saitama,chiba,ibaraki,tochigi,gunma,other"


@check("--check を付けないと従来どおり終了コード0（既定の動作を変えない）")
def _():
    code, out, err = _run_main(SHORT_ROWS, ["lives"])
    return code == 0 or f"--check なしで落ちた: {out}{err}"


@check("--check だけだと不足があれば終了コード1")
def _():
    code, out, err = _run_main(SHORT_ROWS, ["lives", "--check"])
    if code != 1:
        return f"不足があるのに通った: code={code} {out}"
    return "gunma" in out or f"不足の都県が出ていない: {out}"


@check("--allow-short で承知した都県は --check を通す")
def _():
    code, out, err = _run_main(SHORT_ROWS, ["lives", "--check", "--allow-short", SHORT_PREFS])
    return code == 0 or f"--allow-short を渡しても落ちた: {out}{err}"


@check("--allow-short はカンマ区切りでも繰り返しでも受け付ける")
def _():
    argv = ["lives", "--check"]
    for p in SHORT_PREFS.split(","):
        argv += ["--allow-short", p]
    code, out, err = _run_main(SHORT_ROWS, argv)
    return code == 0 or f"繰り返し指定で落ちた: {out}{err}"


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
