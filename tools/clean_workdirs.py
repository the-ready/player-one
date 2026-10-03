#!/usr/bin/env python3
"""作業ディレクトリに溜まる古い残骸を片付ける（既定は一覧だけ。消すのは `--apply`）。

    python3 tools/clean_workdirs.py            # 消す候補を一覧する（何も消さない）
    python3 tools/clean_workdirs.py --apply    # 実際に消す

## なぜ要るのか

`temp/` は過去の `claude-routine.sh` が起動時に2日より古いファイルを `find` で消していた。
ただしそれは (1) 週次ルーチンの起動時にしか走らず、人が対話で調べた回の残骸は誰も消さない、
(2) 直下の**ファイル**しか見ないので、サブエージェントが作ったディレクトリ（`temp/mu4/` など）
は残る、(3) `.claude/logs/` と `data/.robots/` は対象外で増える一方だった。
実測では temp/ が約 20MB・100ファイル超、logs が 6.3MB まで膨らんでいる。
`ls temp/` を実行した子は**その全件を自分の文脈に取り込む**（2026-08-27）ので、古い名前が
増えるほど毎ターンの再送が重くなる。

消す規則を `claude-routine.sh` の `find` 1行から、テストのある1本の道具にまとめた。
週次ルーチンはこの道具を呼ぶだけで、手で打っても同じ規則で動く。

## 何を・いつ消すか（保持日数は `RULES` が正本）

| 場所                                  | 消す条件                                 | 保持の理由 |
| ------------------------------------- | ---------------------------------------- | ---------- |
| `temp/` の直下（ファイルもディレクトリも） | 中身を含めて最後の更新から3日以上        | 打ち切られた回の `rows-*.jsonl` は**唯一残った調査結果**で、人が拾い直せる必要がある |
| `.claude/logs/{routine,investigate,repair}_日付.log` | 最後の書き込みから30日以上 | 失敗の調査（`routine-investigate`）が直近を読む。要約は `docs/routine-postmortems.md` に残る |
| `.claude/logs/failed/<日時>/`         | 退避した日時から30日以上                 | 検証に落ちた回の生成物。調査が済めば不要 |
| `data/.robots/` の中のファイル        | 最後の更新から7日以上                    | キャッシュの寿命は24時間（`robots_rules.CACHE_TTL_SEC`）。7日使われていなければ取り直すだけ |

`temp/` の3日は、従来の `find -mtime +2`（実効は3日以上）と同じ強さである。ここを強めると、
前回の実行が打ち切られた直後に拾い直す猶予が減る。

## 決して消さないもの

- **`data/.prev/`**：差分検知の比較元。消すと「説明のない消滅」の検証が変わる。
- **`data/.run/`**：その回の消費の実測（`budget.py`）。実行中に消すと計測が飛ぶ。
- **`.claude/logs/.routine.lock` と `.claude/logs/.run.*`**：実行中のロックと状態。
- **上の表にない名前すべて。** 名前で拾う（`routine_2026-09-24.log` の形のものだけ）ので、
  設定ファイルや別のログを巻き込まない。`data/*.csv`・コード・`.git` には一切触れない。
- **シンボリックリンクの先。** リンクは**リンクそのもの**だけを消し、先は辿らない
  （`temp/link.csv -> ../data/events.csv` のようなものが過去にあった。設計書 第9.1.5節）。
- **リポジトリの外。** 対象ディレクトリ自体が外を指すリンクなら、警告して何もしない。

## 実行中の週次ルーチンとの関係

`--apply` は、`.claude/logs/.routine.lock` の持ち主（pid）が生きている間は**断る**（終了コード2）。
収集が `temp/` の作業ファイルを読み書きしている最中に消さないためである。
ただし週次ルーチン自身がこの道具を呼ぶときは、自分がそのロックを持っているので
`--from-routine` を付けて断りを外す。この旗は「呼び出し側が実行中の本人である」という宣言である。

## 終了コード

0 … 成功（消すものが無い場合も含む）／ 1 … 一部が消せなかった／ 2 … 実行中のため断った。
週次ルーチンは **どの終了コードでも収集を止めない**（掃除は本業ではない）。
"""

import argparse
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DAY = 24 * 60 * 60

# (種類, 対象ディレクトリ（ROOT からの相対）, 保持日数, 名前の条件, 年齢の測り方)
#   age: "tree"  … 中身を含む最新の更新時刻（ディレクトリは中で最近書かれていれば新しい）
#        "mtime" … そのファイルの更新時刻
#        "name"  … 名前の日時（YYYYMMDD-HHMMSS）。読めなければ tree にする
RULES = [
    {"kind": "temp", "dir": "temp", "days": 3,
     "match": lambda n: n != ".gitkeep", "age": "tree"},
    {"kind": "log", "dir": os.path.join(".claude", "logs"), "days": 30,
     "match": re.compile(r"^(routine|investigate|repair)_\d{4}-\d{2}-\d{2}\.log$").match,
     "age": "mtime", "files_only": True},
    {"kind": "failed", "dir": os.path.join(".claude", "logs", "failed"), "days": 30,
     "match": lambda n: not n.startswith("."), "age": "name"},
    {"kind": "robots", "dir": os.path.join("data", ".robots"), "days": 7,
     "match": lambda n: True, "age": "mtime", "files_only": True},
]

LOCK_REL = os.path.join(".claude", "logs", ".routine.lock")

_STAMP = re.compile(r"^(\d{8}-\d{6})$")

LIST_CAP = 40   # 一覧に出す行数の上限（残りは件数だけ）


@dataclass
class Item:
    kind: str
    path: str
    age_days: float
    size: int


def _newest_mtime(path):
    """リンクを辿らずに、path 以下の最新の更新時刻を返す。"""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    newest = st.st_mtime
    if os.path.isdir(path) and not os.path.islink(path):
        for dp, dns, fns in os.walk(path, followlinks=False):
            for n in dns + fns:
                try:
                    newest = max(newest, os.lstat(os.path.join(dp, n)).st_mtime)
                except OSError:
                    pass
    return newest


def _size(path):
    """リンクを辿らずに、path 以下の合計バイト数を返す（表示用）。"""
    try:
        if os.path.islink(path) or not os.path.isdir(path):
            return os.lstat(path).st_size
    except OSError:
        return 0
    total = 0
    for dp, dns, fns in os.walk(path, followlinks=False):
        for n in fns:
            try:
                total += os.lstat(os.path.join(dp, n)).st_size
            except OSError:
                pass
    return total


def _inside(root, path):
    """path の実体が root の内側にあるか。"""
    r = os.path.realpath(root)
    p = os.path.realpath(path)
    return p == r or p.startswith(r + os.sep)


def collect(root, now, warn=lambda m: None):
    """消してよいものを集める。何も消さない。"""
    items = []
    for rule in RULES:
        base = os.path.join(root, rule["dir"])
        if not os.path.isdir(base):
            continue
        # 対象ディレクトリ自体がリポジトリの外を指しているなら、何もしない。
        if not _inside(root, base):
            warn(f"{rule['dir']} がリポジトリの外を指しているため触りません")
            continue
        keep_sec = rule["days"] * DAY
        for name in sorted(os.listdir(base)):
            if not rule["match"](name):
                continue
            path = os.path.join(base, name)
            is_link = os.path.islink(path)
            is_dir = os.path.isdir(path) and not is_link
            if rule.get("files_only") and (is_dir):
                continue
            stamp = None
            if rule["age"] == "name":
                m = _STAMP.match(name)
                if m:
                    try:
                        stamp = datetime.strptime(m.group(1), "%Y%m%d-%H%M%S").timestamp()
                    except ValueError:
                        stamp = None
            if stamp is None:
                stamp = _newest_mtime(path) if rule["age"] != "mtime" else _lstat_mtime(path)
            if stamp is None:
                continue
            age = now - stamp
            if age >= keep_sec:
                items.append(Item(rule["kind"], path, age / DAY, _size(path)))
    return items


def _lstat_mtime(path):
    try:
        return os.lstat(path).st_mtime
    except OSError:
        return None


def delete(items, root):
    """items を消す。(消せた数, 失敗の一覧) を返す。リンクは辿らない。"""
    done, errors = 0, []
    for it in items:
        # 念のための最終確認：消す直前にもう一度、リポジトリの内側かを見る。
        parent = os.path.dirname(it.path)
        if not _inside(root, parent):
            errors.append((it.path, "リポジトリの外のため消さない"))
            continue
        try:
            if os.path.islink(it.path) or not os.path.isdir(it.path):
                os.unlink(it.path)
            else:
                shutil.rmtree(it.path)
            done += 1
        except OSError as e:
            errors.append((it.path, str(e)))
    return done, errors


def lock_holder(root):
    """実行中の週次ルーチンの pid を返す。居なければ None。"""
    lock = os.path.join(root, LOCK_REL)
    pidfile = os.path.join(lock, "pid")
    if not os.path.isdir(lock):
        return None
    try:
        with open(pidfile) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        # pid が読めないロックは、実行中かどうか分からない。消さない側に倒す。
        return -1
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None          # 持ち主が居ない残存ロック
    except PermissionError:
        return pid           # 他ユーザーのプロセスだが生きている
    return pid


def _fmt_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024


def main(argv=None, root=ROOT, now=None, out=sys.stdout, err=sys.stderr):
    ap = argparse.ArgumentParser(
        description="temp/・ログ・robots キャッシュの古い残骸を片付ける（既定は一覧だけ）",
    )
    ap.add_argument("--apply", action="store_true", help="実際に消す（既定は一覧だけ）")
    ap.add_argument("--from-routine", action="store_true",
                    help="週次ルーチン自身が呼ぶとき。自分が持っているロックを理由に断らない")
    args = ap.parse_args(argv)
    now = time.time() if now is None else now

    def warn(msg):
        print(f"WARNING: {msg}", file=err)

    items = collect(root, now, warn)

    by_kind = {}
    for it in items:
        by_kind.setdefault(it.kind, []).append(it)

    mode = "削除" if args.apply else "候補（--apply で削除）"
    total = sum(i.size for i in items)
    print(f"# {mode}: {len(items)}件 / {_fmt_size(total)}", file=out)
    for kind in ("temp", "log", "failed", "robots"):
        group = by_kind.get(kind, [])
        if not group:
            continue
        gsize = sum(i.size for i in group)
        print(f"  [{kind}] {len(group)}件 / {_fmt_size(gsize)}", file=out)
        for it in group[:LIST_CAP]:
            print(f"    {os.path.relpath(it.path, root)}  （{it.age_days:.0f}日前・{_fmt_size(it.size)}）", file=out)
        if len(group) > LIST_CAP:
            print(f"    … 他{len(group) - LIST_CAP}件", file=out)

    if not args.apply:
        return 0

    holder = lock_holder(root)
    if holder is not None and not args.from_routine:
        print(f"実行中の週次ルーチンがあるため消しません（pid={holder if holder > 0 else '不明'}）。"
              "終わってからやり直してください。", file=err)
        return 2

    done, errors = delete(items, root)
    print(f"# {done}件を消しました", file=out)
    for path, msg in errors:
        warn(f"消せませんでした: {os.path.relpath(path, root)}（{msg}）")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
