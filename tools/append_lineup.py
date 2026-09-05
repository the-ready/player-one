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

## `--rows` —— `lives.csv` の行と1回の呼び出しで書く（第9.3.9節）

上の使い方は、その公演の行が**先に** `lives.csv` にあることを前提にする
（`known_lineup_ids()` が今の `lives.csv` を読むため）。手順どおりなら
`append_rows.py lives` → `append_lineup.py` の2回の呼び出しに分かれ、
**その間でセッションが打ち切られると、`lineup_id` を書いた行だけが残り、
ラインナップが1件も無いままになる**（`validate_data.py` がERRORで捕まえる。
2026-09-04 に実際に起きた——`docs/DESIGN.md` 第12.12節）。

`lives.csv` 側の行がまだ無い（今回はじめて `lineup_id` を付ける）場合は、
`--rows` にその行のJSONL（`append_rows.py lives` に渡すのと同じ形）を渡すと、
**両方の検証が通ってから、両方を書く**（`lineups.csv` → `lives.csv` の順）。
検証と書き込みの間に呼び出しが1つも挟まらないので、打ち切りが割り込める窓は
実質的に無くなる。

    python3 tools/append_lineup.py --rows temp/rows-festivals.jsonl <<'EOF'
    {"lineup_id":"luckyfes-2026","date":"2026-08-08","stage":"RAINBOW STAGE","artist":"TUBE","is_headliner":"1"}
    EOF

`temp/rows-festivals.jsonl` 側に `lineup_id: "luckyfes-2026"` を持つ行が要る
（`lives.csv` にまだ無くても、この呼び出しの中でこれから書く行として数える）。
既に `lives.csv` にある行（前回から持ち越した `lineup_id`）に書き足すだけなら、
`--rows` は不要——今までどおり `--init` のあとにこのコマンドだけでよい。
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
import append_rows
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


def existing_lineup_ids():
    """`lineups.csv` に今すでに書かれている lineup_id。`--rows` の逆方向チェックで使う。

    `known_lineup_ids()` と向きが逆——あちらは「`lives.csv` が参照しているか」、
    こちらは「`lineups.csv` に実体があるか」を見る。
    """
    if not os.path.exists(PATH):
        return set()
    with open(PATH, newline="", encoding="utf-8") as f:
        return {
            (r.get("lineup_id") or "").strip()
            for r in csv.DictReader(f)
            if (r.get("lineup_id") or "").strip()
        }


def init_file():
    with open(PATH, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(HEADERS)
    print(f"{NAME} をヘッダーのみに初期化しました")


def parse_jsonl_stdin():
    records = []
    for i, line in enumerate((ln for ln in sys.stdin.read().splitlines() if ln.strip()), 1):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            raise SystemExit(f"ERROR: 標準入力の{i}行目のJSONを解析できませんでした: {e}")
        if not isinstance(obj, dict):
            raise SystemExit(f"ERROR: 標準入力の{i}行目がJSONオブジェクトではありません")
        records.append(obj)
    return records


def parse_jsonl_file(path):
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        raise SystemExit(f"ERROR: --rows で指定されたファイルを読めませんでした: {path!r} ({e})")
    records = []
    for i, line in enumerate((ln for ln in raw.splitlines() if ln.strip()), 1):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            raise SystemExit(f"ERROR: {path} の{i}行目のJSONを解析できませんでした: {e}")
        if not isinstance(obj, dict):
            raise SystemExit(f"ERROR: {path} の{i}行目がJSONオブジェクトではありません")
        records.append(obj)
    if not records:
        raise SystemExit(f"ERROR: --rows で指定されたファイルが空です: {path!r}")
    return records


def validate_records(records, known):
    """ラインナップの各行を検証する（書き込みはしない）。

    `known` に何を渡すかで単独モード（`lives.csv` の現在の内容）と `--rows` モード
    （それに今回書く行の lineup_id を足したもの）を切り替える——検証そのものは同じ。
    """
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
                f"ERROR: {i}件目の lineup_id={lid!r} は lives.csv のどの行も参照していません"
                "（--rows を渡したなら、そちらの行の lineup_id 列も確認してください）。"
                f"\n  先に該当のフェスの行の lineup_id 列に {lid!r} を入れてください"
                f"\n  （参照されていないラインナップは、収集は成功しても画面に出ません）"
                f"\n  参照中の lineup_id: {sorted(known)}"
            )


def write_records(records):
    exists = os.path.exists(PATH)
    with open(PATH, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if not exists:
            w.writerow(HEADERS)
        for r in records:
            w.writerow([str(r.get(h, "") or "") for h in HEADERS])


def summarize(records):
    by_fes = {}
    for r in records:
        by_fes[r["lineup_id"]] = by_fes.get(r["lineup_id"], 0) + 1
    return f"{len(records)}件を {NAME} に追記しました（{'／'.join(f'{k} {v}件' for k, v in by_fes.items())}）"


def report_progress(n):
    # 進捗はツールが出す（append_rows.py と同じ理由。モデルに書かせていた
    # `[進捗]` 行は、3回の実行を通じて1行も出なかった）。
    # 書き込みは既に終わっているので、ここで例外が出ても追記自体は失敗扱いにしない
    # （append_rows.py と同じ理由。tools/append_rows.py の該当コメントを参照）。
    try:
        print(f"[進捗] ラインナップ追記{n}件 / "
              f"{budget.summary_line(budget.load()).removeprefix('[予算] ')}", file=sys.stderr)
    except Exception as e:                                    # noqa: BLE001
        print(f"WARNING: 進捗表示に失敗しました（追記自体は成功しています）: "
              f"{type(e).__name__}: {e}", file=sys.stderr)


def main():
    args = sys.argv[1:]
    if "--init" in args:
        init_file()
        return

    rows_path = None
    if "--rows" in args:
        idx = args.index("--rows")
        if idx + 1 >= len(args):
            raise SystemExit("ERROR: --rows の後にファイルパス（temp/rows-*.jsonl）を指定してください")
        rows_path = args[idx + 1]

    records = parse_jsonl_stdin()
    if not records:
        raise SystemExit("ERROR: 標準入力からJSONLを読み込めませんでした（空です）")

    if rows_path is None:
        validate_records(records, known_lineup_ids())
        write_records(records)
        print(summarize(records))
        report_progress(len(records))
        return

    # --rows モード：`lives.csv` の行とこのラインナップを1回の呼び出しで書く
    # （第9.3.9節・`docs/DESIGN.md` 第12.12節）。**両方の検証が通るまで、
    # どちらのファイルにも書き込まない。**
    row_records = parse_jsonl_file(rows_path)
    row_lids = {(r.get("lineup_id") or "").strip() for r in row_records
                if (r.get("lineup_id") or "").strip()}

    # 1. ラインナップ側：既存 lives.csv に加え、今回これから書く行の lineup_id も
    #    「参照先」として認める（まだ lives.csv に無くても、この呼び出しの中で書くため）。
    validate_records(records, known_lineup_ids() | row_lids)

    # 2. 行側：バリデーション・持ち越し・ID採番だけ行う（書き込みはまだしない）。
    #    通常の `append_rows.py lives` と完全に同じ経路を使う——別の検証を
    #    書いて二重管理にしない。
    headers, path, row_records, filled, misses, regressions, start_id = \
        append_rows.prepare_records("lives.csv", row_records)

    # 3. 逆方向：今回書く行の lineup_id が、ラインナップにも既存 lineups.csv にも
    #    1件も無ければ落とす（=書いた瞬間にダングリング参照になる行を弾く）。
    #    validate_data.py が最終的に検査するのと同じ向き（第12.12節の表）を、
    #    書く前にここで先取りする。
    lineup_lids_now = {(r.get("lineup_id") or "").strip() for r in records}
    have_lineup = lineup_lids_now | existing_lineup_ids()
    dangling = [
        (r.get("title", "")[:30], (r.get("lineup_id") or "").strip())
        for r in row_records
        if (r.get("lineup_id") or "").strip() and (r.get("lineup_id") or "").strip() not in have_lineup
    ]
    if dangling:
        lines = "\n  ".join(f"{title!r}: lineup_id={lid!r}" for title, lid in dangling)
        raise SystemExit(
            "ERROR: 以下の行の lineup_id に対応するラインナップが、標準入力にも既存の "
            f"{NAME} にもありません（書くと『全◯組の日程を見る』ボタンが出ない行になります）:\n  "
            f"{lines}\n"
            "  対処: この行のぶんのラインナップを標準入力に含めるか、まだ書けないなら "
            "lineup_id を空欄にして --rows を使わず append_rows.py lives に渡してください。"
        )

    # ここまで来て初めて書き込む。lineups.csv → lives.csv の順にする理由は無い
    # （どちらも検証済みで、順序が結果を変えることは無い）が、`append_lineup.py`
    # 自身が扱うファイルを先に書くほうが読みやすいので、この順にしてある。
    write_records(records)
    append_rows.write_rows(path, headers, row_records)

    end_id = start_id + len(row_records) - 1
    print(summarize(records))
    print(f"{len(row_records)}件を lives.csv に追記しました（id: {start_id}〜{end_id}）")
    if any(filled.values()):
        print(f"  前回値から補完: 固定列{filled['always']} / 会場から{filled['by_place']} "
              f"/ 明示要求{filled['requested']}")

    try:
        append_rows.record_roster_hits("lives.csv", row_records)
    except Exception as e:                                    # noqa: BLE001
        print(f"WARNING: 名簿の収穫記録に失敗しました（追記自体は成功しています）: "
              f"{type(e).__name__}: {e}", file=sys.stderr)

    try:
        budget.bump("rows", n=len(row_records))
    except Exception as e:                                    # noqa: BLE001
        print(f"WARNING: 進捗表示に失敗しました（追記自体は成功しています）: "
              f"{type(e).__name__}: {e}", file=sys.stderr)
    report_progress(len(records))

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
