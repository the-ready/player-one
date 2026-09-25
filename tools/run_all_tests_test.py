#!/usr/bin/env python3
"""`tools/run_all_tests.py` の判定を検証する（ネットワーク不要）。

    python3 tools/run_all_tests_test.py

## なぜここを固定するのか

このランナーは `investigate-routine.sh` の push ゲートである。**ゲートが素通しに
なる壊れ方は、落ちるより危険である**——調査ルーチンが main へ直接 push する設計な
ので、素通ししたゲートはそのまま未検証のコードを公開まで運ぶ。

そこで「通った」と答えてよい条件を機械的に固定する。特に、テストが1本も見つから
ない回（実行場所の取り違え）と、実行そのものができなかった回（node が無い等）を
成功として返さないことを見る。
"""

import contextlib
import io
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_all_tests as rat                                   # noqa: E402


def _sandbox(files):
    """偽のテストを並べた一時ディレクトリを作り、そのパスを返す。

    files は {ファイル名: 終了コード} の対応。
    """
    tmp = tempfile.mkdtemp(prefix="run_all_tests_test_")
    for name, code in files.items():
        path = os.path.join(tmp, name)
        if name.endswith(".py"):
            body = f"import sys\nsys.exit({code})\n"
        else:
            body = f"process.exit({code});\n"
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
    return tmp


def _run_main(argv):
    """main() を走らせて (終了コード, 標準出力) を返す。"""
    buf = io.StringIO()
    orig = sys.argv
    sys.argv = ["run_all_tests.py"] + argv
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            rc = rat.main()
    finally:
        sys.argv = orig
    return rc, buf.getvalue()


CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


@check("smoke_test.mjs は外す（HTTPサーバとブラウザが要るため）")
def _():
    if "smoke_test.mjs" not in rat.EXCLUDED:
        return f"EXCLUDED に入っていない: {rat.EXCLUDED}"
    orig = rat.TOOLS
    rat.TOOLS = _sandbox({"smoke_test.mjs": 0, "a_test.py": 0})
    try:
        names = [n for n, _ in rat.discover()]
    finally:
        rat.TOOLS = orig
    return names == ["a_test.py"] or f"拾い方が違う: {names}"


@check("*_test.py と *_test.mjs の両方を拾い、テストでないファイルは拾わない")
def _():
    orig = rat.TOOLS
    rat.TOOLS = _sandbox({"a_test.py": 0, "b_test.mjs": 0, "helper.py": 0})
    try:
        names = [n for n, _ in rat.discover()]
    finally:
        rat.TOOLS = orig
    return names == ["a_test.py", "b_test.mjs"] or f"拾い方が違う: {names}"


@check("1本でも落ちれば終了コードは1")
def _():
    orig = rat.TOOLS
    rat.TOOLS = _sandbox({"ok_test.py": 0, "ng_test.py": 1})
    try:
        rc, out = _run_main([])
    finally:
        rat.TOOLS = orig
    if rc != 1:
        return f"終了コードが1でない: {rc}"
    return "ng_test.py" in out or f"落ちたテスト名が出ていない: {out}"


@check("全部通れば終了コードは0")
def _():
    orig = rat.TOOLS
    rat.TOOLS = _sandbox({"a_test.py": 0, "b_test.py": 0})
    try:
        rc, _out = _run_main([])
    finally:
        rat.TOOLS = orig
    return rc == 0 or f"終了コードが0でない: {rc}"


@check("テストが0件なら失敗にする（ゲートを素通しさせない）")
def _():
    orig = rat.TOOLS
    rat.TOOLS = _sandbox({})
    try:
        rc, _out = _run_main([])
    finally:
        rat.TOOLS = orig
    return rc == 1 or f"0件を成功として返した: rc={rc}"


@check("実行そのものができなければ失敗にする（判定不能を通さない）")
def _():
    ok, out = rat.run_one("dummy", ["__no_such_command_for_test__"])
    if ok:
        return "存在しないコマンドを成功として返した"
    return "実行できません" in out or f"理由が出ていない: {out}"


@check("--with-data で validate_data.py が対象に加わる")
def _():
    orig = rat.TOOLS
    rat.TOOLS = _sandbox({"a_test.py": 0})
    try:
        _rc, out = _run_main(["--list", "--with-data"])
    finally:
        rat.TOOLS = orig
    return "validate_data.py" in out or f"加わっていない: {out}"


@check("--with-data を付けなければ validate_data.py は回さない")
def _():
    orig = rat.TOOLS
    rat.TOOLS = _sandbox({"a_test.py": 0})
    try:
        _rc, out = _run_main(["--list"])
    finally:
        rat.TOOLS = orig
    return "validate_data.py" not in out or f"既定で加わっている: {out}"


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
