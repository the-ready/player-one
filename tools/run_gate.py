#!/usr/bin/env python3
"""その回が「収集した回」と言える形をしているかを、終了コードで返す。

## なぜ要るのか —— これまでの門は全部「使いすぎ」の天井だった

`budget.py` の25M/40M、`agent-guard.sh`、`wave_gate.py`、`fetch-budget-guard.sh`
——どれも「使いすぎ」を止める天井である。**「調べなさすぎ」を止める床がどこにも
無かった。**

2026-09-04 20:50 の lives 収集は、起動時の予算表示が別セッションのトークンを
拾って「撤退の手順に入ってください」と出したため（`budget.transcript_files()`
の説明を参照）、**サブエージェントを1体も起動せず、検索0回・取得0回**で9分で
終えた。やったのは、同じ日の失敗回が `temp/` に残したJSONLの回収と終了工程だけ
である。それでも既存の門はすべて通った。

  - `validate_data.py`: 行の形は壊れていないので ERROR 0
  - `diff_data.py`: 回収した77行が「新規」に数えられるので空回りではない
  - `report_stats.py --check-fresh`: 当時 `FRESH_FLOOR` は events にしか無かった

結果、**先週の87行＋今朝の中途半端な77行**が「週次データ更新」として commit・
push された（`onsale_start`/`onsale_end` は0%）。

## 何を見るか —— 「外を1回でも見たか」と「開始点を通ったか」

判断ではなく事実だけを見る。どちらも `data/.run/budget.json` に実測がある。

  1. **検索も取得も0回** —— 外部の情報源を1度も見ていない。どんな事情があっても、
     これは収集の回ではない（`fetch_page.py` は取得のたびに、`WebSearch` は
     フックが、それぞれ実測を積む）
  2. **`append_rows.py <ds> --init` を通っていない** —— 収集の開始点を踏んでいない。
     前回のCSVに追記するだけの回は、先週の行を今週の行として commit してしまう
     （`data/.prev/` も更新されないので、翌週の差分の基準までずれる）

**撤退した回を罰するものではない。** 撤退（40M）に入った回でも、そこまでに
取得は行われているので 1 は通る。1で落ちるのは「一度も外を見ていない回」だけである。

## 終了コード

  0 : 収集の回として成立している
  1 : 成立していない。理由を stderr に書く
  2 : 判定できない（`data/.run/budget.json` が無い・古い）

**2 では止めない。** 計測できないことを理由に成果を捨てるのは、この門が防ごうと
している損失より大きい（`wave_gate.py` / `budget.py --gate` と同じ倒し方）。

使い方:
    python3 tools/run_gate.py --check            # ROUTINE_SKILL から対象を決める
    python3 tools/run_gate.py --check --ds lives # 対象を明示する
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import budget                                                  # noqa: E402

SKILL_DS = {
    "kanto-event-collector": "events",
    "kanto-live-collector": "lives",
    "kanto-movie-collector": "movies",
}


def resolve_ds(arg):
    """対象データセット名（`lives.csv` の形）。決められなければ None。"""
    ds = (arg or SKILL_DS.get((os.environ.get("ROUTINE_SKILL") or "").strip(), "")).strip()
    if not ds:
        return None
    return ds if ds.endswith(".csv") else ds + ".csv"


def read_state():
    """今回の実行の実測。無い・古い・壊れているときは None（＝判定しない）。

    `budget.load()` を使わないのは、あれが「古ければ数え直す」実装で、**古い記録と
    真っさらな記録を同じ形（カウンタ0）で返す**ためである。ここでは両者を区別する
    必要がある——0回の実測は止める理由だが、記録が無いことは止める理由ではない。
    """
    try:
        with open(budget.STATE, encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(st, dict) or not isinstance(st.get("started_at"), (int, float)):
        return None
    if time.time() - st["started_at"] > budget.STALE_SEC:
        return None
    return st


def check(ds):
    """(終了コード, [理由...]) を返す。"""
    st = read_state()
    if st is None:
        return 2, ["# 今回の実行の実測（data/.run/budget.json）が読めません。判定を見送ります。"]

    totals = st.get("totals") if isinstance(st.get("totals"), dict) else {}
    search = int(totals.get("search") or 0)
    fetch = int(totals.get("fetch") or 0)
    inits = st.get("inits") if isinstance(st.get("inits"), list) else []

    reasons = []
    if search == 0 and fetch == 0:
        reasons.append(
            "検索0回・取得0回で、外部の情報源を1度も見ていません。"
            "調べていない回を「週次データ更新」として記録に残すことはできません。\n"
            "  すでに調べた結果が temp/rows-*.jsonl にあるなら、それは前回の回の成果です"
            "——今回の収集としてコミットするのではなく、今回の調査を行ってください。")

    # `--init` は「対象が分かるとき」だけ見る。ROUTINE_SKILL が無い（対話的に
    # 手で叩いた等）状況で、収集ですらない作業を止める門にはしない。
    if ds and ds not in inits:
        reasons.append(
            f"収集の開始点（python3 tools/append_rows.py {ds.replace('.csv', '')} --init）を"
            "通っていません。前回のCSVに追記しただけの回は、先週の行を今週の行として"
            "コミットしてしまいます（data/.prev/ も更新されないので、翌週の差分の基準までずれます）。")

    return (1 if reasons else 0), reasons


def main():
    p = argparse.ArgumentParser(description="その回が収集の回として成立しているかを見る")
    p.add_argument("--check", action="store_true", help="成立していなければ理由を出して exit 1")
    p.add_argument("--ds", help="対象データセット（events / lives / movies）。既定は ROUTINE_SKILL から")
    args = p.parse_args()
    if not args.check:
        p.error("--check を指定してください")

    rc, reasons = check(resolve_ds(args.ds))
    if reasons:
        print("\n".join(reasons), file=sys.stderr)
    return rc


if __name__ == "__main__":
    sys.exit(main())
