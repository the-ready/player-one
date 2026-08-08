#!/usr/bin/env python3
"""前回の収集結果と今回の結果を突き合わせて、変化を機械的に洗い出す。

## なぜスクリプトでやるのか

「前回から何が変わったか」をモデルに目視で突き合わせさせると、
126行×39列を読み直すことになって高いうえ、見落としが起きても誰も気づけない。
突き合わせは機械の仕事で、モデルの仕事は**機械が拾った差分の意味を判断すること**
（これは会期延長か／中止か／単なる表記ゆれか）である。ここを分ける。

## 静かな欠落を許さない

前回あって今回無い行は、次の2つが混ざっている。

  1. 本当に終わった／中止になった  → 正しく消えている
  2. 今回たまたま見つけられなかった → **開催中の催しを一覧から落とした事故**

この2つは結果のCSVを見ても区別できない。だからこのツールは、消えた行それぞれに
`prev_rows.py --dispose` での説明を要求し、説明の無い消滅をERRORにする。
説明できないなら、それは調べ直すべき行である。

使い方:
    python3 tools/diff_data.py                 # 3データセットぶん
    python3 tools/diff_data.py events          # 1つだけ
    python3 tools/diff_data.py events --json   # 機械可読
"""

import argparse
import csv
import json
import os
import sys

from prev_rows import load_dispositions, load_prev, resolve_dataset
from rowkey import natural_key, similarity, title_key
from rowkey import uid as row_uid
from validate_data import START_COL

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# 変化したら報告する列。desc のような長い列は「変わった」事実だけを出し、中身は出さない
# （差分報告そのものがコンテキストを食っては本末転倒なため）。
WATCH = [
    "start_date", "release_date", "end_date", "dates", "date", "date_note",
    "open_time", "start_time", "end_time",
    "onsale_label", "onsale_start", "onsale_end", "limited_sale",
    "price", "price_best", "discount_pct", "coupon_note",
    "artists", "venue", "theater", "is_additional", "url",
]
QUIET = ["desc", "note", "official_url", "poster_url"]   # 変わった事実だけ出す

FUZZY_MIN = 0.82   # これ以上似ていれば「同じ催しの表記ゆれ」の候補として出す


def read_current(name):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def index(name, rows):
    out = {}
    for r in rows:
        out[row_uid(name, r)] = r
    return out


def fuzzy_pairs(name, gone, added):
    """消えた行と現れた行のあいだで、同じ催しの言い換えらしいペアを探す。

    タイトルの言い換え（正式名称への修正、副題の追加）や会場の表記ゆれは実際に起きる。
    これを検知せずに放置すると「毎週すべてが新規で、すべてが消滅する」という
    無意味な差分になり、NEWバッジも追加公演の検知も信用できなくなる。
    """
    scored = []
    for gu, grow in gone.items():
        gk, gnat = title_key(grow), natural_key(name, grow)
        for au, arow in added.items():
            s = similarity(gk, title_key(arow))
            anat = natural_key(name, arow)
            # キーのうちタイトル以外（会場・日付など）がいくつ一致しているか。
            # 全部一致していればタイトルが大きく変わっていても同じ催しの可能性が高い。
            shares = len(set(gnat[1:]) & set(anat[1:]) - {""})
            same_place_and_date = shares >= len([x for x in gnat[1:] if x])
            if s >= FUZZY_MIN or (same_place_and_date and shares >= 2 and s >= 0.45):
                scored.append((s, gu, au))

    # 1対1に割り当てる。似ている順に取り、既に使った行は再利用しない。
    pairs, used_g, used_a = [], set(), set()
    for s, gu, au in sorted(scored, reverse=True):
        if gu in used_g or au in used_a:
            continue
        used_g.add(gu)
        used_a.add(au)
        pairs.append((gu, au, round(s, 2)))
    return pairs


def diff_one(name):
    prev_rows, source = load_prev(name)
    cur_rows = read_current(name)
    result = {
        "dataset": name, "prev_source": source,
        "prev_count": len(prev_rows), "current_count": len(cur_rows),
        "added": [], "gone": [], "changed": [], "rename_candidates": [],
        "unexplained": [],
    }
    if not prev_rows:
        result["note"] = "前回データなし（初回実行）"
        return result, 0

    prev = index(name, prev_rows)
    cur = index(name, cur_rows)
    disp = load_dispositions(name)
    start_col = START_COL[name]

    gone = {u: r for u, r in prev.items() if u not in cur}
    added = {u: r for u, r in cur.items() if u not in prev}

    for u, r in added.items():
        result["added"].append({
            "uid": u, "title": r.get("title", ""),
            "venue": r.get("venue") or r.get("theater", ""),
            "date": r.get(start_col, ""), "pref": r.get("pref", ""),
            "is_additional": (r.get("is_additional") or "").strip(),
            "announced_date": r.get("announced_date", ""),
        })

    renames = {g: (a, s) for g, a, s in fuzzy_pairs(name, gone, added)}
    for g, (a, s) in renames.items():
        result["rename_candidates"].append({
            "prev_uid": g, "new_uid": a, "similarity": s,
            "prev_title": gone[g].get("title", ""), "new_title": added[a].get("title", ""),
        })

    for u, r in gone.items():
        d = disp.get(u)
        entry = {
            "uid": u, "title": r.get("title", ""),
            "venue": r.get("venue") or r.get("theater", ""),
            "date": r.get(start_col, ""),
            "disposition": (d or {}).get("status"), "note": (d or {}).get("note", ""),
        }
        result["gone"].append(entry)
        if not d and u not in renames:
            result["unexplained"].append(entry)

    for u, new in cur.items():
        old = prev.get(u)
        if not old:
            continue
        fields, quiet = {}, []
        for col in WATCH:
            if col not in new or col not in old:
                continue
            a, b = (old.get(col) or "").strip(), (new.get(col) or "").strip()
            if a != b:
                fields[col] = [a, b]
        for col in QUIET:
            if col in new and (old.get(col) or "").strip() != (new.get(col) or "").strip():
                quiet.append(col)
        if fields or quiet:
            result["changed"].append({
                "uid": u, "title": new.get("title", ""),
                "fields": fields, "also_changed": quiet,
            })

    return result, len(result["unexplained"])


def print_human(res):
    name = res["dataset"]
    print(f"\n=== {name} ===")
    if res.get("note"):
        print(f"  {res['note']}")
        return
    print(f"  前回 {res['prev_count']}件（{res['prev_source']}） → 今回 {res['current_count']}件")

    print(f"\n  [新規] {len(res['added'])}件")
    for a in res["added"]:
        mark = " ★追加公演" if a["is_additional"] in ("1", "true", "yes") else ""
        print(f"    + {a['uid']} {a['date']} {a['pref']} {a['title'][:40]} / {a['venue'][:20]}{mark}")

    if res["rename_candidates"]:
        print(f"\n  [表記が変わった可能性] {len(res['rename_candidates'])}件"
              "（同じ催しなら --dispose で renamed を記録すること）")
        for c in res["rename_candidates"]:
            print(f"    ~ {c['similarity']} {c['prev_title'][:34]} → {c['new_title'][:34]}")

    print(f"\n  [変更] {len(res['changed'])}件")
    for c in res["changed"]:
        for col, (a, b) in c["fields"].items():
            print(f"    * {c['uid']} {c['title'][:28]} {col}: {a[:28]!r} → {b[:28]!r}")
        if c["also_changed"]:
            print(f"      （{', '.join(c['also_changed'])} も変更）")

    print(f"\n  [消滅] {len(res['gone'])}件")
    for g in res["gone"]:
        label = g["disposition"] or "説明なし"
        print(f"    - {g['uid']} {g['title'][:36]} [{label}] {g['note'][:40]}")

    if res["unexplained"]:
        print(f"\n  ERROR: 説明のない消滅が {len(res['unexplained'])}件あります。")
        print("  前回あった行が今回無いのは「終了した」か「見つけられなかった」のどちらかです。")
        print("  どちらなのか調べ、python3 tools/prev_rows.py <ds> --dispose で記録してください。")


def main():
    p = argparse.ArgumentParser(description="前回と今回のCSVを突き合わせる")
    p.add_argument("dataset", nargs="?", help="events / lives / movies（省略時は全部）")
    p.add_argument("--json", action="store_true", help="機械可読なJSONで出す")
    p.add_argument("--allow-unexplained", action="store_true",
                   help="説明のない消滅があっても終了コード0にする（調査途中の確認用）")
    args = p.parse_args()

    names = [resolve_dataset(args.dataset)] if args.dataset else \
            ["events.csv", "lives.csv", "movies.csv"]

    results, bad = [], 0
    for n in names:
        res, unexplained = diff_one(n)
        results.append(res)
        bad += unexplained

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for res in results:
            print_human(res)
        print(f"\n合計: 説明のない消滅 {bad}件")

    if bad and not args.allow_unexplained:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
