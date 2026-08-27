#!/usr/bin/env python3
"""`tools/wave_gate.py` が、止めるべきものだけを止めるかを検証する（ネットワーク不要）。

    python3 tools/wave_gate_test.py

## なぜ念入りにやるか

このゲートは `PreToolUse(Agent)` から自動で走り、**サブエージェントの起動を
拒否できる**。誤って止めると、収集そのものが進まないまま利用上限まで空転する
——つまり**取りこぼしを防ぐための門が、取りこぼしより大きな損害を出しうる。**

だから「止めるべきものを止める」より「止めるべきでないものを止めない」ほうを
厚く固定する。判定できない状況（記録が無い・壊れている）で素通しになることも、
仕様として明示的に確かめる。
"""

import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wave_gate as wg                                        # noqa: E402
from rowkey import uid as row_uid                             # noqa: E402
from validate_data import EXPECTED_HEADERS                    # noqa: E402

HEADERS = EXPECTED_HEADERS["movies.csv"]

ROWS = [
    {"title": "作品A", "theater": "劇場X", "release_date": "2026-09-01",
     "end_date": "2026-09-30", "pref": "tokyo", "genre": "japanese",
     "screening_type": "new", "area": "東京都・渋谷区"},
    {"title": "作品B", "theater": "劇場Y", "release_date": "2026-09-05",
     "end_date": "2026-10-05", "pref": "tokyo", "genre": "foreign",
     "screening_type": "new", "area": "東京都・新宿区"},
    {"title": "作品C", "theater": "劇場Z", "release_date": "2026-09-10",
     "end_date": "2026-10-10", "pref": "chiba", "genre": "anime",
     "screening_type": "revival", "area": "千葉県・千葉市"},
    {"title": "作品D", "theater": "劇場W", "release_date": "2026-09-12",
     "end_date": "2026-10-12", "pref": "tokyo", "genre": "japanese",
     "screening_type": "new", "area": "東京都・港区"},
]

CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


class Sandbox:
    """一時ディレクトリに data/ と temp/ を作り、wave_gate の参照先を差し替える。"""

    def __init__(self, in_csv=0, budget=True, mtime_offset=+10):
        self.in_csv = in_csv
        self.budget = budget
        self.mtime_offset = mtime_offset

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="wave_gate_test_")
        self.data = os.path.join(self.tmp, "data")
        self.temp = os.path.join(self.tmp, "temp")
        os.makedirs(os.path.join(self.data, ".run"))
        os.makedirs(self.temp)
        self.orig = (wg.ROOT, wg.DATA, wg.TEMP, wg.BUDGET)
        wg.ROOT, wg.DATA, wg.TEMP = self.tmp, self.data, self.temp
        wg.BUDGET = os.path.join(self.data, ".run", "budget.json")

        self.started = time.time() - 600
        if self.budget:
            with open(wg.BUDGET, "w", encoding="utf-8") as f:
                json.dump({"started_at": self.started}, f)

        # CSV は「先頭 in_csv 件だけ追記済み」の状態にする
        import csv as _csv
        with open(os.path.join(self.data, "movies.csv"), "w",
                  newline="", encoding="utf-8") as f:
            w = _csv.writer(f, quoting=_csv.QUOTE_ALL)
            w.writerow(HEADERS)
            for r in ROWS[:self.in_csv]:
                w.writerow([r.get(h, "") for h in HEADERS])
        return self

    def write_wave(self, name="rows-wave1.jsonl", rows=None, raw=None):
        path = os.path.join(self.temp, name)
        with open(path, "w", encoding="utf-8") as f:
            if raw is not None:
                f.write(raw)
            else:
                for r in (ROWS if rows is None else rows):
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
        t = self.started + self.mtime_offset
        os.utime(path, (t, t))
        return path

    def __exit__(self, *a):
        wg.ROOT, wg.DATA, wg.TEMP, wg.BUDGET = self.orig
        shutil.rmtree(self.tmp, ignore_errors=True)
        return False


# ---------------------------------------------- 止めるべきものを止める

@check("追記していない波は止める")
def _():
    with Sandbox(in_csv=0) as sb:
        sb.write_wave()
        left = wg.pending()
        if len(left) != 1:
            return f"止めていない: {left}"
        _path, name, hit, total = left[0]
        return (name, hit, total) == ("movies.csv", 0, 4) or f"内訳が違う: {left[0]}"


@check("半分未満しか入っていない波は止める")
def _():
    with Sandbox(in_csv=1) as sb:
        sb.write_wave()
        return len(wg.pending()) == 1 or "止めていない"


@check("行が入ってさえいれば、入り先が違っても通す（守備範囲の線引き）")
def _():
    # このゲートが答えるのは「調べた行がCSVに入ったか」だけで、
    # 「正しいCSVに正しい形で入ったか」は validate_data.py の仕事である。
    # ここまで見に行くと、判定を誤ったときに**正しく追記した波を止める**側の
    # 事故が起きる。間違ったデータセットへの追記は、列が落ちて必須列が欠け、
    # validate_data.py が ERROR で捕まえる（黙って公開されることはない）。
    with Sandbox(in_csv=0) as sb:
        import csv as _csv
        with open(os.path.join(sb.data, "lives.csv"), "w",
                  newline="", encoding="utf-8") as f:
            w = _csv.writer(f, quoting=_csv.QUOTE_ALL)
            w.writerow(EXPECTED_HEADERS["lives.csv"])
            for r in ROWS:
                w.writerow([r.get(h, "") for h in EXPECTED_HEADERS["lives.csv"]])
        return wg.pending() == [] or "入っているのに止めた"


# ---------------------------------------------- 止めてはいけないものを通す

@check("全件追記済みなら通す")
def _():
    with Sandbox(in_csv=4) as sb:
        sb.write_wave()
        return wg.pending() == [] or f"誤って止めた: {wg.pending()}"


@check("半分以上入っていれば通す（purge_ended が数行落とすため）")
def _():
    with Sandbox(in_csv=2) as sb:
        sb.write_wave()
        return wg.pending() == [] or f"誤って止めた: {wg.pending()}"


@check("先週の残骸（実行開始より古いファイル）は見ない")
def _():
    with Sandbox(in_csv=0, mtime_offset=-86400) as sb:
        sb.write_wave()
        return wg.pending() == [] or "古いファイルで止めた"


@check("rows-*.jsonl 以外の作業ファイルは見ない")
def _():
    with Sandbox(in_csv=0) as sb:
        sb.write_wave(name="n1_scratch.jsonl")
        sb.write_wave(name="prevrows.jsonl")
        return wg.pending() == [] or "作業ファイルで止めた"


@check("budget.json が無ければ何も止めない（起点が分からない）")
def _():
    with Sandbox(in_csv=0, budget=False) as sb:
        sb.write_wave()
        return wg.pending() == [] or "起点不明なのに止めた"


@check("壊れたJSONでは止めない（判定できないものは通す）")
def _():
    with Sandbox(in_csv=0) as sb:
        sb.write_wave(raw='{"title": "作品A", ...壊れている\n')
        return wg.pending() == [] or "解析できないのに止めた"


@check("空のファイルでは止めない")
def _():
    with Sandbox(in_csv=0) as sb:
        sb.write_wave(raw="")
        return wg.pending() == [] or "空で止めた"


@check("ファイルを消せば止まらなくなる（行き止まりを作らない）")
def _():
    with Sandbox(in_csv=0) as sb:
        path = sb.write_wave()
        if not wg.pending():
            return "そもそも止めていない"
        os.remove(path)
        return wg.pending() == [] or "消しても止まったまま"


@check("CSVがヘッダーだけでも、列名からデータセットを当てる")
def _():
    with Sandbox(in_csv=0) as sb:
        sb.write_wave()
        _path, name, _hit, _total = wg.pending()[0]
        return name == "movies.csv" or f"当てられていない: {name}"


@check("--check の終了コードと、直し方が書かれたメッセージ")
def _():
    import contextlib, io
    with Sandbox(in_csv=0) as sb:
        sb.write_wave()
        err = io.StringIO()
        argv = sys.argv
        sys.argv = ["wave_gate.py", "--check"]
        try:
            with contextlib.redirect_stderr(err):
                rc = wg.main()
        finally:
            sys.argv = argv
        if rc != 1:
            return f"未消化なのに exit={rc}"
        msg = err.getvalue()
        # 行き止まりを作らないために、直し方が2つとも書かれている必要がある
        for want in ("append_rows.py movies", "消せば止めません"):
            if want not in msg:
                return f"メッセージに {want!r} が無い"
    with Sandbox(in_csv=4) as sb:
        sb.write_wave()
        argv = sys.argv
        sys.argv = ["wave_gate.py", "--check"]
        try:
            rc = wg.main()
        finally:
            sys.argv = argv
        return rc == 0 or f"消化済みなのに exit={rc}"


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
