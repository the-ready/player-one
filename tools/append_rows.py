#!/usr/bin/env python3
"""調査結果をバッチでCSVに追記するヘルパー。

収集スキルは「全件を調査してからコンテキストに保持し、最後にCSVを一括生成する」
という流れになりがちで、これが件数の多いタスクほどコンテキストを圧迫し、
後半の調査品質を落とす原因になっていた。5〜10件の調査が終わるたびに
このスクリプトでCSVに追記し、書いた分はコンテキストから解放する運用にする。

使い方:
    # 複数件をまとめて追記（標準入力からJSONL: 1行1JSONオブジェクト）
    python3 tools/append_rows.py events <<'EOF'
    {"title": "...", "cats": "art", "area": "...", ...}
    {"title": "...", "cats": "food", "area": "...", ...}
    EOF

    # CSVを空にしてヘッダーだけ書く（毎回の完全再生成の冒頭で実行）
    python3 tools/append_rows.py events --init
    python3 tools/append_rows.py lives --init
    python3 tools/append_rows.py movies --init

対象は events / lives / movies（events.csv / lives.csv / movies.csv でも可）。
列の並びは validate_data.py の EXPECTED_HEADERS を正本として使う（二重管理しない）。
"""

import csv
import json
import os
import sys

from validate_data import EXPECTED_HEADERS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

NAME_MAP = {"events": "events.csv", "lives": "lives.csv", "movies": "movies.csv"}


def resolve_filename(arg):
    if arg in NAME_MAP:
        return NAME_MAP[arg]
    if arg in EXPECTED_HEADERS:
        return arg
    raise SystemExit(
        f"ERROR: 不明なデータセット名です: {arg!r}（events / lives / movies のいずれかを指定してください）"
    )


def read_last_id(path):
    if not os.path.exists(path):
        return 0
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return 0
    try:
        return int((rows[-1].get("id") or "0").strip() or 0)
    except ValueError:
        return 0


def init_file(path, headers):
    with open(path, "w", newline="", encoding="utf-8") as f:
        csv.writer(f, quoting=csv.QUOTE_ALL).writerow(headers)
    print(f"{os.path.basename(path)} をヘッダーのみに初期化しました")


def write_rows(path, headers, records):
    file_exists = os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        if not file_exists:
            w.writerow(headers)
        for row in records:
            w.writerow([row.get(h, "") for h in headers])


def parse_jsonl(raw):
    records = []
    for i, line in enumerate((ln for ln in raw.splitlines() if ln.strip()), start=1):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            raise SystemExit(f"ERROR: 標準入力の{i}行目のJSONを解析できませんでした: {e}")
        if not isinstance(obj, dict):
            raise SystemExit(f"ERROR: 標準入力の{i}行目がJSONオブジェクトではありません")
        records.append(obj)
    return records


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit("使い方: python3 tools/append_rows.py <events|lives|movies> [--init]")

    name = resolve_filename(args[0])
    headers = EXPECTED_HEADERS[name]
    path = os.path.join(DATA, name)

    if "--init" in args[1:]:
        init_file(path, headers)
        return

    raw = sys.stdin.read()
    records = parse_jsonl(raw)
    if not records:
        raise SystemExit("ERROR: 標準入力からJSONLを読み込めませんでした（空です）")

    for i, obj in enumerate(records, start=1):
        unknown = [k for k in obj if k not in headers]
        if unknown:
            print(f"WARNING: {i}件目に {name} にない列があります（無視します）: {unknown}", file=sys.stderr)

    start_id = read_last_id(path) + 1
    for offset, row in enumerate(records):
        row["id"] = str(start_id + offset)

    write_rows(path, headers, records)

    end_id = start_id + len(records) - 1
    print(f"{len(records)}件を {name} に追記しました（id: {start_id}〜{end_id}）")


if __name__ == "__main__":
    main()
