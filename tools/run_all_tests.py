#!/usr/bin/env python3
"""`tools/` のテストを一括で回す（ネットワーク不要）。

    python3 tools/run_all_tests.py            # 全テスト
    python3 tools/run_all_tests.py --list     # 回す対象を並べるだけ
    python3 tools/run_all_tests.py --with-data  # validate_data.py も併せて回す

## なぜ一覧を持たず自動検出にするか

`CLAUDE.md` はテストのコマンドを列挙しているが、実際には `diff_data_test.py` と
`festival_gate_test.py` が漏れていた。**一覧を持つと、テストを足した回に一覧を
書き換え忘れるという、このリポジトリが列の同期で何度も踏んだ形の穴が開く。**
`tools/*_test.py` と `tools/*_test.mjs` を実行時に拾えば、新しいテストは置いた
時点で自動的にゲートの一部になる。

## なぜ validate_data.py を既定で回さないか

このランナーの第一の用途は `investigate-routine.sh` の push ゲートであり、
そこで検証したいのは**コード**である。`validate_data.py` は `data/` の中身を見る
検査なので、収集が失敗して `data/` が壊れたまま残っている回では失敗する——
そのとき止まるのは「壊れたデータ」ではなく「コードの修正を push すること」で、
直したい相手と違うものを止めてしまう。調査ルーチンは `data/` を書き換えない
（スクリプト側が差分に `data/` が含まれる回を拒否する）ので、切り離してよい。

対話で「変更したときに最低限やること」をまとめて済ませたい場合のために
`--with-data` を用意してある。

## なぜ smoke_test.mjs を外すか

`python3 -m http.server` と playwright / Chromium が要る（`tools/smoke_test.mjs`
の冒頭に使い方がある）。無人実行の依存に入れると、画面と無関係な修正でも
サーバの起動具合でゲートの結果が揺れる。
"""

import argparse
import os
import subprocess
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(TOOLS)

# 実行に外部の環境（HTTPサーバ・ブラウザ）が要るものだけを名指しで外す。
EXCLUDED = {"smoke_test.mjs"}

# 1本あたりの上限。CLAUDE.md の言うとおり実際は1秒未満だが、無人実行で
# 固まったテストがジョブ全体を抱えたまま居座るのを防ぐ。
PER_TEST_TIMEOUT_SEC = 120


def discover():
    """回すテストを (表示名, コマンド) の並びで返す。名前順で安定させる。"""
    found = []
    for name in sorted(os.listdir(TOOLS)):
        if name in EXCLUDED:
            continue
        path = os.path.join(TOOLS, name)
        if name.endswith("_test.py"):
            found.append((name, [sys.executable, path]))
        elif name.endswith("_test.mjs"):
            found.append((name, ["node", path]))
    return found


def run_one(name, cmd):
    """1本走らせて (通ったか, 出力) を返す。

    実行そのものができなかった場合（node が無い等）も失敗として扱う。
    push のゲートとして使う以上、「検査できなかった」は「通った」ではない
    ——`block-git.sh` が判定不能を拒否側に倒しているのと同じ考え方である。
    """
    try:
        p = subprocess.run(
            cmd,
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=PER_TEST_TIMEOUT_SEC,
        )
    except FileNotFoundError as e:
        return False, f"実行できません（{type(e).__name__}: {e}）"
    except subprocess.TimeoutExpired:
        return False, f"{PER_TEST_TIMEOUT_SEC}秒を超えても終わりませんでした"
    out = (p.stdout or "") + (p.stderr or "")
    return p.returncode == 0, out.strip()


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--list", action="store_true", help="回す対象を並べるだけ")
    ap.add_argument("--with-data", action="store_true",
                    help="validate_data.py も併せて回す")
    args = ap.parse_args()

    targets = discover()
    if args.with_data:
        targets.append(("validate_data.py",
                        [sys.executable, os.path.join(TOOLS, "validate_data.py")]))

    if args.list:
        for name, _ in targets:
            print(name)
        return 0

    if not targets:
        # テストが1本も見つからないのは、実行場所を取り違えているとき。
        # 「0件すべて通った」を成功として返すと、ゲートが素通しになる。
        print("ERROR: テストが1本も見つかりません", file=sys.stderr)
        return 1

    fails = []
    for name, cmd in targets:
        ok, out = run_one(name, cmd)
        if ok:
            print(f"✓ {name}")
        else:
            print(f"✗ {name}")
            if out:
                print("    " + out.replace("\n", "\n    "))
            fails.append(name)

    print(f"\n{len(targets) - len(fails)}/{len(targets)} 件が通りました")
    if fails:
        print("落ちたテスト: " + " ".join(fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
