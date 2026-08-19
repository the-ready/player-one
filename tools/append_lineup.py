#!/usr/bin/env python3
"""フェスの日割りラインナップ（`data/lineups.csv`）を書き出す（設計書 第12.12節）。

## なぜ専用のツールなのか

`append_rows.py` は本体3ファイル用で、`id` の採番・前回値の持ち越し・uid での
突き合わせを持つ。ラインナップにはそのどれも要らない——このファイルは
「どの日に誰が出るか」を公式の発表からそのまま写すだけで、**前回値を持ち越して
よい列が1つも無い**（出演者は追加され、キャンセルされ、日割りは後から確定する。
持ち越しは、いなくなったアーティストを載せ続ける仕組みになる）。

代わりにこのツールは、手でCSVを書くときに必ず起きる事故を引き受ける。

  - 引用符とカンマのエスケープ（アーティスト名に「,」も「"」も実際に入る）
  - 列の順序と列名
  - `lives.csv` に無い `lineup_id` を書いてしまうこと（＝永久に表示されない行）

## 使い方

    # 書き始める前に1回。lineups.csv をヘッダーだけにする
    python3 tools/append_lineup.py --init

    # フェス1本ぶんを、公式の並び順のままJSONLで流し込む
    python3 tools/append_lineup.py <<'EOF'
    {"lineup_id":"luckyfes-2026","date":"2026-08-08","stage":"RAINBOW STAGE","artist":"TUBE","is_headliner":"1"}
    {"lineup_id":"luckyfes-2026","date":"2026-08-08","stage":"RAINBOW STAGE","artist":"影山ヒロノブ"}
    EOF

`date` と `stage` は空欄でよい（日割り・ステージ割りが未発表のフェスは実在する）。
`apple_music_url` は**空で渡す**。書き終えたあとに `tools/fill_apple_music.py` を
実行すると、iTunes Search API から一括で埋まる（手で書かない）。それでも絞り込めない
名前は空欄のまま残り、表示側が名前から Apple Music の検索URLを組み立てる。

行の順序はそのまま表示の順序になる。**公式が出している並び（トリが先頭、以下出演順）
を崩さないこと。**五十音順に直すと、主催者が付けた序列の情報が消える。
"""

import csv
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# `python3 tools/append_lineup.py` で起動すると tools/ が sys.path に入るので、
# append_rows.py と同じく列の定義を validate_data.py と1か所で共有できる。
import budget
from validate_data import EXPECTED_HEADERS

NAME = "lineups.csv"
HEADERS = EXPECTED_HEADERS[NAME]
PATH = os.path.join(DATA, NAME)
LIVES = os.path.join(DATA, "lives.csv")


def known_lineup_ids():
    """`lives.csv` が実際に参照している lineup_id。ここに無い値は表示されない。"""
    if not os.path.exists(LIVES):
        return set()
    with open(LIVES, newline="", encoding="utf-8") as f:
        return {
            (r.get("lineup_id") or "").strip()
            for r in csv.DictReader(f)
            if (r.get("lineup_id") or "").strip()
        }


def init_file():
    with open(PATH, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(HEADERS)
    print(f"{NAME} をヘッダーのみに初期化しました")


def main():
    args = sys.argv[1:]
    if "--init" in args:
        init_file()
        return

    records = []
    for i, line in enumerate((ln for ln in sys.stdin.read().splitlines() if ln.strip()), 1):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            raise SystemExit(f"ERROR: 標準入力の{i}行目のJSONを解析できませんでした: {e}")
        if not isinstance(obj, dict):
            raise SystemExit(f"ERROR: 標準入力の{i}行目がJSONオブジェクトではありません")
        records.append(obj)
    if not records:
        raise SystemExit("ERROR: 標準入力からJSONLを読み込めませんでした（空です）")

    known = known_lineup_ids()
    for i, r in enumerate(records, 1):
        unknown = [k for k in r if k not in HEADERS]
        if unknown:
            print(f"WARNING: {i}件目に {NAME} にない列があります（無視します）: {unknown}",
                  file=sys.stderr)
        lid = (r.get("lineup_id") or "").strip()
        if not lid:
            raise SystemExit(f"ERROR: {i}件目に lineup_id がありません")
        if not (r.get("artist") or "").strip():
            raise SystemExit(f"ERROR: {i}件目に artist がありません")
        # ここで落とすのが要点。表示されない行を静かに書き込むより、書く前に止める。
        if known and lid not in known:
            raise SystemExit(
                f"ERROR: {i}件目の lineup_id={lid!r} は lives.csv のどの行も参照していません。"
                f"\n  先に該当のフェスの行の lineup_id 列に {lid!r} を入れてください"
                f"\n  （参照されていないラインナップは、収集は成功しても画面に出ません）"
                f"\n  lives.csv が参照中: {sorted(known)}"
            )

    exists = os.path.exists(PATH)
    with open(PATH, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if not exists:
            w.writerow(HEADERS)
        for r in records:
            w.writerow([str(r.get(h, "") or "") for h in HEADERS])

    by_fes = {}
    for r in records:
        by_fes[r["lineup_id"]] = by_fes.get(r["lineup_id"], 0) + 1
    print(f"{len(records)}件を {NAME} に追記しました"
          f"（{'／'.join(f'{k} {v}件' for k, v in by_fes.items())}）")

    # 進捗はツールが出す（append_rows.py と同じ理由。モデルに書かせていた
    # `[進捗]` 行は、3回の実行を通じて1行も出なかった）。
    # 書き込みは既に終わっているので、ここで例外が出ても追記自体は失敗扱いにしない
    # （append_rows.py と同じ理由。tools/append_rows.py の該当コメントを参照）。
    try:
        print(f"[進捗] ラインナップ追記{len(records)}件 / "
              f"{budget.summary_line(budget.load()).removeprefix('[予算] ')}", file=sys.stderr)
    except Exception as e:                                    # noqa: BLE001
        print(f"WARNING: 進捗表示に失敗しました（追記自体は成功しています）: "
              f"{type(e).__name__}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
