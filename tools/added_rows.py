#!/usr/bin/env python3
"""この1週間でボードに加わった行を data/added.json に書き出す（Pages の公開時に実行）。

## 何に使うか

運営者の個人用 AI エージェント（Hermes）が「今週の新着は？」に答えるため。画面は使わない。
Hermes 側は Pages の CSV とこのファイルを読むだけで、新着の判定を自分で持たない。

## なぜ id を書くのか、なぜ CSV のハッシュも書くのか

週をまたぐ同定は rowkey.py の自然キーで行う（`id` は append_rows.py が毎回振り直すので、
週をまたぐ識別子にならない）。一方、書き出すのは今の CSV の `id` にする。読む側が自然キーの
計算を持たずに済むからである。`id` は同じ版の CSV の中でだけ意味を持つので、その CSV の
sha256 も一緒に書き、読む側は手元の CSV と一致したときだけ使う（取得の合間に公開が挟まると
版がずれるため）。

## 1週間前とは

その CSV の、今から7日より前の最後のコミット。git の全履歴が要る（pages.yml は
fetch-depth: 0 で取っている）。7日より前の版が無い（ファイルが新しい）ときは、そのデータセットを
書かない。

使い方:
    python3 tools/added_rows.py              # data/added.json を書く
    python3 tools/added_rows.py --days 14    # 基準を14日前にする
"""

import argparse
import csv
import hashlib
import io
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rowkey import natural_key                                 # noqa: E402

TARGETS = {"event": "data/events.csv", "movie": "data/movies.csv", "live": "data/lives.csv"}
OUT = "data/added.json"


def parse(text: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(text.lstrip("﻿"))))


def added_ids(name: str, now_rows: list[dict], old_rows: list[dict]) -> list[str]:
    """今の行のうち、自然キーが前の版に無いものの id（今の CSV の並び順）。"""
    old = {natural_key(name, r) for r in old_rows}
    return [r["id"] for r in now_rows if (r.get("id") or "").strip() and natural_key(name, r) not in old]


def git(*args: str, cwd: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout


def baseline(path: str, days: int, cwd: str) -> tuple[str, str] | None:
    """(基準のコミットの日時, そのときの CSV の中身)。無ければ None。"""
    line = git("log", "-1", f"--before={days} days ago", "--format=%H %cI", "--", path, cwd=cwd).strip()
    if not line:
        return None
    sha, when = line.split(" ", 1)
    try:
        return when, git("show", f"{sha}:{path}", cwd=cwd)
    except subprocess.CalledProcessError:
        return None                    # その版ではパスが違った（移動の前）。比べない


def build(root: str, days: int, now: datetime) -> dict:
    out: dict = {"generated_at": now.isoformat(timespec="seconds"), "days": days}
    for kind, path in TARGETS.items():
        full = os.path.join(root, path)
        if not os.path.exists(full):
            continue
        with open(full, "rb") as f:
            raw = f.read()
        base = baseline(path, days, root)
        if base is None:
            continue
        since, old_text = base
        name = os.path.basename(path)
        out[kind] = {
            "since": since,
            "csv_sha256": hashlib.sha256(raw).hexdigest(),
            "ids": added_ids(name, parse(raw.decode("utf-8")), parse(old_text)),
        }
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--root", default=".")
    args = ap.parse_args(argv)
    data = build(args.root, args.days, datetime.now(timezone.utc))
    with open(os.path.join(args.root, OUT), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(json.dumps({k: (len(v["ids"]) if isinstance(v, dict) else v) for k, v in data.items()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
