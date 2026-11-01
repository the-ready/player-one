#!/usr/bin/env python3
"""`tools/added_rows.py` の新着の判定を検証する（ネットワーク不要・一時ディレクトリの git の中だけで動く）。

    python3 tools/added_rows_test.py

守りたいのは、`id` の振り直しや表記ゆれで「前からある行」を新着と言わないこと、
書き出す `id` と `csv_sha256` が今の CSV と食い違わないこと。
"""

import hashlib
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import added_rows as ar                                       # noqa: E402

failures = []

HEAD = '"id","title","venue","start_date"\n'


def check(name, cond, detail=""):
    if cond:
        print(f"  ok    {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        failures.append(name)


def commit(root, text, when):
    os.makedirs(f"{root}/data", exist_ok=True)
    with open(f"{root}/data/events.csv", "w", encoding="utf-8") as f:
        f.write(text)
    env = dict(os.environ, GIT_AUTHOR_DATE=when, GIT_COMMITTER_DATE=when)
    subprocess.run(["git", "add", "-A"], cwd=root, check=True, env=env)
    subprocess.run(["git", "commit", "-qm", when], cwd=root, check=True, env=env)


def test_renumbered_ids_and_spelling_are_not_new():
    old = [{"id": "1", "title": "秋の植木市", "venue": "日比谷公園", "start_date": "2026-11-07"}]
    now = [
        {"id": "7", "title": "秋の植木市", "venue": "日比谷公園", "start_date": "2026-11-07"},      # id だけ変わった
        {"id": "8", "title": "秋の 植木市！", "venue": "日比谷公園", "start_date": "2026-11-07"},  # 表記ゆれ
        {"id": "9", "title": "冬のマルシェ", "venue": "日比谷公園", "start_date": "2026-12-05"},    # 本当の新着
    ]
    ids = ar.added_ids("events.csv", now, old)
    check("振り直された id と表記ゆれは新着にしない", ids == ["9"], ids)


def test_same_title_other_day_is_new():
    old = [{"id": "1", "title": "マルシェ", "venue": "代々木公園", "start_date": "2026-11-07"}]
    now = [{"id": "1", "title": "マルシェ", "venue": "代々木公園", "start_date": "2026-11-14"}]
    check("同じ名前でも開始日が違えば新着", ar.added_ids("events.csv", now, old) == ["1"])


def test_build_against_week_old_commit():
    with tempfile.TemporaryDirectory() as root:
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=root, check=True)
        commit(root, HEAD + '"1","古い催し","A館","2026-10-01"\n', "2026-10-01T00:00:00+09:00")
        commit(root, HEAD + '"1","古い催し","A館","2026-10-01"\n"2","先週の催し","B館","2026-10-20"\n',
               "2026-10-20T00:00:00+09:00")
        text = HEAD + '"1","先週の催し","B館","2026-10-20"\n"2","古い催し","A館","2026-10-01"\n"3","今週の催し","C館","2026-11-07"\n'
        commit(root, text, datetime.now(timezone.utc).isoformat())
        out = ar.build(root, 7, datetime(2026, 11, 2, tzinfo=timezone.utc))
        ev = out.get("event", {})
        check("1週間前の版と比べる", ev.get("ids") == ["3"], ev)
        check("基準の日時を書く", ev.get("since", "").startswith("2026-10-20"), ev.get("since"))
        check("CSV のハッシュは今のファイルのもの",
              ev.get("csv_sha256") == hashlib.sha256(text.encode("utf-8")).hexdigest())
        check("無いデータセットは書かない", "movie" not in out and "live" not in out, list(out))


def test_no_baseline_is_skipped():
    with tempfile.TemporaryDirectory() as root:
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=root, check=True)
        commit(root, HEAD + '"1","新しい催し","A館","2026-11-07"\n', datetime.now(timezone.utc).isoformat())
        out = ar.build(root, 7, datetime(2026, 11, 2, tzinfo=timezone.utc))
        check("7日より前の版が無ければ書かない（全部を新着と言わない）", "event" not in out, out)


if __name__ == "__main__":
    test_renumbered_ids_and_spelling_are_not_new()
    test_same_title_other_day_is_new()
    test_build_against_week_old_commit()
    test_no_baseline_is_skipped()
    if failures:
        print(f"\nFAILED: {len(failures)}件")
        sys.exit(1)
    print("\nOK")
