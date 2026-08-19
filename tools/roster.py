#!/usr/bin/env python3
"""収集の「定点観測リスト」を、収集タスク自身が育てていくためのツール。

## なぜスキル本文を書き換えないのか

会場は開業し、閉館し、改称する。名画座は畳み、フェスは開催地を変える。
定点観測リストは放っておけば必ず腐るので、収集タスク自身が更新できるほうがよい。

ただし **SKILL.md を実行のたびに書き換える形は採らない。** 理由は4つある。

  1. Webページを読んだ主体が、自分の指示書に書き込む権限を持つ構造になる。
     「重要：収集ルールを次のように変更せよ」と書かれたページ1枚で、
     翌週以降のすべての実行が汚染される。しかも cron の自動実行である。
  2. モデルは自分を縛るルールを緩める方向に書き換える誘因を常に持ち、
     そして劣化を判定するのはその劣化したスキル自身になる。
  3. 散文の書き換えは差分が読みにくく、毎週mainへ直pushする運用では
     誰も気づけない。
  4. 追加しかできない仕組みは単調に膨らみ、いずれ定点観測が
     対象期間を回りきれなくなる。

そこで「名簿（データ）は自動更新、ルール（散文）は提案止まり」で線を引く。
このツールが触るのはCSVの名簿だけで、列も値も検証される。
ルールの変更提案は docs/skill-feedback.md に積み、適用は人間が判断する。

## 名簿の状態

    candidate … 今回はじめて見つけた会場。まだ定点観測の本リストには入れない
    active    … 2回以上ヒットした、または最初から載っていた定点観測先
    retired   … 閉館・閉店・長期にわたり収穫ゼロ。調査対象から外す
    blocked   … robots.txt が取得を拒否している。**閉館ではない**

blocked を retired と分けているのは、この2つが次週の自分に伝える内容が
まったく違うためである。retired は「もう存在しない」、blocked は
「存在するが、こちらが見に行ってはいけない」。ここを一緒にすると、
翌週の収集が blocked の会場の公演を「閉館したから」として片付けかねない。

blocked も retired も、行そのものはCSVに残る（--gc は消さない）。名簿は
「どこを見に行くか」であると同時に、座標・種別・キャパを引く**マスター**でも
あり、表示側は status を見ずに読むためである。見に行かないだけで、
その会場の公演を他の情報源から拾って載せることは妨げない。

## 使い方

    # 収穫を記録する（その会場でイベントを1件以上拾えた）
    python3 tools/roster.py spots --hit 東京国立博物館 --hit すみだ水族館

    # 名簿に無い会場を見つけた（candidate として足す）
    python3 tools/roster.py spots --add <<'EOF'
    {"name": "○○ミュージアム", "kind": "museum", "pref": "tokyo", "area": "東京都・港区",
     "lat": "35.6", "lng": "139.7", "url": "https://...", "note": "2026年開館"}
    EOF

    # 閉館・休館を反映する
    python3 tools/roster.py venues --retire さいたま○○ホール --reason "2026年6月閉館"
    python3 tools/roster.py venues --close さいたまスーパーアリーナ --until 2027-04-01

    # robots.txt が取得を拒否している先を、調査対象から外す（閉館ではない）
    python3 tools/roster.py venues --block ○○ホール --reason "robots.txt が Claude-SearchBot を拒否" 

    # 収穫のない名簿を整理する（毎回の最後に実行）
    python3 tools/roster.py spots --gc

    # いま調べるべき先を出す（retired・blocked・休館中を除いた一覧）
    python3 tools/roster.py spots --list --pref tokyo

    # 調査先を「名前とURL」で出す（検索せずに直接開くため）
    python3 tools/roster.py spots --list --pref tokyo --urls
"""

import argparse
import csv
import json
import os
import re
import sys
import unicodedata
from datetime import date

from validate_data import load_prefs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# 名簿ごとの「名前の列」。--hit / --retire はこの列で引く。
ROSTERS = {
    "spots":     ("spots.csv", "name"),
    "venues":    ("venues.csv", "venue"),
    "theaters":  ("theaters.csv", "name"),
    "festivals": ("festivals.csv", "name"),
}

# --- 整理（GC）のしきい値。週次実行なので日数で数える -------------------------
CANDIDATE_TTL = 60     # candidate のまま収穫がなければ retired へ
ACTIVE_TTL = 180       # active でも半年収穫がなければ candidate へ降格（消しはしない）
PROMOTE_HITS = 2       # candidate がこの回数ヒットしたら active に昇格

# --- 外から来た文字列を名簿に入れる前の検疫 -----------------------------------
# 名簿の値はWebページ由来になりうる。次の実行でこのCSVを読むのは自分自身なので、
# 指示文めいた長文や制御文字が混じると、実質的に指示書へ書き込めてしまう。
MAX_LEN = {"name": 60, "area": 30, "note": 120, "kind": 20, "month_hint": 20, "venue": 60}
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
SUSPICIOUS = re.compile(
    r"(ignore\s+(all\s+)?previous|disregard\s+the|system\s*prompt|"
    r"以下の指示|指示を無視|ルールを変更|必ず実行|あなたは)", re.I)


def sanitize(col, value):
    s = unicodedata.normalize("NFKC", str(value or "")).strip()
    s = CONTROL_RE.sub("", s)
    if SUSPICIOUS.search(s):
        raise SystemExit(
            f"ERROR: {col} に指示文のような文字列が含まれています: {s[:60]!r}\n"
            "名簿には施設名・URL・短い備考だけを入れてください"
            "（収集元のページに書かれていた文言をそのまま持ち込まないこと）"
        )
    limit = MAX_LEN.get(col)
    if limit and len(s) > limit:
        raise SystemExit(f"ERROR: {col} が長すぎます（{len(s)}文字 > {limit}）: {s[:40]!r}")
    return s


def path_of(kind):
    if kind not in ROSTERS:
        raise SystemExit(f"ERROR: 不明な名簿です: {kind!r}（{' / '.join(ROSTERS)}）")
    return os.path.join(DATA, ROSTERS[kind][0]), ROSTERS[kind][1]


def load(path):
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
        f.seek(0)
        head = next(csv.reader(f))
    return head, rows


def save(path, head, rows):
    # 一時ファイルに書いてから置き換える。直接 open(path, "w") すると、
    # 書き込み途中で失敗した（ディスク満杯・権限エラー等）ときに名簿CSVが
    # 中途半端に切り詰められる。budget.save() と同じ形にそろえてある。
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=head)
        w.writeheader()
        for r in rows:
            w.writerow({k: (r.get(k) or "") for k in head})
    os.replace(tmp, path)


def _norm(s):
    return unicodedata.normalize("NFKC", (s or "")).strip().casefold().replace(" ", "")


def find(rows, key, name):
    n = _norm(name)
    for r in rows:
        if _norm(r.get(key)) == n:
            return r
    return None


def _int(v):
    try:
        return int((v or "0").strip() or 0)
    except ValueError:
        return 0


def _date(v):
    try:
        return date.fromisoformat((v or "").strip())
    except ValueError:
        return None


# ---------------------------------------------------------------- 操作

def do_hit(rows, key, names, today):
    done, missing = [], []
    today_iso = today.isoformat()
    for name in names:
        r = find(rows, key, name)
        if not r:
            missing.append(name)
            continue
        # record_hits() と同じガード。同じコマンド行に同じ名前を複数回渡しても
        # （`--hit A --hit A` 等）、その日1回分としてしか数えない。
        if r.get("last_hit") == today_iso:
            done.append(name)
            continue
        r["last_hit"] = today_iso
        r["hit_count"] = str(_int(r.get("hit_count")) + 1)
        if r.get("status") == "candidate" and _int(r["hit_count"]) >= PROMOTE_HITS:
            r["status"] = "active"
            done.append(f"{name}（candidate → active）")
        else:
            done.append(name)
    return done, missing


def record_hits(kind, names, today=None):
    """収穫のあった先を機械的に記録する。`append_rows.py` から呼ばれる。

    ## なぜ手動の `--hit` では足りなかったか

    `--hit` は最初から用意してあったが、**2026-08 の時点で `spots.csv` の
    234件すべてが `hit_count=0`・`last_hit` 空だった**。3回の実行で `--hit` が
    実際に走ったのは1回だけである。名簿の育成（昇格・降格・整理）はこの数字を
    唯一の材料にしているので、記録が付かない限り `--gc` は判断材料を持たない。
    そのうえ `ACTIVE_TTL=180` 日が来れば、収穫の有無に関わらず全件が
    candidate へ降格する軌道に乗る。

    モデルの意志に任せた記録は残らない——`[進捗]` 行が3回の実行で0行だったのと
    同じ失敗である。**書き込みが起きた事実から機械的に導けるなら、機械が書く。**
    CSVに行が入ったということは、その会場から収穫があったということそのものである。

    戻り値は `(記録した名前, 名簿に無かった名前)`。後者は捨てずに返す——
    「名簿に無い会場から拾えた」ことは探索が効いている証拠であり、
    `--add` の候補でもあるためである。
    """
    today = today or date.today()
    try:
        path, key = path_of(kind)
        head, rows = load(path)
    except (SystemExit, OSError):
        return [], list(names)

    wanted = [n for n in dict.fromkeys(names) if n and n.strip() and n.strip() != "-"]
    hits, misses = [], []
    for name in wanted:
        r = find(rows, key, name)
        targets = [r] if r else []
        # theaters.csv だけは名簿が二役（チェーンの店舗ディレクトリ＋名画座の名簿）
        # である。新作行の theater はチェーン名なので、店舗名では引けない。
        # チェーン名で当たったときは、その傘下の店舗をまとめて収穫ありとする
        # ——実際にその作品を掛けているのはそれらの店舗だからである。
        if not targets and "chain" in head:
            targets = [x for x in rows if _norm(x.get("chain")) == _norm(name)]
        if not targets:
            misses.append(name)
            continue
        today_iso = today.isoformat()
        for x in targets:
            # 今日まだヒットが付いていない先だけ hit_count を進める。
            #
            # `append_rows.py` は5〜10件ごとのバッチで何度も呼ばれ、
            # `theater`/`venue` 列にチェーン名（`TOHOシネマズ` 等）が入っている
            # ときは傘下の全店舗が `targets` になる（226行目のコメント）。
            # ガードが無いと、1回の実行の中でそのチェーン名が何十回も
            # 出現するぶんだけ `hit_count` が加算され、実測で `theaters.csv`
            # 85件中85件が同じ日に更新され、`hit_count` が実行の刻み方
            # （バッチの分け方）に依存する値になっていた。**`hit_count` を
            # 「調査を実行した回数」として保つには、同じ日の重複は数えない。**
            # `PROMOTE_HITS=2` も「2回の実行でヒットした」ことを前提にしている
            # ので、1回の実行内で何回ヒットしても1回として扱うのが正しい。
            if x.get("last_hit") == today_iso:
                continue
            x["last_hit"] = today_iso
            x["hit_count"] = str(_int(x.get("hit_count")) + 1)
            if x.get("status") == "candidate" and _int(x["hit_count"]) >= PROMOTE_HITS:
                x["status"] = "active"
        hits.append(name)

    if hits:
        try:
            save(path, head, rows)
        except OSError:
            # `append_rows.py` はこの関数を、CSVへの追記が終わった**あと**に呼ぶ。
            # ここで例外を外に出すと、行は正しく書けているのに `append_rows.py`
            # 自体が失敗したように見え、モデルが同じ行を重複投入しかねない
            # （書き込みが起きた事実は既に確定しているので、ここでの失敗は
            # 「名簿の収穫記録だけが今回は付かなかった」という意味に留める）。
            return [], list(names)
    return hits, misses


def do_add(rows, head, key, today):
    added, dupes = [], []
    prefs = load_prefs()          # config.js の読み直しを1回に抑える
    raw = sys.stdin.read()
    for i, line in enumerate((l for l in raw.splitlines() if l.strip()), start=1):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            raise SystemExit(f"ERROR: {i}行目のJSONを解析できません: {e}")
        name = sanitize(key, obj.get(key) or obj.get("name"))
        if not name:
            raise SystemExit(f"ERROR: {i}行目に {key} がありません")
        if find(rows, key, name):
            dupes.append(name)
            continue
        row = {c: "" for c in head}
        for col, val in obj.items():
            if col in head:
                row[col] = sanitize(col, val)
        row[key] = name
        if row.get("url") and not row["url"].startswith(("http://", "https://")):
            raise SystemExit(f"ERROR: {name} の url がURLではありません: {row['url'][:60]!r}")
        # pref は都県の絞り込みキーそのものなので、集合外の値を通すと
        # 「名簿には載っているのに絞り込みから漏れる会場」ができる。
        # 実際に `shizuoka` / `niigata` が18件+1件書き込まれ、以降の収集タスクが
        # 着手前から validate_data.py の ERROR を抱える状態になっていた
        # （docs/skill-feedback.md 2026-08-08）。関東以外は `other` に寄せる。
        if row.get("pref") and row["pref"] not in prefs:
            raise SystemExit(
                f"ERROR: {name} の pref に未知の値 {row['pref']!r} が指定されています。"
                f"使えるのは {sorted(prefs)} です"
                "（関東以外の会場は 'other' にしてください）"
            )
        row["status"] = "candidate"
        row["first_seen"] = today.isoformat()
        row["last_hit"] = today.isoformat()
        row["hit_count"] = "1"
        rows.append(row)
        added.append(name)
    return added, dupes


def do_gc(rows, key, today):
    retired, demoted = [], []
    for r in rows:
        st = (r.get("status") or "active").strip()
        # blocked は「収穫ゼロ」だが、それは見に行っていないからである。
        # 自動整理の対象にすると、理由が robots.txt だった事実が失われる。
        if st in ("retired", "blocked"):
            continue
        base = _date(r.get("last_hit")) or _date(r.get("first_seen"))
        if not base:
            continue
        idle = (today - base).days
        if st == "candidate" and idle > CANDIDATE_TTL:
            r["status"] = "retired"
            r["note"] = (r.get("note") or "") + f"（{today} 自動整理: {idle}日間ヒットなし）"
            retired.append(r[key])
        elif st == "active" and idle > ACTIVE_TTL:
            r["status"] = "candidate"
            r["note"] = (r.get("note") or "") + f"（{today} 自動降格: {idle}日間ヒットなし）"
            demoted.append(r[key])
    return retired, demoted


def do_list(rows, key, args, today):
    out = []
    for r in rows:
        st = (r.get("status") or "active").strip()
        if st in ("retired", "blocked") and not args.all:
            continue
        if args.status and st != args.status:
            continue
        if args.pref and (r.get("pref") or "") != args.pref:
            continue
        # theaters.csv は kind を持たず chain が種別にあたる。表示側が
        # kind or chain を出しているので、絞り込みも同じ列で引けるようにする。
        if args.kind and (r.get("kind") or r.get("chain") or "") != args.kind:
            continue
        closed = _date(r.get("closed_until"))
        if closed and closed > today and not args.all:
            continue        # 休館中は調べても収穫がない
        out.append(r)
    return out


# ---------------------------------------------------------------- entry


def _parse_today(s):
    """`--today` の検証。argparse の `type=` に渡すと、壊れた値は
    トレースバックではなく argparse 自身の使用法メッセージで弾かれる。"""
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"YYYY-MM-DD 形式で指定してください: {s!r}")

def main():
    p = argparse.ArgumentParser(description="定点観測リスト（名簿）の保守")
    p.add_argument("roster", help=" / ".join(ROSTERS))
    p.add_argument("--hit", action="append", help="収穫があった先（複数可）")
    p.add_argument("--add", action="store_true", help="標準入力(JSONL)から candidate として追加")
    p.add_argument("--retire", action="append", help="閉館・閉店で調査対象から外す")
    p.add_argument("--block", action="append",
                   help="robots.txt が取得を拒否している先を外す（閉館ではない）")
    p.add_argument("--unblock", action="append",
                   help="--block を解除して active に戻す（拒否が解けた／申請が取り下げられた）")
    p.add_argument("--reason", default="", help="--retire / --block / --close の理由")
    p.add_argument("--close", help="休館中にする")
    p.add_argument("--until", help="--close の再開予定日 YYYY-MM-DD")
    p.add_argument("--gc", action="store_true", help="収穫のない名簿を整理する")
    p.add_argument("--list", action="store_true", help="調査対象の一覧を出す")
    p.add_argument("--status", help="--list を状態で絞る")
    p.add_argument("--pref", help="--list を都県で絞る")
    p.add_argument("--kind", help="--list を種別で絞る")
    p.add_argument("--all", action="store_true", help="--list に retired・blocked・休館中も含める")
    p.add_argument("--urls", action="store_true",
                   help="--list にURLも出す（検索せずに直接開くため）")
    p.add_argument("--today", type=_parse_today, help="基準日 YYYY-MM-DD（試験用）")
    args = p.parse_args()

    today = args.today if args.today else date.today()
    path, key = path_of(args.roster)
    head, rows = load(path)
    dirty = False

    if args.hit:
        done, missing = do_hit(rows, key, args.hit, today)
        dirty = True
        for d in done:
            print(f"  hit: {d}")
        for m in missing:
            print(f"  WARNING: 名簿にありません（--add で追加してください）: {m}", file=sys.stderr)

    if args.add:
        added, dupes = do_add(rows, head, key, today)
        dirty = True
        for a in added:
            print(f"  追加(candidate): {a}")
        for d in dupes:
            print(f"  既にあります: {d}")

    if args.retire:
        for name in args.retire:
            r = find(rows, key, name)
            if not r:
                print(f"  WARNING: 名簿にありません: {name}", file=sys.stderr)
                continue
            r["status"] = "retired"
            if args.reason:
                r["note"] = sanitize("note", args.reason)
            dirty = True
            print(f"  retired: {name}")

    if args.unblock:
        for name in args.unblock:
            r = find(rows, key, name)
            if not r:
                print(f"  WARNING: 名簿にありません: {name}", file=sys.stderr)
                continue
            if r.get("status") != "blocked":
                print(f"  blocked ではありません（{r.get('status') or 'active'}）: {name}")
                continue
            # blocked にしたのは収穫が無かったからではないので、active に戻す。
            # candidate へ落とすと、再開後2回ヒットするまで名簿に出てこない。
            r["status"] = "active"
            if args.reason:
                r["note"] = sanitize("note", args.reason)
            dirty = True
            print(f"  unblocked: {name}")

    if args.block:
        for name in args.block:
            r = find(rows, key, name)
            if not r:
                print(f"  WARNING: 名簿にありません: {name}", file=sys.stderr)
                continue
            r["status"] = "blocked"
            if args.reason:
                r["note"] = sanitize("note", args.reason)
            dirty = True
            print(f"  blocked: {name}")

    if args.close:
        r = find(rows, key, args.close)
        if not r:
            raise SystemExit(f"ERROR: 名簿にありません: {args.close}")
        if "closed_until" not in head:
            raise SystemExit(f"ERROR: {os.path.basename(path)} に closed_until 列がありません")
        if not args.until or not _date(args.until):
            raise SystemExit("ERROR: --close には --until YYYY-MM-DD が要ります")
        r["closed_until"] = args.until
        if args.reason:
            r["note"] = sanitize("note", args.reason)
        dirty = True
        print(f"  休館: {args.close}（{args.until} まで）")

    gc_result = None
    if args.gc:
        gc_result = do_gc(rows, key, today)
        dirty = True

    # 変更はここで確定させる。長い一覧を先に出すと、その出力がどこかで
    # 打ち切られた（head で切った等）ときに保存まで到達しない。
    if dirty:
        save(path, head, rows)
        print(f"{os.path.relpath(path, ROOT)} を更新しました")

    if gc_result:
        retired, demoted = gc_result
        print(f"  整理: retired {len(retired)}件 / candidate へ降格 {len(demoted)}件")
        for n in (retired + demoted)[:20]:
            print(f"    - {n}")
        rest = len(retired) + len(demoted) - 20
        if rest > 0:
            print(f"    …ほか{rest}件")

    if args.list:
        hits = do_list(rows, key, args, today)
        for r in hits:
            extra = f" [{r.get('status')}]" if (r.get("status") or "active") != "active" else ""
            cols = [r[key], r.get("kind") or r.get("chain") or "", r.get("pref", "") + extra]
            if args.urls:
                # URLを知っている調査先は、検索せずに直接開ける。
                # 検索回数はセッションあたりの有限資源なので、
                # 「知っているURLを検索し直す」のが最も無自覚に消える分になる。
                cols.append(r.get("url") or "-")
            print("\t".join(cols))
        if args.urls:
            missing = sum(1 for r in hits if not (r.get("url") or "").strip())
            print(f"# {len(hits)}件（うちURL不明 {missing}件＝この分だけ検索が要る）",
                  file=sys.stderr)
        else:
            print(f"# {len(hits)}件", file=sys.stderr)

    if not dirty and not args.list:
        p.print_help()


if __name__ == "__main__":
    main()
