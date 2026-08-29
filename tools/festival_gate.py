#!/usr/bin/env python3
"""`data/festivals.csv`（フェス名簿）と `data/lives.csv`（本体）の整合を機械的に確認する。

## なぜ要るか

フェスは2つのファイルに分かれて管理されている——`festivals.csv`（フェス名・
主な会場・開催時期の目安の名簿）と `lives.csv`（実際に表示される公演行）。
この2つを突き合わせる仕組みが無かったため、2026-08-29 の無人実行では、
直近まで継続的に見つかっていたフェス（ROCK IN JAPAN・氣志團万博・
New Acoustic Camp・ポムフェス2026）が今週の会場ベース調査の範囲から
構造的に漏れ、`lives.csv`側の行が気づかれないまま「消滅」扱いになった。

`lives.csv` 側の消滅は `diff_data.py` が検知するが、それは「前回あった行が
今回無い」という**行単位**の比較でしかない。`festivals.csv` は先週・先々週の
ことを覚えていないので、`diff_data.py` だけでは「本来ここにあるべきフェス」
という視点の欠落を検知できない。このツールは逆方向——**名簿には登録されて
最近まで見つかっていたのに、今回はどの行にも対応しなさそうなフェス**を
見つける。

## 判定の作り

  - `status` が `active`（`retired` は対象外。`blocked` は公式サイトが
    見られないだけで名簿としては生きているので対象に含める）。
    **`candidate` は対象に含めない**——roster.py 自身の定義で「今回はじめて
    見つけた、まだ定点観測の本リストには入れていない」行だからである
    （`tools/roster.py` の名簿の状態を参照）。まだ「毎週いて当然」とは
    言えない行を対象にすると、正しく載っていない週まで誤検知し、
    警告が読まれなくなる
  - `hit_count` が1以上（一度も見つかったことがない名簿行は、今回見つからな
    くても「継続していたのに消えた」とは言えない）
  - `last_hit` が実行日から `RECENT_HIT_DAYS` 日以内（直近まで継続的に
    見つかっていた、という条件。半年前に一度ヒットしただけの行を毎回
    引っかけると、オオカミ少年になって誰も見なくなる）

一致の判定は正規化した名簿名が `lives.csv` のいずれかの `title` に
**部分文字列として含まれるか**で見る（`tools/rowkey.norm`）。編集距離ベースの
類似度は「ROCK IN JAPAN」と無関係な「FUJI ROCK」を誤って高スコアにする
（共通する英単語が多いため）。部分文字列なら「ROCK IN JAPAN FESTIVAL」が
「ROCK IN JAPAN FESTIVAL 2026 第1週」に含まれる、という素直な一致だけを拾う。

使い方:
    python3 tools/festival_gate.py                       # 一覧して判定する
    python3 tools/festival_gate.py --allow "ROCK IN JAPAN FESTIVAL"
    python3 tools/festival_gate.py --allow "A,B"          # カンマ区切り・複数指定可
    python3 tools/festival_gate.py --today 2026-08-29     # 試験用
"""

import argparse
import csv
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rowkey import norm                                       # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

RECENT_HIT_DAYS = 45   # prev_rows.PRICE_TTL_DAYS と同じ考え方（直近とみなす窓）
TRACKED_STATUSES = {"active", "blocked"}   # candidate は対象外（上記docstring参照）


def _read(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _int(v):
    try:
        return int((v or "0").strip())
    except ValueError:
        return 0


def _date(v):
    try:
        return date.fromisoformat((v or "").strip())
    except ValueError:
        return None


def find_missing(festivals, lives_titles, today):
    """今回どの lives.csv 行にも対応しなさそうな、継続追跡中のフェスを返す。"""
    norm_titles = [norm(t) for t in lives_titles if t]
    missing = []
    for f in festivals:
        if (f.get("status") or "").strip() not in TRACKED_STATUSES:
            continue
        if _int(f.get("hit_count")) < 1:
            continue
        last_hit = _date(f.get("last_hit"))
        if not last_hit or (today - last_hit).days > RECENT_HIT_DAYS:
            continue
        name = norm(f.get("name"))
        if not name:
            continue
        if any(name in t for t in norm_titles):
            continue
        missing.append(f)
    return missing


def main():
    p = argparse.ArgumentParser(description="festivals.csv と lives.csv の整合を確認する")
    p.add_argument("--allow", action="append", default=[],
                   help="このフェスは今回 lives.csv に無くてよいと承知している"
                        "（名簿の name 列と同じ文字列。複数指定可・カンマ区切り可）")
    p.add_argument("--today", type=lambda s: date.fromisoformat(s), help="基準日（試験用）")
    args = p.parse_args()

    today = args.today or date.today()
    festivals = _read(os.path.join(DATA, "festivals.csv"))
    lives = _read(os.path.join(DATA, "lives.csv"))
    titles = [r.get("title", "") for r in lives]

    allowed = set()
    for a in args.allow:
        allowed.update(norm(v) for v in a.split(",") if v.strip())

    missing = find_missing(festivals, titles, today)
    unresolved = [f for f in missing if norm(f.get("name")) not in allowed]

    if missing:
        print(f"名簿にあり直近{RECENT_HIT_DAYS}日以内に見つかっていたのに、"
              f"今回 lives.csv に対応する行が見当たらないフェス {len(missing)}件:")
        for f in missing:
            mark = " [--allowで承知済み]" if f not in unresolved else ""
            print(f"  - {f.get('name')}（{f.get('venue', '')}／最終ヒット {f.get('last_hit')}）{mark}")

    if unresolved:
        print(f"\nERROR: {len(unresolved)}件が未確認のままです。"
              "実際にその会場・公式サイトを調べて、今回のlives.csvに書くか、"
              "今回は無いと確認できたなら --allow で明示してください"
              "（本当に終了したなら data/festivals.csv 側を retired にすることも検討する）。")
        return 1

    print("festivals.csv とlives.csvの整合: 問題ありません" if not missing else
          "\n未確認は残っていません（すべて --allow で承知済み）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
