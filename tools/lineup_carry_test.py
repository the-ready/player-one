#!/usr/bin/env python3
"""フェスの日割り（`data/lineups.csv`）が週をまたいで消えないことを検証する（ネットワーク不要）。

    python3 tools/lineup_carry_test.py

2026-10-23 の lives 収集は、開催前の4本のフェスについて、日割りを1本も調べ直さないまま
終わった。手順どおりに `append_lineup.py --init` で `lineups.csv` を空にし、
`prev_rows.py --carry-rest` でフェス行を前回値のまま書き戻した。しかし、日割りは
持ち越さない設計だった。その結果、書き戻した4行すべてから `lineup_id` が外れ、
カードの「全◯組の日程を見る」ボタンが消えた。検証も通っていた
（参照先の無い `lineup_id` は外してあるので、不整合が無い）。

このテストは、1週分の工程（`--init` → `--carry-rest` → 一部のフェスだけ調べ直す）を
一時ディレクトリで再現し、次の約束を固定する。

  1. 調べ直さなかったフェスは、日割りも `lineup_id` も前回のまま残る
  2. 調べ直したフェスは、日割りが丸ごと今週分に差し替わる（前回分と二重にならない）
  3. 終わったフェスの日割りは戻さない
  4. 同じ回の再 `--init` で、退避した前回分を空で上書きしない
  5. 何週も前の退避は使わない（その回の `--init` を通っていない）

`append_rows.py` の実プロセスは起動しない（`prev_rows_test.py` の
`_stub_subprocess_run` と同じ理由。起動すると実リポジトリの `data/` に書く）。
"""

import csv
import io
import contextlib
import json
import os
import sys
import tempfile
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import append_lineup as al                                    # noqa: E402
import prev_rows as pr                                        # noqa: E402
from validate_data import EXPECTED_HEADERS                    # noqa: E402

TODAY = date(2026, 10, 23)
LIVES_HEADERS = EXPECTED_HEADERS["lives.csv"]
LINEUP_HEADERS = EXPECTED_HEADERS["lineups.csv"]

failures = []


def check(name, ok, detail=""):
    print(f"{'  ok  ' if ok else '  NG  '} {name}{('  — ' + detail) if detail and not ok else ''}")
    if not ok:
        failures.append(name)


class Args:
    def __init__(self, **kw):
        self.today = TODAY
        self.apply = True
        self.force = False
        self.dataset = "lives"
        for k, v in kw.items():
            setattr(self, k, v)


def _write_csv(path, headers, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(headers)
        for r in rows:
            w.writerow([r.get(h, "") for h in headers])


def _read(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def fes(title, lid, start, end):
    return {"title": title, "venue": "会場", "pref": "chiba", "live_type": "fes",
            "start_date": start, "end_date": end, "lineup_id": lid}


def lineup(lid, day, *artists):
    return [{"lineup_id": lid, "date": day, "stage": "MAIN", "artist": a} for a in artists]


class Week:
    """一時ディレクトリに「先週の data/」を作り、今週の工程を流す。"""

    def __init__(self, prev_lives, prev_lineups):
        self.tmp = tempfile.mkdtemp(prefix="lineup_carry_test_")
        self.prev = os.path.join(self.tmp, ".prev")
        os.makedirs(self.prev, exist_ok=True)
        self.orig = (al.DATA, al.PATH, al.LIVES, pr.DATA, pr.PREV, pr.subprocess.run)
        al.DATA = pr.DATA = self.tmp
        al.PATH = os.path.join(self.tmp, "lineups.csv")
        al.LIVES = os.path.join(self.tmp, "lives.csv")
        pr.PREV = self.prev
        self.payloads = []
        pr.subprocess.run = self._fake_append_rows
        _write_csv(al.LIVES, LIVES_HEADERS, prev_lives)
        _write_csv(al.PATH, LINEUP_HEADERS, prev_lineups)
        self.prev_lives = prev_lives

    def _fake_append_rows(self, cmd, input=None, text=None, cwd=None, env=None):
        """append_rows.py の代わり。渡された行を lives.csv に足すだけ（列の持ち越しはしない）。"""
        self.payloads.append(input)
        rows = _read(al.LIVES)
        for line in (input or "").splitlines():
            if line.strip():
                obj = json.loads(line)
                rows.append({h: obj.get(h, "") for h in LIVES_HEADERS})
        _write_csv(al.LIVES, LIVES_HEADERS, rows)

        class Done:
            returncode = 0
        return Done()

    def init(self, today=TODAY):
        """append_rows.py lives --init と append_lineup.py --init に当たる工程。"""
        _write_csv(os.path.join(self.prev, "lives.csv"), LIVES_HEADERS, self.prev_lives)
        with open(os.path.join(self.prev, "lives.meta.json"), "w", encoding="utf-8") as f:
            json.dump({"taken_at": today.isoformat(), "rows": len(self.prev_lives)}, f)
        _write_csv(al.LIVES, LIVES_HEADERS, [])
        with contextlib.redirect_stdout(io.StringIO()):
            al.init_file()
        # 退避の日付は実行日（date.today()）で記録される。基準日 TODAY にそろえる
        # （そろえないと、このテストを走らせる日によって「古い退避」と判定される）
        if os.path.exists(pr.lineups_meta_path()):
            with open(pr.lineups_meta_path(), encoding="utf-8") as f:
                meta = json.load(f)
            meta["taken_at"] = today.isoformat()
            with open(pr.lineups_meta_path(), "w", encoding="utf-8") as f:
                json.dump(meta, f)

    def carry_rest(self, today=TODAY):
        rows, _src = pr.load_prev("lives.csv")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            pr.cmd_carry_rest("lives.csv", rows, Args(today=today))

    def write_lineup(self, records):
        with contextlib.redirect_stdout(io.StringIO()):
            al.validate_records(records, al.known_lineup_ids())
            al.write_records(records)

    def lives(self):
        return {r["title"]: r for r in _read(al.LIVES)}

    def lineups(self):
        out = {}
        for r in _read(al.PATH):
            out.setdefault(r["lineup_id"], []).append(r["artist"])
        return out

    def close(self):
        (al.DATA, al.PATH, al.LIVES, pr.DATA, pr.PREV, pr.subprocess.run) = self.orig


PREV_LIVES = [
    fes("氣志團万博2026", "kishidan-2026", "2026-11-07", "2026-11-08"),
    fes("AIR JAM 2026", "airjam-2026", "2026-11-07", "2026-11-07"),
    fes("終わったフェス", "ended-2026", "2026-10-10", "2026-10-11"),
]
PREV_LINEUPS = (lineup("kishidan-2026", "2026-11-07", "氣志團", "B", "C")
                + lineup("kishidan-2026", "2026-11-08", "D")
                + lineup("airjam-2026", "2026-11-07", "Hi-STANDARD", "E")
                + lineup("ended-2026", "2026-10-10", "F"))


print("\n--- 1. 1本も調べ直さなかった週（2026-10-23 の再現） ---")
w = Week(PREV_LIVES, PREV_LINEUPS)
try:
    w.init()
    w.carry_rest()
    lv, lu = w.lives(), w.lineups()
    check("調べ直さなかったフェスの lineup_id が残る",
          lv["氣志團万博2026"]["lineup_id"] == "kishidan-2026"
          and lv["AIR JAM 2026"]["lineup_id"] == "airjam-2026",
          f"{ {k: v['lineup_id'] for k, v in lv.items()} }")
    check("日割りが前回の並びのまま戻る",
          lu.get("kishidan-2026") == ["氣志團", "B", "C", "D"]
          and lu.get("airjam-2026") == ["Hi-STANDARD", "E"], f"{lu}")
    check("終わったフェスの日割りは戻さない", "ended-2026" not in lu, f"{lu}")
    check("終わったフェスの行は書き戻さない", "終わったフェス" not in lv)
    check("戻したフェスを持ち越しとして記録する",
          pr.load_carried_lineups() == {"kishidan-2026", "airjam-2026"},
          f"{pr.load_carried_lineups()}")
finally:
    w.close()

print("\n--- 2. 一部だけ調べ直した週 ---")
w = Week(PREV_LIVES, PREV_LINEUPS)
try:
    w.init()
    w.carry_rest()
    w.write_lineup(lineup("kishidan-2026", "2026-11-07", "氣志團", "新しい出演者"))
    lu = w.lineups()
    check("調べ直したフェスは今週分に差し替わる（前回分と二重にならない）",
          lu.get("kishidan-2026") == ["氣志團", "新しい出演者"], f"{lu.get('kishidan-2026')}")
    check("調べ直さなかったフェスはそのまま", lu.get("airjam-2026") == ["Hi-STANDARD", "E"])
    w.write_lineup(lineup("kishidan-2026", "2026-11-08", "2日目の出演者"))
    lu = w.lineups()
    check("同じフェスの2回目の書き込みは追記になる（1回目を消さない）",
          lu.get("kishidan-2026") == ["氣志團", "新しい出演者", "2日目の出演者"],
          f"{lu.get('kishidan-2026')}")
    check("差し替えたフェスは持ち越しの記録から外れる",
          pr.load_carried_lineups() == {"airjam-2026"}, f"{pr.load_carried_lineups()}")
finally:
    w.close()

print("\n--- 3. 同じ回の再 --init ---")
w = Week(PREV_LIVES, PREV_LINEUPS)
try:
    w.init()
    w.init()  # 直前はヘッダーだけ。退避した前回分を空で上書きしてはいけない
    w.carry_rest()
    lu = w.lineups()
    check("再 --init のあとも前回分から戻せる",
          lu.get("airjam-2026") == ["Hi-STANDARD", "E"], f"{lu}")
finally:
    w.close()

print("\n--- 4. 古い退避は使わない ---")
w = Week(PREV_LIVES, PREV_LINEUPS)
try:
    w.init()
    # 退避の日付を3日前にずらす（今回の --init を通っていない退避）
    with open(pr.lineups_meta_path(), "w", encoding="utf-8") as f:
        json.dump({"taken_at": (TODAY - timedelta(days=3)).isoformat(), "rows": 1}, f)
    w.carry_rest()
    lv, lu = w.lives(), w.lineups()
    check("古い退避からは戻さない", lu == {}, f"{lu}")
    check("戻せないときは lineup_id を外す（参照先の無い値を書かない）",
          lv["AIR JAM 2026"]["lineup_id"] == "", f"{lv['AIR JAM 2026']['lineup_id']!r}")
finally:
    w.close()

print("\n--- 5. 下見（--apply なし）は何も書かない ---")
w = Week(PREV_LIVES, PREV_LINEUPS)
try:
    w.init()
    rows, _src = pr.load_prev("lives.csv")
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        pr.cmd_carry_rest("lives.csv", rows, Args(apply=False))
    check("下見では lineups.csv に書かない", w.lineups() == {}, f"{w.lineups()}")
finally:
    w.close()

print("\n--- 6. 失ったら diff_data.py が止める（2026-10-23 の状態をそのまま与える） ---")
import diff_data as dd                                        # noqa: E402

prev = {"a": fes("AIR JAM 2026", "airjam-2026", "2026-11-07", "2026-11-07"),
        "b": fes("終わったフェス", "ended-2026", "2026-10-10", "2026-10-11"),
        "c": fes("日割りを保ったフェス", "kept-2026", "2026-11-01", "2026-11-01")}
cur = {"a": {**prev["a"], "lineup_id": ""},
       "b": {**prev["b"], "lineup_id": ""},
       "c": prev["c"]}
lost = dd.lineup_lost(prev, cur, TODAY)
check("まだ終わっていないフェスが lineup_id を失ったら検出する",
      [x["uid"] for x in lost] == ["a"], f"{lost}")
check("終わったフェス・日割りを保ったフェスは検出しない",
      all(x["uid"] != "b" and x["uid"] != "c" for x in lost))

print(f"\nNG {len(failures)}件: {', '.join(failures)}" if failures else "\nすべて通過")
sys.exit(1 if failures else 0)
