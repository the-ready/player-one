#!/usr/bin/env python3
"""`tools/prev_rows.py` の「打ち切られたときの後始末」を検証する（ネットワーク不要）。

    python3 tools/prev_rows_test.py

## なぜここを固定するのか

`--carry-rest` は、実行が予告なく打ち切られたときに**その週の収穫が丸ごと
巻き戻るのを防ぐ**ための後始末である（2026-08-26 の lives 収集はこれが無く、
書けていた94行と日割り217行を失った）。終了工程から自動で呼ばれ、モデルの
確認を経ずにCSVへ書き戻すので、間違える方向が2つある。

  - **書き戻しすぎる**: 終了した催しを復活させる／受付の締切を古いまま残す
  - **書き戻さなすぎる**: 消滅の説明が付かず、結局 `diff_data.py` が落ちる

どちらも無音で起きるので、判定と書き換えの規則をここで固定する。
`--worklist` の足切り（終了した行を調査対象に出さない）も同じ規則を使う。
"""

import contextlib
import csv
import io
import json
import os
import sys
import tempfile
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prev_rows as pr                                        # noqa: E402
from validate_data import EXPECTED_HEADERS                    # noqa: E402

TODAY = date(2026, 8, 26)
HEADERS = EXPECTED_HEADERS["lives.csv"]


class Args:
    def __init__(self, **kw):
        self.today = TODAY
        self.apply = False
        self.force = False
        self.dataset = "lives"
        self.tier = None
        self.pref = None
        for k, v in kw.items():
            setattr(self, k, v)


def _write_csv(path, headers, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(headers)
        for r in rows:
            w.writerow([r.get(h, "") for h in headers])


def _row(**kw):
    base = {"title": "公演", "venue": "会場", "pref": "tokyo",
            "start_date": "2026-09-01", "end_date": "2026-09-01"}
    return base | kw


def _carry_rest(prev, current, lineups=None, dispositions=None, today=TODAY):
    """一時ディレクトリで --carry-rest を回し、(書き戻すJSONL, 処分記録) を返す。"""
    tmp = tempfile.mkdtemp(prefix="prev_rows_test_")
    prev_dir = os.path.join(tmp, ".prev")
    os.makedirs(prev_dir, exist_ok=True)
    orig = (pr.DATA, pr.PREV)
    pr.DATA, pr.PREV = tmp, prev_dir
    try:
        _write_csv(os.path.join(prev_dir, "lives.csv"), HEADERS, prev)
        _write_csv(os.path.join(tmp, "lives.csv"), HEADERS, current)
        # `--init` を今日実行した体にする（していないと carry-rest は何もしない）
        with open(os.path.join(prev_dir, "lives.meta.json"), "w", encoding="utf-8") as f:
            json.dump({"taken_at": today.isoformat(), "rows": len(prev)}, f)
        if lineups is not None:
            _write_csv(os.path.join(tmp, "lineups.csv"),
                       EXPECTED_HEADERS["lineups.csv"], lineups)
        if dispositions:
            with open(os.path.join(prev_dir, "lives.dispositions.jsonl"),
                      "w", encoding="utf-8") as f:
                for d in dispositions:
                    f.write(json.dumps(d, ensure_ascii=False) + "\n")

        rows, _src = pr.load_prev("lives.csv")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            pr.cmd_carry_rest("lives.csv", rows, Args(today=today))
        carried = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]

        disp_path = os.path.join(prev_dir, "lives.dispositions.jsonl")
        recorded = []
        if os.path.exists(disp_path):
            with open(disp_path, encoding="utf-8") as f:
                recorded = [json.loads(l) for l in f if l.strip()]
        return carried, recorded
    finally:
        pr.DATA, pr.PREV = orig


def _uid(row):
    return pr.row_uid("lives.csv", row)


def _dispose(prev, stdin_lines, today=TODAY, dispositions=None):
    """一時ディレクトリで --dispose を回し、(returncode, stdout, stderr) を返す。

    `raise SystemExit(msg)` は argparse 由来の使用法エラーと区別せず、
    ここでは「メッセージを持つ SystemExit」として stderr 側に落とす。
    """
    tmp = tempfile.mkdtemp(prefix="prev_rows_test_")
    prev_dir = os.path.join(tmp, ".prev")
    os.makedirs(prev_dir, exist_ok=True)
    orig = (pr.DATA, pr.PREV)
    pr.DATA, pr.PREV = tmp, prev_dir
    try:
        _write_csv(os.path.join(prev_dir, "lives.csv"), HEADERS, prev)
        if dispositions:
            with open(os.path.join(prev_dir, "lives.dispositions.jsonl"),
                      "w", encoding="utf-8") as f:
                for d in dispositions:
                    f.write(json.dumps(d, ensure_ascii=False) + "\n")
        rows, _src = pr.load_prev("lives.csv")
        stdin = "\n".join(json.dumps(o, ensure_ascii=False) for o in stdin_lines) + "\n"
        out, err = io.StringIO(), io.StringIO()
        orig_stdin = sys.stdin
        sys.stdin = io.StringIO(stdin)
        code = 0
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    pr.cmd_dispose("lives.csv", rows, Args(today=today))
                except SystemExit as e:
                    code = 1
                    print(str(e.code if e.code is not None else ""), file=sys.stderr)
        finally:
            sys.stdin = orig_stdin
        return code, out.getvalue(), err.getvalue()
    finally:
        pr.DATA, pr.PREV = orig


CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


@check("今回すでに書かれている行には手を出さない")
def _():
    r = _row(title="書き直した公演")
    carried, disp = _carry_rest(prev=[r], current=[r])
    return (carried, disp) == ([], []) or f"carried={carried} disp={disp}"


@check("今回に無く、まだ終わっていない行は書き戻す")
def _():
    r = _row(title="未確認のまま残った公演", start_date="2026-09-20", end_date="2026-09-20")
    carried, disp = _carry_rest(prev=[r], current=[])
    if len(carried) != 1:
        return f"書き戻しが1件でない: {carried}"
    if carried[0]["title"] != "未確認のまま残った公演":
        return f"別の行が出た: {carried[0]}"
    return disp == [] or f"処分まで記録している: {disp}"


@check("書き戻す行の受付（onsale_* / limited_sale）は空にする")
def _():
    r = _row(title="受付つき公演", start_date="2026-09-20", end_date="2026-09-20",
             onsale_label="先着受付中", onsale_start="2026-08-01",
             onsale_start_time="10:00", onsale_end="2026-09-10",
             onsale_end_time="23:59", limited_sale="機材開放席あり",
             price="7,700円", price_checked="2026-08-19")
    carried, _ = _carry_rest(prev=[r], current=[])
    leaked = [c for c in pr.CARRY_REST_CLEAR if carried[0].get(c)]
    if leaked:
        return f"受付の値が残っている: {leaked}"
    # 価格は残す（price_checked が「いつ確認した値か」を示すため）
    if carried[0].get("price") != "7,700円":
        return f"価格まで消している: {carried[0].get('price')!r}"
    return True


@check("前回の note を持ち越しの目印で上書きしない")
def _():
    r = _row(title="注意書きつき公演", start_date="2026-09-20", end_date="2026-09-20",
             note="雨天決行・荒天中止")
    carried, _ = _carry_rest(prev=[r], current=[])
    # note はカードに「注意」バッジとして出る列。内部事情を書くと利用者に見える
    return carried[0].get("note") == "雨天決行・荒天中止" or f"上書きされた: {carried[0].get('note')!r}"


@check("今回に無く、終了日を過ぎた行は expired で処分し、書き戻さない")
def _():
    r = _row(title="終わった公演", start_date="2026-08-01", end_date="2026-08-20")
    carried, disp = _carry_rest(prev=[r], current=[])
    if carried:
        return f"終了した行を書き戻している: {carried}"
    if len(disp) != 1 or disp[0]["status"] != "expired":
        return f"expired の処分が記録されていない: {disp}"
    return disp[0]["uid"] == _uid(r) or f"uid が違う: {disp[0]}"


@check("すでに理由が記録されている行は二重に処分しない")
def _():
    r = _row(title="中止になった公演", start_date="2026-08-01", end_date="2026-08-20")
    prior = {"uid": _uid(r), "status": "cancelled", "title": "中止になった公演"}
    carried, disp = _carry_rest(prev=[r], current=[], dispositions=[prior])
    if carried:
        return f"処分済みの行を書き戻している: {carried}"
    if len(disp) != 1 or disp[0]["status"] != "cancelled":
        return f"既存の処分を上書き・追記している: {disp}"
    return True


@check("参照先を失った lineup_id は落として書き戻す")
def _():
    r = _row(title="フェス", start_date="2026-09-20", end_date="2026-09-21",
             lineup_id="somefes-2026")
    carried, _ = _carry_rest(prev=[r], current=[], lineups=[])
    if not carried:
        return "書き戻していない"
    if "lineup_id" in carried[0]:
        return f"lineup_id が残った: {carried[0]}"
    # 空にするだけでは append_rows.py の CARRY_ALWAYS が前回値で埋め直す
    if carried[0].get("_no_carry") != "lineup_id":
        return f"_no_carry で打ち消していない: {carried[0].get('_no_carry')!r}"
    return True


@check("日割りが残っている lineup_id は保つ")
def _():
    r = _row(title="フェス", start_date="2026-09-20", end_date="2026-09-21",
             lineup_id="somefes-2026")
    lineup = {"lineup_id": "somefes-2026", "date": "2026-09-20",
              "stage": "MAIN", "artist": "だれか"}
    carried, _ = _carry_rest(prev=[r], current=[], lineups=[lineup])
    if carried[0].get("lineup_id") != "somefes-2026":
        return f"落ちた: {carried[0]}"
    return "_no_carry" not in carried[0] or "不要な _no_carry が付いている"


@check("2回目は何もしない（書き戻した後に再実行しても増えない）")
def _():
    r = _row(title="持ち越した公演", start_date="2026-09-20", end_date="2026-09-20")
    carried, _ = _carry_rest(prev=[r], current=[])
    # 1回目の結果が今回のCSVに入った状態で、もう一度回す
    again, disp = _carry_rest(prev=[r], current=[r])
    if again:
        return f"同じ行を2回書き戻している: {again}"
    return disp == [] or f"処分が増えた: {disp}"


@check("今回 --init していないデータセットには触らない")
def _():
    r = _row(title="別の日のデータセット", start_date="2026-09-20", end_date="2026-09-20")
    tmp = tempfile.mkdtemp(prefix="prev_rows_test_")
    prev_dir = os.path.join(tmp, ".prev")
    os.makedirs(prev_dir, exist_ok=True)
    orig = (pr.DATA, pr.PREV)
    pr.DATA, pr.PREV = tmp, prev_dir
    try:
        _write_csv(os.path.join(prev_dir, "lives.csv"), HEADERS, [r])
        _write_csv(os.path.join(tmp, "lives.csv"), HEADERS, [])
        with open(os.path.join(prev_dir, "lives.meta.json"), "w", encoding="utf-8") as f:
            json.dump({"taken_at": "2026-08-19", "rows": 1}, f)   # 1週間前＝別の回
        rows, _src = pr.load_prev("lives.csv")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            pr.cmd_carry_rest("lives.csv", rows, Args())
        if out.getvalue().strip():
            return f"触っている: {out.getvalue()[:120]}"
        # --force なら動く
        out2 = io.StringIO()
        args = Args()
        args.force = True
        with contextlib.redirect_stdout(out2), contextlib.redirect_stderr(io.StringIO()):
            pr.cmd_carry_rest("lives.csv", rows, args)
        return bool(out2.getvalue().strip()) or "--force でも動かない"
    finally:
        pr.DATA, pr.PREV = orig


@check("持ち越した行は、翌週の棚卸しで tier A に戻る")
def _():
    # 受付欄を空にすると tier の根拠ごと消える。それを打ち消せているかを見る
    # （打ち消せていないと、確認できなかった行が「確認しなくてよい行」に見える）
    r = _row(title="持ち越した公演", start_date="2026-10-20", end_date="2026-10-20",
             onsale_label="先着受付中", onsale_start="2026-08-01",
             onsale_end="2026-09-10", price="7,700円", price_checked="2026-08-19")
    carried, _d = _carry_rest(prev=[r], current=[])
    if not carried:
        return "持ち越していない"
    tmp = tempfile.mkdtemp(prefix="prev_rows_test_")
    prev_dir = os.path.join(tmp, ".prev")
    os.makedirs(prev_dir, exist_ok=True)
    orig = (pr.DATA, pr.PREV)
    pr.DATA, pr.PREV = tmp, prev_dir
    try:
        _write_csv(os.path.join(prev_dir, "lives.csv"), HEADERS, [carried[0]])
        with open(pr.unverified_path("lives.csv"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"uid": _uid(carried[0]), "title": "持ち越した公演"},
                               ensure_ascii=False) + "\n")
        rows, _src = pr.load_prev("lives.csv")
        out = io.StringIO()
        args = Args(today=date(2026, 9, 3))
        with contextlib.redirect_stdout(out):
            pr.cmd_worklist("lives.csv", rows, args)
        line = [l for l in out.getvalue().splitlines() if "持ち越した公演" in l]
    finally:
        pr.DATA, pr.PREV = orig
    if not line:
        return "棚卸しに出ていない"
    tier = line[0].split("\t")[1]
    if tier != "A":
        return f"tier={tier}（受付欄を空にした副作用で優先度が落ちている）"
    return "前回は未確認のまま持ち越し" in line[0] or "理由が書かれていない"


@check("--worklist は終了日を過ぎた行を出さない")
def _():
    ended = _row(title="終わった公演", start_date="2026-08-01", end_date="2026-08-20")
    alive = _row(title="これからの公演", start_date="2026-09-20", end_date="2026-09-20")
    tmp = tempfile.mkdtemp(prefix="prev_rows_test_")
    prev_dir = os.path.join(tmp, ".prev")
    os.makedirs(prev_dir, exist_ok=True)
    orig = (pr.DATA, pr.PREV)
    pr.DATA, pr.PREV = tmp, prev_dir
    try:
        _write_csv(os.path.join(prev_dir, "lives.csv"), HEADERS, [ended, alive])
        rows, _src = pr.load_prev("lives.csv")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            pr.cmd_worklist("lives.csv", rows, Args())
        text = out.getvalue()
    finally:
        pr.DATA, pr.PREV = orig
    if "終わった公演" in text:
        return "終了した行が棚卸しに出ている"
    if "これからの公演" not in text:
        return "続いている行まで落ちている"
    return "終了日を過ぎた1件は一覧から除いてあります" in text or "除外の告知が無い"


@check("会期がまだ残っている行を ended で処分できない")
def _():
    r = _row(title="開催中のフェス", start_date="2026-08-28", end_date="2026-08-30")
    code, out, err = _dispose(prev=[r], stdin_lines=[
        {"uid": _uid(r), "status": "ended", "note": "終了確認"},
    ], today=date(2026, 8, 29))
    if code == 0:
        return f"通ってしまった: {out}"
    return "end_date" in err or f"期待したエラーが出ていない: {err}"


@check("終了日を過ぎた行は ended で処分できる")
def _():
    r = _row(title="終わった公演", start_date="2026-08-01", end_date="2026-08-20")
    code, out, err = _dispose(prev=[r], stdin_lines=[
        {"uid": _uid(r), "status": "ended", "note": "終了確認"},
    ], today=date(2026, 8, 29))
    return code == 0 or f"正当な ended まで拒否した: {err}"


@check("本日が予備日の行は、終了日を過ぎていても ended にできない")
def _():
    # 元の終了日は過ぎているが、本日(8/29)が予備日として登録されている
    # ＝雨天順延等でまだ今日開催されうる。is_ended() と同じくここでも「未終了」扱いにする
    r = _row(title="順延ありの公演", start_date="2026-08-25", end_date="2026-08-25",
             backup_date="2026-08-29")
    code, out, err = _dispose(prev=[r], stdin_lines=[
        {"uid": _uid(r), "status": "ended", "note": "終了確認"},
    ], today=date(2026, 8, 29))
    if code == 0:
        return f"予備日当日なのに ended が通ってしまった: {out}"
    return "backup_date" in err or f"期待したエラーが出ていない: {err}"


@check("日付を持たない行の ended は機械的に判定できないので拒否しない")
def _():
    r = _row(title="自由記述の公演", start_date="", end_date="", date="2026年秋ごろ")
    code, out, err = _dispose(prev=[r], stdin_lines=[
        {"uid": _uid(r), "status": "ended", "note": "終了確認"},
    ], today=date(2026, 8, 29))
    return code == 0 or f"判定不能な行まで拒否した: {err}"


@check("ended/notfound の一括処分には上限がある")
def _():
    rows = [_row(title=f"公演{i}", start_date="2026-08-01", end_date="2026-08-20")
            for i in range(pr.DISPOSE_BATCH_LIMIT + 1)]
    lines = [{"uid": _uid(r), "status": "notfound", "note": f"公演{i}確認できず"}
             for i, r in enumerate(rows)]
    code, out, err = _dispose(prev=rows, stdin_lines=lines, today=date(2026, 8, 29))
    if code == 0:
        return f"上限を超えても通ってしまった: {out}"
    return "carry-rest" in err or f"代替手段への案内が無い: {err}"


@check("上限以内なら ended/notfound をまとめて処分できる")
def _():
    rows = [_row(title=f"公演{i}", start_date="2026-08-01", end_date="2026-08-20")
            for i in range(pr.DISPOSE_BATCH_LIMIT)]
    lines = [{"uid": _uid(r), "status": "notfound", "note": f"公演{i}確認できず"}
             for i, r in enumerate(rows)]
    code, out, err = _dispose(prev=rows, stdin_lines=lines, today=date(2026, 8, 29))
    return code == 0 or f"上限以内なのに拒否された: {err}"


@check("cancelled/renamed 等は上限の対象外")
def _():
    rows = [_row(title=f"公演{i}", start_date="2026-08-01", end_date="2026-08-20")
            for i in range(pr.DISPOSE_BATCH_LIMIT + 2)]
    lines = [{"uid": _uid(r), "status": "cancelled", "note": f"公演{i}は台風のため中止"}
             for i, r in enumerate(rows)]
    code, out, err = _dispose(prev=rows, stdin_lines=lines, today=date(2026, 8, 29))
    return code == 0 or f"cancelled まで上限に引っかかった: {err}"


@check("似た定型文が並ぶと警告が出る（ブロックはしない）")
def _():
    rows = [_row(title=f"公演{i}", start_date="2026-08-01", end_date="2026-08-20")
            for i in range(4)]
    lines = [{"uid": _uid(r), "status": "notfound", "note": "詳細確認できず"}
             for r in rows]
    code, out, err = _dispose(prev=rows, stdin_lines=lines, today=date(2026, 8, 29))
    if code != 0:
        return f"警告のはずがブロックされた: {err}"
    return "WARNING" in err or f"似た理由文への警告が出ていない: {err}"


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
