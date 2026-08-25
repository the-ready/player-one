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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# 各スキルが「このタスクの価値の中心」と宣言している列。ここが薄い週は、
# 件数がそろっていても仕事をしていない。
CORE = {
    "events.csv": [
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
    }

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
    # 数字を出すのが仕事で、良し悪しの判定はしない。落とすのは validate/diff の役目。
    return 0


if __name__ == "__main__":
    sys.exit(main())
