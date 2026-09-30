#!/usr/bin/env python3
"""終了工程の機械的な部分を、1回の呼び出しでまとめて通す。

    python3 tools/close_run.py <events|lives|movies> [--allow-short 県,...] [--allow-thin 列,...]
                                                     [--allow "フェス名"]   # lives のみ

順に回すもの（どれも取得を伴わない。`fill_apple_music.py` だけは iTunes Search API
を引くが、結果をキャッシュするので2回目以降は新しい名前しか引かない）:

    1. purge_ended.py <ds>                 終了日を過ぎた行の片付け
    2. fill_apple_music.py                 （lives のみ）日割りの Apple Music リンク
    3. roster.py <名簿> --gc                名簿の整理
    4. diff_data.py <ds>                   差分の確定（出力は**切らずに全部**出す）
    5. validate_data.py                    検証（出力は全部出す）
    6. report_stats.py <ds> --check        充足率・網羅性の判定
    7. festival_gate.py                    （lives のみ）フェス名簿との整合

中止・改名の処分（`prev_rows.py --dispose`）は判断を要するので含めない。4 が
「説明のない消滅」を出したら、処分してからもう一度このコマンドを回す。

## なぜ1本にまとめるのか

終了工程は波をすべて受け取った後、**親の文脈がいちばん膨らんでいる時点**で走る。
そこで1コマンドを1ターンずつ打つと、1ターンごとに文脈全体（200〜300k）を送り直す。
2026-09-25 の lives は最後の波の後に親が72ターン回り、実際の文脈再送で16.2M——
**その回の消費の53%を、調査ではなく終了工程に使っていた**（`tools/budget.py` の
重複を除いた数え方で計測）。同じ diff を4回、validate を4回打ち直し、フックや
ツールのソースまで読んでいる。ここで打つ回数を1〜2回にすれば、その分がそのまま
調査に回る。

終了コード: 4〜7 のどれかが落ちていれば 1（どれが落ちたかを末尾にまとめて出す）。
1〜3 の失敗は報告するが止めない（片付けの失敗で検証まで飛ばさない）。
"""

import argparse
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")

ROSTERS = {
    "events": ["spots"],
    "lives": ["venues", "festivals"],
    "movies": ["theaters"],
}


def _run(label, args):
    """1コマンドを回し、出力を**切らずに**そのまま出す。終了コードを返す。"""
    print(f"\n===== {label}: python3 {' '.join(args)} =====", flush=True)
    try:
        r = subprocess.run([sys.executable] + args, cwd=ROOT,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    except OSError as e:
        print(f"起動できませんでした: {e}")
        return 127
    out = r.stdout.rstrip()
    if out:
        print(out)
    print(f"----- exit {r.returncode}", flush=True)
    return r.returncode


def _csv_args(flag, values):
    vals = [v.strip() for a in values for v in a.split(",") if v.strip()]
    return [flag, ",".join(vals)] if vals else []


def main():
    p = argparse.ArgumentParser(description="終了工程の機械的な部分をまとめて通す")
    p.add_argument("dataset", choices=sorted(ROSTERS))
    p.add_argument("--allow-short", action="append", default=[],
                   help="report_stats.py にそのまま渡す（調べたうえで少ない都県）")
    p.add_argument("--allow-thin", action="append", default=[],
                   help="report_stats.py にそのまま渡す（調べたうえで薄い列。承知はこの回のあいだ記録される）")
    p.add_argument("--allow", action="append", default=[],
                   help="festival_gate.py にそのまま渡す（lives のみ）")
    args = p.parse_args()
    ds = args.dataset
    t = lambda name: os.path.join("tools", name)       # noqa: E731

    soft = []
    if _run("1 終了日を過ぎた行", [t("purge_ended.py"), ds]) != 0:
        soft.append("purge_ended.py")
    if ds == "lives" and _run("2 Apple Music", [t("fill_apple_music.py")]) != 0:
        soft.append("fill_apple_music.py")
    for r in ROSTERS[ds]:
        if _run(f"3 名簿 {r}", [t("roster.py"), r, "--gc"]) != 0:
            soft.append(f"roster.py {r} --gc")

    hard = []
    if _run("4 差分", [t("diff_data.py"), ds]) != 0:
        hard.append(f"diff_data.py {ds}（説明のない消滅は prev_rows.py {ds} --dispose で処分してから、"
                    "このコマンドをもう一度）")
    if _run("5 検証", [t("validate_data.py")]) != 0:
        hard.append("validate_data.py（ERROR を直してから、このコマンドをもう一度）")
    stats = [t("report_stats.py"), ds, "--check"]
    stats += _csv_args("--allow-short", args.allow_short) + _csv_args("--allow-thin", args.allow_thin)
    if _run("6 充足率と網羅性", stats) != 0:
        hard.append(f"report_stats.py {ds} --check（調べたうえでなら --allow-short / --allow-thin を"
                    "このコマンドに付けて承知する）")
    if ds == "lives":
        fg = [t("festival_gate.py")]
        for a in args.allow:
            fg += ["--allow", a]
        if _run("7 フェス名簿", fg) != 0:
            hard.append("festival_gate.py（調べたうえでなら --allow \"フェス名\" を付けて承知する）")

    print("\n===== まとめ =====")
    for s in soft:
        print(f"  △ {s} が失敗しました（片付けの失敗。検証は続けました）")
    if not hard:
        print("  ✓ 差分・検証・充足率" + ("・フェス名簿" if ds == "lives" else "")
              + " はすべて通りました。報告を書いて終えてください。")
        return 0
    for h in hard:
        print(f"  ✗ {h}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
