#!/usr/bin/env python3
"""駐車場（P）の列を足し、名簿の空欄を「確実に読み取れるものだけ」埋める。

    python3 tools/backfill_parking.py --migrate           # 列を足す（1回だけ。何度回しても同じ）
    python3 tools/backfill_parking.py [events|lives|all]  # 名簿の空欄の下見（書かない）
    python3 tools/backfill_parking.py events --apply      # 実際に書く

## 何をするのか

画面のP（駐車場）バッジは2つの列から組み立てる（`docs/DESIGN.md` 第5.11節）。

  名簿（spots / venues / theaters.csv）の `parking`
      その場所の常設の駐車場。yes=あり / nearby=近隣の特定の駐車場を案内 / no=なし / 空=未確認。
  催しの行（events / lives.csv）の `event_parking`
      その催しの日だけの事情。temp=臨時あり / closed=当日は常設が使えない / temp_only=当日は臨時のみ。

`--migrate` はこの2種類の列を、既存のCSVへ足す。名簿は `url` の次、催しの行は
`nearest_station` の次に入れる。列が既にあれば何もしない。

通常実行（`--migrate` なし）は、**催しの行にすでに書かれている `parking` の文**
（公式の「アクセス」ページの写し）から、その場所の名簿の `parking` を埋める。
`close_run.py` が週次の終了工程で `--apply` つきで呼ぶので、収集が文を書くたびに
名簿の空欄が減っていく。

## 確実なものだけを入れる理由

空欄は「未確認」で、画面には何も出ない。誤った「あり」は、駐車場の無い場所へ
利用者を向かわせる。そこで次の規則を守る（`classify_place`）。

  ・「なし」で始まる文は no。ただし**特定の近隣駐車場の名前**を挙げて案内していれば nearby
    （`専用駐車場なし（近隣の北の丸公園第三駐車場を利用）`）。
    `周辺の有料駐車場を利用` のような一般的な言い方は no のまま
  ・台数・料金・「あり」・事前予約制など、駐車場が使えると読み取れる文は yes
  ・それ以外（「◯◯駐車場を利用」だけ、など）は判断せず空欄のまま
  ・同じ場所の行どうしで読み取りが食い違えば、どちらも採らずに空欄のまま
  ・名簿に値が既にあれば**上書きしない**（人や収集が確かめた値のほうが強いため）

## `event_parking` は初回の1回だけ文から種を蒔く

臨時駐車場・当日の閉鎖は催しごとの事情で、`append_rows.py` が前回値を持ち越さない
列である（CARRY_NEVER）。`parking` の文は会場単位で持ち越されるので、毎週ここから
`event_parking` を導くと、終わった催しの案内が次の催しに残る。そのため `--migrate` が
列を**新しく足した回にだけ**、文に明記されたもの（`当イベントでは利用不可`
`利用休止中` `臨時駐車場…開放`）を入れる。以後は収集が毎回確かめて書く。
"""

import argparse
import csv
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import roster  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# (ファイル, 足す列, この列の次に入れる)
MIGRATIONS = [
    ("spots.csv", "parking", "url"),
    ("venues.csv", "parking", "url"),
    ("theaters.csv", "parking", "url"),
    ("events.csv", "event_parking", "nearest_station"),
    ("lives.csv", "event_parking", "nearest_station"),
]

# 行のデータセット → (名簿のキー, 行の会場列)
DATASETS = {
    "events": ("spots", "venue"),
    "lives": ("venues", "venue"),
}

# ---------------------------------------------------------------- 文の読み取り

# 常設の駐車場が無いと言い切っている書き出し。
_NO_HEAD = re.compile(
    r"^(?:"
    r"なし|無し"
    r"|[^、。（）()]{0,8}駐車場(?:・駐輪場)?(?:の用意)?(?:は)?(?:なし|無し)"
    r"|駐輪・駐車スペースなし"
    r")"
)
# 近隣の駐車場を名前つきで案内している節。「◯◯を利用」「隣接の◯◯駐車場は…」。
_LOT_USE = re.compile(
    r"(?:近隣の|隣接の|周辺の|近くの)?(?P<n>[^、。（）()／/]{2,40}?)(?:等|など)?を利用"
)
_LOT_ADJ = re.compile(r"(?:隣接|近隣)の(?P<n>[^、。（）()]+?駐車場)は")
# 一般的な言い方を落としたとき、固有の名前が残るか。残らなければ「周辺の有料駐車場」の類。
_GENERIC = re.compile(
    r"周辺|近隣|近く|隣接|有料|無料|民間|私営|公営|一般|コインパーキング|駐車場|パーキング|"
    r"公共交通機関|電車|バス|等|など|[のや・、\s]"
)
# 台数・料金・予約制など、駐車場が使えると読み取れる印。
_YES = re.compile(
    r"^(?:あり|有)(?:$|[（(、。])"
    r"|駐車場(?:が)?(?:あり|有)"
    r"|\d[\d,]*台"
    r"|円"
    r"|事前予約制|事前精算制"
    r"|^(?:来館者|見学者|美術館|館)(?:用|専用)?駐車場"
    r"|駐車場[（(][^）)]*(?:無料|有料)"
)
_NEARBY_HEAD = re.compile(r"^(?:隣接|近隣)")
_NEARBY_WALK = re.compile(r"周辺.*徒歩\d+分")
# その催し・その日に限った利用不可（場所の事実ではない）
_UNAVAILABLE = re.compile(r"当イベントでは利用不可|当日は?利用不可|利用休止|閉鎖")
_TEMP = re.compile(r"臨時駐車場[^。]{0,12}(?:開放|用意|設置)")


def _named(fragment):
    """節の中に固有の駐車場名（一般語を落としても残る名前）があるか。"""
    return bool(_GENERIC.sub("", fragment))


def classify_place(text):
    """`parking` の文から、場所の常設の駐車場を yes / nearby / no で読む。読めなければ None。"""
    t = (text or "").strip()
    if not t or _UNAVAILABLE.search(t):
        return None
    m = _NO_HEAD.match(t)
    if m:
        rest = t[m.end():]
        for pat in (_LOT_USE, _LOT_ADJ):
            hit = pat.search(rest)
            if hit and _named(hit.group("n")):
                return "nearby"
        return "no"
    if _NEARBY_HEAD.match(t):
        return "nearby"
    if _YES.search(t):
        return "yes"
    if _NEARBY_WALK.search(t):
        return "nearby"
    return None


def classify_event(text):
    """`parking` の文に**明記された**催しごとの事情を、event_parking の値で返す。無ければ None。"""
    t = (text or "").strip()
    if not t:
        return None
    if _UNAVAILABLE.search(t):
        return "closed"
    if _TEMP.search(t):
        return "temp"
    return None


# ---------------------------------------------------------------- CSV の読み書き

def _quoting(path):
    """既存の書式（全項目を引用か、最小限か）を先頭の1文字から引き継ぐ。差分を列の追加だけにするため。"""
    with open(path, "rb") as f:
        return csv.QUOTE_ALL if f.read(1) == b'"' else csv.QUOTE_MINIMAL


def _read(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.reader(f))


def _write(path, rows):
    quoting = _quoting(path)
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        csv.writer(f, quoting=quoting, lineterminator="\r\n").writerows(rows)
    os.replace(tmp, path)


def migrate(data_dir=DATA, log=print):
    """列を足す。足したファイルの名前の一覧を返す。既にあれば何もしない。

    催しの行（events / lives）で列を新しく足した回だけ、`parking` の文に明記された
    臨時駐車場・当日の閉鎖を event_parking に入れる（モジュールの説明を参照）。
    """
    changed = []
    for fname, col, after in MIGRATIONS:
        path = os.path.join(data_dir, fname)
        if not os.path.exists(path):
            continue
        rows = _read(path)
        if not rows:
            continue
        head = rows[0]
        if col in head:
            continue
        if after not in head:
            raise SystemExit(f"ERROR: {fname} に {after} 列がありません（{col} を足す位置を決められません）")
        at = head.index(after) + 1
        seed = col == "event_parking" and "parking" in head
        pi = head.index("parking") if seed else None
        seeded = 0
        out = [head[:at] + [col] + head[at:]]
        for r in rows[1:]:
            val = ""
            if seed and pi < len(r):
                val = classify_event(r[pi]) or ""
                seeded += bool(val)
            out.append(r[:at] + [val] + r[at:])
        _write(path, out)
        changed.append(fname)
        log(f"  列を追加: {fname} に {col}" + (f"（文に明記された {seeded} 件を入れた）" if seed else ""))
    return changed


# ---------------------------------------------------------------- 名簿の埋め

def plan_fill(dataset, data_dir=DATA):
    """名簿の空の parking を、行の文から埋める計画を返す。

    戻り値は (書く値の dict {名簿の名前: 値}, 食い違って採らなかった名前のリスト, 名簿の head, 名簿の rows,
    名簿のパス)。名簿・行のどちらかに列が無ければ空の計画を返す。
    """
    roster_kind, venue_col = DATASETS[dataset]
    rpath = os.path.join(data_dir, roster.ROSTERS[roster_kind][0])
    key = roster.ROSTERS[roster_kind][1]
    dpath = os.path.join(data_dir, f"{dataset}.csv")
    if not (os.path.exists(rpath) and os.path.exists(dpath)):
        return {}, [], [], [], rpath
    rhead, rrows = roster.load(rpath)
    dhead, drows = roster.load(dpath)
    if "parking" not in rhead or "parking" not in dhead:
        return {}, [], rhead, rrows, rpath

    found = {}      # 名簿の行の id() -> (行, {値の集合})
    for r in drows:
        value = classify_place(r.get("parking"))
        if not value:
            continue
        targets = roster.match_venue(rrows, key, r.get(venue_col) or "")
        # 複数の場所にまたがる表記は、どの場所の文か決められないので採らない
        if len(targets) != 1:
            continue
        found.setdefault(id(targets[0]), (targets[0], set()))[1].add(value)

    fill, conflicts = {}, []
    for row, values in found.values():
        if (row.get("parking") or "").strip():
            continue               # 既にある値は上書きしない
        if len(values) == 1:
            fill[row[key]] = next(iter(values))
        else:
            conflicts.append(row[key])
    return fill, conflicts, rhead, rrows, rpath


def fill(dataset, apply, data_dir=DATA, log=print):
    fills, conflicts, rhead, rrows, rpath = plan_fill(dataset, data_dir)
    if not rhead or "parking" not in rhead:
        log(f"  {dataset}: 名簿に parking 列がありません（--migrate で足してください）")
        return 0
    key = roster.ROSTERS[DATASETS[dataset][0]][1]
    for name, value in sorted(fills.items()):
        log(f"  {'書く' if apply else '下見'}: {name} = {value}")
    for name in conflicts:
        log(f"  採らない（行どうしで読み取りが食い違う）: {name}")
    if apply and fills:
        by_name = {r[key]: r for r in rrows}
        for name, value in fills.items():
            by_name[name]["parking"] = value
        roster.save(rpath, rhead, rrows)
    log(f"  {dataset}: 名簿の parking を {len(fills)} 件" + ("埋めました" if apply else "埋められます（--apply で書く）"))
    return len(fills)


def main():
    p = argparse.ArgumentParser(description="駐車場（P）の列を足し、名簿の空欄を確実なものだけ埋める")
    p.add_argument("dataset", nargs="?", choices=["events", "lives", "all"], default="all")
    p.add_argument("--migrate", action="store_true", help="parking / event_parking の列を足す（冪等）")
    p.add_argument("--apply", action="store_true", help="名簿へ実際に書く（付けなければ下見）")
    args = p.parse_args()

    if args.migrate:
        if not migrate():
            print("  列はすべて揃っています")
    for ds in (["events", "lives"] if args.dataset == "all" else [args.dataset]):
        fill(ds, args.apply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
