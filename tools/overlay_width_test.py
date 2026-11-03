#!/usr/bin/env python3
"""画面に浮かせる部品（toast など）が、短い一文を不自然に折り返さないことの静的な検査。

`position: fixed|absolute` の要素に `left: 50%`（と `translateX(-50%)`）で中央寄せを掛け、
`width` を指定しないと、幅は「残りの右半分」に収まるよう縮む（shrink-to-fit）。`max-width` は
縮める上限でしかないので、「行きたいリストに追加しました」のような短い文でも画面の半分で
折り返し、2行に割れて見える。`width: max-content`（または明示の width）が要る。

見た目はブラウザでしか確かめられないので、ここでは原因になる書き方そのものを CSS から探す。
新しく浮かせる部品を足すときにこの形を書くと落ちる。

使い方（リポジトリのルートから）:
    python3 tools/overlay_width_test.py
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS = os.path.join(ROOT, "assets", "app.css")

# 幅が中身の文ではなく、記号やピンの大きさで決まるもの（文を持たない）。理由つきで除外する。
EXEMPT = {
    ".ring-circle": "円。width は --ring-size で決める",
    ".ring-pin": "地図のピン（svg）。文を持たない",
}


def blocks(css):
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        yield m.group(1).strip(), m.group(2)


def has_prop(body, name):
    return re.search(rf"(^|[;\s]){name}\s*:", body) is not None


def main():
    css = open(CSS, encoding="utf-8").read()
    bad, checked = [], 0
    for sel, body in blocks(css):
        if not re.search(r"position\s*:\s*(fixed|absolute)", body):
            continue
        if not re.search(r"(^|[;\s])left\s*:\s*50%", body):
            continue
        # 中央寄せ（左を 50% にして半分戻す）の形だけを見る
        if not re.search(r"translate(X)?\(\s*-50%", body):
            continue
        checked += 1
        name = " ".join(sel.split())
        if name in EXEMPT:
            continue
        w = re.search(r"(^|[;\s])width\s*:\s*([^;]+)", body)
        if not w:
            bad.append(f"{name}: left:50% の中央寄せなのに width が無い（残りの右半分で折り返す）")
        elif "auto" in w.group(2):
            bad.append(f"{name}: width:auto では縮む。max-content か明示の幅にする")

    print(f"  中央寄せの浮かせ部品: {checked}件を検査")
    if checked < 3:
        bad.append(f"検査対象が{checked}件しかない（.toast / .fav-toast / .map-loading を見つけられていない）")
    for b in bad:
        print("  NG ", b)
    if not bad:
        print("  ok  すべての中央寄せの部品が、中身の長さか明示の幅を持つ")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
