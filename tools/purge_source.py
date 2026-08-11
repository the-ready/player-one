#!/usr/bin/env python3
"""あるサイトの痕跡をリポジトリ全体から洗い出し、掲載データから消す。

## なぜこのスクリプトがあるのか

調査対象外の申請（`terms.html` 第6節）を受けたとき、やることは「そのサイトを
やめる」の一言だが、**実際にそのサイトが載っている場所は10か所以上に散っている**。

    data/events.csv     url / official_url / venue_url
    data/lives.csv      url / official_url / venue_url
    data/movies.csv     url / official_url / theater_url
    data/lineups.csv    公演が消えたら道連れになる行
    data/spots.csv 他   名簿4つの url
    data/sources.json   「調べたサイト一覧」
    .claude/skills/     横断サイトの表に名前とURLが書いてある
    docs/ README.md     例示として出てくることがある
    data/.prev/         前回の退避（次週これを見て復活しうる）

手で grep して消すと、**必ずどれかが残る**。しかも残ったことに誰も気づかない
——次の週に収集タスクが `.prev` からその行を引き直して復活させても、
差分は「変更なし」としか出ない。だから探すのは機械の仕事にする。

**このスクリプトは判断しない。** どこに何があるかを出し、消せと言われたものを
消すだけである。スコープ（取得だけやめるのか、掲載も消すのか）の判断は
`.claude/skills/source-optout/SKILL.md` の手順に従って人間が行う。

## 使い方

    python3 tools/purge_source.py --audit example.com        # どこにあるかを出す（既定）
    python3 tools/purge_source.py --apply example.com        # 掲載データから消す
    python3 tools/purge_source.py --apply example.com --keep-rows
                                                             # 名簿と一覧だけ外し、行は残す

`--apply` は散文（SKILL.md・docs・README・terms.html）には触らない。**書き換えると
指示が変わる**ので、該当箇所を挙げるところまでにして、直すのは人間の仕事にしてある
（`docs/COLLECTION-PROTOCOL.md` 7.1節と同じ線引き）。
"""

import argparse
import csv
import glob
import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import robots_rules as rr                                    # noqa: E402

ROOT = rr.ROOT

# 掲載データ。行ごと消す対象になる。
FEEDS = {
    "events": ["url", "official_url", "venue_url"],
    "lives": ["url", "official_url", "venue_url"],
    "movies": ["url", "official_url", "theater_url"],
}
ROSTERS = {"spots": "name", "venues": "venue", "theaters": "name", "festivals": "name"}

# 散文。挙げるだけで書き換えない。
PROSE = ["README.md", "terms.html", "privacy.html", "index.html",
         "docs/*.md", ".claude/skills/*/SKILL.md", ".claude/routines/*.txt"]


def host_of(url):
    try:
        h = urllib.parse.urlsplit(url.strip()).netloc.lower().split(":")[0]
    except ValueError:
        return ""
    return h[4:] if h.startswith("www.") else h


def matches(url, target):
    h = host_of(url)
    return bool(h) and (h == target or h.endswith("." + target))


def path_of(name):
    return os.path.join(ROOT, "data", f"{name}.csv")


# ---------------------------------------------------------------- 洗い出し


def audit(target):
    """どこに何があるかを集める。戻り値は表示と `--apply` の両方で使う。"""
    found = {"feeds": {}, "rosters": {}, "sources": [], "prose": [],
             "prev": {}, "lineups": [], "no_crawl": None}

    for feed, cols in FEEDS.items():
        p = path_of(feed)
        if not os.path.exists(p):
            continue
        hits = []
        with open(p, encoding="utf-8") as f:
            for i, row in enumerate(csv.DictReader(f), start=2):
                where = [c for c in cols if matches(row.get(c) or "", target)]
                if where:
                    hits.append({"line": i, "id": row.get("id"),
                                 "title": row.get("title"), "cols": where,
                                 "lineup_id": (row.get("lineup_id") or "").strip()})
        if hits:
            found["feeds"][feed] = hits

    # lives が消えると、その日割りラインナップも宙に浮く
    live_ids = {h["lineup_id"] for h in found["feeds"].get("lives", []) if h["lineup_id"]}
    lp = path_of("lineups")
    if live_ids and os.path.exists(lp):
        with open(lp, encoding="utf-8") as f:
            for i, row in enumerate(csv.DictReader(f), start=2):
                if (row.get("lineup_id") or "").strip() in live_ids:
                    found["lineups"].append({"line": i, "lineup_id": row["lineup_id"],
                                             "artist": row.get("artist")})

    for roster, key in ROSTERS.items():
        p = path_of(roster)
        if not os.path.exists(p):
            continue
        hits = []
        with open(p, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if matches(row.get("url") or "", target):
                    hits.append({"name": row.get(key), "status": row.get("status")})
        if hits:
            found["rosters"][roster] = hits

    sp = os.path.join(ROOT, "data", "sources.json")
    if os.path.exists(sp):
        with open(sp, encoding="utf-8") as f:
            data = json.load(f)
        for tab, entries in data.items():
            if tab.startswith("_"):
                continue
            for e in entries:
                if matches(e.get("url") or "", target):
                    found["sources"].append({"tab": tab, "name": e["name"]})

    for pattern in PROSE:
        for p in glob.glob(os.path.join(ROOT, pattern)):
            try:
                with open(p, encoding="utf-8") as f:
                    for i, line in enumerate(f, start=1):
                        if target in line:
                            found["prose"].append(
                                {"file": os.path.relpath(p, ROOT), "line": i,
                                 "text": line.strip()[:100]})
            except (OSError, UnicodeDecodeError):
                continue

    for p in glob.glob(os.path.join(ROOT, "data", ".prev", "*.csv")):
        n = sum(1 for line in open(p, encoding="utf-8") if target in line)
        if n:
            found["prev"][os.path.relpath(p, ROOT)] = n

    found["no_crawl"] = rr.optout_match(f"https://{target}/")
    return found


def report(target, f):
    print(f"■ {target} の痕跡\n")
    total = 0

    for feed, hits in f["feeds"].items():
        print(f"  data/{feed}.csv — {len(hits)}行")
        for h in hits[:20]:
            print(f"    行{h['line']:>4} id={h['id']:<4} {(h['title'] or '')[:40]}"
                  f"  ({'/'.join(h['cols'])})")
        if len(hits) > 20:
            print(f"    …ほか {len(hits) - 20}行")
        total += len(hits)

    if f["lineups"]:
        print(f"  data/lineups.csv — {len(f['lineups'])}行（上の公演に紐づく日割り）")
        total += len(f["lineups"])

    for roster, hits in f["rosters"].items():
        print(f"  data/{roster}.csv — {len(hits)}件")
        for h in hits:
            print(f"    {h['name']}（現在 {h['status'] or 'active'}）")

    if f["sources"]:
        print(f"  data/sources.json — {len(f['sources'])}件")
        for s in f["sources"]:
            print(f"    [{s['tab']}] {s['name']}")

    if f["prev"]:
        print("  data/.prev/ — 前回の退避に残存（次週これを見て復活しうる）")
        for p, n in f["prev"].items():
            print(f"    {p}: {n}行")

    if f["prose"]:
        print(f"  散文 — {len(f['prose'])}か所（**自動では消さない。人間が直す**）")
        for h in f["prose"]:
            print(f"    {h['file']}:{h['line']}  {h['text']}")

    print(f"\n  no-crawl.json への登録: "
          f"{'あり（' + (f['no_crawl'].get('requested_on') or '') + '）' if f['no_crawl'] else '**なし**'}")
    if not any([f["feeds"], f["rosters"], f["sources"], f["prose"], f["prev"]]):
        print("  掲載データ・名簿・散文のいずれにも見つからなかった。")
    return total


# ---------------------------------------------------------------- 削除


def rewrite(path, rows, head):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=head)
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, path)


def apply(target, f, keep_rows):
    changed = []

    if not keep_rows:
        for feed, cols in FEEDS.items():
            p = path_of(feed)
            if not os.path.exists(p) or feed not in f["feeds"]:
                continue
            with open(p, encoding="utf-8") as fh:
                r = csv.DictReader(fh)
                head, rows = r.fieldnames, list(r)
            kept = [x for x in rows
                    if not any(matches(x.get(c) or "", target) for c in cols)]
            # id は1から連番、という3スキル共通の規則を保つ
            for n, x in enumerate(kept, start=1):
                if "id" in head:
                    x["id"] = str(n)
            rewrite(p, kept, head)
            changed.append(f"data/{feed}.csv: {len(rows) - len(kept)}行を削除")

        if f["lineups"]:
            p = path_of("lineups")
            gone = {h["lineup_id"] for h in f["lineups"]}
            with open(p, encoding="utf-8") as fh:
                r = csv.DictReader(fh)
                head, rows = r.fieldnames, list(r)
            kept = [x for x in rows if (x.get("lineup_id") or "").strip() not in gone]
            rewrite(p, kept, head)
            changed.append(f"data/lineups.csv: {len(rows) - len(kept)}行を削除")

    # 名簿は blocked にする（行は残す。座標・種別は表示側のマスターだから）
    for roster, hits in f["rosters"].items():
        p = path_of(roster)
        with open(p, encoding="utf-8") as fh:
            r = csv.DictReader(fh)
            head, rows = r.fieldnames, list(r)
        n = 0
        for x in rows:
            if matches(x.get("url") or "", target) and x.get("status") != "blocked":
                x["status"] = "blocked"
                n += 1
        if n:
            rewrite(p, rows, head)
            changed.append(f"data/{roster}.csv: {n}件を blocked に")

    if f["sources"]:
        p = os.path.join(ROOT, "data", "sources.json")
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
        n = 0
        for tab, entries in list(data.items()):
            if tab.startswith("_"):
                continue
            before = len(entries)
            data[tab] = [e for e in entries if not matches(e.get("url") or "", target)]
            n += before - len(data[tab])
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        changed.append(f"data/sources.json: {n}件を削除")

    return changed


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host", help="対象ホスト（例 example.com）")
    ap.add_argument("--audit", action="store_true", help="どこにあるかを出す（既定）")
    ap.add_argument("--apply", action="store_true", help="掲載データから消す")
    ap.add_argument("--keep-rows", action="store_true",
                    help="--apply で、名簿と一覧だけ外し掲載行は残す（scope=crawl のとき）")
    args = ap.parse_args()

    target = host_of("https://" + args.host) or args.host.lower()
    f = audit(target)
    report(target, f)

    if not args.apply:
        print("\n（消すには --apply を付ける。先に no-crawl.json への登録を済ませること）")
        return 0

    if not f["no_crawl"]:
        print("\nERROR: data/no-crawl.json に未登録です。**先に登録してください。**\n"
              "  登録しないまま行だけ消しても、翌週の収集がまた取りに行って復活します。",
              file=sys.stderr)
        return 1

    print("\n■ 適用")
    for line in apply(target, f, args.keep_rows) or ["（変更なし）"]:
        print("  " + line)
    print("\n  残りは人間の仕事:")
    print("    - 上に挙げた散文の該当箇所を直す（SKILL.md の横断サイト表など）")
    print("    - python3 tools/validate_data.py が ERROR 0 か確認する")
    print("    - コミットして push する（GitHub Pages に反映されて初めて掲載が消える）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
