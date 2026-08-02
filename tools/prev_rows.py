#!/usr/bin/env python3
"""前回の収集結果を、コンテキストを食わずに参照するためのツール。

## なぜ必要か

収集タスクは「前回のCSVを読んで、既存の行が更新・終了していないか確認する」
という工程を持つ。しかし前回CSVをそのまま読み込むと、events.csv だけで
約68,000文字（概算4〜5万トークン）あり、着手した時点でコンテキストの2〜3割を
失う。append_rows.py の冒頭に書いた「後半の調査品質が落ちる」問題が、
そのまま再発する。

そこでこのツールが、

  1. **一覧は圧縮して出す**（棚卸しに必要な列だけ・1行1軒）
  2. **詳細は uid 指定で引く**（必要になった行だけ全列を返す）

という2段構えを提供する。全部を読むのではなく、必要な分だけ引く。

## 前回データはどこにあるか

`append_rows.py <ds> --init` が、CSVを空にする**前に** `data/.prev/` へ
退避する。退避が無い場合（初回や、手作業で消した場合）は git の HEAD から
復元を試みる。どちらも無ければ「前回データなし」として扱う。

## 使い方

    # 棚卸し用の一覧（既定は全件。--tier A で要再確認だけに絞る）
    python3 tools/prev_rows.py events --worklist
    python3 tools/prev_rows.py events --worklist --tier A

    # 特定の行だけ全列を引く（複数指定可）
    python3 tools/prev_rows.py events --uid 3f2a1b9c --uid 8d7e6f50

    # 会場名で引く（その会場の前回分がまとめて出る）
    python3 tools/prev_rows.py events --venue 東京国立博物館

    # 前回にあった行の「その後」を記録する（消滅行の説明。diff_data.py が要求する）
    python3 tools/prev_rows.py events --dispose <<'EOF'
    {"uid": "3f2a1b9c", "status": "ended", "note": "8/31で会期終了を公式で確認"}
    {"uid": "8d7e6f50", "status": "cancelled", "note": "台風のため中止"}
    EOF
"""

import argparse
import csv
import json
import os
import subprocess
import sys
from datetime import date, timedelta

from rowkey import uid as row_uid
from validate_data import EXPECTED_HEADERS, START_COL

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
PREV = os.path.join(DATA, ".prev")

NAME_MAP = {"events": "events.csv", "lives": "lives.csv", "movies": "movies.csv"}

# 前回にあった行が今回無い場合に付けられる説明。diff_data.py が対応表として使う。
DISPOSITIONS = {
    "ended":        "会期・上映・公演が終了したことを確認した",
    "cancelled":    "中止・延期になったことを確認した",
    "out-of-scope": "対象期間（3ヶ月）や対象地域から外れた",
    "merged":       "他の行に統合した（重複の解消）",
    "renamed":      "同じ催しだが表記が変わった（to に新しい uid を書くこと）",
    "notfound":     "今回は確認できなかった（終了したとは限らない。要注意）",
}

# --- 再確認の優先度（tier）を決めるしきい値 ---------------------------------
# 「全行を毎週フルに調べ直す」のは高いだけでなく、後半の調査を浅くする。
# 列ごとに変わりやすさが違うので、変わりやすいものを持つ行から先に見る。
NEAR_DAYS = 21          # 会期末・受付締切がこの日数以内なら要再確認
PRICE_TTL_DAYS = 14     # 価格の確認日がこれより古ければ洗い直す
URGENT_STATUS = {
    "本日まで", "まもなく開催", "本日開催", "本日が最終上映", "まもなく公開",
}


def resolve_dataset(arg):
    if arg in NAME_MAP:
        return NAME_MAP[arg]
    if arg in EXPECTED_HEADERS:
        return arg
    raise SystemExit(f"ERROR: 不明なデータセット名です: {arg!r}（events / lives / movies）")


# ---------------------------------------------------------------- 前回データ

def snapshot_path(name):
    return os.path.join(PREV, name)


def meta_path(name):
    return os.path.join(PREV, name.replace(".csv", ".meta.json"))


def _from_git(name):
    """`.prev` が無いときの保険。直前のコミットのCSVを読む。

    週次タスクは毎回コミットしてpushする運用なので、HEAD はほぼ前回の実行結果に
    あたる。ただし同じ日に2回実行した場合などはズレるため、あくまで保険。
    """
    try:
        out = subprocess.run(
            ["git", "show", f"HEAD:data/{name}"],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    return out.stdout


def load_prev(name):
    """(rows, source) を返す。前回データが無ければ ([], None)。"""
    path = snapshot_path(name)
    if os.path.exists(path):
        with open(path, newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f)), f"snapshot:{os.path.relpath(path, ROOT)}"
    text = _from_git(name)
    if text:
        return list(csv.DictReader(text.splitlines())), "git:HEAD"
    return [], None


def take_snapshot(name):
    """現在のCSVを `.prev/` に退避する。append_rows.py --init から呼ばれる。"""
    src = os.path.join(DATA, name)
    if not os.path.exists(src):
        return None
    os.makedirs(PREV, exist_ok=True)
    with open(src, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    with open(src, encoding="utf-8") as f:
        raw = f.read()
    with open(snapshot_path(name), "w", encoding="utf-8") as f:
        f.write(raw)
    with open(meta_path(name), "w", encoding="utf-8") as f:
        json.dump({"taken_at": date.today().isoformat(), "rows": len(rows)},
                  f, ensure_ascii=False, indent=2)
    # 退避のたびに、その時点の処分記録は役目を終える（次の週の分をゼロから貯める）
    disp = disposition_path(name)
    if os.path.exists(disp):
        os.remove(disp)
    return len(rows)


def prev_taken_at(name):
    try:
        with open(meta_path(name), encoding="utf-8") as f:
            return date.fromisoformat(json.load(f)["taken_at"])
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------- tier 判定

def _d(value):
    try:
        return date.fromisoformat((value or "").strip())
    except ValueError:
        return None


def tier_of(name, row, today):
    """A=毎回必ず再確認 / B=会場調査のついでに確認 / C=低頻度でよい。

    tier は「手を抜いてよい行」を決めるためのものではなく、
    **限られた回数のページ取得を、変わりやすい行から先に使う**ための優先順位である。
    B の行も、その会場のページを開いた時点で同時に確認できる（会場単位で回るため）。
    """
    reasons = []
    start = _d(row.get(START_COL[name]))
    end = _d(row.get("end_date"))
    status = (row.get("status") or "").strip()
    soon = today + timedelta(days=NEAR_DAYS)

    if status in URGENT_STATUS:
        reasons.append(f"status={status}")
    if end and end <= soon:
        reasons.append(f"会期末{end}")
    if start and today <= start <= soon:
        reasons.append(f"開始{start}")

    os_end = _d(row.get("onsale_end"))
    os_start = _d(row.get("onsale_start"))
    if os_end and os_end <= soon:
        reasons.append(f"締切{os_end}")
    if os_start and os_start >= today:
        reasons.append(f"発売{os_start}")
    if (row.get("onsale_label") or "").strip() and not os_end:
        reasons.append("受付状況が未確定")

    if (row.get("coupon_note") or "").strip():
        reasons.append("クーポン")           # 配布は不定期に終わる
    if (row.get("is_additional") or "").strip() in ("1", "true", "yes"):
        reasons.append("追加公演")

    has_price = any((row.get(c) or "").strip()
                    for c in ("price_official", "price_best", "discount_pct"))
    checked = _d(row.get("price_checked"))
    if has_price and (not checked or (today - checked).days > PRICE_TTL_DAYS):
        reasons.append("価格の確認日が古い")

    if reasons:
        return "A", reasons

    if status == "通年予約可" or (not start and not end):
        return "C", ["日程が動かない/日程を持たない"]
    return "B", []


# ---------------------------------------------------------------- 出力

def _clip(value, width):
    s = (value or "").strip().replace("\t", " ").replace("\n", " ")
    return s if len(s) <= width else s[: width - 1] + "…"


def cmd_worklist(name, rows, args):
    today = date.fromisoformat(args.today) if args.today else date.today()
    taken = prev_taken_at(name)

    print(f"# {name} 前回分の棚卸しリスト（{len(rows)}件）")
    if taken:
        print(f"# 前回の取得日: {taken}（{(today - taken).days}日前）")
    print("# tier A=今回必ず再確認 / B=会場ページを開いたついでに確認 / C=低頻度でよい")
    print("# 全列が要るときは: python3 tools/prev_rows.py <ds> --uid <uid>")
    print("uid\ttier\tpref\ttitle\tvenue\t期間\t締切\t理由")

    counts = {"A": 0, "B": 0, "C": 0}
    place_col = "theater" if name == "movies.csv" else "venue"
    for r in rows:
        tier, reasons = tier_of(name, r, today)
        counts[tier] += 1
        if args.tier and tier not in args.tier:
            continue
        span = f"{(r.get(START_COL[name]) or '')[5:]}〜{(r.get('end_date') or '')[5:]}".strip("〜")
        print("\t".join([
            row_uid(name, r), tier, (r.get("pref") or ""),
            _clip(r.get("title"), 34), _clip(r.get(place_col), 16),
            span or "-", (r.get("onsale_end") or "")[5:] or "-",
            ",".join(reasons)[:48],
        ]))
    print(f"\n# 内訳: A={counts['A']} B={counts['B']} C={counts['C']}")


def cmd_show(name, rows, args):
    wanted = set(args.uid or [])
    venues = {v for v in (args.venue or [])}
    place_col = "theater" if name == "movies.csv" else "venue"
    hits = [r for r in rows
            if (row_uid(name, r) in wanted) or ((r.get(place_col) or "").strip() in venues)]
    if not hits:
        print("# 該当なし", file=sys.stderr)
        return 1
    for r in hits:
        out = {k: v for k, v in r.items() if (v or "").strip()}
        out["_uid"] = row_uid(name, r)
        print(json.dumps(out, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- 処分の記録

def disposition_path(name):
    return os.path.join(PREV, name.replace(".csv", ".dispositions.jsonl"))


def cmd_dispose(name, rows, args):
    known = {row_uid(name, r): r for r in rows}
    raw = sys.stdin.read()
    recs = []
    for i, line in enumerate((l for l in raw.splitlines() if l.strip()), start=1):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            raise SystemExit(f"ERROR: {i}行目のJSONを解析できません: {e}")
        uid_ = (obj.get("uid") or "").strip()
        st = (obj.get("status") or "").strip()
        if uid_ not in known:
            raise SystemExit(f"ERROR: {i}行目の uid {uid_!r} は前回データにありません")
        if st not in DISPOSITIONS:
            raise SystemExit(
                f"ERROR: {i}行目の status {st!r} は未定義です。"
                f"使えるのは: {', '.join(DISPOSITIONS)}"
            )
        if st == "renamed" and not (obj.get("to") or "").strip():
            raise SystemExit(f"ERROR: {i}行目 renamed には to（新しいuid）が要ります")
        obj["title"] = known[uid_].get("title", "")
        recs.append(obj)

    os.makedirs(PREV, exist_ok=True)
    with open(disposition_path(name), "a", encoding="utf-8") as f:
        for obj in recs:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    print(f"{len(recs)}件の処分を記録しました → {os.path.relpath(disposition_path(name), ROOT)}")
    return 0


def load_dispositions(name):
    path = disposition_path(name)
    if not os.path.exists(path):
        return {}
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                obj = json.loads(line)
                out[obj["uid"]] = obj
    return out


# ---------------------------------------------------------------- entry

def main():
    p = argparse.ArgumentParser(description="前回の収集結果を圧縮して参照する")
    p.add_argument("dataset", help="events / lives / movies")
    p.add_argument("--worklist", action="store_true", help="棚卸し用の圧縮一覧を出す")
    p.add_argument("--tier", help="worklist を tier で絞る（例: A / AB）")
    p.add_argument("--uid", action="append", help="この uid の行を全列で出す（複数可）")
    p.add_argument("--venue", action="append", help="この会場の行を全列で出す（複数可）")
    p.add_argument("--dispose", action="store_true", help="消えた行の理由を標準入力(JSONL)から記録する")
    p.add_argument("--stats", action="store_true", help="件数だけ出す")
    p.add_argument("--today", help="基準日 YYYY-MM-DD（試験用。既定は今日）")
    args = p.parse_args()

    name = resolve_dataset(args.dataset)
    rows, source = load_prev(name)
    if not rows:
        print(f"# 前回データがありません（{name}）。初回実行として扱ってください。")
        return 0
    print(f"# 出典: {source}", file=sys.stderr)

    if args.dispose:
        return cmd_dispose(name, rows, args)
    if args.uid or args.venue:
        return cmd_show(name, rows, args)
    if args.stats:
        print(f"{name}: {len(rows)}行")
        return 0
    cmd_worklist(name, rows, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
