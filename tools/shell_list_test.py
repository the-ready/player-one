#!/usr/bin/env python3
"""画面のモジュールを列挙している2つの一覧が、実際のファイルとずれていないかを検証する（ネットワーク不要）。

    python3 tools/shell_list_test.py

`assets/js/` のモジュールは、手で並べた一覧に2か所で載っている。

- `sw.js` の `SHELL` … オフラインでも開けるよう、Service Worker が先にキャッシュする。
  漏れたモジュールは、オフラインでは import に失敗し、画面ごと動かなくなる
- `index.html` の `<script type="module">` と `<link rel="modulepreload">` … import の段数ぶんの
  往復を待たずに、並行して取らせる。漏れても動くが、そのモジュールだけ初回表示が遅れる

どちらも漏れても手元の確認では気づけない（オンラインで、キャッシュも温まっているため）。
ここで、ディレクトリの中身と突き合わせて固定する。
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def main():
    failures = []

    def check(name, ok, detail=""):
        print(f"{'  ok  ' if ok else '  NG  '} {name}{('  — ' + detail) if detail else ''}")
        if not ok:
            failures.append(name)

    on_disk = sorted(f for f in os.listdir(os.path.join(ROOT, "assets/js")) if f.endswith(".js"))
    check("assets/js にモジュールがある", len(on_disk) > 0, f"{len(on_disk)}本")

    # --- sw.js の SHELL ---
    sw = read("sw.js")
    m = re.search(r"const SHELL = \[(.*?)\];", sw, re.S)
    check("sw.js に SHELL がある", m is not None)
    shell = re.findall(r'"\./([^"]*)"', m.group(1)) if m else []
    shell_js = sorted(os.path.basename(p) for p in shell if p.startswith("assets/js/"))
    check(
        "SHELL の assets/js がディレクトリと一致する",
        shell_js == on_disk,
        "" if shell_js == on_disk
        else f"不足 {sorted(set(on_disk) - set(shell_js))} / 余分 {sorted(set(shell_js) - set(on_disk))}",
    )
    check("SHELL に重複が無い", len(shell) == len(set(shell)))
    missing = [p for p in shell if p and not os.path.exists(os.path.join(ROOT, p))]
    check("SHELL のファイルがすべて実在する", not missing, f"{missing}" if missing else "")

    # --- index.html ---
    html = read("index.html")
    scripts = re.findall(r'<script type="module" src="assets/js/([^"]+)"', html)
    preloads = re.findall(r'<link rel="modulepreload" href="assets/js/([^"]+)"', html)
    listed = scripts + preloads
    check(
        "index.html の module script と modulepreload がディレクトリと一致する",
        sorted(listed) == on_disk,
        "" if sorted(listed) == on_disk
        else f"不足 {sorted(set(on_disk) - set(listed))} / 余分 {sorted(set(listed) - set(on_disk))}",
    )
    check("index.html に二重の指定が無い", len(listed) == len(set(listed)))

    print(f"\nNG {len(failures)}件: {', '.join(failures)}" if failures else "\nすべて通過")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
