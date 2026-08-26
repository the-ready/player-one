#!/usr/bin/env python3
"""会期・上映・公演がすでに終わった行を、CSVから機械的に取り除く。

## なぜ要るか

収集タスクは「終わったイベントを載せない」ことを毎週の調査判断でやっているが、
検索予算やコンテキストが尽きたときの撤退の手順（各SKILL.md）は、再確認できなかった
行を「前回値のまま書き戻してよい」としている。これは本来、日程が動かない tier C の
行のためのものだが、確認が間に合わなかった行にも同じ扱いが適用されうる。すると、
前回すでに終了日を過ぎていた行が、確認されないまま今週もそのまま持ち越される——
という抜け道が生まれる。それが翌週も同じ理由で再確認を逃せば、終了日を過ぎた行が
CSVの中に無期限に居座ることになる。

表示側（`assets/js/schedule.js` の `schedulePhase`）はこの抜け道の実害を
利用者からは隠している。終了日を過ぎた行は毎回の描画でその場で「終了」と
判定され、既定では一覧から外れる（設計書 第5.4.1節）。だから利用者の目には
触れない。だがCSVの中にはまだ残り、週を追うごとに静かに積み上がる——
次回以降の収集タスクが読む前回データを太らせ、「終了のものも表示」チップを
押した利用者には何ヶ月も前の催しが延々と並ぶ。

この静かな蓄積を、日付の比較だけで機械的に断ち切るのがこのスクリプトである。
モデルの判断も検索も要らない——**終了日が「今日」より前かどうか**という、
唯一の客観的な事実だけで決まる。`schedulePhase` と同じ規則をPython側に
移植してあるので、「表示では隠れているのにCSVには残っている」という状態を、
両者の定義がずれないまま解消できる。

## 何を残し、何を消すか（schedulePhase と同じ規則）

  - 終了日（`end_date`。飛び日程（`dates`）を持つ行ではその最後の日）が
    今日より前 → 削除
  - 終了日が空欄（会期未定・通年） → 残す（「まだ続いている」の意味）
  - 開始日も終了日も空欄（自由記述の `date` だけを持つ行） → 残す（判定不能）
  - 今日が `backup_date`（予備日）に含まれる → 残す
    （表示側も「本日予備日」を「終了」より優先して出すため）

## 消えた行の扱い

前回のCSV（`data/.prev/`）にも同じ行があった場合は、`prev_rows.py --dispose`
と同じ形式で `status: "expired"` の処分を自動記録する。これをしないと、
次の `diff_data.py` が「説明のない消滅」としてERRORにする（収集タスクが
自分で消したのか、見失っただけなのかを機械には区別できないため）。

`"ended"`ではなく専用の`"expired"`を使うのは、`"ended"`の定義が
「会期・上映・公演が終了したことを確認した」——**情報源に当たって確認した**
という意味だからである。このスクリプトは確認していない。終了日を過ぎたという
客観的な事実だけを根拠に機械的に判定しており、その区別を処分記録の上でも
正直に残す。

lives.csv 側で `lineup_id` を持つ行を消す場合は、他の行が同じ `lineup_id` を
参照していない限り `data/lineups.csv` 側の該当行も一緒に削除する
（参照を残すと `validate_data.py` が「ラインナップの参照切れ」でERRORにする）。

## どこから呼ばれるか

各収集スキルの終了工程（`append_rows.py` での書き切りの直後、
`prev_rows.py --dispose` の前）から呼ぶほか、`.claude/hooks/verify-data.sh`
（Stop フック）と `.claude/scripts/claude-routine.sh`（週次ルーチンの最終ゲート）
からも自動で呼ばれる。判断を要しない機械的な後始末なので、モデルが手順を
飛ばしても後段で必ず適用される（設計書 第9.1.5節と同じ考え方）。

使い方:
    python3 tools/purge_ended.py              # 3データセットぶん、実際に書き換える
    python3 tools/purge_ended.py events        # 1つだけ
    python3 tools/purge_ended.py --dry-run     # 何が消えるかだけ確認する（書き換えない）
"""

import argparse
import csv
import json
import os
import sys
from datetime import date

# 終了判定（is_ended / last_date）は prev_rows 側にある。`--worklist` と
# `--carry-rest` も同じ規則を使うため、import の向き（こちらが prev_rows に
# 依存する）に合わせて下位へ移した。理由は prev_rows.is_ended の説明にある。
from prev_rows import (
    PREV, disposition_path, is_ended, last_date, load_dispositions, load_prev, resolve_dataset,
)
from rowkey import uid as row_uid
from validate_data import EXPECTED_HEADERS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

DATASETS = ["events.csv", "lives.csv", "movies.csv"]
LINEUPS = "lineups.csv"

EXPIRED_STATUS = "expired"
EXPIRED_NOTE_FMT = "終了日（{end}）を過ぎたため tools/purge_ended.py が自動削除（未確認）"


def _write_csv(path, headers, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(headers)
        for r in rows:
            w.writerow([r.get(h, "") for h in headers])


def _purge_orphan_lineups(keep_live_rows, purged_live_rows):
    """参照する行が1件も残っていない lineup_id を lineups.csv からも消す。"""
    purged_lids = {(r.get("lineup_id") or "").strip() for r in purged_live_rows} - {""}
    if not purged_lids:
        return 0
    still_used = {(r.get("lineup_id") or "").strip() for r in keep_live_rows} - {""}
    orphans = purged_lids - still_used
    if not orphans:
        return 0

    path = os.path.join(DATA, LINEUPS)
    if not os.path.exists(path):
        return 0
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    keep = [r for r in rows if (r.get("lineup_id") or "").strip() not in orphans]
    removed = len(rows) - len(keep)
    if removed:
        _write_csv(path, EXPECTED_HEADERS[LINEUPS], keep)
    return removed


def _record_dispositions(name, purged_rows, today):
    prev_rows, _source = load_prev(name)
    if not prev_rows:
        return 0
    prev_uids = {row_uid(name, r) for r in prev_rows}
    known = load_dispositions(name)

    recs = []
    for r in purged_rows:
        u = row_uid(name, r)
        if u not in prev_uids or u in known:
            continue  # 前回データに無い（今回新規に混入した過去行）か、既に処分済み
        _, end = last_date(name, r)
        recs.append({
            "uid": u, "status": EXPIRED_STATUS, "title": r.get("title", ""),
            "note": EXPIRED_NOTE_FMT.format(end=end or "不明"),
        })
    if not recs:
        return 0
    os.makedirs(PREV, exist_ok=True)
    with open(disposition_path(name), "a", encoding="utf-8") as f:
        for obj in recs:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    return len(recs)


def purge_one(name, today, dry_run):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return {"dataset": name, "purged": [], "disposed": 0, "lineups_removed": 0}
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    keep, purged = [], []
    for r in rows:
        (purged if is_ended(name, r, today) else keep).append(r)

    result = {"dataset": name, "purged": purged, "disposed": 0, "lineups_removed": 0}
    if not purged or dry_run:
        return result

    _write_csv(path, EXPECTED_HEADERS[name], keep)
    if name == "lives.csv":
        result["lineups_removed"] = _purge_orphan_lineups(keep, purged)
    result["disposed"] = _record_dispositions(name, purged, today)
    return result



def _parse_today(s):
    """`--today` の検証。argparse の `type=` に渡すと、壊れた値は
    トレースバックではなく argparse 自身の使用法メッセージで弾かれる。"""
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"YYYY-MM-DD 形式で指定してください: {s!r}")

def main():
    p = argparse.ArgumentParser(description="終了日を過ぎた行をCSVから機械的に取り除く")
    p.add_argument("dataset", nargs="?", help="events / lives / movies（省略時は3つとも）")
    p.add_argument("--dry-run", action="store_true", help="書き換えず、消える行を一覧するだけ")
    p.add_argument("--today", type=_parse_today, help="基準日 YYYY-MM-DD（試験用。既定は今日）")
    args = p.parse_args()

    today = args.today if args.today else date.today()
    names = [resolve_dataset(args.dataset)] if args.dataset else DATASETS
    for n in names:
        if n not in DATASETS:
            raise SystemExit(f"ERROR: purge_ended.py の対象外です: {n}（events / lives / movies のみ）")

    total = 0
    for name in names:
        res = purge_one(name, today, args.dry_run)
        purged = res["purged"]
        total += len(purged)
        if not purged:
            print(f"{name}: 終了済みの行はありません")
            continue
        verb = "見つかりました（--dry-run のため未削除）" if args.dry_run else "削除しました"
        print(f"{name}: {len(purged)}件 {verb}")
        for r in purged:
            _, end = last_date(name, r)
            print(f"  - {r.get('title', '')[:40]}（{end or '不明'} 終了）")
        if not args.dry_run:
            if res["disposed"]:
                print(f"  → {res['disposed']}件を dispositions（status={EXPIRED_STATUS}）に記録しました")
            if res["lineups_removed"]:
                print(f"  → {LINEUPS} から参照切れの行を{res['lineups_removed']}件削除しました")

    if total == 0:
        print("\n削除対象はありませんでした")
    return 0


if __name__ == "__main__":
    sys.exit(main())
