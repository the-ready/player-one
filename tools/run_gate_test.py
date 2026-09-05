#!/usr/bin/env python3
"""`tools/run_gate.py` が、止めるべき回だけを止めるかを検証する（ネットワーク不要）。

    python3 tools/run_gate_test.py

## なぜ念入りにやるか

この門は `claude-routine.sh` の検証工程から走り、**落ちるとその週の収集が
コミットされない**（生成物は `.claude/logs/failed/` に退避され、data/ は HEAD に
戻る）。誤って止めれば、正しく調べた週を丸ごと捨てることになる。

固定したいのは線の値ではなく**倒し方**である。

  - 外を1回でも見た回は通す（取得だけ・検索だけでも通す）
  - 一度も見ていない回は止め、次に何をすべきかを stderr に書く
  - `--init` を通っていない回は止める。ただし対象が分からないときは見ない
  - **判定できないとき（記録が無い・古い）は通す**
"""

import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import budget                                                  # noqa: E402
import run_gate                                                # noqa: E402


def write_state(st):
    with open(budget.STATE, "w", encoding="utf-8") as f:
        json.dump(st, f)


def state(search=0, fetch=0, inits=(), age_sec=60):
    return {
        "started_at": time.time() - age_sec,
        "phase": "（未設定）",
        "phases": {},
        "totals": {"search": search, "fetch": fetch, "rows": 0, "blocked": 0, "waited": 0.0},
        "inits": list(inits),
    }


def check_fetched_passes():
    write_state(state(search=0, fetch=151, inits=["lives.csv"]))
    rc, _ = run_gate.check("lives.csv")
    return rc == 0 or f"取得151回の回を止めた: exit={rc}"


def check_searched_only_passes():
    write_state(state(search=12, fetch=0, inits=["lives.csv"]))
    rc, _ = run_gate.check("lives.csv")
    return rc == 0 or f"検索だけの回を止めた: exit={rc}"


def check_no_investigation_blocks():
    """2026-09-04 20:50 の回。検索0・取得0で、回収と終了工程だけを行った。"""
    write_state(state(search=0, fetch=0, inits=["lives.csv"]))
    rc, reasons = run_gate.check("lives.csv")
    if rc != 1:
        return f"検索0・取得0の回を通してしまった: exit={rc}"
    joined = "\n".join(reasons)
    return ("検索0回・取得0回" in joined) or f"理由が書かれていない: {joined!r}"


def check_missing_init_blocks():
    write_state(state(search=0, fetch=151, inits=[]))
    rc, reasons = run_gate.check("lives.csv")
    if rc != 1:
        return f"--init を通っていない回を通してしまった: exit={rc}"
    return ("--init" in "\n".join(reasons)) or "対処のコマンドが書かれていない"


def check_other_dataset_init_does_not_count():
    """movies を --init した回は、lives の開始点を通ったことにはならない。"""
    write_state(state(search=0, fetch=10, inits=["movies.csv"]))
    rc, _ = run_gate.check("lives.csv")
    return rc == 1 or f"別データセットの --init を流用してしまった: exit={rc}"


def check_unknown_dataset_skips_init_check():
    """対象が分からない回（対話的に手で叩いた等）では、--init を理由に止めない。"""
    write_state(state(search=0, fetch=10, inits=[]))
    rc, _ = run_gate.check(None)
    return rc == 0 or f"対象不明なのに --init を理由に止めた: exit={rc}"


def check_missing_state_passes():
    """**ここがいちばん大事。** 計測できないときに素通しにする。"""
    try:
        os.remove(budget.STATE)
    except OSError:
        pass
    rc, reasons = run_gate.check("lives.csv")
    if rc == 1:
        return "記録が無いことを理由に週の成果を捨てている（素通しにすべき）"
    if rc != 2:
        return f"判定不能は exit=2 のはずが exit={rc}"
    return bool(reasons) or "理由が書かれていない"


def check_stale_state_passes():
    """先週の記録が残っているだけの状態を、「今週は0回」と読み違えない。"""
    write_state(state(search=0, fetch=0, inits=[], age_sec=budget.STALE_SEC + 60))
    rc, _ = run_gate.check("lives.csv")
    return rc == 2 or f"古い記録で判定してしまった: exit={rc}"


def check_broken_state_passes():
    with open(budget.STATE, "w", encoding="utf-8") as f:
        f.write("{壊れたJSON")
    rc, _ = run_gate.check("lives.csv")
    return rc == 2 or f"壊れた記録で判定してしまった: exit={rc}"


def check_init_file_marks_and_resets():
    """`append_rows.py --init` が、数え直したあとに印を残すこと。

    **順序が逆だと、印は `budget.reset()` に消される。** そうなるとこの門は
    毎回「--init を通っていません」で落ち、正しく調べた週まで捨てることになる。
    実際に `init_file()` を呼んで、両方（カウンタが0・印が残る）を確かめる。
    """
    import csv as _csv
    import append_rows as ar
    import prev_rows as pr
    import roster as ro
    from validate_data import EXPECTED_HEADERS

    tmp = tempfile.mkdtemp(prefix="run_gate_test_init_")
    prev = os.path.join(tmp, ".prev")
    os.makedirs(prev, exist_ok=True)
    orig = (ar.DATA, pr.DATA, pr.PREV, ro.DATA)
    ar.DATA, pr.DATA, pr.PREV, ro.DATA = tmp, tmp, prev, tmp
    try:
        headers = EXPECTED_HEADERS["lives.csv"]
        path = os.path.join(tmp, "lives.csv")
        with open(path, "w", newline="", encoding="utf-8") as f:
            _csv.writer(f).writerow(headers)
        # 直前の実行が残っている状態を作る（reset() が消すべきもの）
        write_state(state(search=99, fetch=99, inits=["events.csv"]))
        import io as _io
        import contextlib as _ctx
        with _ctx.redirect_stdout(_io.StringIO()), _ctx.redirect_stderr(_io.StringIO()):
            ar.init_file("lives.csv", path, headers)
        st = run_gate.read_state()
        if st is None:
            return "--init のあとに実測が読めない"
        if st.get("totals", {}).get("fetch"):
            return f"--init が数え直していない: {st.get('totals')}"
        if "lives.csv" not in (st.get("inits") or []):
            return f"--init の印が残っていない（reset との順序が逆の可能性）: {st.get('inits')!r}"
        rc, _ = run_gate.check("lives.csv")
        # この時点では検索も取得も0なので、--init 以外の理由（調査0）で止まるのが正しい
        return rc == 1 or f"直後は「調査0」で止まるはずが exit={rc}"
    finally:
        ar.DATA, pr.DATA, pr.PREV, ro.DATA = orig
        shutil.rmtree(tmp, ignore_errors=True)


def check_resolve_ds_from_skill():
    orig = os.environ.get("ROUTINE_SKILL")
    os.environ["ROUTINE_SKILL"] = "kanto-movie-collector"
    try:
        got = run_gate.resolve_ds(None)
    finally:
        if orig is None:
            os.environ.pop("ROUTINE_SKILL", None)
        else:
            os.environ["ROUTINE_SKILL"] = orig
    return got == "movies.csv" or f"ROUTINE_SKILL から対象を決められない: {got!r}"


CHECKS = [
    ("取得した回は通す", check_fetched_passes),
    ("検索だけの回も通す", check_searched_only_passes),
    ("検索0・取得0の回は止め、次の行動を書く", check_no_investigation_blocks),
    ("--init を通っていない回は止める", check_missing_init_blocks),
    ("別データセットの --init は流用しない", check_other_dataset_init_does_not_count),
    ("対象が分からないときは --init を理由に止めない", check_unknown_dataset_skips_init_check),
    ("記録が無いときは通す", check_missing_state_passes),
    ("古い記録では判定しない", check_stale_state_passes),
    ("壊れた記録では判定しない", check_broken_state_passes),
    ("--init は数え直したあとに印を残す（順序）", check_init_file_marks_and_resets),
    ("ROUTINE_SKILL から対象を決める", check_resolve_ds_from_skill),
]


def main():
    tmp = tempfile.mkdtemp(prefix="run_gate_test_")
    orig = (budget.STATE_DIR, budget.STATE, budget.LOCK, budget.TOKEN_SAMPLE)
    budget.STATE_DIR = tmp
    budget.STATE = os.path.join(tmp, "budget.json")
    budget.LOCK = budget.STATE + ".lock"
    budget.TOKEN_SAMPLE = os.path.join(tmp, "token_sample.json")
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
        budget.STATE_DIR, budget.STATE, budget.LOCK, budget.TOKEN_SAMPLE = orig
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{len(CHECKS) - fails}/{len(CHECKS)} 件が期待どおり")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
