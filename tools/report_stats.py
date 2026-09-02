#!/usr/bin/env python3
"""今週の収集で何がどれだけ埋まったかを、前回と比べて出す。

## なぜ要るのか

各スキルは報告に「件数・都県別内訳・カテゴリ別内訳」を求めていた。だが件数は
**中身の薄さを隠す**。2026-08 の実測はこうだった。

    events  price_best  6/113 (5%)   ← スキルが「このタスクの中核」と宣言した層
            coupon_note 2/113 (1%)
    lives   onsale_end  2/90  (2%)   ← 「この列の精度がこのタスクの価値を決める」
    movies  price_* / onsale_* / kana / series_id / announced_date / is_additional
            すべて 0/130 (0%)

件数だけを見ていた限り、これは「100件そろっている健全な週」に見える。
**劣化を検知する経路が、人間の体感しかなかった。**

このスクリプトは、各スキルが自分で中核だと言っている列の充足率を、前回のCSVと
並べて出す。「調査能力が落ちている気がする」を「先週5%から今週3%に落ちた」に
変えるためのもので、報告にそのまま貼る。数字が下がった週は
`docs/skill-feedback.md` に書くべきことが実在するという合図でもある。

## 品質チェックの一部も、ここで機械が数える

「7都県すべてから5件以上」「東京は半分以下」「8カテゴリすべてから3件以上」は、
各SKILL.mdのチェックリストにある項目だが、数えるのはモデルの目視だった。
数えられるものは数える。

使い方:
    python3 tools/report_stats.py                # 3データセットぶん
    python3 tools/report_stats.py events
    python3 tools/report_stats.py --json
"""

import argparse
import csv
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prev_rows import load_prev, resolve_dataset                  # noqa: E402
from rowkey import uid as row_uid                                # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# 各スキルが「このタスクの価値の中心」と宣言している列。ここが薄い週は、
# 件数がそろっていても仕事をしていない。
CORE = {
    "events.csv": [
        # `price`（画面に出る料金の文字列）が、この表に無かった。中核だと宣言して
        # いるのは比較のほう（`price_official` / `price_best`）だが、**利用者が
        # 実際に読むのはこの列**であり、ここが空の行はカードに料金が出ない。
        # 2026-09-02 の回はこの列が 66%→58% に落ちたが、表に無いので数字がどこにも
        # 出ず、報告は「price_official が5ポイント落ちた」だけを述べて終わっている。
        ("price", "料金（画面に出る文字列）"),
        ("price_official", "公式の正規料金"),
        ("price_best", "最安経路の総額"),
        ("coupon_note", "配布中クーポン"),
        ("price_checked", "価格の確認日"),
        ("desc", "目玉の説明"),
        ("nearest_station", "最寄り駅"),
        ("lat", "座標（地図に出る条件）"),
    ],
    "lives.csv": [
        ("onsale_label", "受付の名称"),
        ("onsale_start_time", "発売時刻"),
        ("onsale_end", "受付の締切日"),
        ("onsale_end_time", "締切時刻"),
        ("limited_sale", "限定・追加販売"),
        ("is_additional", "追加公演"),
        ("apple_music_url", "Apple Music"),
        ("desc", "公演の位置づけ"),
    ],
    "movies.csv": [
        ("onsale_label", "前売り券の券種"),
        ("onsale_end", "前売りの販売終了日"),
        ("price_official", "通常料金"),
        ("price_best", "実際に払える最安額"),
        ("price", "料金"),
        ("price_checked", "価格の確認日"),
        ("end_date", "上映終了日"),
        ("official_url", "作品公式サイト"),
        ("desc", "目玉の説明"),
        ("kana", "読み仮名"),
        ("series_id", "特集上映のシリーズID"),
        ("announced_date", "公開・上映の発表日"),
        ("is_additional", "上映延長・アンコール"),
    ],
}

# 分布を見る列と、各SKILL.mdが求めている下限。
BALANCE = {
    "events.csv": {"pref": 5, "cats": 3},
    "lives.csv": {"pref": 3, "genre": None, "live_type": None},
    "movies.csv": {"pref": 2, "screening_type": None, "genre": None},
}

# 「今週あらたに書いた行」に求める下限。**全体の充足率では、この失敗は見えない。**
#
# 2026-09-02 の events は price 58%（前回66%）で、5ポイントの低下にしか見えない。
# だが内訳は「継続365件は65%・新規90件は32%」で、継続分の値は
# `prev_rows.py --carry-rest` が前回値を書き戻しただけである（あれは `onsale_*`
# だけを空にして `price_*` は残す）。**今週その料金を実際に見た行は、ほぼ無い。**
# 前回値の持ち越しが、調べていない事実を「充足している」に見せる。
#
# だから見るのは、持ち越しが混ざりようのない層——前回に無い uid の行だけ——に絞る。
#
# 下限を70%にしてあるのは、過去5回の実測（18% / 96% / 41% / 15% / 32%）のうち
# 唯一まともだった回が96%で、他は明確に調査が届いていない回だからである。
# **「毎週落ちるなら下限が高すぎる」ではなく「毎週調べられていない」が正しい読み方**
# であることを、この数字で固定する。
FRESH_FLOOR = {
    "events.csv": {"price": 70},
}

# 新規が数件しかない週まで判定すると、1件の空欄で下限を割る。数えるに足りる分だけ見る。
FRESH_MIN_SAMPLE = 10

PREFS = ["tokyo", "kanagawa", "saitama", "chiba", "ibaraki", "tochigi", "gunma", "other"]
# イベントだけ対象地域が1都4県（栃木・群馬は対象外）。「都県ごとに floor 件
# 以上」のバランスチェックをここだけ絞らないと、栃木・群馬が常に0件のまま
# 「floorに満たない」警告が毎回出てしまう。
EVENT_PREFS = ["tokyo", "kanagawa", "saitama", "chiba", "ibaraki"]


def read_current(name):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def filled(rows, col):
    return sum(1 for r in rows if (r.get(col) or "").strip())


def pct(n, total):
    return (n * 100 // total) if total else 0


def counts(rows, col):
    out = {}
    for r in rows:
        for v in (r.get(col) or "").split("|"):
            v = v.strip()
            if v:
                out[v] = out.get(v, 0) + 1
    return out


def analyse(name):
    cur = read_current(name)
    prev, _src = load_prev(name)
    res = {
        "dataset": name,
        "current_count": len(cur),
        "prev_count": len(prev),
        "core": [],
        "balance": {},
        "warnings": [],
        # pref の網羅性に関する問題だけを、--check が拾えるよう構造化して残す。
        # 2026-08-29 の無人実行は、千葉・群馬が調査範囲から漏れたまま最後まで
        # 気づかれなかった。この不足自体はここの WARNING と同じ集計で検知できて
        # いたが、report_stats.py は「数字を出すだけで良し悪しは判定しない」設計
        # のため、誰も見ないまま流れた。coverage_issues はその数字を、判定したい
        # 側（--check）が使える形で持たせるためのものである。
        "coverage_issues": [],
        # 「今週書いた行が薄い」を、判定したい側（--check）が使える形で持たせる。
        # warnings と別に持つのは coverage_issues と同じ理由である。
        "thin_issues": [],
    }

    # 今週あらたに書いた行（前回に無い uid）。持ち越しが混ざらない層。
    prev_uids = {row_uid(name, r) for r in prev}
    fresh = [r for r in cur if row_uid(name, r) not in prev_uids] if prev else []
    res["fresh"] = {"count": len(fresh), "columns": []}
    for col, floor in FRESH_FLOOR.get(name, {}).items():
        if cur and col not in cur[0]:
            continue
        n = filled(fresh, col)
        p = pct(n, len(fresh))
        res["fresh"]["columns"].append(
            {"column": col, "filled": n, "pct": p, "floor": floor})
        if len(fresh) >= FRESH_MIN_SAMPLE and p < floor:
            res["warnings"].append(
                f"今週の新規{len(fresh)}件のうち {col} があるのは{n}件（{p}%）。"
                f"下限{floor}%に届いていません")
            res["thin_issues"].append(
                {"column": col, "pct": p, "floor": floor, "count": len(fresh), "filled": n})

    for col, label in CORE.get(name, []):
        if cur and col not in cur[0]:
            continue
        n, p = filled(cur, col), filled(prev, col)
        res["core"].append({
            "column": col, "label": label,
            "filled": n, "pct": pct(n, len(cur)),
            "prev_filled": p, "prev_pct": pct(p, len(prev)),
            "delta_pct": pct(n, len(cur)) - pct(p, len(prev)),
        })

    for col, floor in BALANCE.get(name, {}).items():
        c = counts(cur, col)
        res["balance"][col] = c
        if floor:
            if col == "pref":
                keys = EVENT_PREFS if name == "events.csv" else PREFS[:7]
            else:
                keys = sorted(c)
            short = [k for k in keys if c.get(k, 0) < floor]
            if col == "pref" and short:
                res["warnings"].append(
                    f"{col}: {floor}件に満たない都県が{len(short)}件（{', '.join(short)}）")
                res["coverage_issues"].extend({"kind": "floor", "pref": k} for k in short)
            elif col != "pref" and short:
                res["warnings"].append(
                    f"{col}: {floor}件に満たない区分が{len(short)}件（{', '.join(short)}）")

    tokyo = counts(cur, "pref").get("tokyo", 0)
    if cur and tokyo * 2 > len(cur):
        res["warnings"].append(f"東京が全体の半分を超えています（{tokyo}/{len(cur)}）")

    # ライブだけは隣接5県の扱いに上限がある（設計書 第9.2節）
    if name == "lives.csv" and cur:
        other = counts(cur, "pref").get("other", 0)
        if other == 0:
            res["warnings"].append(
                "隣接5県（pref=other）が0件です。venues.csv には隣接県の会場が登録されており、"
                "収穫が付かないままだと roster.py --gc がいずれ自動整理します")
        elif other * 10 > len(cur) * 2:
            res["warnings"].append(
                f"隣接5県が多すぎます（{other}/{len(cur)}）。関東側の探索不足を疑ってください")
            res["coverage_issues"].append({"kind": "adjacent_heavy", "pref": "other"})

    return res


def print_human(res):
    name = res["dataset"]
    d = res["current_count"] - res["prev_count"]
    print(f"\n=== {name} ===")
    print(f"  件数: {res['current_count']}件（前回 {res['prev_count']}件 / {d:+d}）")

    if res["core"]:
        print("\n  中核列の充足率（前回比）")
        for c in res["core"]:
            arrow = "→" if c["delta_pct"] == 0 else ("↑" if c["delta_pct"] > 0 else "↓")
            print(f"    {c['column']:<18} {c['filled']:>4}/{res['current_count']:<4}"
                  f" {c['pct']:>3}%  {arrow} 前回{c['prev_pct']:>3}%"
                  f"  （{c['label']}）")

    fresh = res.get("fresh") or {}
    if fresh.get("columns"):
        print(f"\n  今週あらたに書いた行の充足率（{fresh['count']}件・持ち越しを含まない）")
        for c in fresh["columns"]:
            mark = "  " if c["pct"] >= c["floor"] else "← 下限割れ"
            print(f"    {c['column']:<18} {c['filled']:>4}/{fresh['count']:<4}"
                  f" {c['pct']:>3}%  （下限 {c['floor']}%）{mark}")

    for col, c in res["balance"].items():
        if not c:
            continue
        keys = [k for k in PREFS if k in c] if col == "pref" else sorted(c, key=lambda k: -c[k])
        print(f"\n  {col}: " + " ".join(f"{k}={c[k]}" for k in keys))

    if res["warnings"]:
        print()
        for w in res["warnings"]:
            print(f"  WARNING {w}")


def main():
    p = argparse.ArgumentParser(description="収集結果の充足率と分布を前回と比べて出す")
    p.add_argument("dataset", nargs="?", help="events / lives / movies（省略時は全部）")
    p.add_argument("--json", action="store_true", dest="as_json", help="機械可読に出す")
    # `--check` は既定の動作を変えない。数字を出すことと良し悪しを判定することを
    # 分ける設計（下記コメント）は保ったまま、判定してほしい側（終了工程のゲート）
    # だけが明示的にこのフラグを付けて使う。
    p.add_argument("--check", action="store_true",
                   help="都県の網羅性と、今週の新規行の中核列を判定し、"
                        "承知していない不足があれば終了コード1で返す"
                        "（既定では判定しない。下記 --allow-short / --allow-thin 参照）")
    # `--check` を丸ごとフックに置かない理由。
    #
    # `.claude/hooks/verify-data.sh` はルーチン中 events/lives/movies の3つを回す
    # （収集していないデータセットの後始末も安全網として通すため）。そこに
    # `--check` を置くと、**今週 events を集めている回が、先週のままの lives の
    # 都県不足で止まる。** 網羅性は「今週その都県を調べたか」の話なので、
    # 調べていないデータセットに対して問う意味が無い。
    #
    # 一方、今週の新規行の充足率は、収集していないデータセットでは新規0件＝
    # 判定対象なしになるので、3つ回しても誤って落ちない。フックにはこちらだけを置く。
    p.add_argument("--check-fresh", action="store_true", dest="check_fresh",
                   help="今週あらたに書いた行の中核列だけを判定する"
                        "（都県の網羅性は見ない。終了前フック用）")
    p.add_argument("--allow-thin", action="append", default=[],
                   help="この列は今週の新規行で薄くてよいと承知している"
                        "（--check 用。列名を指定。複数指定可・カンマ区切り可）")
    p.add_argument("--allow-short", action="append", default=[],
                   help="この都県は今回件数が少ない／0件でよいと承知している"
                        "（--check 用。複数指定可・カンマ区切り可。隣接5県が多すぎる警告は "
                        "--allow-short other で承知したことにする）")
    args = p.parse_args()

    names = [resolve_dataset(args.dataset)] if args.dataset else \
            ["events.csv", "lives.csv", "movies.csv"]
    results = [analyse(n) for n in names]

    if args.as_json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for r in results:
            print_human(r)
        print("\n充足率が前回より落ちた列があれば、その理由を報告に書くこと。"
              "\n原因が目標件数・品質基準・禁止事項の側にあるなら docs/skill-feedback.md に追記する"
              "（自分で書き換えない）。それ以外の小さなバグなら自分で直してよい。")
    # 数字を出すのが仕事で、良し悪しの判定はしない。落とすのは validate/diff の役目
    # ——ただし網羅性（pref）と今週の新規行の薄さだけは、判定を明示的に頼める（下記）。
    if not (args.check or args.check_fresh):
        return 0

    allowed = set()
    for a in args.allow_short:
        allowed.update(v.strip() for v in a.split(",") if v.strip())
    allowed_thin = set()
    for a in args.allow_thin:
        allowed_thin.update(v.strip() for v in a.split(",") if v.strip())

    rc = 0

    unresolved = []
    for r in results if args.check else []:
        left = [i for i in r["coverage_issues"] if i["pref"] not in allowed]
        if left:
            prefs = ", ".join(sorted({i["pref"] for i in left}))
            unresolved.append(f"{r['dataset']}: {prefs}")

    if unresolved:
        print("\n--check: 都県の網羅性に承知していない不足があります"
              "（今週その都県を実際に調べたうえで0件/僅少だったなら "
              "--allow-short <pref> で承知したことにしてください。調べていないなら調べること）")
        for u in unresolved:
            print(f"  {u}")
        rc = 1

    thin = []
    for r in results:
        for i in r["thin_issues"]:
            if i["column"] not in allowed_thin:
                thin.append((r["dataset"], i))

    if thin:
        print("\n新規行の下限: 今週あらたに書いた行が、中核の列で下限を割っています")
        for ds, i in thin:
            print(f"  {ds}: {i['column']} {i['filled']}/{i['count']}"
                  f"（{i['pct']}% < 下限{i['floor']}%）")
        print("\n  持ち越した行の値は「今週確認した値」ではありません"
              "（carry-rest は前回値をそのまま書き戻します）。"
              "\n  料金は一覧ページには載っていないのが普通です。会場ごとに1回、"
              "料金ページ（利用案内・入館料・チケット）を開いてください——"
              "\n    python3 tools/fetch_page.py <会場トップ> --links | grep -E "
              "'料金|入館|入園|チケット|利用案内|price|ticket|admission'"
              "\n  1回の取得でその会場の全行を埋められるので、追加の検索は要りません。"
              "\n  調べたうえで本当に確認できない行ばかりだったなら "
              "--allow-thin <列名> で承知したことにし、その理由を報告に書いてください。")
        rc = 1

    return rc


if __name__ == "__main__":
    sys.exit(main())
