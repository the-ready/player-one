#!/usr/bin/env python3
"""`tools/purge_ended.py` の判定・書き換えを検証する（ネットワーク不要）。

    python3 tools/purge_ended_test.py

この後始末は毎ターン `.claude/hooks/verify-data.sh` から自動で呼ばれる
（設計は `docs/COLLECTION-PROTOCOL.md` 第5.1節）。**削除方向に間違えると
開催中の催しを黙って消す**ため、判定規則（`is_ended`）と、CSV・処分記録・
`lineups.csv` の参照整合を保ったまま書き換えられるかを固定しておく。
"""

import csv
import json
import os
import shutil
import sys
import tempfile
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import purge_ended as pe                                      # noqa: E402
import prev_rows as pr                                        # noqa: E402

TODAY = date(2026, 8, 14)

# (説明, row, 終了と判定してよいか)
CASES = [
    ("終了日が今日より前",
     {"start_date": "2026-07-01", "end_date": "2026-07-31"}, True),
    ("終了日が今日",
     {"start_date": "2026-08-01", "end_date": "2026-08-14"}, False),
    ("終了日が今日より後",
     {"start_date": "2026-08-01", "end_date": "2026-08-20"}, False),
    ("終了日が空欄（会期未定・openrun）",
     {"start_date": "2026-07-01", "end_date": ""}, False),
    ("開始日も終了日も空欄（自由記述の date だけ）",
     {"start_date": "", "end_date": "", "date": "2026年秋（会期は公式サイト参照）"}, False),
    ("飛び日程では dates の最後の日で判定する",
     {"start_date": "2026-07-01", "end_date": "2026-08-14",
      "dates": "2026-07-01|2026-07-10|2026-07-20"}, True),
    ("飛び日程の最後がまだ先なら終了ではない",
     {"start_date": "2026-07-01", "end_date": "2026-08-14",
      "dates": "2026-07-01|2026-08-20"}, False),
    ("終了日を過ぎていても、今日が予備日なら消さない",
     {"start_date": "2026-08-01", "end_date": "2026-08-10",
      "backup_date": "2026-08-14"}, False),
    ("終了日を過ぎていて、予備日は別の日",
     {"start_date": "2026-08-01", "end_date": "2026-08-10",
      "backup_date": "2026-08-20"}, True),
]

# movies.csv は開始日の列名が release_date になる（validate_data.START_COL）
MOVIE_CASES = [
    ("映画: release_date 基準で終了日超過",
     {"release_date": "2026-07-01", "end_date": "2026-07-31"}, True),
    ("映画: end_date が空欄なら openrun（上映終了未定）",
     {"release_date": "2026-07-01", "end_date": ""}, False),
]


def run_unit():
    fails = 0
    for name, row, want in CASES:
        got = pe.is_ended("events.csv", row, TODAY)
        if got != want:
            print(f"✗ {name}\n    期待 {want} / 実際 {got} / row={row}")
            fails += 1
    for name, row, want in MOVIE_CASES:
        got = pe.is_ended("movies.csv", row, TODAY)
        if got != want:
            print(f"✗ {name}\n    期待 {want} / 実際 {got} / row={row}")
            fails += 1
    return fails, len(CASES) + len(MOVIE_CASES)


def _write_csv(path, headers, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(headers)
        for r in rows:
            w.writerow([r.get(h, "") for h in headers])


def run_integration():
    """CSV書き換え・処分記録・lineups.csv の参照整合を、一時ディレクトリで確認する。"""
    fails = 0
    tmp = tempfile.mkdtemp(prefix="purge_ended_test_")
    prev_dir = os.path.join(tmp, ".prev")
    os.makedirs(prev_dir, exist_ok=True)

    # モジュール定数を一時ディレクトリへ差し替える（元に戻すまでの間だけ）
    orig = (pe.DATA, pe.PREV, pr.DATA, pr.PREV)
    pe.DATA = tmp
    pe.PREV = prev_dir
    pr.DATA = tmp
    pr.PREV = prev_dir

    try:
        headers = ["id", "title", "venue", "pref", "start_date", "end_date", "dates",
                   "backup_date", "price", "source", "url", "desc", "note",
                   "date", "cats", "area", "kana", "venue_url", "open_time", "start_time",
                   "end_time", "date_note", "status", "rank", "series_id", "announced_date",
                   "is_additional", "onsale_label", "onsale_start", "onsale_start_time",
                   "onsale_end", "onsale_end_time", "limited_sale", "price_official",
                   "price_best", "discount_pct", "best_source", "coupon_note", "price_checked",
                   "price_condition", "official_url", "lat", "lng", "parking", "nearest_station"]
        ended = {"id": "1", "title": "終わった展覧会", "venue": "A館", "pref": "tokyo",
                 "start_date": "2026-07-01", "end_date": "2026-07-31"}
        ongoing = {"id": "2", "title": "続いている展覧会", "venue": "B館", "pref": "tokyo",
                   "start_date": "2026-08-01", "end_date": "2026-09-30"}

        # 前回スナップショット：どちらの行も前回から続いている、という体にする
        os.makedirs(prev_dir, exist_ok=True)
        _write_csv(os.path.join(prev_dir, "events.csv"), headers, [ended, ongoing])
        with open(os.path.join(prev_dir, "events.meta.json"), "w", encoding="utf-8") as f:
            json.dump({"taken_at": "2026-08-07", "rows": 2}, f)

        # 今回のCSV：終了日を過ぎた行がそのまま持ち越されている状態を再現する
        _write_csv(os.path.join(tmp, "events.csv"), headers, [ended, ongoing])

        res = pe.purge_one("events.csv", TODAY, dry_run=False)

        if len(res["purged"]) != 1 or res["purged"][0]["title"] != "終わった展覧会":
            print(f"✗ 終了行だけが対象になっていない: {res['purged']}")
            fails += 1

        with open(os.path.join(tmp, "events.csv"), newline="", encoding="utf-8") as f:
            remaining = list(csv.DictReader(f))
        titles = [r["title"] for r in remaining]
        if titles != ["続いている展覧会"]:
            print(f"✗ CSVに残った行が期待と違う: {titles}")
            fails += 1

        disp_path = pr.disposition_path("events.csv")
        if not os.path.exists(disp_path):
            print("✗ 処分記録（dispositions）が書かれていない")
            fails += 1
        else:
            with open(disp_path, encoding="utf-8") as f:
                recs = [json.loads(line) for line in f if line.strip()]
            if len(recs) != 1 or recs[0]["status"] != "expired":
                print(f"✗ 処分記録の内容が期待と違う: {recs}")
                fails += 1

        # 同じ入力に対する2回目の実行は、CSVから既に消えているので何もしない
        # （dispositions の重複書き込みが起きないことを確認する）
        res2 = pe.purge_one("events.csv", TODAY, dry_run=False)
        if res2["purged"]:
            print(f"✗ 2回目の実行で何も消えないはずが、消えている: {res2['purged']}")
            fails += 1
        with open(disp_path, encoding="utf-8") as f:
            recs_after = [json.loads(line) for line in f if line.strip()]
        if len(recs_after) != 1:
            print(f"✗ 処分記録が重複して増えている: {len(recs_after)}件")
            fails += 1

        # --- lineups.csv の参照整合（lives.csv 相当） ---
        live_headers = headers + ["lineup_id"]
        live_ended = dict(ended, lineup_id="fes-a")
        live_ongoing = dict(ongoing, lineup_id="fes-b")
        _write_csv(os.path.join(prev_dir, "lives.csv"), live_headers, [live_ended, live_ongoing])
        with open(os.path.join(prev_dir, "lives.meta.json"), "w", encoding="utf-8") as f:
            json.dump({"taken_at": "2026-08-07", "rows": 2}, f)
        _write_csv(os.path.join(tmp, "lives.csv"), live_headers, [live_ended, live_ongoing])

        lineup_headers = ["lineup_id", "date", "stage", "artist", "is_headliner",
                          "apple_music_url", "note"]
        lineup_rows = [
            {"lineup_id": "fes-a", "date": "2026-07-15", "stage": "MAIN", "artist": "X"},
            {"lineup_id": "fes-b", "date": "2026-08-15", "stage": "MAIN", "artist": "Y"},
        ]
        _write_csv(os.path.join(tmp, "lineups.csv"), lineup_headers, lineup_rows)

        res_live = pe.purge_one("lives.csv", TODAY, dry_run=False)
        if res_live["lineups_removed"] != 1:
            print(f"✗ 参照切れの lineups.csv 行が想定通り消えていない: {res_live}")
            fails += 1

        with open(os.path.join(tmp, "lineups.csv"), newline="", encoding="utf-8") as f:
            remaining_lineups = [r["lineup_id"] for r in csv.DictReader(f)]
        if remaining_lineups != ["fes-b"]:
            print(f"✗ lineups.csv に残った行が期待と違う: {remaining_lineups}")
            fails += 1

        # --- dry-run は何も書き換えない ---
        _write_csv(os.path.join(tmp, "events.csv"), headers, [ended, ongoing])
        os.remove(disp_path)
        res_dry = pe.purge_one("events.csv", TODAY, dry_run=True)
        if len(res_dry["purged"]) != 1:
            print(f"✗ dry-run でも対象の検出自体はできるはず: {res_dry}")
            fails += 1
        with open(os.path.join(tmp, "events.csv"), newline="", encoding="utf-8") as f:
            after_dry = [r["title"] for r in csv.DictReader(f)]
        if sorted(after_dry) != sorted(["終わった展覧会", "続いている展覧会"]):
            print(f"✗ dry-run なのにCSVが書き換わっている: {after_dry}")
            fails += 1
        if os.path.exists(disp_path):
            print("✗ dry-run なのに処分記録が書かれている")
            fails += 1

    finally:
        pe.DATA, pe.PREV, pr.DATA, pr.PREV = orig
        shutil.rmtree(tmp, ignore_errors=True)

    return fails, 11  # 上の run_integration 内にある個別チェックの総数


def main():
    unit_fails, unit_total = run_unit()
    int_fails, int_total = run_integration()
    fails = unit_fails + int_fails
    total = unit_total + int_total
    print(f"\n{total - fails}/{total} 件が期待どおり")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
