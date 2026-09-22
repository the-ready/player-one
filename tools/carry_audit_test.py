#!/usr/bin/env python3
"""`tools/carry_audit.py` の4条件を固定する（ネットワーク不要）。

    python3 tools/carry_audit_test.py

この判定は**正しい仕事を捏造と呼びかねない**側の道具である。1〜3の条件
（持ち越しが多い・`price_checked` が実行日・波が大きい）は、正しい再確認でも
そのまま成立する。区別しているのは4つめ（取得回数が会場数に足りない）だけなので、
**4を落としたら誤検知の道具になる**。ここではその1点を中心に固定する。

判定を左右する数字のうち「取得回数」は `budget.py` の状態ファイルから来るので、
テストは一時ディレクトリに状態を作って差し替える。
"""

import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import budget                                                 # noqa: E402
import carry_audit as ca                                      # noqa: E402

TODAY = "2026-09-06"
CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


def _rows(n, *, carry="*", checked=TODAY, venues=None):
    """n件の行。既定は 2026-09-06 に破棄された波と同じ形（持ち越し100%・確認日=実行日）。"""
    venues = venues or [f"会場{i}" for i in range(n)]
    out = []
    for i in range(n):
        r = {"title": f"催し{i}", "venue": venues[i % len(venues)],
             "start_date": "2026-09-01", "end_date": "2026-12-31"}
        if carry is not None:
            r["_carry"] = carry
        if checked is not None:
            r["price_checked"] = checked
        out.append(r)
    return out


def _with_fetch(total, mark=0):
    """取得回数 total・前回追記時点 mark の予算状態を用意して、audit を回せるようにする。"""
    tmp = tempfile.mkdtemp(prefix="carry_audit_test_")
    orig_dir, orig_state, orig_lock = budget.STATE_DIR, budget.STATE, budget.LOCK
    budget.STATE_DIR = tmp
    budget.STATE = os.path.join(tmp, "budget.json")
    budget.LOCK = budget.STATE + ".lock"
    st = {"started_at": time.time(), "phase": "テスト", "phases": {},
          "totals": {"search": 0, "fetch": total, "rows": 0, "blocked": 0},
          ca.FETCH_MARK: mark}
    with open(budget.STATE, "w", encoding="utf-8") as f:
        json.dump(st, f)

    def restore():
        budget.STATE_DIR, budget.STATE, budget.LOCK = orig_dir, orig_state, orig_lock
        shutil.rmtree(tmp, ignore_errors=True)
    return restore


def _audit(rows, total, mark=0, name="events.csv"):
    restore = _with_fetch(total, mark)
    try:
        return ca.audit(name, rows, today=TODAY)
    finally:
        restore()


@check("2026-09-06 の波と同じ形を挙げる（92件・持ち越し100%・確認日=実行日・取得が会場数に足りない）")
def _():
    rows = _rows(92, venues=[f"施設{i}" for i in range(72)])
    got = _audit(rows, total=44)
    return (got is not None and "前回CSVの再出力" in got) or f"挙がりませんでした: {got}"


@check("取得回数が会場数に足りていれば挙げない（本当に再確認した波）")
def _():
    rows = _rows(92, venues=[f"施設{i}" for i in range(72)])
    got = _audit(rows, total=80)
    return got is None or f"正しい波を挙げました: {got}"


@check("取得回数は前回の追記からの差分で見る（累計ではない）")
def _():
    # 累計150回でも、前回の追記時点が140回なら、この波で使ったのは10回しかない。
    # 累計で見ると波を重ねるほど「足りている」に倒れて、後半の波を素通りさせる。
    rows = _rows(92, venues=[f"施設{i}" for i in range(72)])
    got = _audit(rows, total=150, mark=140)
    return (got is not None and "10回" in got) or f"差分で見ていません: {got}"


@check("持ち越しが少なければ挙げない（新規発見が主体の波）")
def _():
    rows = _rows(92, venues=[f"施設{i}" for i in range(72)])
    for r in rows[:40]:
        r.pop("_carry")
    got = _audit(rows, total=10)
    return got is None or f"新規主体の波を挙げました: {got}"


@check("列名を並べた _carry は数えない（どこを持ち越すか選んだ＝中身を見た形跡）")
def _():
    rows = _rows(92, carry="desc|lat|lng", venues=[f"施設{i}" for i in range(72)])
    got = _audit(rows, total=10)
    return got is None or f"列指定の持ち越しを挙げました: {got}"


@check("price_checked が実行日でなければ挙げない（前回値のままなのは正直な持ち越し）")
def _():
    rows = _rows(92, checked="2026-08-22", venues=[f"施設{i}" for i in range(72)])
    got = _audit(rows, total=10)
    return got is None or f"前回の確認日を挙げました: {got}"


@check("小さい波では判定しない（割合が揺れる）")
def _():
    rows = _rows(19, venues=[f"施設{i}" for i in range(19)])
    got = _audit(rows, total=5)
    return got is None or f"19件の波を挙げました: {got}"


@check("price_checked を持たない lives では判定しない")
def _():
    rows = _rows(92, checked=None, venues=[f"会場{i}" for i in range(72)])
    got = _audit(rows, total=5, name="lives.csv")
    return got is None or f"lives を挙げました: {got}"


@check("会場が1つに集中している波は挙げない（1会場なら取得1回で全行が正しい）")
def _():
    rows = _rows(92, venues=["東京都美術館"])
    got = _audit(rows, total=1)
    return got is None or f"単一会場の波を挙げました: {got}"


@check("判定しても止めない（返すのは文字列だけで、例外を投げない）")
def _():
    rows = _rows(92, venues=[f"施設{i}" for i in range(72)])
    got = _audit(rows, total=44)
    return isinstance(got, str) or f"文字列ではありません: {type(got)}"


@check("カウンタが1つも動いていなければ判定しない（計測が立ち上がっていない回）")
def _():
    # 「計測できない」を「取得0回」と読むと、計測が効いていない回のすべての波が
    # 疑われる。判定できないときは通す（budget.py --gate と同じ倒し方）。
    rows = _rows(92, venues=[f"施設{i}" for i in range(72)])
    got = _audit(rows, total=0)
    return got is None or f"未計測の回を挙げました: {got}"


@check("次の波のために、いまの取得回数を覚える")
def _():
    restore = _with_fetch(total=44, mark=0)
    try:
        ca.audit("events.csv", _rows(92, venues=[f"施設{i}" for i in range(72)]), today=TODAY)
        st = json.load(open(budget.STATE, encoding="utf-8"))
        return st.get(ca.FETCH_MARK) == 44 or f"記録されていません: {st.get(ca.FETCH_MARK)}"
    finally:
        restore()


@check("予算の状態が壊れていても例外を外に出さない（追記の付随処理であるため）")
def _():
    tmp = tempfile.mkdtemp(prefix="carry_audit_broken_")
    orig = budget.STATE_DIR, budget.STATE, budget.LOCK
    budget.STATE_DIR = tmp
    budget.STATE = os.path.join(tmp, "budget.json")
    budget.LOCK = budget.STATE + ".lock"
    with open(budget.STATE, "w", encoding="utf-8") as f:
        f.write("{壊れている")
    try:
        got = ca.audit("events.csv", _rows(92), today=TODAY)
        return got is None or f"壊れた状態で判定しました: {got}"
    finally:
        budget.STATE_DIR, budget.STATE, budget.LOCK = orig
        shutil.rmtree(tmp, ignore_errors=True)


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
