#!/usr/bin/env python3
"""この実行で何をどれだけ使ったかを実測して返す。

## なぜ要るのか

各 SKILL.md の「調査予算」表は、工程ごとの検索回数の枠を決めている。これは
3スキルの中心的な統制手段だが、**数える手段がモデルの記憶しかなかった。**
枠を守っているかどうかを誰も確認できない指示は、守られているかも分からない
——実際、2026-08-14 の実行は検索115回・取得154回を消費したが、報告には
1行も出ていない（`docs/DESIGN.md` 第9.3.1節）。

待つ処理を `fetch_gate.py` の中に置いたのと同じ理屈である。**数える処理を
フックの中に置けば、モデルが数えなくても数えられている。** このスクリプトは
その集計を保持し、問い合わせに答えるだけの器である。

## もうひとつ、数えていなかったもの

枠表は `WebSearch` だけを数えていた。だが実測では取得のほうが多く、しかも
`fetch_gate.py` が `Crawl-delay` を消化するぶん**時間の律速は取得側にある**。
名簿234施設を一周するだけで、下限3秒×234＝12分が待ち時間として消える。
そこで取得回数と累積待ち時間も同じ器で数える。

時間そのものも同じ理由で出す。1回の実行には6時間の枠があるが（`ROUTINE_TIMEOUT_SEC`）、
その事実がスキル側に伝わっていなかったため、モデルには「打ち切ってよい」しか
届いていなかった。**残りを知らせないまま撤退を促せば、早く撤退する。**

## 三つめ、いちばん効くもの —— トークン

検索も取得も時間も、**実際に実行を止めている資源ではなかった。** 2026-08-26 の
lives 収集は、開始50分でアカウントの利用上限（`You've hit your session limit`）に
当たって強制終了している。そのとき `--report` はこう出していた。

    検索 14/170（残り156・上限200） / 取得 161 / 経過 39分/360分（残り321分）

**「9割残っている」と読める表示の9分後に、実行は殺された。** 律速していたのは
トークンで、それだけが計器に載っていなかった。載っていない資源は、減らす工夫を
しても効いたかどうかが分からない——だから最初に載せる。

セッションの記録（`~/.claude/projects/<slug>/<session-id>.jsonl`）には、応答ごとの
`usage` が入っている。サブエージェントのぶんも `<session-id>/subagents/*.jsonl` に
同じ形で残る。**親と子を別々に数えて出す**のは、その比が「親が自分でページを
開いていないか」（＝調査を子に出しているか）をそのまま映すためである。

数えるのは3つ。

  - **文脈再送**（`cache_read_input_tokens`）。1つの文脈でN回ツールを呼ぶと、
    毎ターン全文脈を送り直すので **Nの2乗** で増える。実測でここが桁違いに大きく、
    調査を1体に集中させたときに真っ先に膨らむのもここである
  - **出力**（`output_tokens`）。収集結果を書き出す量に比例する。サブエージェントの
    JSONL を親の文脈を経由して書き直すと、同じ行を2回払うことになる
  - **現在の文脈**（直近の応答の入力合計）。「次の1回のツール呼び出しがいくら
    かかるか」がこれで、撤退の判断に直接効く

## 上限そのものは分からない、と正直に書いておく

アカウントの利用上限が何トークンなのかは、こちらからは観測できない。実測でも
一貫していない——2026-08-20 は文脈再送 48M で打ち切られ、2026-08-12 は 59M 使って
完走している（同じ枠を対話セッションと分け合うため）。だから
`CACHE_READ_WARN` は上限ではなく**警告線**である。「ここを超えたら、いつ殺されても
おかしくないので終了工程の余力を残せ」という意味しか持たない。

使い方:
    python3 tools/budget.py --report                # いまの消費を1行で
    python3 tools/budget.py --report --verbose      # 工程ごとの内訳つき
    python3 tools/budget.py --phase "ステップ2 エリア軸の探索"   # 以後の計上先を切り替える
    python3 tools/budget.py --reset                 # 明示的に数え直す

    # 以下はフックとツールが自動で呼ぶ。手で叩く必要はない
    python3 tools/budget.py --bump search
    python3 tools/budget.py --bump fetch --waited 3.2
    python3 tools/budget.py --bump rows --n 8
"""

import argparse
import contextlib
import fcntl
import glob
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = os.path.join(ROOT, "data", ".run")
STATE = os.path.join(STATE_DIR, "budget.json")
LOCK = STATE + ".lock"

# 検索の上限。プラットフォーム側が1セッション200回で打ち切るので、
# 3スキルとも枠の合計を170回に置き、30回を余裕として残している。
HARD_LIMIT = 200
PLANNED_LIMIT = 170

# これより古い記録は「別の週の実行」とみなして数え直す。週次実行の間隔（7日）より
# はるかに短く、1回の実行の上限（6時間）よりは長い値にしてある。手で --reset を
# 忘れても、翌週の集計に先週の数字が混ざらない。
STALE_SEC = 12 * 60 * 60

COUNTERS = ("search", "fetch", "rows", "blocked")

# claude-routine.sh 自身の既定値（`ROUTINE_TIMEOUT_SEC="${ROUTINE_TIMEOUT_SEC:-21600}"`）
# と揃えてある。無人ルーチンの外（対話的に手で叩いたとき等）は環境変数が無いが、
# 枠の大きさ自体は変わらないので、「/360分」の表示を省くのではなくこちらを使う。
ROUTINE_TIMEOUT_DEFAULT_SEC = 21600

# 文脈再送（cache_read）の警告線。**上限ではない**（docstring「上限そのものは
# 分からない」を参照）。打ち切られた回の実測が 48M と 57M なので、終了工程を
# 通し切る余力を残せる位置として、その手前に置いてある。
CACHE_READ_WARN = 40_000_000


def _now():
    return time.time()


def _empty(now):
    return {"started_at": now, "phase": "（未設定）", "phases": {}, "totals": _zero()}


def _zero():
    return {k: 0 for k in COUNTERS} | {"waited": 0.0}


@contextlib.contextmanager
def _lock():
    """read-modify-write の間、他のプロセスの `bump()` を締め出す。

    ## なぜ要るのか

    並行調査（サブエージェントの前景並行起動）を勧めるようになったため、
    複数の `WebSearch` / `WebFetch` フックがほぼ同時に `bump()` を呼びうる。
    `load()` → 加算 → `save()` の間に排他が無いと、2つのプロセスが同じ
    「加算前の値」を読んで書き戻し、片方の加算が消える（read-modify-write の
    競合）。実測では並行度60で60回中39回が失われた。

    予算の実測は「多いほど厳しい」方向にしか使わない（超えたら撤退する）ので、
    誤差は**残量を多く見せる**方向にしか出ない。安全側ではないので塞ぐ。

    ロックが取れなくても（ファイルシステムの制約等）致命的にはしない——
    `bump()` 自身が全体を try/except で囲んでいるので、ここで例外を投げれば
    その回の計上を1回諦めるだけで済む。
    """
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LOCK, "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def load():
    now = _now()
    try:
        with open(STATE, encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return _empty(now)
    if not isinstance(st, dict) or "started_at" not in st:
        return _empty(now)
    # started_at は書き込み側では常に数値だが、手で壊れた状態ファイルを置く・
    # 将来の版が形式を変える、といった経路で文字列や null が来うる。型が
    # 違えば `now - started_at` がそのまま例外になり、`[進捗]` 行を出すだけの
    # `append_rows.py` が**追記の成功後に**落ちる（モデルは追記が失敗したと
    # 誤解して同じ行を重複投入しかねない）。計測は収集の付随物なので、
    # 壊れていたら数え直す側に倒す。
    if not isinstance(st.get("started_at"), (int, float)):
        return _empty(now)
    if now - st["started_at"] > STALE_SEC:
        return _empty(now)
    # 古い版の状態ファイルを読んでも落ちないようにしておく（キーが増えることがある）
    st.setdefault("phase", "（未設定）")
    if not isinstance(st.get("phases"), dict):
        st["phases"] = {}
    totals = st.get("totals")
    st["totals"] = _zero() | (totals if isinstance(totals, dict) else {})
    return st


def save(st):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, STATE)      # 書き込み途中の状態を残さない


def reset():
    """数え直す。`append_rows.py --init`（＝収集の開始点）から呼ばれる。"""
    try:
        save(_empty(_now()))
    except Exception:                                    # noqa: BLE001
        pass


def bump(kind, n=1, waited=0.0):
    """計上する。フックから呼ばれるので、**何があっても例外を投げない。**

    計測は収集の付随物であって、目的ではない。ここで落ちて `WebFetch` が
    止まるようなことがあれば、数えるための仕組みが数える対象を壊すことになる。
    """
    if kind not in COUNTERS:
        return
    try:
        with _lock():
            st = load()
            slot = st["phases"].setdefault(st["phase"], _zero())
            for target in (st["totals"], slot):
                target[kind] = target.get(kind, 0) + n
                target["waited"] = round(target.get("waited", 0.0) + float(waited or 0), 1)
            save(st)
    except Exception:                                    # noqa: BLE001
        pass


def elapsed_min(st):
    return (_now() - st.get("started_at", _now())) / 60.0


def limit_min():
    """実行の上限（分）。claude-routine.sh が export した値を使う。

    未設定・空・数値でない値は claude-routine.sh 自身の既定値にそろえる。
    """
    try:
        return float(os.environ.get("ROUTINE_TIMEOUT_SEC") or ROUTINE_TIMEOUT_DEFAULT_SEC) / 60.0
    except ValueError:
        return ROUTINE_TIMEOUT_DEFAULT_SEC / 60.0


# ---------------------------------------------------------------- トークン
#
# ここだけは budget.json ではなくセッションの記録から読む。フックで数えられる
# のは「回数」だけで、1回がいくらだったかはモデルの応答にしか書かれていない
# ためである。`--bump` の経路からは呼ばない——フックは毎回の検索・取得ごとに
# 走るので、そこで数MBの記録を舐めると計器が計測対象を遅くする。

def _projects_dir():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "projects")


def transcript_files():
    """(親の記録, [子の記録...]) を返す。見つからなければ (None, [])。

    セッションIDから引くのを第一にする。`*/<sid>.jsonl` と全プロジェクトを
    横断して探すのは、記録の置き場がリポジトリのパスをスラッグ化した名前で、
    **その規則が将来変わりうる**ためである。IDで引ける限り規則に依存しない。

    IDが無い（対話的に手で叩いた等）ときだけスラッグから引き、その中でいちばん
    新しい記録を今のセッションとみなす。週次ルーチンはロックで同時実行を
    禁じているので、無人実行では取り違えは起きない。
    """
    root = _projects_dir()
    sid = (os.environ.get("CLAUDE_CODE_SESSION_ID") or "").strip()
    parent = None
    if sid:
        hits = glob.glob(os.path.join(root, "*", sid + ".jsonl"))
        parent = hits[0] if hits else None
    if parent is None:
        cands = glob.glob(os.path.join(root, ROOT.replace(os.sep, "-"), "*.jsonl"))
        parent = max(cands, key=os.path.getmtime) if cands else None
    if parent is None:
        return None, []
    subs = sorted(glob.glob(os.path.join(parent[:-len(".jsonl")], "subagents", "*.jsonl")))
    return parent, subs


def _tally(path):
    """1つの記録の usage を合計する。`context` だけは合計ではなく**最後の値**。

    「現在の文脈」は積み上げるものではなく、直近の応答が実際に受け取った入力の
    合計である。これが次の1回のツール呼び出しの値段になる。
    """
    t = {"cache_read": 0, "cache_write": 0, "output": 0, "context": 0}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                # JSONに落とす前に弾く。記録は数MBあり、その大半は usage を
                # 持たない行（ツール結果の添付など）なので、全行を json.loads
                # すると Raspberry Pi では体感できるほど遅い。
                if '"usage"' not in line:
                    continue
                try:
                    msg = json.loads(line).get("message")
                except ValueError:
                    continue
                u = msg.get("usage") if isinstance(msg, dict) else None
                if not isinstance(u, dict):
                    continue
                cr = u.get("cache_read_input_tokens") or 0
                cw = u.get("cache_creation_input_tokens") or 0
                t["cache_read"] += cr
                t["cache_write"] += cw
                t["output"] += u.get("output_tokens") or 0
                # 0 の記録では上書きしない。打ち切られたセッションの末尾には
                # usage が全て 0 の応答が残ることがあり、それを「現在の文脈」に
                # 採ると、**いちばん膨らんだ瞬間に 0k と表示される**。
                ctx = cr + cw + (u.get("input_tokens") or 0)
                if ctx:
                    t["context"] = ctx
    except OSError:
        pass
    return t


def token_usage():
    """親・子・合計のトークンを返す。**何があっても例外を投げない。**

    記録の形式はこちらが決めたものではないので、キーが増減しても・ファイルが
    途中まででも、計測が収集を止めてはいけない（`bump()` と同じ理由）。
    """
    empty = {"cache_read": 0, "cache_write": 0, "output": 0, "context": 0}
    try:
        parent_path, sub_paths = transcript_files()
        if not parent_path:
            return None
        parent = _tally(parent_path)
        subs = dict(empty)
        for sp in sub_paths:
            one = _tally(sp)
            for k in ("cache_read", "cache_write", "output"):
                subs[k] += one[k]
            subs["context"] = max(subs["context"], one["context"])
        total = {k: parent[k] + subs[k] for k in ("cache_read", "cache_write", "output")}
        total["context"] = parent["context"]
        return {"parent": parent, "subagents": subs, "total": total,
                "files": 1 + len(sub_paths)}
    except Exception:                                    # noqa: BLE001
        return None


def _m(n):
    return f"{n / 1_000_000:.1f}M" if n >= 1_000_000 else f"{n / 1000:.0f}k"


def token_line(tk):
    """`summary_line` に混ぜる1区画。親と子を並べて出す。

    親の取り分が大きい実行は、親が自分でページを開いている——つまり調査を
    サブエージェントに出せていない。比をそのまま見せれば、その逸脱が報告に出る。
    """
    t, p, c = tk["total"], tk["parent"], tk["subagents"]
    return (f"文脈再送 {_m(t['cache_read'])}（親{_m(p['cache_read'])}・子{_m(c['cache_read'])}）"
            f" / 出力 {_m(t['output'])} / 現在の文脈 {_m(p['context'])}")


def summary_line(st):
    t = st["totals"]
    used, left = t["search"], max(0, PLANNED_LIMIT - t["search"])
    parts = [
        f"検索 {used}/{PLANNED_LIMIT}（残り{left}・上限{HARD_LIMIT}）",
        f"取得 {t['fetch']}（うち拒否{t['blocked']}）",
        f"待機 {t['waited'] / 60:.0f}分",
        f"追記 {t['rows']}行",
    ]
    el = elapsed_min(st)
    lim = limit_min()
    parts.append(f"経過 {el:.0f}分" + (f"/{lim:.0f}分（残り{max(0, lim - el):.0f}分）" if lim else ""))
    tk = token_usage()
    if tk:
        parts.append(token_line(tk))
    return "[予算] " + " / ".join(parts)


def report(st, verbose):
    print(summary_line(st))
    if verbose and st["phases"]:
        print("  工程別:")
        for name, c in st["phases"].items():
            print(f"    {name}\t検索{c['search']}\t取得{c['fetch']}"
                  f"\t待機{c['waited'] / 60:.0f}分\t追記{c['rows']}行")
    if st["totals"]["search"] >= PLANNED_LIMIT:
        print("  枠(170回)を使い切りました。SKILL.md の「撤退の手順」に入り、"
              "終了工程まで通してください（終了工程は検索を使いません）。")
    tk = token_usage()
    if tk and tk["total"]["cache_read"] >= CACHE_READ_WARN:
        print(f"  文脈再送が {_m(tk['total']['cache_read'])} に達しました。"
              "利用上限で打ち切られた回の実測は 48M と 57M です——"
              "**いつ強制終了されてもおかしくない**と考えて、"
              "SKILL.md の「撤退の手順」に入り、終了工程の余力を残してください。")
    if tk and tk["parent"]["cache_read"] > tk["subagents"]["cache_read"] and tk["files"] > 1:
        print("  親の文脈再送が子より多くなっています。親が自分でページを開いている"
              "兆候です（取得はサブエージェントに出し、親は棚卸し・分割・追記・検証だけを行う）。")


def main():
    p = argparse.ArgumentParser(description="この実行の消費を実測して返す")
    p.add_argument("--report", action="store_true", help="いまの消費を出す")
    p.add_argument("--verbose", action="store_true", help="--report に工程別の内訳を添える")
    p.add_argument("--phase", help="以後の計上先の工程名を切り替える")
    p.add_argument("--reset", action="store_true", help="数え直す")
    p.add_argument("--bump", choices=COUNTERS, help="計上する（フック・ツールが呼ぶ）")
    p.add_argument("--n", type=int, default=1, help="--bump の件数")
    p.add_argument("--waited", type=float, default=0.0, help="--bump fetch の待機秒数")
    p.add_argument("--json", action="store_true", dest="as_json", help="機械可読に出す")
    args = p.parse_args()

    if args.reset:
        reset()
        print("予算の計測を数え直しました")
        return 0

    if args.bump:
        bump(args.bump, n=args.n, waited=args.waited)
        return 0

    if args.phase:
        # bump() と同じ read-modify-write なので、同じロックの中で行う
        # （外側で読んだ st をそのまま使うと、その間に他プロセスの bump() が
        # 書いた加算をここでの save() が上書きしてしまう）。
        with _lock():
            st = load()
            st["phase"] = args.phase.strip() or "（未設定）"
            st["phases"].setdefault(st["phase"], _zero())
            save(st)
        print(f"工程を「{st['phase']}」にしました。{summary_line(st)}")
        return 0

    st = load()

    if args.as_json:
        json.dump({**st, "elapsed_min": round(elapsed_min(st), 1),
                   "tokens": token_usage()},
                  sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    report(st, args.verbose)
    return 0


if __name__ == "__main__":
    sys.exit(main())
