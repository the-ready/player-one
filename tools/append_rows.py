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

## 書き込みは upsert である（2026-09-26 に追記専用から変更）

uid（タイトル×会場×開始日）が既存行と一致すればその行を置き換え、無ければ末尾に足す。
**同じ催しを再収集しても行は増えない。** 以前は無条件に追記していたため、既にCSVに
ある催しを調べ直すたびに重複が生まれ、収集手順は「調べ終えてから前回行を書き戻す」
順序を強いられていた。詳しくは `write_rows()` の説明を参照。

置き換えは**行ごと**で、列ごとの重ね合わせではない。空欄で上書きして消す（料金が
無くなった・受付が終わった）という正当な操作を残すためである。消えては困る安定した
事実は下の CARRY_ALWAYS が受け持ち、それ以外の列が空になった更新は警告に出る。

## 持ち越し（carryover）

前回と同じ行を書き直すとき、座標・最寄り駅・駐車場のような**動かない事実**まで
毎回書き直すのは、出力トークンの無駄であると同時に写し間違いの機会でもある。
これらは前回値から自動で補う（CARRY_ALWAYS）。

一方、日付・料金・受付期間・クーポンは**持ち越してはならない**。
「前回の締切をそのまま書く」のは、このプロジェクトが一貫して禁じている
「確認していない値を書く」そのものだからである。指示文でのお願いではなく、
このスクリプトが受け付けないという形で担保する（CARRY_NEVER）。

その中間（note など）は、**行ごとに明示的に要求したときだけ**持ち越す。
内容に変更がないことを確認できた行では、こう書けばよい:

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
import carry_audit
import prev_rows as prevmod
import roster
from rowkey import uid as row_uid
from validate_data import DESC_MIN_LEN, EXPECTED_HEADERS, load_enums

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


# `prev_rows.py --worklist` / `--dispose` の一覧表示は、タイトル・会場名を
# 表示用に切り詰め、末尾に U+FFFD（REPLACEMENT CHARACTER）を置く（`_clip` 参照）。
# 実在のタイトルにこの文字が混じることは無いので、混じっていれば「一覧の
# 表示用の値をそのまま書き戻した」ことの機械的な証拠になる。
#
# 2026-08-29 の実行では、`--worklist` が34字に切り詰めた表示用タイトルが
# そのまま新しい行として書き戻され、同じ催しが「省略された表記の新規行」と
# 「正しい表記の持ち越し行」の二重掲載になった。`…`（正当なタイトルの末尾にも
# 現れうる記号）ではなく機械的に判別できる文字を切り詰めの目印にすることで、
# この経路をここで止める。
TRUNCATION_MARKER = "�"
TITLE_LIKE_COLUMNS = ("title", "venue", "theater", "desc")


def check_truncated_values(name, records):
    bad = []
    for i, obj in enumerate(records, start=1):
        for col in TITLE_LIKE_COLUMNS:
            v = obj.get(col)
            if v and TRUNCATION_MARKER in v:
                bad.append(f"{i}件目 {col}={v!r}")
    if bad:
        raise SystemExit(
            "ERROR: 表示用に切り詰められた値（末尾が \\ufffd）がそのまま書かれようと"
            "しています。`prev_rows.py --worklist` 等の一覧出力は表示用に34〜40字へ"
            "切り詰めてあり、書き戻す値ではありません。`prev_rows.py <ds> --uid <uid>` "
            "で全列を引き直してください:\n  " + "\n  ".join(bad)
        )


# 空欄なら黙って前回値で埋める列。読み・座標・アクセスなど、時間で変わらないもの。
# lineup_id（フェスの日割りラインナップの参照キー）もここに入る。値は書き手が決めた
# スラッグで、その週の調査で変わるものではない——毎週書き直させると綴りが揺れ、
# lineups.csv 側との参照が静かに切れる（validate_data.py がERRORで捕まえる）。
#
# desc もここに入れている。催しの中身の説明は会期中に変わるものではなく、SKILL.md も
# 「内容に変更が無ければ書き直さず持ち越す」と既に指示している。既定で持ち越せば、
# 子が `_carry` を書き忘れても失われない——2026-09-26 の回で、重複していた2行のうち
# desc を持つ側が消え、持たない側が残って説明文が4件失われた。`_no_carry` で
# 明示的に止められるので、意図して空にする道は残っている。
# cats / area / official_url も同じ理由でここに入れている。催しの分類・エリア・公式
# ページは会期中に動かない事実で、子が書き忘れたときに**前回値を消してよい理由が無い**。
# upsert にしたことで、書き忘れは「疎な重複行が増える」ではなく「既存行の列が消える」
# という壊れ方に変わった（2026-09-26 のシミュレーションで、cats/area/official_url が
# 検証をすり抜けて失われることを確認した）。
CARRY_ALWAYS = (["kana", "lineup_id", "desc", "cats", "area", "official_url"]
                + VENUE_FACTS)

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

# `_no_carry` は「この列は前回値で埋めないでほしい」という指定。CARRY_ALWAYS を
# 行単位で打ち消す唯一の手段である。
#
# 必要になったのは `lineup_id` のためである。この列は CARRY_ALWAYS に入っていて
# （毎週書き直させると綴りが揺れ、lineups.csv との参照が静かに切れるため）、
# 空で渡しても前回値が埋め直される。ふだんはそれが正しい——公演行は手順9で、
# 日割りは手順13.5で書くので、**追記の時点で参照先がまだ無いのは普通のこと**
# であり、ここで参照先の有無を見て落とすと正常な収集を壊す。
#
# 例外は `prev_rows.py --carry-rest` で、あれは「もう何も書かれない」と分かって
# いる終了工程から呼ばれる。そこで参照先を失った lineup_id を残すと
# validate_data.py が「対応する行が lineups.csv に1件もありません」でERRORにし、
# **持ち越しがその週の収穫ごと落とす**。呼び出し側が文脈を知っているので、
# 判断を呼び出し側に持たせる。
CONTROL_KEYS = {"_carry", "_carry_from", "_no_carry"}


def resolve_filename(arg):
    if arg in NAME_MAP:
        return NAME_MAP[arg]
    if arg in EXPECTED_HEADERS:
        return arg
    raise SystemExit(
        f"ERROR: 不明なデータセット名です: {arg!r}（events / lives / movies のいずれかを指定してください）"
    )


def read_current_rows(path):
    """いまのCSVの行を、ファイルの順序のまま返す。"""
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def index_by_uid(name, rows):
    """uid -> その uid を持つ行の位置（複数ありうる）。

    同じ uid が複数あるのは、過去に追記専用だった頃に作られた重複である。
    ここでは潰さず、最初の1行だけを更新の対象にして、残りは呼び出し側が
    警告として報告する——黙って消すと、追記の道具が予告なく行を削ることになる。
    """
    idx = {}
    for i, r in enumerate(rows):
        idx.setdefault(row_uid(name, r), []).append(i)
    return idx


def read_last_id(path):
    """既存行の id の最大値を返す。

    以前は「最後の行の id」を見ていた。追記専用だった頃はそれで最大値と一致したが、
    uid が一致する行をその場で更新するようになると、末尾の行が必ずしも最大 id を
    持つとは限らない。最大値を取れば、どちらの書き方でも id が衝突しない。
    """
    rows = read_current_rows(path)
    if not rows:
        return 0
    best = 0
    for r in rows:
        try:
            best = max(best, int((r.get("id") or "0").strip() or 0))
        except ValueError:
            continue
    return best


def init_file(name, path, headers):
    # `--init` は収集の開始点そのものなので、予算の計測もここで数え直す。
    # budget.py は12時間で自動的に数え直すが、明示的な起点があるならそちらが正しい
    # （同じ日に2回走らせたとき、前半の消費が後半に混ざらない）。
    budget.reset()
    # reset() の直後に置く（reset() は状態を空にするので、順序を逆にすると消える）。
    # 「この回は収集の開始点を通った」という事実だけを残し、run_gate.py が見る。
    budget.mark_init(name)
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
    """uid が既存行と一致すればその行を置き換え、無ければ末尾に足す（upsert）。

    返り値は `(inserted, updated, dup_uids)`。`dup_uids` は「同じ uid の行が
    もともと複数あって、最初の1行だけを更新した」uid の一覧である。

    ## なぜ追記専用をやめたのか

    以前はファイルを `"a"` で開いて無条件に書き足していた。そのため、既にCSVに
    ある催しを再収集すると**必ず重複行が増えた**（2026-09-26 の回で、Claude 自身が
    「append_rows.py はCSV内の既存行とは照合しない」と気づき、追記した4行を
    `sed` で消している）。このため収集手順は「調べ終えてから前回行を書き戻す」
    という順序を強いられ、予算が尽きた回では大量の行が未確認のまま最後に
    流れ込んでいた。uid で突き合わせて更新できれば、先に前回行を全部書き戻して
    から調査を上積みできる（docs/DESIGN.md 第9.3節）。

    ## 置き換えは「行ごと」であって「列ごと」ではない

    既存行に新しい値を重ねるのではなく、**新しい行で丸ごと置き換える**。
    持ち越したい列は CARRY_ALWAYS と `_carry` が既に埋めているので、ここで
    さらに「空欄なら既存値を残す」を足すと、**空欄で上書きして消す**という
    正当な操作（料金が無くなった・受付が終わった）ができなくなる。
    「確認できないものは空欄」という規則と噛み合わなくなるため、行ごとに置く。
    """
    name = os.path.basename(path)
    rows = read_current_rows(path)
    idx = index_by_uid(name, rows) if rows else {}

    inserted, updated, dup_uids = 0, 0, []
    for row in records:
        out = {h: row.get(h, "") for h in headers}
        u = row_uid(name, out)
        at = idx.get(u)
        if at:
            rows[at[0]] = out
            updated += 1
            if len(at) > 1 and u not in dup_uids:
                dup_uids.append(u)
        else:
            rows.append(out)
            # 同じ波の中で同じ uid が2度来たら、2度目は1度目を更新する
            idx[u] = [len(rows) - 1]
            inserted += 1

    # 書き出しは一時ファイル経由で置き換える。全体を書き直す以上、途中で落ちると
    # CSVそのものを失う——追記だったころは最悪でも末尾の1行が欠けるだけだった。
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(headers)
        for row in rows:
            w.writerow([row.get(h, "") for h in headers])
    os.replace(tmp, path)
    return inserted, updated, dup_uids


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

    # **いまのCSVにある行を、前回スナップショットより優先する。**
    # 今週この行を既に書いている（前の波が新しく見つけた催しなど）なら、持ち越しの
    # 供給元はそちらでなければならない。前回だけを見ていると、今週の波1が書いた
    # desc を波2の再収集が消してしまう——`.prev/` にその行は無いので持ち越せない。
    if current_path and os.path.exists(current_path):
        for r in read_current_rows(current_path):
            by_uid[row_uid(name, r)] = r

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
    regressions = []

    for i, row in enumerate(records, start=1):
        requested = resolve_carry_request(row.pop("_carry", None), headers, i)
        blocked = {c.strip() for c in str(row.pop("_no_carry", "") or "").split("|") if c.strip()}
        src_uid = (row.pop("_carry_from", "") or "").strip() or row_uid(name, row)
        src = by_uid.get(src_uid)

        for col in CARRY_ALWAYS:
            if col not in headers or col in blocked or (row.get(col) or "").strip():
                continue
            if src and (src.get(col) or "").strip():
                row[col] = src[col].strip()
                filled["always"] += 1

        # 会期が変わって uid がずれても、会場の座標や最寄り駅は同じ会場の別行から引ける
        place = (row.get(place_col) or "").strip()
        if place in by_place:
            for col in VENUE_FACTS:
                if (col in headers and col not in blocked
                        and not (row.get(col) or "").strip() and col in by_place[place]):
                    row[col] = by_place[place][col]
                    filled["by_place"] += 1

        if requested:
            if not src:
                misses.append((i, row.get("title", "")[:30], src_uid))
                continue
            for col in requested:
                if col in blocked:
                    continue
                if not (row.get(col) or "").strip() and (src.get(col) or "").strip():
                    row[col] = src[col].strip()
                    filled["requested"] += 1

        # desc の劣化検知。2026-08-30 に実データで見つかった実例（「ロン・ミュエク」
        # 91字→11字、「のげやまマルシェ」106字→29字など21件）: 内容は変わって
        # いないのに、会場の一覧ページの一文などで desc が書き直され、前回までの
        # 具体的な説明より大幅に短い一般論に置き換わっていた。`_carry` は空欄の列
        # にしか効かない（このメソッドの上のブロック）ので、モデルが何か書けば
        # それだけで前回の良い値を上書きできてしまい、悪化する方向の書き直しを
        # 誰も止めていなかった。半分未満に縮んだ場合だけを拾う——多少の言い回しの
        # 変更まで拾うと、正当な書き直しにまで警告が付いて読まれなくなる。
        #
        # **新しい値が空のときこそ拾う。** 以前は `new_desc and` を条件に入れていたため、
        # 89字→40字（短縮）は警告されるのに 89字→空（全損）は素通りしていた。軽い劣化を
        # 止めて重い劣化を見逃す、逆向きの守り方になっていた。desc を CARRY_ALWAYS に
        # 入れた今、空で渡した行は前回値が自動で入るのでここには来ない——来るのは
        # `_no_carry` で持ち越しを止めたうえで空にした行だけで、それは警告に値する。
        if "desc" in headers and src:
            new_desc = (row.get("desc") or "").strip()
            old_desc = (src.get("desc") or "").strip()
            if (old_desc and len(old_desc) >= DESC_MIN_LEN
                    and len(new_desc) < len(old_desc) * 0.5):
                regressions.append((i, row.get("title", "")[:30], len(old_desc), len(new_desc)))

    return filled, misses, regressions


def count_rows(path):
    if not os.path.exists(path):
        return 0
    with open(path, newline="", encoding="utf-8") as f:
        return max(0, sum(1 for _ in f) - 1)


def _prefix_variant_of(miss, roster_names):
    """`miss` が、既に名簿にある名前の表記ゆれ（互いに前方一致）である可能性を返す。

    見つかれば名簿側の名前を返し、無ければ None。**自動では書き換えない**——
    前方一致だけで同一施設と決め打つと、たまたま前方一致する別施設
    （例: 「東京タワー」と「東京タワーシティ」）を誤って同一視しかねない。
    ここでの役目は、モデルに気づかせて `roster.py --list` で確認させることまで。

    2026-08-29 に実データで見つかった実例: 名簿には「ワーナー ブラザース
    スタジオツアー東京」が登録済みなのに、収集した行は「ワーナー ブラザース
    スタジオツアー東京 メイキング・オブ ハリー・ポッター」という表記で書かれ、
    名簿には無い会場として扱われた。結果、同じ施設の同じ催しが、週をまたいで
    2つの異なる `venue` 表記＝2つの異なる uid で重複登録された
    （`docs/DESIGN.md` 第3.4.1節・`data/events.csv` の実例を参照）。
    """
    n = roster._norm(miss)
    for r in roster_names:
        rn = roster._norm(r)
        if not rn or rn == n:
            continue
        if n.startswith(rn) or rn.startswith(n):
            return r
    return None


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
        try:
            path, _key = roster.path_of(kind)
            _head, roster_rows = roster.load(path)
            roster_names = [r.get(_key) for r in roster_rows if r.get(_key)]
        except (SystemExit, OSError):
            roster_names = []
        for miss in uniq:
            variant_of = _prefix_variant_of(miss, roster_names)
            if variant_of:
                print(f"  WARNING: {kind!r} の {miss!r} は名簿の {variant_of!r} と"
                      "同じ施設の表記ゆれの可能性があります。別施設なら無視してよいですが、"
                      "同じ施設なら venue/theater を名簿の表記に揃えてください"
                      "——揃えないと、同じ催しが2つの異なる uid で二重掲載されます。",
                      file=sys.stderr)


def prepare_records(name, records):
    """検証・持ち越し・ID採番までを行い、書き込み直前の `records` を返す（書き込みはしない）。

    `main()` の本体と、他ツールからの合成呼び出し（`append_lineup.py --rows`。
    第9.3.9節・`docs/DESIGN.md` 第12.12節）の両方から使う。**書き込みを持たない**のが
    要点で、呼び出し側は「ここまでのバリデーションが全部通ったこと」を確認してから
    `write_rows()` を呼べる。バリデーションを通す前に一部だけ書いてしまうと、
    複数ファイルにまたがる合成書き込みで「片方だけ書けた」状態を作りかねない。
    """
    headers = EXPECTED_HEADERS[name]
    path = os.path.join(DATA, name)

    for i, obj in enumerate(records, start=1):
        unknown = [k for k in obj if k not in headers and k not in CONTROL_KEYS]
        if unknown:
            print(f"WARNING: {i}件目に {name} にない列があります（無視します）: {unknown}", file=sys.stderr)

    check_enum_columns(name, records)
    check_truncated_values(name, records)

    by_uid, by_place = build_prev_index(name, headers, current_path=path)
    filled, misses, regressions = apply_carryover(name, headers, records, by_uid, by_place)

    # id の採番。**既存 uid の行は、その行が既に持っている id を保つ。**
    # upsert で同じ行を更新するのに id を振り直すと、id が毎週飛び回って
    # 「この行は先週と同じか」を人が目で追えなくなる。新しい uid の行にだけ、
    # 既存の最大 id の次から順に振る。
    cur_rows = read_current_rows(path)
    cur_idx = index_by_uid(name, cur_rows) if cur_rows else {}
    next_id = read_last_id(path) + 1
    start_id = next_id
    for row in records:
        at = cur_idx.get(row_uid(name, row))
        if at:
            row["id"] = (cur_rows[at[0]].get("id") or "").strip() or str(next_id)
            if not (cur_rows[at[0]].get("id") or "").strip():
                next_id += 1
        else:
            row["id"] = str(next_id)
            next_id += 1

    # **更新が、値のあった列を空にしていないか。**
    # upsert は行ごと置き換えるので、子が列を書き忘れるとその列は消える。
    # 日付・料金・受付（CARRY_NEVER）は「確認できなければ空欄」が正しい書き方なので
    # 除く——そこまで警告すると、正当な更新のたびに鳴って読まれなくなる。
    watched = [h for h in headers if h not in CARRY_NEVER and h != "id"]
    for i, row in enumerate(records, start=1):
        at = cur_idx.get(row_uid(name, row))
        if not at:
            continue
        old = cur_rows[at[0]]
        gone = [c for c in watched
                if (old.get(c) or "").strip() and not (row.get(c) or "").strip()]
        if gone:
            print(f"  WARNING: {i}件目「{(row.get('title') or '')[:30]}」の更新で "
                  f"{gone} が空になりました。書き忘れなら `_carry` で持ち越してください",
                  file=sys.stderr)

    return headers, path, records, filled, misses, regressions, start_id


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

    # 「前回CSVの言い換え」の判定は、`prepare_records()` **より前**に取る。
    # `apply_carryover()` が `_carry` を pop してしまうので、あとからでは数えられない。
    # 出力は追記が成功したあと（下）に回す——ここで出すと、追記が失敗した波にも
    # 警告だけが残って、何が起きたのかが読みにくくなる。
    try:
        carry_warning = carry_audit.audit(name, records)
    except Exception as e:                                    # noqa: BLE001
        carry_warning = None
        print(f"WARNING: 持ち越しの監査に失敗しました（追記には影響しません）: "
              f"{type(e).__name__}: {e}", file=sys.stderr)

    headers, path, records, filled, misses, regressions, start_id = prepare_records(name, records)
    inserted, updated, dup_uids = write_rows(path, headers, records)

    if updated:
        print(f"{len(records)}件を {name} に書きました（新規{inserted}件・既存の更新{updated}件）")
    else:
        print(f"{inserted}件を {name} に追記しました（id: {start_id}〜{start_id + inserted - 1}）")
    for u in dup_uids:
        print(f"  WARNING: uid={u} の行がCSVに複数あります。最初の1行だけを更新しました"
              f"（残りは消していません。重複の解消は別工程で行ってください）", file=sys.stderr)
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
    if carry_warning:
        print(f"  WARNING: {carry_warning}", file=sys.stderr)

    for i, title, uid_ in misses:
        print(f"  WARNING: {i}件目「{title}」は _carry を指定していますが、"
              f"前回に uid={uid_} の行がありません（新規行なら _carry は不要です）",
              file=sys.stderr)
    for i, title, old_len, new_len in regressions:
        print(f"  WARNING: {i}件目「{title}」は desc が前回({old_len}字)より大幅に短く"
              f"({new_len}字)なっています。内容に変更が無いなら書き直さず "
              '_carry に "desc" を含めて持ち越してください'
              "（会場の一覧ページの一文だけで上書きしていないか確認）",
              file=sys.stderr)


if __name__ == "__main__":
    main()
