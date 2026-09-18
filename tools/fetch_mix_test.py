#!/usr/bin/env python3
"""`tools/fetch_mix.py` が、偏った回に**1度だけ**催促するかを検証する（ネットワーク不要）。

    python3 tools/fetch_mix_test.py

## なぜ念入りにやるか

このゲートは取得を止める。止めすぎれば収集そのものが進まないので、
**1度だけ**であること、**`fetch_page.py` を1回でも使っていれば二度と鳴らない**ことを
固定する。線の値（10回）は動かしてよいが、この2つは動かしてはいけない。

あわせて、回が変われば数え直すこと（先週の内訳で今週を判定しない）も固定する。
"""

import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import budget                                                  # noqa: E402
import fetch_mix                                               # noqa: E402


def start_run(at=None):
    """`budget.json` を置いて「回」を作る。`fetch_mix` はここに紐づく。"""
    os.makedirs(budget.STATE_DIR, exist_ok=True)
    with open(budget.STATE, "w", encoding="utf-8") as f:
        json.dump({"started_at": at if at is not None else time.time(),
                   "phase": "（未設定）", "phases": {},
                   "totals": {"search": 0, "fetch": 0, "rows": 0, "blocked": 0, "waited": 0.0}}, f)


def webfetch(n):
    for _ in range(n):
        fetch_mix.bump("webfetch")


# --- 判定そのもの ---------------------------------------------------------

def check_below_floor_passes():
    rc, _ = fetch_mix.judge(webfetch=fetch_mix.WEBFETCH_FLOOR, page=0, warned=False)
    return rc == 0 or f"線ちょうどで止めた: exit={rc}"


def check_above_floor_blocks():
    rc, why = fetch_mix.judge(webfetch=fetch_mix.WEBFETCH_FLOOR + 1, page=0, warned=False)
    if rc != 1:
        return f"線を越えたのに通した: exit={rc}"
    return ("fetch_page.py" in why) or f"代替が書かれていない: {why!r}"


def check_any_fetch_page_silences():
    """**ここがいちばん大事。** 1回でも使っていれば、どれだけ偏っても鳴らない。"""
    rc, _ = fetch_mix.judge(webfetch=200, page=1, warned=False)
    return rc == 0 or f"fetch_page.py を使った回で鳴った: exit={rc}"


def check_warned_silences():
    rc, _ = fetch_mix.judge(webfetch=200, page=0, warned=True)
    return rc == 0 or f"催促済みなのに再び鳴った: exit={rc}"


# --- 数える・止める（記録つき） -------------------------------------------

def check_gate_fires_once():
    start_run()
    seen = []
    for _ in range(fetch_mix.WEBFETCH_FLOOR + 5):
        rc, _ = fetch_mix.gate(count_webfetch=True)
        seen.append(rc)
    if seen.count(1) != 1:
        return f"催促が1度だけになっていない: {seen}"
    return seen.index(1) == fetch_mix.WEBFETCH_FLOOR or \
        f"鳴る位置が違う（{seen.index(1)}回目）: {seen}"


def check_page_before_floor_prevents_firing():
    start_run()
    fetch_mix.bump("page")
    seen = [fetch_mix.gate(count_webfetch=True)[0] for _ in range(fetch_mix.WEBFETCH_FLOOR + 5)]
    return (1 not in seen) or f"fetch_page.py を使ったのに鳴った: {seen}"


def check_counts_survive_separate_processes():
    """計上と判定は別々のフック呼び出しから来る。記録に残ること。"""
    start_run()
    webfetch(3)
    d = fetch_mix.load()
    return d["webfetch"] == 3 or f"計上が残っていない: {d}"


def check_new_run_resets():
    """先週の内訳で今週を判定しない。"""
    start_run()
    webfetch(fetch_mix.WEBFETCH_FLOOR + 5)
    start_run(at=time.time() + 1)          # 回が変わった
    d = fetch_mix.load()
    if d["webfetch"] != 0:
        return f"回をまたいで数が残った: {d}"
    return d["warned"] is False or f"回をまたいで催促済みの印が残った: {d}"


def check_no_run_is_undecidable():
    """`budget.json` が無ければ判定しない（取得は止めない）。"""
    try:
        os.remove(budget.STATE)
    except OSError:
        pass
    if fetch_mix.load() is not None:
        return "回が無いのに内訳を作ってしまった"
    rc, _ = fetch_mix.gate(count_webfetch=True)
    return rc == 2 or f"判定不能は exit=2 のはずが exit={rc}"


def check_broken_state_is_undecidable():
    with open(budget.STATE, "w", encoding="utf-8") as f:
        f.write("{壊れたJSON")
    rc, _ = fetch_mix.gate(count_webfetch=True)
    return rc == 2 or f"壊れた記録で判定してしまった: exit={rc}"


def check_broken_mix_file_recovers():
    """自分の記録が壊れていても、数え直して続ける。"""
    start_run()
    with open(fetch_mix.STATE, "w", encoding="utf-8") as f:
        f.write("{壊れたJSON")
    fetch_mix.bump("webfetch")
    d = fetch_mix.load()
    return d["webfetch"] == 1 or f"壊れた記録から回復できていない: {d}"


def check_bump_rejects_unknown_kind():
    start_run()
    fetch_mix.bump("その他")
    d = fetch_mix.load()
    return (d["webfetch"] == 0 and d["page"] == 0) or f"知らない種別を数えた: {d}"


CHECKS = [
    ("線ちょうどでは鳴らない", check_below_floor_passes),
    ("線を越えたら鳴り、代替を出す", check_above_floor_blocks),
    ("fetch_page.py を1回でも使えば鳴らない", check_any_fetch_page_silences),
    ("催促は繰り返さない", check_warned_silences),
    ("実際の呼び出しでも催促は1度だけ", check_gate_fires_once),
    ("先に fetch_page.py を使えば一度も鳴らない", check_page_before_floor_prevents_firing),
    ("計上は記録に残る", check_counts_survive_separate_processes),
    ("回が変われば数え直す", check_new_run_resets),
    ("回が無ければ判定しない", check_no_run_is_undecidable),
    ("壊れた budget.json では判定しない", check_broken_state_is_undecidable),
    ("自分の記録が壊れても回復する", check_broken_mix_file_recovers),
    ("知らない種別は数えない", check_bump_rejects_unknown_kind),
]


def main():
    tmp = tempfile.mkdtemp(prefix="fetch_mix_test_")
    orig_budget = (budget.STATE_DIR, budget.STATE, budget.LOCK, budget.TOKEN_SAMPLE)
    orig_mix = (fetch_mix.STATE, fetch_mix.LOCK)
    budget.STATE_DIR = tmp
    budget.STATE = os.path.join(tmp, "budget.json")
    budget.LOCK = budget.STATE + ".lock"
    budget.TOKEN_SAMPLE = os.path.join(tmp, "token_sample.json")
    fetch_mix.STATE = os.path.join(tmp, "fetch_mix.json")
    fetch_mix.LOCK = fetch_mix.STATE + ".lock"

    fails = 0
    try:
        for name, fn in CHECKS:
            try:
                got = fn()
            except Exception as e:                            # noqa: BLE001
                got = f"{type(e).__name__}: {e}"
            if got is not True:
                print(f"✗ {name}\n    {got}")
                fails += 1
    finally:
        budget.STATE_DIR, budget.STATE, budget.LOCK, budget.TOKEN_SAMPLE = orig_budget
        fetch_mix.STATE, fetch_mix.LOCK = orig_mix
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{len(CHECKS) - fails}/{len(CHECKS)} 件が期待どおり")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
