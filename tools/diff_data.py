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

## 空回りも許さない

上の検査は「壊れていないか」を見るもので、**「何か産んだか」は見ていなかった。**
2026-08-14 の events 収集は、検索115回・取得154回を消費したあと、
`data/.prev/` から前回のCSVをそのまま復元して終わった。壊れてはいないので
検証は素通りし、`claude-routine.sh` はそれを「週次データ更新」としてコミットし、
push した。**収穫ゼロの回が、成功と区別できない形で記録に残った。**

そこで、`--init` を今日実行したデータセット——つまり今回の収集対象——について、
新規・変更・消滅が**すべて0件**なら異常として終了コード1を返す。100件規模の
CSVで1週間分の変化が3種類とも0になるのは、`purge_ended.py` が終了日を過ぎた行を
消すことすら起きなかったということで、収集が実質的に走らなかった形である。

調査の途中で確認したいときは `--allow-noop` を付ける（`--allow-unexplained` と
同じ位置づけ）。**最終判定で付けてはいけない。**

使い方:
    python3 tools/diff_data.py                 # 3データセットぶん
    python3 tools/diff_data.py events          # 1つだけ
    python3 tools/diff_data.py events --json   # 機械可読
"""

import argparse
import csv
from datetime import date, timedelta
import json
import os
import sys

from prev_rows import load_dispositions, load_prev, prev_taken_at, resolve_dataset
from rowkey import natural_key, norm, similarity, title_key
from rowkey import uid as row_uid
from validate_data import START_COL

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# 変化したら報告する列。desc のような長い列は「変わった」事実だけを出し、中身は出さない
# （差分報告そのものがコンテキストを食っては本末転倒なため）。
WATCH = [
    "start_date", "release_date", "end_date", "dates", "date", "date_note", "backup_date",
    "open_time", "start_time", "end_time", "status", "announced_date",
    "cats", "genre", "screening_type", "live_type", "pref", "area", "series_id", "tour_id",
    "onsale_label", "onsale_start", "onsale_start_time", "onsale_end", "onsale_end_time", "limited_sale",
    "price", "price_official", "price_best", "discount_pct", "price_condition", "best_source", "coupon_note",
    "artists", "venue", "theater", "is_additional", "url", "source",
]
QUIET = ["desc", "note", "official_url", "apple_music_url"]   # 変わった事実だけ出す

FUZZY_MIN = 0.82   # これ以上似ていれば「同じ催しの表記ゆれ」の候補として出す

# フェス名簿と突き合わせた一致にはこの疑似スコアを与える（真の完全一致 1.0 は
# 上書きしない。1対1割り当ては降順で確定するため、これより低いと通常の
# 類似度スコアに埋もれる場合がある）。
FESTIVAL_MATCH_SCORE = 0.97


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


def _load_festival_names():
    """`data/festivals.csv` の name 列を正規化して返す（lives.csv 専用）。

    見つからなくても壊さない——festivals.csv はライブ収集タスクが自分で
    育てる名簿で、events.csv や movies.csv には存在しない。
    """
    path = os.path.join(DATA, "festivals.csv")
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return [norm(r.get("name")) for r in csv.DictReader(f) if (r.get("name") or "").strip()]


def _festival_membership(rows, festival_names):
    """uid -> 一致したフェス名簿の名前（無ければ None）。タイトルへの部分文字列一致で見る。

    編集距離ベースの類似度（`similarity()`）は「ROCK IN JAPAN」と無関係な
    「FUJI ROCK」のような、同じ単語を多く含むだけの別イベントを高スコアに
    してしまう（文字の集合としての重なりを見るため）。部分文字列一致なら
    「ROCK IN JAPAN FESTIVAL」が「ROCK IN JAPAN FESTIVAL 2026 第1週」に
    含まれる、という素直な一致だけを拾う（`tools/festival_gate.py` と同じ判定）。
    """
    out = {}
    for u, r in rows.items():
        t = norm(r.get("title"))
        if not t:
            continue
        for fname in festival_names:
            if fname and fname in t:
                out[u] = fname
                break
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

    # フェス名簿に登録済みの催しは、タイトルが大きく書き換わっていても
    # （例：「ポムフェス2026（ポムポムプリン30周年記念）」→「ポムフェス
    # POMPOMPURIN FESTIVAL」）、同じフェス名を含む行どうしを強くペアにする。
    # 2026-08-29 の事故では、会場ベース調査が同じフェスを別表記で新規発見し、
    # 元の登録行が「消滅」のまま気づかれなかった。
    if name == "lives.csv":
        festival_names = _load_festival_names()
        if festival_names:
            g_fest = _festival_membership(gone, festival_names)
            a_fest = _festival_membership(added, festival_names)
            a_by_fest = {}
            for au, fname in a_fest.items():
                a_by_fest.setdefault(fname, []).append(au)
            for gu, fname in g_fest.items():
                for au in a_by_fest.get(fname, []):
                    scored.append((FESTIVAL_MATCH_SCORE, gu, au))

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
        prev_title, new_title = gone[g].get("title", ""), added[a].get("title", "")
        result["rename_candidates"].append({
            "prev_uid": g, "new_uid": a, "similarity": s,
            "prev_title": prev_title, "new_title": new_title,
            # タイトルが一字一句同じなら、uid が変わった原因は表記ではなく
            # 会場・日付などの他の材料（rowkey.py）。見出しの「表記が変わった
            # 可能性」が誤解を招くので、印字側で言い換える。
            "title_unchanged": prev_title == new_title,
        })

    for u, r in gone.items():
        d = disp.get(u)
        renamed_to = (d or {}).get("to", "").strip() if (d or {}).get("status") == "renamed" else ""
        entry = {
            "uid": u, "title": r.get("title", ""),
            "venue": r.get("venue") or r.get("theater", ""),
            "date": r.get(start_col, ""),
            "disposition": (d or {}).get("status"), "note": (d or {}).get("note", ""),
            "renamed_to": renamed_to,
            # renamed の to は書き込み時に存在チェックしていない（前回データにしか
            # uid が無いため）。今回のCSVに実在するかはここで初めて確認できる。
            "renamed_to_missing": bool(renamed_to and renamed_to not in cur),
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
            if c.get("title_unchanged"):
                print(f"    ~ {c['similarity']} {c['prev_title'][:34]}"
                      "（表記は同じ。会場や日付など他の材料が変わった可能性）")
            else:
                print(f"    ~ {c['similarity']} {c['prev_title'][:34]} → {c['new_title'][:34]}")

    print(f"\n  [変更] {len(res['changed'])}件")
    for c in res["changed"]:
        # 見出しは必ず1行出す。QUIET列だけが変わった行は fields が空になるので、
        # 見出しを省くと直前の行の続きに見えてしまう。
        print(f"    * {c['uid']} {c['title'][:28]}")
        for col, (a, b) in c["fields"].items():
            print(f"        {col}: {a[:28]!r} → {b[:28]!r}")
        if c["also_changed"]:
            print(f"        （{', '.join(c['also_changed'])} も変更）")

    print(f"\n  [消滅] {len(res['gone'])}件")
    for g in res["gone"]:
        label = g["disposition"] or "説明なし"
        tail = ""
        if g.get("renamed_to"):
            tail = f" → {g['renamed_to']}"
            if g.get("renamed_to_missing"):
                tail += "（今回のデータに見当たりません。uidを確認してください）"
        print(f"    - {g['uid']} {g['title'][:36]} [{label}]{tail} {g['note'][:40]}")

    if res["unexplained"]:
        print(f"\n  ERROR: 説明のない消滅が {len(res['unexplained'])}件あります。")
        print("  前回あった行が今回無いのは「終了した」か「見つけられなかった」のどちらかです。")
        print("  どちらなのか調べ、python3 tools/prev_rows.py <ds> --dispose で記録してください。")

    if res.get("noop"):
        print("\n  ERROR: 新規・変更・消滅がすべて0件です（今回の収集対象なのに、何も産んでいません）。")
        print("  調査結果を append_rows.py で書き切っていない、または前回のCSVをそのまま")
        print("  復元して終えようとしている可能性があります。")
        print("  打ち切るなら SKILL.md の「撤退の手順」に従い、前回行の持ち越しと notfound の")
        print("  記録まで済ませてください（それも変化として現れます）。")


def is_noop(res, today):
    """今回の収集対象なのに、新規も変更も消滅も0件か。

    「今回の収集対象」は `--init` を今日実行したデータセットとする。ルーチンは
    1日1スキルしか回さないので、残り2つのデータセットが無変化なのは正常である
    ——そこまで異常扱いにすると、毎回必ず落ちるだけの検査になる。

    `gone` は `expired`（`purge_ended.py` が終了日の比較だけで機械的に消した行）
    を除いて数える。`verify-data.sh` と `claude-routine.sh` はどちらも
    `purge_ended.py` を `diff_data.py` より**先に**走らせるため、終了日を過ぎた
    行が1件でもあれば（＝ほぼ毎週）`gone` が非空になり、この検査は素通りする
    ——空回りを見つけるために作った検査が、実際に空回りしている週にだけ効かない
    という本末転倒になる。`expired` は調査の成果ではなく日付の比較結果なので、
    「何か産んだか」の判定には数えない。
    """
    if res.get("note") or res.get("prev_count", 0) == 0:
        return False                     # 前回データが無い回（初回）は判定しない
    taken = prev_taken_at(res["dataset"])
    # `today` ちょうどではなく、前日も許容する。実行の上限は6時間
    # （`ROUTINE_TIMEOUT_SEC`）あり、`--init`（＝ taken が記録される時点）が
    # 深夜0時をまたいで終わると、`diff_data.py` を実行する日付が1日進んで
    # `taken != today` になり、この検査自体が黙って外れる。週次実行という
    # 頻度からいって「前々回の taken_at が偶然 today-1 と一致する」ことは
    # 現実的に起きないので、前日まで許容しても誤検知にはならない。
    if taken not in (today, today - timedelta(days=1)):
        return False
    gone_real = [g for g in res["gone"] if g.get("disposition") != "expired"]
    return not (res["added"] or res["changed"] or gone_real)



def _parse_today(s):
    """`--today` の検証。argparse の `type=` に渡すと、壊れた値は
    トレースバックではなく argparse 自身の使用法メッセージで弾かれる。"""
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"YYYY-MM-DD 形式で指定してください: {s!r}")

def main():
    p = argparse.ArgumentParser(description="前回と今回のCSVを突き合わせる")
    p.add_argument("dataset", nargs="?", help="events / lives / movies（省略時は全部）")
    p.add_argument("--json", action="store_true", help="機械可読なJSONで出す")
    p.add_argument("--allow-unexplained", action="store_true",
                   help="説明のない消滅があっても終了コード0にする（調査途中の確認用）")
    p.add_argument("--allow-noop", action="store_true",
                   help="収穫が0件でも終了コード0にする（調査途中の確認用）")
    p.add_argument("--today", type=_parse_today, help="基準日 YYYY-MM-DD（試験用。既定は今日）")
    args = p.parse_args()

    today = args.today if args.today else date.today()

    names = [resolve_dataset(args.dataset)] if args.dataset else \
            ["events.csv", "lives.csv", "movies.csv"]

    results, bad, noop = [], 0, []
    for n in names:
        res, unexplained = diff_one(n)
        res["noop"] = is_noop(res, today)
        results.append(res)
        bad += unexplained
        if res["noop"]:
            noop.append(n)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for res in results:
            print_human(res)
        print(f"\n合計: 説明のない消滅 {bad}件")
        if noop:
            print(f"      収穫0件のデータセット {len(noop)}件: {', '.join(noop)}")

    if (bad and not args.allow_unexplained) or (noop and not args.allow_noop):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
