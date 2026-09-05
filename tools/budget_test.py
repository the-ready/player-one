#!/usr/bin/env python3
"""`tools/budget.py --gate` / `--gate-fetch` が、止めるべきものだけを止めるかを検証する
（ネットワーク不要）。

    python3 tools/budget_test.py

## なぜ念入りにやるか

`--gate` は `PreToolUse(Agent)` から、`--gate-fetch` は `PreToolUse(WebSearch/Bash)`
から自動で走り、どちらも**サブエージェントの取得を拒否できる**。`wave_gate.py` と
同じ位置にあり、同じ危うさを持つ——誤って止めれば収集が進まないまま利用上限まで空転する。

線そのもの（25M / 40M）の値は実測の警告線でしかなく、ここで固定したいのはその値ではない。
固定するのは**倒し方**である。

  - 線に届いていなければ通す
  - 線を越えたら止め、次に何をすべきかを stderr に書く（フックはこれをそのまま Claude に返す）
  - **判定できないときは通す。** 計測できないことを理由に収集を止めると、被害のほうが大きい

`--gate` と `--gate-fetch` の違いは1点だけである。`--gate` は25M（新しい波を止める）と
40M（撤退）の2段だが、`--gate-fetch` は**40Mだけ**を見る——25M〜40Mの間は「動いている波は
受け取って書き切る」設計なので、波の途中の取得まで止めると波を書き切れなくなる。
"""

import contextlib
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import budget                                                 # noqa: E402


def run_gate(cache_read):
    """`token_usage()` を差し替えて `gate()` を呼び、終了コードと stderr を返す。

    セッションの記録（`~/.claude/projects/.../*.jsonl`）を作って読ませる方式は採らない。
    あの形式は Claude Code 側の都合で変わりうるもので、ここで確かめたいのは
    「読めた数字をどう扱うか」だけである。
    """
    orig = budget.token_usage
    budget.token_usage = lambda: (None if cache_read is None
                                  else {"total": {"cache_read": cache_read}})
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            rc = budget.gate()
    finally:
        budget.token_usage = orig
    return rc, err.getvalue()


def check_under_line_passes():
    rc, err = run_gate(budget.CACHE_READ_NO_NEW_WAVE - 1)
    if rc != 0:
        return f"線の手前なのに exit={rc}"
    return err == "" or f"線の手前で何か出力している: {err!r}"


def check_zero_passes():
    rc, _ = run_gate(0)
    return rc == 0 or f"消費0なのに exit={rc}"


def check_no_new_wave_blocks():
    rc, err = run_gate(budget.CACHE_READ_NO_NEW_WAVE)
    if rc != 1:
        return f"25M ちょうどで止まらなかった: exit={rc}"
    # 何をすべきかが書かれていること（フックの reason がそのまま指示になる）
    return "append_rows.py" in err or f"次の行動が書かれていない: {err!r}"


def check_retreat_blocks_with_retreat_wording():
    rc, err = run_gate(budget.CACHE_READ_RETREAT)
    if rc != 1:
        return f"40M で止まらなかった: exit={rc}"
    if "撤退" not in err:
        return f"撤退の指示になっていない: {err!r}"
    # 25M と 40M で言うことが違わないと、線を2段に分けた意味が無い
    _, mild = run_gate(budget.CACHE_READ_NO_NEW_WAVE)
    return mild != err or "25M と 40M で同じ文言を返している"


def check_unmeasurable_passes():
    """**ここがいちばん大事。** 計測できないときに素通しにする。"""
    rc, err = run_gate(None)
    if rc == 1:
        return "計測できないことを理由に起動を拒否している（素通しにすべき）"
    if rc != 2:
        return f"判定不能は exit=2 のはずが exit={rc}"
    return err.strip() != "" or "理由が書かれていない"


# ---------------------------------------------------------- gate_fetch()
#
# `gate()` が「次の波を投げてよいか」（PreToolUse:Agent）を見るのに対し、
# `gate_fetch()` は「波の途中の1回の取得をしてよいか」（PreToolUse:WebSearch/Bash）
# を見る。2026-09-04 は最初の波そのものが40Mを越えて殺され、`gate()` の門が
# 一度も開く機会を持たなかった（`gate_fetch()` の docstring）。線は撤退（40M）
# だけを見て、25M〜40Mの間（「動いている波は受け取って書き切る」区間）は
# 取得を止めない——`gate()` との違いはここに集約されるので、そこを固定する。

def run_gate_fetch(cache_read):
    orig = budget.token_usage
    budget.token_usage = lambda: (None if cache_read is None
                                  else {"total": {"cache_read": cache_read}})
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            rc = budget.gate_fetch()
    finally:
        budget.token_usage = orig
    return rc, err.getvalue()


def check_fetch_under_retreat_passes():
    rc, err = run_gate_fetch(budget.CACHE_READ_RETREAT - 1)
    if rc != 0:
        return f"撤退線の手前なのに exit={rc}"
    return err == "" or f"線の手前で何か出力している: {err!r}"


def check_fetch_between_no_new_wave_and_retreat_passes():
    """**`gate()` との違いの核心。** 25M〜40Mでは「動いている波は書き切る」ので、
    `gate()` は止めても `gate_fetch()` は止めてはいけない。
    """
    cr = (budget.CACHE_READ_NO_NEW_WAVE + budget.CACHE_READ_RETREAT) // 2
    rc, err = run_gate_fetch(cr)
    if rc != 0:
        return f"25M〜40Mの間は取得を止めないはずが exit={rc}（err={err!r}）"
    return True


def check_fetch_retreat_blocks():
    rc, err = run_gate_fetch(budget.CACHE_READ_RETREAT)
    if rc != 1:
        return f"40M ちょうどで止まらなかった: exit={rc}"
    return ("波の途中でも" in err and "temp/rows-" in err) or f"次の行動が書かれていない: {err!r}"


def check_fetch_unmeasurable_passes():
    rc, err = run_gate_fetch(None)
    if rc == 1:
        return "計測できないことを理由に取得を拒否している（素通しにすべき）"
    if rc != 2:
        return f"判定不能は exit=2 のはずが exit={rc}"
    return err.strip() != "" or "理由が書かれていない"


CHECKS = [
    ("線の手前は通す", check_under_line_passes),
    ("消費0は通す", check_zero_passes),
    ("25Mで止め、次の行動を書く", check_no_new_wave_blocks),
    ("40Mは撤退の文言で止める", check_retreat_blocks_with_retreat_wording),
    ("判定できないときは通す", check_unmeasurable_passes),
    ("gate_fetch: 撤退線の手前は通す", check_fetch_under_retreat_passes),
    ("gate_fetch: 25M〜40Mは取得を止めない（波を書き切る猶予）", check_fetch_between_no_new_wave_and_retreat_passes),
    ("gate_fetch: 40Mで波の途中でも取得を止める", check_fetch_retreat_blocks),
    ("gate_fetch: 判定できないときは通す", check_fetch_unmeasurable_passes),
]


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
