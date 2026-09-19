#!/usr/bin/env python3
"""`data/holidays.csv`（カレンダーの祝日ハイライト用）を内閣府の公式データから作り直す。

## なぜ実行時に取りに行かず、事前にコミットするのか

このダッシュボードは「データは事前収集・静的配信、ページは `data/` 配下しか読まない」
という設計（README 構成節）で、実行時に外部サイトへfetchする経路を意図的に持たない
——CORSの可否が保証されない、オフラインPWAのキャッシュ戦略と噛み合わない、
外部依存が増えるたびに一覧の表示可否がそのサイトの生死に引きずられる、という理由から
である（README「外部依存は Google Fonts と OpenStreetMap のタイルだけ」）。祝日は
法改正のとき以外ほぼ動かないデータなので、`theaters.csv` / `venues.csv` と同じ
「準静的なマスター」として扱い、このスクリプトを**人が随時**実行してコミットする形にした
（3つの収集スキルが担う週次の自動更新には含めない）。

## 出典とライセンス

内閣府「国民の祝日について」が配布する syukujitsu.csv
（<https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv>）を使う。デジタル庁が運営する
e-Gov データポータルにも同じファイルがカタログ掲載されており、そこで明示されている
ライセンスは「公共データ利用規約（第1.0版）」（CC-BY相当）：出典表示が必須、商用利用は
制限なし、ただし**加工した場合はその旨を明記し、無加工の政府原本であるかのように
見せてはならない**。この出典表示・加工の告知は `README.md` のデータ節に書き、
この関数のdocstringにも残す（CSVの中には書かない——`assets/js/csv.js` の1行目が
無条件にヘッダー行になるため、コメント行を混ぜると列名が壊れる）。

## 形式の変換

原本は Shift_JIS（実際は機種依存文字を含むため cp932 で読む）、日付は `YYYY/M/D`。
`assets/js/util.js` の `iso()` 相当の `YYYY-MM-DD` に正規化し、`date,name` の2列で書く。
列は `data/*.csv` の9か所ルール（CLAUDE.md）の対象外——祝日は表示用の判定テーブルであって
イベント／映画／ライブのどのスキーマにも属さない別種のファイルなので、
`tools/validate_data.py` の `EXPECTED_HEADERS` にも意図的に加えていない。

## 使い方

    python3 tools/update_holidays.py           # data/holidays.csv を書き直す
    python3 tools/update_holidays.py --dry-run  # 取得と変換だけ行い、書き込まない
"""

import argparse
import csv
import datetime
import os
import sys
import urllib.error
import urllib.request

SOURCE_URL = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv"
UA = "PlayerOneEventBoard-HolidayUpdater/1.0 (+https://github.com/)"
TIMEOUT = 20

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "data", "holidays.csv")


def fetch_rows():
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            raw = res.read()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"ERROR: {SOURCE_URL} が HTTP {e.code} を返しました")
    except Exception as e:                                   # noqa: BLE001
        raise SystemExit(f"ERROR: {SOURCE_URL} を取得できませんでした: {type(e).__name__}: {e}")

    text = raw.decode("cp932")
    reader = csv.reader(text.splitlines())
    header = next(reader, None)
    if not header or "月日" not in header[0]:
        raise SystemExit(f"ERROR: 想定外のヘッダーです: {header!r}（サイト側の形式が変わった可能性）")

    rows = []
    for cells in reader:
        if len(cells) < 2 or not cells[0].strip():
            continue
        y, m, d = cells[0].strip().split("/")
        date = datetime.date(int(y), int(m), int(d)).isoformat()
        rows.append((date, cells[1].strip()))
    if not rows:
        raise SystemExit("ERROR: 祝日データが0件でした（取得内容を確認してください）")
    rows.sort(key=lambda r: r[0])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="取得と変換だけ行い、書き込まない")
    args = ap.parse_args()

    rows = fetch_rows()
    print(f"{len(rows)}件を取得（{rows[0][0]} 〜 {rows[-1][0]}）")

    if args.dry_run:
        return

    with open(OUT_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", "name"])
        w.writerows(rows)
    print(f"書き込み: {os.path.relpath(OUT_PATH, ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
