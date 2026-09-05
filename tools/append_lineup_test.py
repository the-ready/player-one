#!/usr/bin/env python3
"""`tools/append_lineup.py` の検証と、`--rows`（合成書き込み）の安全性を確認する
（ネットワーク不要）。

    python3 tools/append_lineup_test.py

## なぜ念入りにやるか

2026-09-04 の lives 収集は、`lives.csv` に `lineup_id` を書いた行だけが残り、
対応する `lineups.csv` の行が1件も無いまま打ち切られた（両者はそれぞれ独立した
コマンド呼び出しで、間に何ターンも挟まる）。`--rows` はこの2つの書き込みを
1回の呼び出しに近づけるためのものだが、**合成した分だけ壊し方も増える**——
とくに重要なのは「検証のどちらかが落ちたとき、もう片方のファイルも無傷である」
ことで、ここを間違えると「調べたのに中途半端にしか残らない」という、
まさに今回塞ごうとしている事故を合成モード自身が起こしかねない。
"""

import contextlib
import csv
import io
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import append_lineup as al                                    # noqa: E402
import append_rows as ar                                      # noqa: E402
import budget                                                 # noqa: E402
import prev_rows as pr                                        # noqa: E402
import roster                                                 # noqa: E402


# ---------------------------------------------------------------- unit（検証だけ）

def check_validate_accepts_known():
    try:
        al.validate_records(
            [{"lineup_id": "fes-a", "artist": "TUBE"}], known={"fes-a"})
    except SystemExit as e:
        return f"既知の lineup_id なのに拒否した: {e}"
    return True


def check_validate_rejects_unknown():
    try:
        al.validate_records(
            [{"lineup_id": "fes-x", "artist": "TUBE"}], known={"fes-a"})
    except SystemExit:
        return True
    return "未知の lineup_id を通してしまった"


def check_validate_rejects_missing_lineup_id():
    try:
        al.validate_records([{"artist": "TUBE"}], known=set())
    except SystemExit:
        return True
    return "lineup_id が空でも通してしまった"


def check_validate_rejects_missing_artist():
    try:
        al.validate_records([{"lineup_id": "fes-a"}], known={"fes-a"})
    except SystemExit:
        return True
    return "artist が空でも通してしまった"


UNIT_CHECKS = [
    ("既知の lineup_id は通す", check_validate_accepts_known),
    ("未知の lineup_id は拒否する", check_validate_rejects_unknown),
    ("lineup_id 欠落は拒否する", check_validate_rejects_missing_lineup_id),
    ("artist 欠落は拒否する", check_validate_rejects_missing_artist),
]


# ---------------------------------------------------------------- integration

LIVES_HEADERS = [
    "id", "tour_id", "title", "kana", "artists", "genre", "live_type", "area", "venue",
    "venue_url", "pref", "start_date", "end_date", "date", "dates", "open_time",
    "start_time", "end_time", "date_note", "backup_date", "status", "rank",
    "announced_date", "is_additional", "onsale_label", "onsale_start",
    "onsale_start_time", "onsale_end", "onsale_end_time", "limited_sale", "price",
    "source", "url", "official_url", "lat", "lng", "desc", "note", "parking",
    "nearest_station", "apple_music_url", "lineup_id",
]


def _write_csv(path, headers, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(headers)
        for r in rows:
            w.writerow([r.get(h, "") for h in headers])


def call_main(argv, stdin_text):
    """`al.main()` をプロセスを分けずに呼び、(SystemExitのcode, stdout, stderr) を返す。

    `raise SystemExit("ERROR: ...")` はこのリポジトリ全体の規約（メッセージは
    `.code` に文字列として乗る。標準の `sys.exit()` と同じ挙動）。
    """
    orig_argv, orig_stdin = sys.argv, sys.stdin
    sys.argv = ["append_lineup.py"] + argv
    sys.stdin = io.StringIO(stdin_text)
    out, err = io.StringIO(), io.StringIO()
    code = None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            al.main()
    except SystemExit as e:
        code = e.code
    finally:
        sys.argv, sys.stdin = orig_argv, orig_stdin
    return code, out.getvalue(), err.getvalue()


def run_integration():
    fails = 0
    checks = 0
    tmp = tempfile.mkdtemp(prefix="append_lineup_test_")
    prev_dir = os.path.join(tmp, ".prev")
    run_dir = os.path.join(tmp, ".run")
    os.makedirs(prev_dir, exist_ok=True)
    os.makedirs(run_dir, exist_ok=True)

    # このテストが触ってよいのは tmp の中だけにする。budget.py はモジュール独自の
    # ROOT を持つ（`tools/budget.py` 自身の場所から辰く）ので、STATE 系も
    # 明示的に差し替えないと実行中の本物の data/.run/budget.json を書き換えてしまう。
    orig = (al.DATA, al.PATH, al.LIVES, ar.DATA, pr.DATA, pr.PREV, roster.DATA,
            budget.STATE_DIR, budget.STATE, budget.LOCK, budget.TOKEN_SAMPLE)
    al.DATA = tmp
    al.PATH = os.path.join(tmp, "lineups.csv")
    al.LIVES = os.path.join(tmp, "lives.csv")
    ar.DATA = tmp
    pr.DATA = tmp
    pr.PREV = prev_dir
    roster.DATA = tmp
    budget.STATE_DIR = run_dir
    budget.STATE = os.path.join(run_dir, "budget.json")
    budget.LOCK = budget.STATE + ".lock"
    budget.TOKEN_SAMPLE = os.path.join(run_dir, "token_sample.json")

    def snapshot():
        """lives.csv / lineups.csv の現在の中身（無ければ None）。書き込みが
        『全部か・無か』になっているかを、この前後比較だけで確認する。"""
        def _read(path):
            if not os.path.exists(path):
                return None
            with open(path, newline="", encoding="utf-8") as f:
                return list(csv.DictReader(f))
        return _read(al.LIVES), _read(al.PATH)

    try:
        _write_csv(al.LIVES, LIVES_HEADERS, [])
        _write_csv(al.PATH, al.HEADERS, [])

        # --- 1. --rows: 行とラインナップを両方はじめて書く（成功） ---------------
        checks += 1
        rows_path = os.path.join(tmp, "rows-festivals.jsonl")
        with open(rows_path, "w", encoding="utf-8") as f:
            f.write('{"title": "LuckyFes 26", "venue": "国営ひたち海浜公園", "pref": "ibaraki", '
                    '"start_date": "2026-08-08", "end_date": "2026-08-09", '
                    '"genre": "rock", "live_type": "fes", "lineup_id": "luckyfes-2026"}\n')
        lineup_stdin = ('{"lineup_id":"luckyfes-2026","date":"2026-08-08",'
                        '"stage":"RAINBOW STAGE","artist":"TUBE","is_headliner":"1"}\n')
        code, out, err = call_main(["--rows", rows_path], lineup_stdin)
        if code is not None:
            print(f"✗ --rows の正常系が失敗した: code={code} err={err}")
            fails += 1
        else:
            lives_rows, lineup_rows = snapshot()
            if not lives_rows or lives_rows[0]["lineup_id"] != "luckyfes-2026":
                print(f"✗ lives.csv に行が書かれていない: {lives_rows}")
                fails += 1
            elif not (lives_rows[0].get("id") or "").strip():
                print("✗ lives.csv の行に id が採番されていない")
                fails += 1
            if not lineup_rows or lineup_rows[0]["artist"] != "TUBE":
                print(f"✗ lineups.csv に行が書かれていない: {lineup_rows}")
                fails += 1

        # --- 2. --rows: 2件のうち1件だけ、行の lineup_id に対応するラインナップが
        #     無い（拒否）。もう1件（has-data-2026）は標準入力と噛み合っており、
        #     ラインナップ側の検証（1.）だけでは検出できない——行側からの逆向きの
        #     チェック（3.）で初めて捕まる組み合わせにしてある。 -----------------
        checks += 1
        before = snapshot()
        rows_path2 = os.path.join(tmp, "rows-festivals2.jsonl")
        with open(rows_path2, "w", encoding="utf-8") as f:
            f.write('{"title": "データがあるフェス", "venue": "会場A", "pref": "tokyo", '
                    '"start_date": "2026-09-01", "end_date": "2026-09-02", '
                    '"genre": "rock", "live_type": "fes", "lineup_id": "has-data-2026"}\n')
            f.write('{"title": "データが無いフェス", "venue": "会場B", "pref": "tokyo", '
                    '"start_date": "2026-09-05", "end_date": "2026-09-06", '
                    '"genre": "rock", "live_type": "fes", "lineup_id": "no-data-2026"}\n')
        code, out, err = call_main(["--rows", rows_path2],
                                    '{"lineup_id":"has-data-2026","artist":"X"}\n')
        if code is None:
            print("✗ 対応ラインナップの無い行（no-data-2026）を --rows が通してしまった")
            fails += 1
        elif "no-data-2026" not in str(code):
            print(f"✗ エラーに該当の lineup_id が書かれていない: {code}")
            fails += 1
        after = snapshot()
        if after != before:
            print("✗ 拒否したはずなのに、lives.csv / lineups.csv のどちらかが書き換わっている"
                  "（全部か無かになっていない＝ダングリング参照を作りうる。has-data-2026 側だけ"
                  "書けてしまっていないか）")
            fails += 1

        # --- 3. --rows: ラインナップ側が未知の lineup_id を持つ（拒否） ----------
        checks += 1
        before = snapshot()
        rows_path3 = os.path.join(tmp, "rows-festivals3.jsonl")
        with open(rows_path3, "w", encoding="utf-8") as f:
            f.write('{"title": "別のフェス", "venue": "別会場", "pref": "tokyo", '
                    '"start_date": "2026-09-10", "end_date": "2026-09-11", '
                    '"genre": "rock", "live_type": "fes", "lineup_id": "betsu-fes-2026"}\n')
        code, out, err = call_main(["--rows", rows_path3],
                                    '{"lineup_id":"mikichi-fes-2026","artist":"Y"}\n')
        if code is None:
            print("✗ 未知の lineup_id を持つラインナップを --rows が通してしまった")
            fails += 1
        after = snapshot()
        if after != before:
            print("✗ 拒否したはずなのに、lives.csv / lineups.csv のどちらかが書き換わっている")
            fails += 1

        # --- 4. 単独モード（--rows 無し）は今までどおり動く（回帰確認） ----------
        checks += 1
        # 前提: lives.csv には手順1で書いた luckyfes-2026 の行が既にある
        code, out, err = call_main(
            [], '{"lineup_id":"luckyfes-2026","date":"2026-08-09","artist":"影山ヒロノブ"}\n')
        if code is not None:
            print(f"✗ 単独モードの正常系が失敗した: code={code} err={err}")
            fails += 1
        else:
            _, lineup_rows = snapshot()
            names = [r["artist"] for r in lineup_rows]
            if "影山ヒロノブ" not in names:
                print(f"✗ 単独モードで追記されていない: {names}")
                fails += 1

        checks += 1
        code, out, err = call_main([], '{"lineup_id":"mikansei","artist":"Z"}\n')
        if code is None:
            print("✗ 単独モードで、未参照の lineup_id を通してしまった（既存挙動の回帰）")
            fails += 1

    finally:
        (al.DATA, al.PATH, al.LIVES, ar.DATA, pr.DATA, pr.PREV, roster.DATA,
         budget.STATE_DIR, budget.STATE, budget.LOCK, budget.TOKEN_SAMPLE) = orig
        shutil.rmtree(tmp, ignore_errors=True)

    return fails, checks


def main():
    fails = 0
    for name, fn in UNIT_CHECKS:
        try:
            got = fn()
        except Exception as e:                                # noqa: BLE001
            got = f"{type(e).__name__}: {e}"
        if got is not True:
            print(f"✗ {name}\n    {got}")
            fails += 1
    int_fails, int_total = run_integration()
    fails += int_fails
    total = len(UNIT_CHECKS) + int_total
    print(f"\n{total - fails}/{total} 件が期待どおり")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
