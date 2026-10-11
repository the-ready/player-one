#!/usr/bin/env python3
"""`.github/workflows/` の部品が、タグではなくコミットの SHA で固定されているかを検証する
（ネットワーク不要）。

    python3 tools/workflow_pins_test.py

## なぜ要るのか

`actions/checkout@v4` のようなタグは、部品の作者が後から別のコミットへ付け替えられる。
作者のアカウントが乗っ取られると、**次の実行から中身の違う部品が動く**（2025年3月の
tj-actions/changed-files で実際に起きた。タグが書き換えられ、実行ログに秘密が出された）。

このリポジトリでは、weekly-collect・routine-investigate・routine-repair が Pi の上で、
main へ push できるトークンを持って動く。部品が差し替えられると、Pi の上で知らない
コードが動き、公開サイトも書き換えられる。40桁の SHA で固定すれば、固定した中身のまま動く。

固定したいこと:
  - 外の部品の `uses:` は、すべて `owner/repo@<40桁のSHA>` で書く
  - 版がわかるよう、行末に `# vX.Y.Z` の注記を付ける（Dependabot もこの注記を書き換える）
  - Dependabot が github-actions を見張っている（固定したままだと更新が止まるため）
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF_DIR = os.path.join(ROOT, ".github", "workflows")
DEPENDABOT = os.path.join(ROOT, ".github", "dependabot.yml")
USES = re.compile(r"^\s*(?:-\s*)?uses:\s*(\S+)(.*)$")
PINNED = re.compile(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}")
CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


def _uses():
    """(ファイル名, 部品, 行の残り) を返す。同じリポジトリの部品（./ 始まり）は除く。"""
    out = []
    for name in sorted(os.listdir(WF_DIR)):
        if not name.endswith((".yml", ".yaml")):
            continue
        with open(os.path.join(WF_DIR, name), encoding="utf-8") as f:
            for line in f:
                m = USES.match(line)
                if m and not m.group(1).startswith("./"):
                    out.append((name, m.group(1), m.group(2)))
    return out


@check("外の部品はすべてコミットのSHAで固定する")
def _():
    found = _uses()
    if not found:
        return "uses: が1つも見つからない（読み方が壊れている）"
    bad = [f"{n}: {ref}" for n, ref, _ in found if not PINNED.fullmatch(ref)]
    return not bad or "SHA で固定していない: " + ", ".join(bad)


@check("固定した行には版の注記がある")
def _():
    bad = [f"{n}: {ref}" for n, ref, rest in _uses() if not re.search(r"#\s*v\d", rest)]
    return not bad or "版の注記（# vX.Y.Z）が無い: " + ", ".join(bad)


@check("同じ部品は同じSHAにそろっている")
def _():
    seen = {}
    for n, ref, _ in _uses():
        repo, _, sha = ref.partition("@")
        seen.setdefault(repo, set()).add(sha)
    bad = [repo for repo, shas in seen.items() if len(shas) > 1]
    return not bad or "ファイルごとに版がずれている: " + ", ".join(bad)


@check("Dependabot が github-actions を見張る")
def _():
    if not os.path.exists(DEPENDABOT):
        return ".github/dependabot.yml が無い"
    with open(DEPENDABOT, encoding="utf-8") as f:
        text = f.read()
    # PyYAML に頼らない（このリポジトリのテストは標準ライブラリだけで回る）
    if not re.search(r"^\s*-\s*package-ecosystem:\s*github-actions\s*$", text, re.M):
        return "package-ecosystem: github-actions が無い"
    return re.search(r"^\s*directory:\s*/\s*$", text, re.M) is not None or "directory: / が無い"


@check("崩れた書き方を見逃さない（判定そのものの確認）")
def _():
    cases = {
        "actions/checkout@v4": False,
        "actions/checkout@main": False,
        "actions/checkout@11d5960": False,
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262": True,
        "actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa": True,
    }
    bad = [ref for ref, ok in cases.items() if bool(PINNED.fullmatch(ref)) != ok]
    return not bad or "判定が期待と違う: " + ", ".join(bad)


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
