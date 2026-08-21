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

import budget
import prev_rows as prevmod
import roster
from rowkey import uid as row_uid
from validate_data import EXPECTED_HEADERS, load_enums

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

NAME_MAP = {"events": "events.csv", "lives": "lives.csv", "movies": "movies.csv"}

# 行が書かれた＝その会場から収穫があった、という対応。名簿の育成に使う
# （roster.record_hits の冒頭に、なぜ自動化したのかを書いてある）。
ROSTER_OF = {
    "events.csv": ("spots", "venue"),
    "lives.csv": ("venues", "venue"),
    "movies.csv": ("theaters", "theater"),
}

# 会場に紐づく事実。行ではなく場所の属性なので、同じ会場の別の行からも引ける。
VENUE_FACTS = ["lat", "lng", "parking", "nearest_station", "venue_url", "theater_url"]

# 列挙値を持つ列と、その許可集合の名前（load_enums() のキー）。
#
# 以前はここを検証しておらず、`cats` に config.js に無いキー（`photo` `film`
# など）が実際に書き込まれたことがある。書いた時点では何も起きず、
# `validate_data.py` まで届いて初めて ERROR になるので、**その回の収集が
# 丸ごと巻き戻される**（Stop フック・claude-routine.sh の双方が ERROR を
# 理由に data/ を戻す）。数十件書いた後にまとめて弾かれるより、書く瞬間に
# 1件だけ弾くほうが被害が小さい。
ENUM_COLUMNS = {
    "events.csv": {"cats": "cats"},
    "movies.csv": {"genre": "movie_genre", "screening_type": "screening_type"},
    "lives.csv": {"genre": "live_genre", "live_type": "live_type"},
}


def check_enum_columns(name, records):
    """列挙値を検証する。複数値は `|` 区切り。空欄は許容する（必須は別の話）。"""
    cols = ENUM_COLUMNS.get(name)
    if not cols:
        return
    enums = load_enums()
    bad = []
    for i, obj in enumerate(records, start=1):
        for col, enum_key in cols.items():
            raw = (obj.get(col) or "").strip()
            if not raw:
                continue
            for v in (x.strip() for x in raw.split("|")):
                if v and v not in enums[enum_key]:
                    bad.append(f"{i}件目 {col}={v!r}（使えるのは: {', '.join(sorted(enums[enum_key]))}）")
    if bad:
        raise SystemExit(
            "ERROR: config.js の定義に無いキーがあります。書く前に直してください:\n  "
            + "\n  ".join(bad)
        )

# 空欄なら黙って前回値で埋める列。読み・座標・アクセスなど、時間で変わらないもの。
# lineup_id（フェスの日割りラインナップの参照キー）もここに入る。値は書き手が決めた
# スラッグで、その週の調査で変わるものではない——毎週書き直させると綴りが揺れ、
# lineups.csv 側との参照が静かに切れる（validate_data.py がERRORで捕まえる）。
CARRY_ALWAYS = ["kana", "lineup_id"] + VENUE_FACTS

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
    # `--init` は収集の開始点そのものなので、予算の計測もここで数え直す。
    # budget.py は12時間で自動的に数え直すが、明示的な起点があるならそちらが正しい
    # （同じ日に2回走らせたとき、前半の消費が後半に混ざらない）。
    budget.reset()
    kept = prevmod.take_snapshot(name)
    with open(path, "w", newline="", encoding="utf-8") as f:
        csv.writer(f, quoting=csv.QUOTE_ALL).writerow(headers)
    if kept is None:
        print(f"{os.path.basename(path)} をヘッダーのみに初期化しました（前回データなし）")
    elif kept < 0:
        # 直前のCSVが既にヘッダーだけだった（同じ日の再 --init）。前回の本物の
        # スナップショットを空データで上書きしないよう、退避をスキップしている
        # （tools/prev_rows.py take_snapshot の説明を参照）。
        print(f"{os.path.basename(path)} をヘッダーのみに初期化しました"
              f"（直前も0件だったため、data/.prev/ の前回スナップショットは温存）")
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


def _fold_roster_coords(name, by_place):
    """名簿（spots.csv 等）の座標を、前回・今回セッションにまだ無い会場にだけ補う。

    SKILL.md 各文書は「名簿に載っている会場は lat/lng を空欄で渡せば自動で埋まる。
    調べない」と明記している。だが前回・今回セッションのCSV行から引く経路
    （`_fold_places`）は、その週いずれかの出力に一度でも登場した会場しか
    知らない——名簿には`--add`済みでも、まだその行を一度も書いていない会場では
    この約束が果たせなかった。名簿の名前列と本体CSVの会場列は完全一致するとは
    限らない（`prev_rows.py` の `_venue_matches` が示すとおり events は約1/3が
    不一致）ので、一致しない分はこれまでどおり「調べる」側に残る——退行にはならない。
    """
    kind, _col = ROSTER_OF[name]
    path, key = roster.path_of(kind)
    if not os.path.exists(path):
        return
    _, rows = roster.load(path)
    for r in rows:
        place = (r.get(key) or "").strip()
        lat, lng = (r.get("lat") or "").strip(), (r.get("lng") or "").strip()
        if not place or not lat or not lng:
            continue
        slot = by_place.setdefault(place, {})
        slot.setdefault("lat", lat)
        slot.setdefault("lng", lng)


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

    # 座標だけは、前回・今回セッションのどちらにも無くても名簿から引ける
    # （駐車場・最寄り駅は名簿に列そのものが無いので、ここでは扱わない）。
    _fold_roster_coords(name, by_place)

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


def count_rows(path):
    if not os.path.exists(path):
        return 0
    with open(path, newline="", encoding="utf-8") as f:
        return max(0, sum(1 for _ in f) - 1)


def record_roster_hits(name, records):
    """書けた行の会場を、そのまま名簿の収穫として記録する。

    名簿に無い会場は「探索が名簿の外まで届いた」という成果でもあるので、
    黙って捨てずに挙げる（`roster.py --add` の候補になる）。
    """
    kind, col = ROSTER_OF[name]
    names = [(r.get(col) or "").strip() for r in records]
    names = [v.strip() for n in names for v in n.split("|") if v.strip()]
    if not names:
        return
    hits, misses = roster.record_hits(kind, names)
    if hits:
        print(f"  名簿 {kind} に収穫を記録: {len(hits)}件")
    if misses:
        uniq = list(dict.fromkeys(misses))
        print(f"  名簿 {kind} に無い会場 {len(uniq)}件: {'、'.join(uniq[:5])}"
              + ("…" if len(uniq) > 5 else "")
              + "\n    継続的に催しがある場所なら roster.py --add で名簿に入れてください",
              file=sys.stderr)


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

    check_enum_columns(name, records)

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

    # ここから先（名簿の収穫記録・進捗表示）は、上の write_rows() が終わったあとの
    # 付随処理である。CSVへの追記は既に成功しているので、ここで例外を外に漏らすと
    # 「◯件を追記しました」が出力済みなのにプロセスがトレースバックで終了し、
    # モデルが追記の失敗と誤解して同じ行を重複投入しかねない。付随処理は失敗しても
    # 追記そのものを失敗扱いにしない。
    try:
        record_roster_hits(name, records)
    except Exception as e:                                    # noqa: BLE001
        print(f"WARNING: 名簿の収穫記録に失敗しました（追記自体は成功しています）: "
              f"{type(e).__name__}: {e}", file=sys.stderr)

    # 進捗は、モデルに書かせるのをやめてここで出す。「途中で止まったときに
    # どこまで進んだかを人間が判別できる唯一の手がかり」と位置づけながら、
    # 実際には3回の実行を通じて1行も出ていなかった（`docs/DESIGN.md` 第9.3.1節）。
    # 追記が起きた事実はこのスクリプトが知っているので、ここで出せば必ず残る。
    try:
        budget.bump("rows", n=len(records))
        print(f"[進捗] 追記{len(records)}件（累計{count_rows(path)}件）/ "
              f"{budget.summary_line(budget.load()).removeprefix('[予算] ')}", file=sys.stderr)
    except Exception as e:                                    # noqa: BLE001
        print(f"WARNING: 進捗表示に失敗しました（追記自体は成功しています）: "
              f"{type(e).__name__}: {e}", file=sys.stderr)
    for i, title, uid_ in misses:
        print(f"  WARNING: {i}件目「{title}」は _carry を指定していますが、"
              f"前回に uid={uid_} の行がありません（新規行なら _carry は不要です）",
              file=sys.stderr)


if __name__ == "__main__":
    main()
