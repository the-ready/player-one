#!/usr/bin/env python3
"""`tools/close_run.py` が終了工程を正しく通し、落ちたものを落ちたと返すかを検証する
（ネットワーク不要。リポジトリの写しの上で回し、本物の data/ には触れない）。

    python3 tools/close_run_test.py

固定したいこと:
  - いまのデータ（検証の通る状態）なら終了コード0で「すべて通りました」
  - 検証が落ちる状態なら終了コード1で、落ちたコマンド名をまとめに出す
  - 差分・検証の出力を**切らない**（`[表記が変わった可能性]` が画面外に落ちた事故の再発防止。
    diff_data.py の出力を head/tail で切ってはいけない理由と同じ）
  - lives では festival_gate.py まで回す／events では回さない
"""

import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


def _copy_repo():
    tmp = tempfile.mkdtemp(prefix="close_run_test_")
    for d in ("tools", "data", "assets", ".claude"):
        src = os.path.join(ROOT, d)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(tmp, d), symlinks=True,
                            ignore=shutil.ignore_patterns("__pycache__", "logs", ".run"))
    # fill_apple_music.py はネットワークを引くので、写しでは何もしない版に差し替える
    with open(os.path.join(tmp, "tools", "fill_apple_music.py"), "w", encoding="utf-8") as f:
        f.write("print('（試験のため Apple Music の照会は省略）')\n")
    return tmp


def _run(tmp, *args):
    env = dict(os.environ)
    env.pop("CLAUDE_ROUTINE", None)
    r = subprocess.run([sys.executable, os.path.join(tmp, "tools", "close_run.py"), *args],
                       cwd=tmp, capture_output=True, text=True, env=env, timeout=300)
    return r.returncode, r.stdout + r.stderr


def _prepare_prev(tmp, ds):
    """前回スナップショットを「いまのCSVそのもの」にする（差分が消滅0になる状態）。"""
    prev = os.path.join(tmp, "data", ".prev")
    os.makedirs(prev, exist_ok=True)
    shutil.copy(os.path.join(tmp, "data", f"{ds}.csv"), os.path.join(prev, f"{ds}.csv"))


@check("events: 検証の通るデータなら exit 0 で、festival_gate は回さない")
def _():
    tmp = _copy_repo()
    try:
        _prepare_prev(tmp, "events")
        code, out = _run(tmp, "events", "--allow-short", "tokyo,kanagawa,saitama,chiba,ibaraki,other",
                         "--allow-thin", "price")
        if "festival_gate.py" in out:
            return "events で festival_gate.py を回している"
        for step in ("purge_ended.py", "roster.py spots --gc", "diff_data.py events",
                     "validate_data.py", "report_stats.py events --check"):
            if step not in out:
                return f"{step} を回していない"
        return (code == 0 and "すべて通りました" in out) or f"exit={code}\n{out[-1500:]}"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@check("lives: festival_gate.py まで回し、--allow を渡す")
def _():
    tmp = _copy_repo()
    try:
        _prepare_prev(tmp, "lives")
        code, out = _run(tmp, "lives", "--allow", "テスト用フェス")
        if "festival_gate.py --allow テスト用フェス" not in out:
            return f"festival_gate.py に --allow が渡っていない\n{out[-800:]}"
        return "roster.py festivals --gc" in out or "festivals の名簿を整理していない"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@check("検証が落ちる状態なら exit 1 で、落ちたコマンドをまとめに出す")
def _():
    tmp = _copy_repo()
    try:
        _prepare_prev(tmp, "movies")
        # ヘッダーを壊す（validate_data.py が必ず ERROR にする）
        path = os.path.join(tmp, "data", "movies.csv")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        with open(path, "w", encoding="utf-8") as f:
            f.write("broken_header," + text)
        code, out = _run(tmp, "movies")
        if code != 1:
            return f"壊れたデータで exit={code}"
        tail = out.split("===== まとめ =====")[-1]
        return "✗ validate_data.py" in tail or f"まとめに validate_data.py が出ていない\n{tail}"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@check("差分の出力を切らずに全部出す")
def _():
    tmp = _copy_repo()
    try:
        _prepare_prev(tmp, "events")
        direct = subprocess.run([sys.executable, "tools/diff_data.py", "events"], cwd=tmp,
                                capture_output=True, text=True).stdout.rstrip()
        _, out = _run(tmp, "events")
        return direct in out or "diff_data.py の出力の一部が欠けている"
    finally:
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
