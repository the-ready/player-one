#!/usr/bin/env python3
"""サブエージェントの波の結果が、CSVに入る前に次の波が投げられるのを止める。

## なぜ要るのか

2026-08-27 の movies 収集は、2つの波が調査を終えて結果を書き出していながら、
**新規0件で差し戻された。**

    02:53  子: temp/rows-... に44件を書く
    02:53  子→親: 「44件書いた」
    02:53  親: 「44件を書き出しました。続けて2体並行で調査します」
    02:54  親: 次の波を起動          ← append_rows.py を挟んでいない
    03:04  子: さらに46件を書く
    03:08  利用上限で強制終了

90行が調査済みのままディスクに残り、1行もCSVに入らなかった。あとで追記して
検証を流し直すと `新規14件・変更6件・消滅3件` で**通る**——収集は成功していて、
受け取りだけが抜けていた。

各SKILL.mdは以前から「1つの波の結果を全部 `append_rows.py` で書き切ってから、
次の波を投げる」と書いている。**書いてあるだけでは守られなかった。**

この抜け方は、結果の受け渡しをファイルに変えた（親の文脈を経由させない）ことで
起きやすくなった側面がある。子が返答本文に行を載せていた頃は、親が書き写す以外に
行を扱う道が無く、**追記が避けて通れない工程だった**。ファイルに移した瞬間、
行は親が一度も触らない場所へ移り、「44件書いた」が完了として読めるようになった。
消したのは無駄な往復だが、同時に「必ず通る道」も消していた。だからここで戻す。

## 何を見るか —— 台帳ではなく、行がCSVに在るかどうか

「`append_rows.py` を実行したか」を記録する方式は採らない。`--from` で渡しても
`< file` でも `cat |` でも追記は成立するので、記録できるのは呼び出しの形の
どれか一つだけになり、**別の形で正しく追記した回を誤って止める。**

代わりに、波のファイルの各行から `rowkey.uid()` を計算し、**その uid が今の
CSVに在るか**を数える。追記の手段に依存せず、「行が入ったか」だけを見る。
入っていれば通し、入っていなければ止める——止めたい事故がまさにそれである。

## 誤って止めないための線引き

- **`temp/rows-*.jsonl` だけを見る。** サブエージェントは作業用のファイルも
  temp/ に置く。名前で区切らないと、下書きが次の波を止める
- **今回の実行で作られたものだけを見る。** 判定の起点は `budget.json` の
  `started_at`（＝`append_rows.py --init` の時刻）。先週の残骸は対象外
- **半分以上が入っていれば通す。** `purge_ended.py` が終了日超過の行を
  落とすので、追記した全行がCSVに残るとは限らない
- **判定できないときは通す。** budget.json が無い・CSVが読めない・JSONが壊れて
  いる、のいずれでも素通しにする。ここは事故を1種類だけ塞ぐ門であって、
  収集そのものを止める権限は持たせない（`fetch_gate.py` と逆の倒し方をする
  理由は、あちらが「外部への迷惑」を、こちらが「自分の取りこぼし」を見ているため）

使い方:
    python3 tools/wave_gate.py --check      # 未消化の波があれば理由を出して exit 1
    python3 tools/wave_gate.py --list       # 対象ファイルと一致率を一覧する
"""

import argparse
import csv
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rowkey import uid as row_uid                             # noqa: E402
from validate_data import EXPECTED_HEADERS                    # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
TEMP = os.path.join(ROOT, "temp")
BUDGET = os.path.join(DATA, ".run", "budget.json")

# 波の結果だと名乗るファイル名。これ以外の temp/*.jsonl は見ない。
WAVE_GLOB = "rows-*.jsonl"

DATASETS = ("events.csv", "lives.csv", "movies.csv")

# 一致率がこれ未満なら「入っていない」とみなす。
MATCH_RATIO = 0.5


def run_started_at():
    """今回の実行の起点（epoch秒）。取れなければ None。"""
    try:
        with open(BUDGET, encoding="utf-8") as f:
            v = json.load(f).get("started_at")
        return float(v) if isinstance(v, (int, float)) else None
    except (OSError, ValueError, TypeError):
        return None


def csv_uids(name):
    path = os.path.join(DATA, name)
    try:
        with open(path, newline="", encoding="utf-8") as f:
            return {row_uid(name, r) for r in csv.DictReader(f)}
    except (OSError, ValueError):
        return set()


def read_rows(path):
    rows = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    return None            # 壊れている＝判定しない（素通し）
                if isinstance(obj, dict):
                    rows.append(obj)
    except OSError:
        return None
    return rows


def infer_dataset(rows):
    """列の顔ぶれから、どのデータセット向けの行かを当てる。

    一致数から決められない場合（**CSVがヘッダーだけのとき**——まさに打ち切りの
    直後がその状態である）でも、示すコマンドに正しいデータセット名を入れたい。
    uid が1件も一致しないときの唯一の手がかりが列名になる。
    """
    keys = set()
    for r in rows[:20]:
        keys |= set(r)
    best, score = None, -1
    for name in DATASETS:
        headers = set(EXPECTED_HEADERS[name])
        # その データセットにしか無い列をどれだけ持っているかで見る
        unique = headers - set().union(*(set(EXPECTED_HEADERS[o]) for o in DATASETS if o != name))
        s = len(keys & unique) * 10 + len(keys & headers)
        if s > score:
            best, score = name, s
    return best


def best_match(rows):
    """(データセット名, 一致した件数, 総件数) を返す。最も一致したものを採る。

    どのデータセット向けのファイルかは書いてないので、3つとも試す。uid は
    自然キー（タイトル・会場・日付）のハッシュなので、別のデータセットの
    uid 集合にたまたま一致することは実質起こらない。
    """
    best = (None, 0, len(rows))
    for name in DATASETS:
        have = csv_uids(name)
        if not have:
            continue
        hit = sum(1 for r in rows if row_uid(name, r) in have)
        if hit > best[1]:
            best = (name, hit, len(rows))
    if best[0] is None:
        best = (infer_dataset(rows), 0, len(rows))
    return best


def pending(started_at=None):
    """未消化の波のファイルを [(パス, データセット, 一致数, 総数)] で返す。"""
    started = started_at if started_at is not None else run_started_at()
    if started is None:
        return []                          # 起点が分からない＝判定しない
    out = []
    for path in sorted(glob.glob(os.path.join(TEMP, WAVE_GLOB))):
        try:
            if os.path.getmtime(path) < started:
                continue                   # 今回の実行より前のもの
        except OSError:
            continue
        rows = read_rows(path)
        if not rows:                       # 空・壊れている＝判定しない
            continue
        name, hit, total = best_match(rows)
        if hit < total * MATCH_RATIO:
            out.append((path, name, hit, total))
    return out


def rel(path):
    return os.path.relpath(path, ROOT)


def main():
    p = argparse.ArgumentParser(description="波の結果がCSVに入ったかを見る")
    p.add_argument("--check", action="store_true",
                   help="未消化があれば理由を stderr に出して exit 1")
    p.add_argument("--list", action="store_true", dest="as_list",
                   help="対象ファイルと一致率を一覧する")
    args = p.parse_args()

    if args.as_list:
        started = run_started_at()
        if started is None:
            print("# 今回の実行の起点が分かりません（data/.run/budget.json が無い）")
            return 0
        found = sorted(glob.glob(os.path.join(TEMP, WAVE_GLOB)))
        if not found:
            print(f"# temp/{WAVE_GLOB} に該当するファイルはありません")
            return 0
        for path in found:
            rows = read_rows(path) or []
            if not rows:
                print(f"{rel(path)}\t（空・または解析不能）")
                continue
            name, hit, total = best_match(rows)
            fresh = "今回" if os.path.getmtime(path) >= started else "前回以前"
            print(f"{rel(path)}\t{fresh}\t{name or '-'}\t{hit}/{total}件がCSVに在る")
        return 0

    if not args.check:
        p.error("--check か --list を指定してください")

    left = pending()
    if not left:
        return 0

    lines = ["調査済みの行が、まだCSVに入っていません。次の波を投げる前に追記してください。", ""]
    for path, name, hit, total in left:
        ds = (name or "events").replace(".csv", "")
        lines.append(f"  {rel(path)}: {total}件のうちCSVに在るのは{hit}件")
        lines.append(f"    python3 tools/append_rows.py {ds} < {rel(path)}")
    lines += [
        "",
        "2026-08-27 の実行は、2つの波が90行を調べ終えてファイルに書きながら、",
        "一度も append_rows.py を通さないまま利用上限で打ち切られました。",
        "**調査は成功していて、受け取りだけが抜けていました**（あとで追記して",
        "検証を流し直すと、新規14件・変更6件で通ります）。",
        "",
        "追記できない事情があるなら（列の値が不正で弾かれる等）、直すか、",
        "そのファイルを消してから起動し直してください。**消せば止めません**",
        "——このゲートは「調べたのに入っていない行」だけを見ています。",
    ]
    print("\n".join(lines), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
