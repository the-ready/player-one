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
    #   このとき、直前の内容は data/.prev/ に自動退避される（差分検知の材料）
    python3 tools/append_rows.py events --init
    python3 tools/append_rows.py lives --init
    python3 tools/append_rows.py movies --init

対象は events / lives / movies（events.csv / lives.csv / movies.csv でも可）。
列の並びは validate_data.py の EXPECTED_HEADERS を正本として使う（二重管理しない）。

## 持ち越し（carryover）

前回と同じ行を書き直すとき、座標・最寄り駅・駐車場のような**動かない事実**まで
毎回書き直すのは、出力トークンの無駄であると同時に写し間違いの機会でもある。
これらは前回値から自動で補う（CARRY_ALWAYS）。

一方、日付・料金・受付期間・クーポンは**持ち越してはならない**。
「前回の締切をそのまま書く」のは、このプロジェクトが一貫して禁じている
「確認していない値を書く」そのものだからである。指示文でのお願いではなく、
このスクリプトが受け付けないという形で担保する（CARRY_NEVER）。

その中間（desc・note・official_url など）は、**行ごとに明示的に要求したときだけ**
持ち越す。内容に変更がないことを確認できた行では、こう書けばよい:

    {"title": "...", "venue": "...", "start_date": "...", "_carry": "*", ...}

`_carry` は `"*"`（持ち越し可能な列すべて）か、`"desc|note"` のような列名の並び。
持ち越し元は、その行のタイトル・会場・日付から決まる uid で引く（rowkey.py）。
タイトルを修正した等で uid が変わる場合は `"_carry_from": "<前回のuid>"` を添える。
"""

import csv
import json
import os
import sys

import prev_rows as prevmod
from rowkey import uid as row_uid
from validate_data import EXPECTED_HEADERS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

NAME_MAP = {"events": "events.csv", "lives": "lives.csv", "movies": "movies.csv"}

# 会場に紐づく事実。行ではなく場所の属性なので、同じ会場の別の行からも引ける。
VENUE_FACTS = ["lat", "lng", "parking", "nearest_station", "venue_url", "theater_url"]

# 空欄なら黙って前回値で埋める列。読み・座標・アクセスなど、時間で変わらないもの。
CARRY_ALWAYS = ["kana"] + VENUE_FACTS

# 持ち越しを絶対に許さない列。日付・金額・受付は毎回確認するか、空欄にするかの二択。
CARRY_NEVER = {
    "id", "title", "date", "dates", "date_note", "backup_date", "status", "rank",
    "open_time", "start_time", "end_time",
    "start_date", "release_date", "end_date", "announced_date", "is_additional",
    "onsale_label", "onsale_start", "onsale_start_time", "onsale_end", "onsale_end_time",
    "limited_sale", "price", "price_official", "price_best", "discount_pct",
    "best_source", "coupon_note", "price_checked", "price_condition",
    "url", "source",
}

CONTROL_KEYS = {"_carry", "_carry_from"}


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


def init_file(name, path, headers):
    kept = prevmod.take_snapshot(name)
    with open(path, "w", newline="", encoding="utf-8") as f:
        csv.writer(f, quoting=csv.QUOTE_ALL).writerow(headers)
    if kept is None:
        print(f"{os.path.basename(path)} をヘッダーのみに初期化しました（前回データなし）")
    else:
        print(f"{os.path.basename(path)} をヘッダーのみに初期化しました"
              f"（前回の{kept}件を data/.prev/ に退避）")


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


# ---------------------------------------------------------------- carryover

def _fold_places(rows, headers, by_place, place_col):
    for r in rows:
        place = (r.get(place_col) or "").strip()
        if not place:
            continue
        slot = by_place.setdefault(place, {})
        for col in VENUE_FACTS:
            if col in headers and (r.get(col) or "").strip() and col not in slot:
                slot[col] = r[col].strip()


def build_prev_index(name, headers, current_path=None):
    """(uid→行, 会場名→会場の事実) を作る。前回データが無ければ空。"""
    rows, _ = prevmod.load_prev(name)
    by_uid, by_place = {}, {}
    place_col = "theater" if name == "movies.csv" else "venue"
    for r in rows:
        by_uid[row_uid(name, r)] = r
    _fold_places(rows, headers, by_place, place_col)

    # 今回このセッションで既に書いた行からも、会場の事実を引けるようにする。
    # 名簿にも前回にも無い新しい会場では、1公演目で調べた駐車場・最寄り駅を
    # 2公演目以降に書き写す作業が発生していた。会場の属性なのだから、
    # 同じ会場の行が既にCSVにあるなら、そこから引けばよい。
    if current_path and os.path.exists(current_path):
        with open(current_path, newline="", encoding="utf-8") as f:
            _fold_places(list(csv.DictReader(f)), headers, by_place, place_col)

    return by_uid, by_place


def resolve_carry_request(raw, headers, line_no):
    """`_carry` の指定を列名の集合にする。禁止列を頼まれたらその場で落とす。"""
    if not raw:
        return []
    allowed = [h for h in headers if h not in CARRY_NEVER and h not in CARRY_ALWAYS]
    if str(raw).strip() == "*":
        return allowed
    wanted = [c.strip() for c in str(raw).split("|") if c.strip()]
    for c in wanted:
        if c in CARRY_NEVER:
            raise SystemExit(
                f"ERROR: {line_no}件目 _carry に {c!r} が指定されています。"
                f"日付・料金・受付・クーポンは前回値の持ち越しを禁止しています"
                f"（確認できないなら空欄にしてください）"
            )
        if c not in headers:
            raise SystemExit(f"ERROR: {line_no}件目 _carry の {c!r} は {headers[0]} 系の列にありません")
    return wanted


def apply_carryover(name, headers, records, by_uid, by_place):
    place_col = "theater" if name == "movies.csv" else "venue"
    filled = {"always": 0, "requested": 0, "by_place": 0}
    misses = []

    for i, row in enumerate(records, start=1):
        requested = resolve_carry_request(row.pop("_carry", None), headers, i)
        src_uid = (row.pop("_carry_from", "") or "").strip() or row_uid(name, row)
        src = by_uid.get(src_uid)

        for col in CARRY_ALWAYS:
            if col not in headers or (row.get(col) or "").strip():
                continue
            if src and (src.get(col) or "").strip():
                row[col] = src[col].strip()
                filled["always"] += 1

        # 会期が変わって uid がずれても、会場の座標や最寄り駅は同じ会場の別行から引ける
        place = (row.get(place_col) or "").strip()
        if place in by_place:
            for col in VENUE_FACTS:
                if col in headers and not (row.get(col) or "").strip() and col in by_place[place]:
                    row[col] = by_place[place][col]
                    filled["by_place"] += 1

        if requested:
            if not src:
                misses.append((i, row.get("title", "")[:30], src_uid))
                continue
            for col in requested:
                if not (row.get(col) or "").strip() and (src.get(col) or "").strip():
                    row[col] = src[col].strip()
                    filled["requested"] += 1

    return filled, misses


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit("使い方: python3 tools/append_rows.py <events|lives|movies> [--init]")

    name = resolve_filename(args[0])
    headers = EXPECTED_HEADERS[name]
    path = os.path.join(DATA, name)

    if "--init" in args[1:]:
        init_file(name, path, headers)
        return

    raw = sys.stdin.read()
    records = parse_jsonl(raw)
    if not records:
        raise SystemExit("ERROR: 標準入力からJSONLを読み込めませんでした（空です）")

    for i, obj in enumerate(records, start=1):
        unknown = [k for k in obj if k not in headers and k not in CONTROL_KEYS]
        if unknown:
            print(f"WARNING: {i}件目に {name} にない列があります（無視します）: {unknown}", file=sys.stderr)

    by_uid, by_place = build_prev_index(name, headers, current_path=path)
    filled, misses = apply_carryover(name, headers, records, by_uid, by_place)

    start_id = read_last_id(path) + 1
    for offset, row in enumerate(records):
        row["id"] = str(start_id + offset)

    write_rows(path, headers, records)

    end_id = start_id + len(records) - 1
    print(f"{len(records)}件を {name} に追記しました（id: {start_id}〜{end_id}）")
    if any(filled.values()):
        print(f"  前回値から補完: 固定列{filled['always']} / 会場から{filled['by_place']} "
              f"/ 明示要求{filled['requested']}")
    for i, title, uid_ in misses:
        print(f"  WARNING: {i}件目「{title}」は _carry を指定していますが、"
              f"前回に uid={uid_} の行がありません（新規行なら _carry は不要です）",
              file=sys.stderr)


if __name__ == "__main__":
    main()
