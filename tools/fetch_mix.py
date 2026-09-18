#!/usr/bin/env python3
"""取得の内訳（`WebFetch` と `fetch_page.py`）を数え、偏った回に**1度だけ**催促する。

## なぜ要るのか —— 「WebFetch を使うな」は3スキルに書いてあり、守られていない

各SKILL.mdはこう書いている。

> **取得は `WebFetch` ではなく `fetch_page.py --text` を使うこと。** 料金は表で
> 書かれていることが多く、`--text` はセルをタブ区切りで残すが、`WebFetch` は
> 要約を返すので、**要約に載らなかった金額は二度と手に入らない**

2026-09-02 の events は、**取得114回すべて `WebFetch`・`fetch_page.py` は0回**で、
新規90件の `price_official` が **0件**で終わった。取得したURLを全数照合すると、
料金・チケット・入館料のページは1枚も無い（`docs/routine-postmortems.md`）。

## なぜ一律に拒否しないのか

`WebFetch` が正しい場面が実在する。`fetch_page.py` が本文を取れないページ
（JavaScript描画・403）はそちらに戻すよう、スキル本文が明示的に許している。
一律に塞ぐと、**読めるページまで読めなくなる**——外部への迷惑を見ているゲート
（`fetch_gate.py`）と違い、こちらが見ているのは自分の取りこぼしなので、
止めすぎの害のほうが大きい。

そこで**比率**を見る。`fetch_page.py` を**一度も**使わないまま `WebFetch` が
線（既定10回）を越えたときだけ、1度だけ拒否して理由を返す。1回拒否したら
印を残し、以後は何回偏っていても止めない（`report_stats.py --check-fresh` を
`verify-data.sh` が「1回だけの強い催促」として使っているのと同じ形）。

## なぜ `budget.py` の `fetch` カウンタでは判定できないか

`fetch_gate.py`（`WebFetch` のフック）と `fetch_page.py` は、**どちらも
`budget.bump("fetch")` を呼ぶ**。実測は1つの数に合流していて、内訳は残らない。
内訳を足すために `budget.py` の `COUNTERS` を増やすと `--report` の表示と
`budget_test.py` の期待値まで動くので、**計測の本体には触れず**、この小さな
記録を別に持つ。

記録は `data/.run/fetch_mix.json`（`budget.json` と同じ場所＝gitignore 済み）。
`budget.json` の `started_at` に紐づけてあり、回が変われば自動的に数え直す。

## 終了コード（`--gate`）

  0 : 取得してよい
  1 : 偏っている。理由を stderr に書く（**1回だけ**）
  2 : 判定できない

**2 では止めない。** 数えられないことを理由に取得を止めるのは、この門が
防ごうとしている損失より大きい（`wave_gate.py` / `budget.py --gate` と同じ倒し方）。

使い方:
    python3 tools/fetch_mix.py --hook              # PreToolUse(WebFetch) から（数えてから判定する）
    python3 tools/fetch_mix.py --bump webfetch     # 数えるだけ
    python3 tools/fetch_mix.py --bump page         # PreToolUse(Bash) から（fetch_page.py を呼ぶ回だけ）
    python3 tools/fetch_mix.py --gate              # 偏っていれば exit 1
    python3 tools/fetch_mix.py --report            # いまの内訳
"""

import argparse
import contextlib
import fcntl
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import budget                                                  # noqa: E402

# `fetch_page.py` が0回のまま `WebFetch` がこの回数を越えたら、1度だけ止める。
# 10回にしてあるのは、**偏りが偶然では説明できなくなる最小の回数**だからである。
# 「最初の数回は WebFetch で様子を見る」という進め方は普通にありうるし、
# 2026-09-02 の回は114回すべてが WebFetch だった——10回で気づけば十分早い。
WEBFETCH_FLOOR = 10

STATE = os.path.join(budget.STATE_DIR, "fetch_mix.json")
LOCK = STATE + ".lock"


@contextlib.contextmanager
def _lock():
    """並行する子からの計上が失われないようにする（`budget._lock()` と同じ理由）。

    ロックが取れなくても致命的にはしない。呼び出し側が全体を try/except で
    囲んでいるので、その回の計上を1回諦めるだけで済む。
    """
    os.makedirs(budget.STATE_DIR, exist_ok=True)
    with open(LOCK, "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def _run_id():
    """いまの回の識別子。`budget.json` の `started_at` を借りる。

    自前で回の切り替わりを判断しない。`claude-routine.sh` は起動直前に
    `budget.py --reset` を回し、`append_rows.py --init` も数え直す——**回の
    始まりを知っているのは `budget.py` だけ**なので、そこに合わせる。
    """
    try:
        with open(budget.STATE, encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return None
    started = st.get("started_at") if isinstance(st, dict) else None
    return started if isinstance(started, (int, float)) else None


def load():
    """いまの回の内訳。回が変わっていれば0から。判定できなければ None。"""
    run = _run_id()
    if run is None:
        return None
    try:
        with open(STATE, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    if not isinstance(d, dict) or d.get("run") != run:
        d = {"run": run}
    d.setdefault("webfetch", 0)
    d.setdefault("page", 0)
    d.setdefault("warned", False)
    return d


def save(d):
    os.makedirs(budget.STATE_DIR, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, STATE)      # 書き込み途中の状態を残さない


def bump(kind, n=1):
    """計上する。フックから呼ばれるので、**何があっても例外を投げない。**"""
    if kind not in ("webfetch", "page"):
        return
    try:
        with _lock():
            d = load()
            if d is None:
                return
            d[kind] = int(d.get(kind) or 0) + n
            save(d)
    except Exception:                                    # noqa: BLE001
        pass


def judge(webfetch, page, warned):
    """(終了コード, 理由) を返す。数だけを見る純粋な判定。"""
    if warned or page > 0 or webfetch <= WEBFETCH_FLOOR:
        return 0, ""
    return 1, (
        f"ここまで取得{webfetch}回がすべて `WebFetch` で、`tools/fetch_page.py` を"
        "1度も使っていません。\n"
        "\n"
        "  python3 tools/fetch_page.py <URL> --text        本文だけ（表はタブ区切りで残る）\n"
        "  python3 tools/fetch_page.py <URL> --schedule    日付行とその配下だけ\n"
        "\n"
        "**`WebFetch` は要約を返します。要約に載らなかった金額は二度と手に入りません。**\n"
        "2026-09-02 の events は取得114回すべてが `WebFetch` で、新規90件の "
        "`price_official` が**0件**で終わりました（`fetch_page.py` は0回）。\n"
        "\n"
        "料金・日程・一覧の構造が要るページは `fetch_page.py` を使ってください。\n"
        "本文が取れないページ（JS描画・403）に限って `WebFetch` に戻して構いません。\n"
        "**この催促は1度だけです。次からは止めません。**\n"
        "\n"
        "**`curl` や `wget` で代替しないこと。** あれらはフックを通らないので "
        "robots.txt の判定も `Crawl-delay` の消化も行われません（`bash_gate.py` が拒否します）。")


def gate(count_webfetch=False):
    """(終了コード, 理由)。1回止めたら印を残し、以後は止めない。

    `count_webfetch` が真なら、**この1回を数えてから**判定する。数えるのと
    判定するのを別々のフックに分けない理由は2つある。ひとつは Claude Code が
    同じマッチャの複数のフックを並行に走らせること（数える側と読む側が競合する）。
    もうひとつは `_lock()` が fcntl のファイルロックで、同じプロセスから
    二重に取ると自分自身を待ってしまうことである。
    """
    try:
        with _lock():
            d = load()
            if d is None:
                return 2, "# 今回の実行の実測（data/.run/budget.json）が読めません。判定を見送ります。"
            if count_webfetch:
                d["webfetch"] = int(d.get("webfetch") or 0) + 1
                save(d)
            rc, reason = judge(int(d["webfetch"]), int(d["page"]), bool(d["warned"]))
            if rc == 1:
                d["warned"] = True
                save(d)
            return rc, reason
    except Exception:                                    # noqa: BLE001
        return 2, "# 取得の内訳を読めませんでした。判定を見送ります。"


def hook():
    """PreToolUse(WebFetch) として呼ばれたときの入口。この1回を数えてから判定する。"""
    if (os.environ.get("CLAUDE_ROUTINE") or "0") != "1":
        return 0
    # 入力は使わない。`WebFetch` というマッチャに当たっている時点で用は足りている
    # ——ただし読み捨てないと、書き込み側が詰まりうる。
    try:
        sys.stdin.read()
    except OSError:
        pass
    rc, reason = gate(count_webfetch=True)
    if rc == 1:
        print(reason, file=sys.stderr)
        return 2                                   # PreToolUse は exit 2 で拒否する
    return 0                                       # 判定できないとき（2）も通す


def main():
    p = argparse.ArgumentParser(description="取得の内訳を数え、偏った回に1度だけ催促する")
    p.add_argument("--hook", action="store_true", help="PreToolUse(WebFetch) の入口。数えてから判定する")
    p.add_argument("--bump", choices=("webfetch", "page"), help="計上する")
    p.add_argument("--n", type=int, default=1, help="--bump の件数")
    p.add_argument("--gate", action="store_true", help="偏っていれば exit 1（1回だけ）")
    p.add_argument("--report", action="store_true", help="いまの内訳を出す")
    args = p.parse_args()

    if args.hook:
        return hook()
    if args.bump:
        bump(args.bump, args.n)
        return 0
    if args.gate:
        rc, reason = gate()
        if reason:
            print(reason, file=sys.stderr)
        return rc
    if args.report:
        d = load()
        if d is None:
            print("取得の内訳 未計測")
            return 0
        print(f"取得の内訳 WebFetch {d['webfetch']}回 / fetch_page.py {d['page']}回"
              f"{'（催促済み）' if d['warned'] else ''}")
        return 0
    p.error("--hook / --bump / --gate / --report のいずれかを指定してください")


if __name__ == "__main__":
    sys.exit(main())
