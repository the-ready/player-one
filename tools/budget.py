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
`CACHE_READ_NO_NEW_WAVE` / `CACHE_READ_RETREAT` は上限ではなく**警告線**である。
「ここを超えたら、いつ殺されてもおかしくない」という意味しか持たない。

**ここまでの数字（48M・59M など）は、応答1回をブロックの数だけ重ねて数えていた頃の
値で、実際の1.85〜2.36倍である**（`_scan()` の docstring）。重複を除いた実際の値では、
2026-09-22〜30 の7回は16.7M〜30.8Mで、一度も打ち切られていない。

線は2026-09-28に `CACHE_READ_NO_NEW_WAVE`=45M・`CACHE_READ_RETREAT`=60M へ引き上げたが、
その値は水増しされた数え方の上で決めたもので、実際には約24M・32Mで止めていた
（2026-09-30 は300分の枠の29分目で新しい波を止めている）。重複を除いた今は、
同じ45M・60Mが実際の値として効く。

**そして判定の主役は、もうこの線ではない。** 実際の利用率（5時間枠・7日枠）が
読めるときはそちらで判定し（「実際の利用率」の節）、この線は利用率が読めない
ときの代わりとしてだけ使う。

線を2つに分けたのは、1つでは間に合わなかったからである。2026-08-27 の実行は
40M の警告を受け取った**3分16秒後**に殺された。しかもその時点で親は波の帰りを
待って停止中で、動いている子に割り込む手段が無い。判断が要るのは「次の波を
投げるか」を決める瞬間だけではない——2026-09-04 は**最初の波そのもの**が
40M を越えて殺されており、「次の波」の判断が一度も出番を持たなかった。そこで
`--gate` （次の波を投げる瞬間）に加え、`--gate-fetch` （波の途中の1回の取得）
の2つの門を置く。後者は動いている子自身が取得のたびに通るので、
「親が波の帰りを待って停止中」でも間に合う（`gate_fetch()` の docstring）。

使い方:
    python3 tools/budget.py --report                # いまの消費を1行で
    python3 tools/budget.py --report --verbose      # 工程ごとの内訳つき
    python3 tools/budget.py --phase "ステップ2 エリア軸の探索"   # 以後の計上先を切り替える
    python3 tools/budget.py --reset                 # 明示的に数え直す

    # 以下はフックとツールが自動で呼ぶ。手で叩く必要はない
    python3 tools/budget.py --bump search
    python3 tools/budget.py --bump fetch --waited 3.2
    python3 tools/budget.py --bump rows --n 8
    python3 tools/budget.py --gate                  # 次の波を投げてよいか（PreToolUse:Agent）
    python3 tools/budget.py --gate-fetch             # 波の途中でも、この1回の取得をしてよいか
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
TOKEN_SAMPLE = os.path.join(STATE_DIR, "token_sample.json")

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

# 文脈再送（cache_read）の線。**上限ではない**（docstring「上限そのものは
# 分からない」を参照）。2段階に分けてある。
#
# 1段で足りなかった。2026-08-27 の実行は 03:05:22 に 40M の警告を受け取り、
# **その3分16秒後に殺されている。** しかも警告が届いた時点で親は波の帰りを
# 待って停止中で、動いている子に割り込む手段が無い。**間に合う位置に置くには、
# 「次の波を投げるかどうか」を決める前に鳴る必要がある。**
#
#   NO_NEW_WAVE (45M) : 探索をやめる。動いている波は受け取って書き切る
#   RETREAT     (60M) : 撤退の手順へ。終了工程だけを通す
#
# **利用率（`meter()`）が読めるときは使わない。** 読めないときの代わりである。
# 値は実際の（重複を除いた）文脈再送で数える。無人実行の実測（2026-09-22〜30、7回）は
# 16.7M〜30.8Mで一度も打ち切られていない。ギャップ（NO_NEW_WAVE→RETREAT）の15Mは、
# 単独の波1つが一気に増やす実測の最大値（重複除去前14.6M・除去後およそ7.5M）を
# 余裕で上回る幅として保っている。
CACHE_READ_NO_NEW_WAVE = 45_000_000
CACHE_READ_RETREAT = 60_000_000

# 1体のサブエージェントが1つの文脈で回ってよいターン数の目安。
# 超えると2乗で効いてくる（第11.6節）。2026-08-27 の実測は 196/110/120 ターン。
SUBAGENT_TURN_WARN = 60


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
    try:
        os.remove(TOKEN_SAMPLE)       # 前回の実行の標本で速度を出さない
    except OSError:
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


def mark_init(name):
    """`append_rows.py <ds> --init` を通ったことを記録する（`run_gate.py` が見る）。

    収集の開始点はこの1回しかないので、通ったかどうかをここに残しておけば
    「`--init` を飛ばしたまま前回のCSVに追記して終えた回」を後から機械的に
    見分けられる（2026-09-04 20:50 の回がそれだった）。

    `bump()` と同じく、**何があっても例外を投げない**——計測の都合で
    `--init` そのものを失敗させない。
    """
    try:
        with _lock():
            st = load()
            inits = st.get("inits")
            if not isinstance(inits, list):
                inits = []
            if name not in inits:
                inits.append(name)
            st["inits"] = inits
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
    """(親の記録, [子の記録...]) を返す。**自分のセッションを同定できなければ (None, [])。**

    セッションIDだけで引く。`*/<sid>.jsonl` と全プロジェクトを横断して探すのは、
    記録の置き場がリポジトリのパスをスラッグ化した名前で、**その規則が将来
    変わりうる**ためである。IDで引ける限り規則に依存しない。

    ## 「いちばん新しい記録」へのフォールバックを持たない理由

    以前は、IDで引けないとき同じプロジェクトの中でいちばん新しい `.jsonl` を
    今のセッションとみなしていた。「週次ルーチンはロックで同時実行を禁じている
    ので取り違えは起きない」という理由づけだったが、**あのロックが防ぐのは
    ルーチン同士の同時実行だけで、同じリポジトリで人が対話セッションを開いて
    いる場合は防げない。**

    2026-09-04 20:50 の lives 収集がこれを踏んだ。`weekly-routine/SKILL.md` は
    起動時に `!` 埋め込みで `--report` を実行する——**セッション開始の最初期で、
    自分の記録がまだディスクに無い瞬間**である。フォールバックは、そのとき同じ
    プロジェクトで動いていた対話セッション（44.8M）を拾い、「文脈再送44.8M。
    **撤退の手順に入ってください**」を文脈の先頭に載せた。モデルはそれに従い、
    サブエージェントを1体も起動せず、検索0回・取得0回で9分で終えている
    （`docs/routine-postmortems.md` 2026-09-04）。

    **他人の数字を返すくらいなら「分からない」を返す。** 分からないときの倒し方は
    既に決まっていて（`gate()` は 2 を返して通す、`report()` はトークンの節を出さない）、
    そちらは計測できないことを理由に収集を止めない。取り違えだけが、収集を
    止める方向に嘘をつける。
    """
    root = _projects_dir()
    sid = (os.environ.get("CLAUDE_CODE_SESSION_ID") or "").strip()
    if not sid:
        return None, []
    hits = glob.glob(os.path.join(root, "*", sid + ".jsonl"))
    if not hits:
        return None, []
    parent = hits[0]
    subs = sorted(glob.glob(os.path.join(parent[:-len(".jsonl")], "subagents", "*.jsonl")))
    return parent, subs


def _scan(path):
    """1つの記録の usage を合計し、応答の回数（ターン数）と一緒に返す。

    `context` だけは合計ではなく**最後の値**。「現在の文脈」は積み上げるものでは
    なく、直近の応答が実際に受け取った入力の合計である。これが次の1回のツール
    呼び出しの値段になる。

    ## 応答1回を1回として数える（`message.id` で重複を除く）

    記録は応答1回を**内容のブロック（思考・本文・ツール呼び出し）ごとに1行ずつ**
    書き、どの行にも同じ応答の `usage` を丸ごと載せる。行を素朴に足すと、1回の
    応答がブロックの数だけ計上される。2026-09-22〜30 の7回はこれで
    **実際の1.85〜2.36倍**を数えていた（09-30 は表示56.3M・実際29.7M）。
    ターン数も同じ壊れ方をし、`maxTurns: 60` で止まった子が「109〜119ターン」と
    表示されて「maxTurns が効いていない」と誤診されている（docs/skill-feedback.md
    2026-09-30）。線（`CACHE_READ_*`）もその水増しされた数字の上で引かれていた。

    同じ `message.id` の行は `usage` が一致することを実測で確かめてあるので、
    最初の1行だけを採る。`id` の無い行（打ち切られた応答など）は重複の判定が
    できないので、1行を1回として数える。
    """
    t = {"cache_read": 0, "cache_write": 0, "output": 0, "context": 0}
    turns = 0
    seen = set()
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                # JSONに落とす前に弾く。記録は数MBあり、その大半は usage を
                # 持たない行（ツール結果の添付など）なので、全行を json.loads
                # すると Raspberry Pi では体感できるほど遅い。
                if '"usage"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                msg = rec.get("message") if isinstance(rec, dict) else None
                u = msg.get("usage") if isinstance(msg, dict) else None
                if not isinstance(u, dict):
                    continue
                key = msg.get("id") or rec.get("requestId")
                if key:
                    if key in seen:
                        continue
                    seen.add(key)
                turns += 1
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
    return t, turns


def _tally(path):
    return _scan(path)[0]


def _turns(path):
    """その記録に何回の応答があったか。1つの文脈で回ったターン数にあたる。"""
    return _scan(path)[1]


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
        worst = {"turns": 0, "cache_read": 0}
        for sp in sub_paths:
            one, t = _scan(sp)
            for k in ("cache_read", "cache_write", "output"):
                subs[k] += one[k]
            subs["context"] = max(subs["context"], one["context"])
            if t > worst["turns"]:
                worst = {"turns": t, "cache_read": one["cache_read"]}
        total = {k: parent[k] + subs[k] for k in ("cache_read", "cache_write", "output")}
        total["context"] = parent["context"]
        return {"parent": parent, "subagents": subs, "total": total,
                "worst_subagent": worst, "count": len(sub_paths),
                "files": 1 + len(sub_paths)}
    except Exception:                                    # noqa: BLE001
        return None


def burn_rate(cache_read):
    """直近の文脈再送の増え方（トークン/分）。取れなければ None。

    実行全体の平均では役に立たない。波が動いている間とそうでない間で桁が
    違い、**知りたいのは「いまの速さで残り何分か」**だからである
    （2026-08-27 は全体平均 1.4M/分に対し、波が動いている間は 3.5M/分だった）。
    そこで前回このスクリプトを呼んだ時点との差分で出す。
    """
    now = _now()
    # **budget.json には書かない。** あちらは `load()` が「古ければ数え直す」
    # 実装なので、読んで書き戻すと**古くなった瞬間に起点が今へずれる**。
    # `--report` は今まで読むだけの操作で、呼んだだけで経過時間が0に戻るのは
    # 計器として筋が通らない。標本だけを別のファイルに置く。
    prev = None
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        try:
            with open(TOKEN_SAMPLE, encoding="utf-8") as f:
                prev = json.load(f)
        except (OSError, ValueError):
            prev = None
        tmp = TOKEN_SAMPLE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump([now, cache_read], f)
        os.replace(tmp, TOKEN_SAMPLE)
    except Exception:                                    # noqa: BLE001
        return None
    if not (isinstance(prev, list) and len(prev) == 2):
        return None
    dt = (now - prev[0]) / 60.0
    dv = cache_read - prev[1]
    if dt < 0.5 or dv <= 0:
        return None            # 間隔が短すぎる・進んでいない
    return dv / dt


def _m(n):
    return f"{n / 1_000_000:.1f}M" if n >= 1_000_000 else f"{n / 1000:.0f}k"


def token_line(tk):
    """`summary_line` に混ぜる1区画。親と子を並べて出す。

    親の取り分が大きい実行は、親が自分でページを開いている——つまり調査を
    サブエージェントに出せていない。比をそのまま見せれば、その逸脱が報告に出る。
    """
    t, p, c = tk["total"], tk["parent"], tk["subagents"]
    worst = tk.get("worst_subagent") or {}
    tail = f"・最長の子{worst['turns']}ターン" if worst.get("turns") else ""
    return (f"文脈再送 {_m(t['cache_read'])}（親{_m(p['cache_read'])}・子{_m(c['cache_read'])}{tail}）"
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
    else:
        # **黙って省かない。** 省くと「トークンの節が無い＝0だった」と読めてしまい、
        # 計器に載っていない資源がまた見えなくなる（第8.7.1節の再発）。
        # 起動直後（自分の記録がまだ書かれていない瞬間）は、これが正常な表示である。
        parts.append("文脈再送 未計測（このセッションの記録がまだ見つかりません）")
    return "[予算] " + " / ".join(parts)


def report(st, verbose):
    print(summary_line(st))
    sample = meter()
    if sample:
        print("  " + meter_line(sample))
        level, why = meter_verdict(sample)
        if level >= 2:
            print("  " + "、".join(why) + "。**撤退の手順に入ってください。**")
        elif level == 1:
            print("  " + "、".join(why) + "。**新しい波を投げないでください。**")
    if verbose and st["phases"]:
        print("  工程別:")
        for name, c in st["phases"].items():
            print(f"    {name}\t検索{c['search']}\t取得{c['fetch']}"
                  f"\t待機{c['waited'] / 60:.0f}分\t追記{c['rows']}行")
    if st["totals"]["search"] >= PLANNED_LIMIT:
        print("  枠(170回)を使い切りました。SKILL.md の「撤退の手順」に入り、"
              "終了工程まで通してください（終了工程は検索を使いません）。")
    tk = token_usage()
    if not tk:
        return
    cr = tk["total"]["cache_read"]
    rate = burn_rate(cr)
    if rate and not sample:
        # 撤退の線までの見込みを添える。上限は観測できないので
        # 「あと何分か」ではなく「実測に基づく警告線まで何分か」と書く。
        left = (CACHE_READ_RETREAT - cr) / rate
        print(f"  直近の燃焼速度 {_m(rate)}/分"
              f"（この速さなら、撤退の線 {_m(CACHE_READ_RETREAT)} まで約{max(0, left):.0f}分）")
        # 「まだ波を投げてよいか」の判断に直接使える数字を添える。NO_NEW_WAVE に
        # 届く前提で、「あと何分」を出す——「まだ余っていそう」
        # という感覚ではなく、この数字で決めてもらうため（「予算に余裕があるなら、
        # 何を厚くするか」章参照）。届いた後はRETREATまでの残り分に切り替える。
        if cr < CACHE_READ_NO_NEW_WAVE:
            left_wave = (CACHE_READ_NO_NEW_WAVE - cr) / rate
            print(f"  {_m(CACHE_READ_NO_NEW_WAVE)}（新しい波を投げないでください）まで約{left_wave:.0f}分"
                  "——新しい波を投げるかどうかは、この残り時間と直近の波1つぶんの"
                  "所要時間を見比べて決める。")
        elif cr < CACHE_READ_RETREAT:
            left_retreat = (CACHE_READ_RETREAT - cr) / rate
            print(f"  {_m(CACHE_READ_RETREAT)}（撤退の手順）まで約{left_retreat:.0f}分。新しい波は投げず、"
                  "動いている波の帰りを待って終了工程へ進む。")
    if sample:
        pass      # 判定は上の利用率で出した。文脈再送の線は利用率が読めないときの代わり
    elif cr >= CACHE_READ_RETREAT:
        print(f"  文脈再送が {_m(cr)}。**撤退の手順に入ってください。**"
              "（利用率が読めないため、代わりに文脈再送の線で判定しています。）"
              "新しい調査はやめ、終了工程（追記・処分・検証）だけを通します。")
    elif cr >= CACHE_READ_NO_NEW_WAVE:
        print(f"  文脈再送が {_m(cr)}。**新しい波を投げないでください。**"
              "動いている波は受け取り、`append_rows.py` で書き切ってから終了工程へ進みます"
              "（波を投げてしまうと、打ち切られたときに割り込む手段がありません）。")
    if tk["parent"]["cache_read"] > tk["subagents"]["cache_read"] and tk["files"] > 1:
        print("  親の文脈再送が子より多くなっています。親が自分でページを開いている"
              "兆候です（取得はサブエージェントに出し、親は棚卸し・分割・追記・検証だけを行う）。")
    worst = tk.get("worst_subagent") or {}
    if worst.get("turns", 0) >= SUBAGENT_TURN_WARN:
        print(f"  1体のサブエージェントが {worst['turns']}ターン回っています"
              f"（{_m(worst['cache_read'])}）。`maxTurns: {SUBAGENT_TURN_WARN}` に達した子は"
              "**担当の途中で打ち切られています**（返ってきた行が担当の全部ではない）。"
              "1つの文脈でN回呼ぶと入力はNの2乗で増えるので、次の波からは担当範囲を小さく分けて"
              f"**1体 {SUBAGENT_TURN_WARN}ターン未満**で書き切れる大きさにしてください。")




# ---------------------------------------------------------------- 実際の利用率
#
# 文脈再送（cache_read）は**代わりの数字**でしかない。上限そのものが観測できない
# から、その手前に警告線を引いて代用してきた（docstring「上限そのものは
# 分からない」）。ところが `claude -p --output-format stream-json` は
# `rate_limit_event` として**サブスクリプションの実際の利用率**を出している
# （5時間枠と7日枠。2026-09-30 に実測で確認）。見えるものは直接見る。
#
#   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
#     "unifiedWindows":{"five_hour":{"utilization":0.7,"resetsAt":1790770200},
#                       "seven_day":{"utilization":0.63,"resetsAt":1791061200}}}}
#
# 標本は2つの経路で `data/.run/ratelimit.json` に入る。
#   1. `claude-routine.sh` が本体の出力ストリームに流れてきたイベントを
#      `--record-ratelimit` で書く（セッション開始時に1回出る）
#   2. `--probe` が最小の `claude -p`（haiku・ツール無し・設定無し・記録無し）を
#      起動して、その開始時のイベントを読む。1回およそ $0.01・6秒。
#      `claude-routine.sh` が実行中に数分おきに回すほか、`gate()` も古ければ回す
#
# **標本が読めない・古いときは、従来どおり文脈再送の線で判定する。** 計器が
# 壊れたことを理由に収集を止めない（他のゲートと同じ倒し方）。
RATELIMIT = os.path.join(STATE_DIR, "ratelimit.json")
RATELIMIT_RUN = os.path.join(STATE_DIR, "ratelimit-run.json")
RATELIMIT_HISTORY = os.path.join(STATE_DIR, "ratelimit-history.jsonl")
PROBE_LOCK = os.path.join(STATE_DIR, "ratelimit-probe.lock")

# これより古い標本は判定に使わない（`claude-routine.sh` の測り直しの間隔は4分）
METER_MAX_AGE_SEC = 15 * 60
# `gate()`（次の波を投げる瞬間）は、これより古ければその場で測り直す
GATE_PROBE_AGE_SEC = 5 * 60
PROBE_TIMEOUT_SEC = 45

# 5時間枠の線。100%で `status: rejected` になり、実行はその場で殺される。
# 新しい波を止めてから撤退までに、動いている波1つ（実測で最大7.5M、
# 重複除去後）と終了工程が走り切る幅を残す。
FIVE_HOUR_NO_NEW_WAVE = 0.80
FIVE_HOUR_RETREAT = 0.92

# 7日枠は同じ週の**後の回と分け合う**。水曜の回が使い切ると、木金の回は
# 最初の波すら投げられない（2026-09-30 の時点で水曜の夜に既に63%だった）。
# そこで「リセットまでに残っている予定の回数 × 1回ぶん」を残す位置に線を引く。
# 1回ぶんは `ratelimit-history.jsonl`（各回の開始と終了の標本）の実測から取り、
# 実測が無いうちは既定値を使う。
SEVEN_DAY_CEILING = 0.92
SEVEN_DAY_RETREAT = 0.96
SEVEN_DAY_RESERVE_DEFAULT = 0.10
SEVEN_DAY_RESERVE_MIN = 0.03
SEVEN_DAY_RESERVE_MAX = 0.20

# 定期起動の時刻（`.claude/systemd/player-one-dispatch.timer` の OnCalendar）。
# 曜日は weekly-routine/SKILL.md の ```schedule ブロックから読む。
SCHEDULE_FILE = os.path.join(ROOT, ".claude", "skills", "weekly-routine", "SKILL.md")
SCHEDULE_TZ = "Asia/Tokyo"
SCHEDULE_HOUR, SCHEDULE_MINUTE = 2, 30


def _window(info, name):
    """`rate_limit_info` から1つの枠を {"u": 利用率, "reset": 秒} で取り出す。"""
    w = (info.get("unifiedWindows") or {}).get(name)
    if isinstance(w, dict) and isinstance(w.get("utilization"), (int, float)):
        return {"u": float(w["utilization"]), "reset": w.get("resetsAt")}
    # 古い形式: 最上位に「いちばん厳しい枠」だけが載る
    if info.get("rateLimitType") == name and isinstance(info.get("utilization"), (int, float)):
        return {"u": float(info["utilization"]), "reset": info.get("resetsAt")}
    return None


def parse_rate_limit_event(obj):
    """ストリームの1イベントから標本を作る。対象外・形が違えば None。"""
    if not isinstance(obj, dict) or obj.get("type") != "rate_limit_event":
        return None
    info = obj.get("rate_limit_info")
    if not isinstance(info, dict):
        return None
    five, seven = _window(info, "five_hour"), _window(info, "seven_day")
    if five is None and seven is None and info.get("status") != "rejected":
        return None
    return {"five_hour": five, "seven_day": seven, "status": info.get("status") or ""}


def _write_json(path, obj):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def record_sample(sample, source):
    """標本を保存する。**何があっても例外を投げない。**"""
    try:
        _write_json(RATELIMIT, dict(sample, at=_now(), source=source))
        return True
    except Exception:                                    # noqa: BLE001
        return False


def record_stream(lines, source="stream"):
    """ストリームの行（JSON）から `rate_limit_event` を拾って保存する。保存した件数を返す。"""
    n = 0
    for line in lines:
        line = line.strip()
        if '"rate_limit_event"' not in line:
            continue
        try:
            sample = parse_rate_limit_event(json.loads(line))
        except ValueError:
            continue
        if sample and record_sample(sample, source):
            n += 1
    return n


def meter(max_age=METER_MAX_AGE_SEC):
    """新しい標本を返す。無い・古い・壊れているなら None。"""
    try:
        with open(RATELIMIT, encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(st, dict) or not isinstance(st.get("at"), (int, float)):
        return None
    if _now() - st["at"] > max_age:
        return None
    return st


def _probe_env():
    """測定用の `claude` に渡す環境。**このセッションの素性を持ち込まない。**

    `CLAUDE_CODE_SESSION_ID` を継ぐと、測定用のセッションが本体の記録を自分のもの
    だと名乗る（`claude-routine.sh` がこれを unset している理由と同じ）。
    `CLAUDE_ROUTINE` を継ぐと、万一プロジェクトの設定が読まれたときにゲートが
    測定用のセッションにまで効く。認証（`CLAUDE_CODE_OAUTH_TOKEN`）はそのまま渡す。
    """
    drop = {"CLAUDE_CODE_SESSION_ID", "CLAUDE_ROUTINE", "CLAUDE_INVESTIGATE",
            "CLAUDE_PROJECT_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"}
    return {k: v for k, v in os.environ.items() if k not in drop}


def probe(timeout=PROBE_TIMEOUT_SEC):
    """最小の `claude -p` を起動して利用率を測り、保存した標本を返す。取れなければ None。

    ほかのプロセスが測っている最中なら待たずに None を返す（呼び出し側は既存の
    標本を使う）。子が3体並行で取得している最中に、それぞれが測り直しに行って
    6秒ずつ待たされる事態を作らないため。
    """
    import shutil
    import subprocess
    import tempfile
    claude = os.environ.get("CLAUDE_BIN") or shutil.which("claude")
    if not claude:
        return None
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        lockf = open(PROBE_LOCK, "w")
    except OSError:
        return None
    try:
        try:
            fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return None
        # 設定を1つも読ませない（`--setting-sources ""`）。フックもスキルも動かず、
        # 記録も残らない（`--no-session-persistence`）ので、測定が計測対象に混ざらない。
        # `--bare` は OAuth を読まないので使えない。
        cmd = [claude, "-p", ".", "--setting-sources", "", "--no-session-persistence",
               "--tools", "", "--strict-mcp-config", "--model", "haiku",
               "--max-turns", "1", "--output-format", "stream-json", "--verbose"]
        try:
            r = subprocess.run(cmd, cwd=tempfile.gettempdir(), env=_probe_env(),
                               stdin=subprocess.DEVNULL, capture_output=True,
                               text=True, timeout=timeout)
        except (OSError, subprocess.SubprocessError):
            return None
        if record_stream(r.stdout.splitlines(), source="probe"):
            return meter()
        return None
    finally:
        try:
            fcntl.flock(lockf, fcntl.LOCK_UN)
        except OSError:
            pass
        lockf.close()


def _scheduled_days():
    """```schedule ブロックに曜日番号（1〜7）で書かれた行の曜日。読めなければ空。"""
    try:
        text = open(SCHEDULE_FILE, encoding="utf-8").read()
    except OSError:
        return set()
    days, inside = set(), False
    for line in text.splitlines():
        t = line.strip()
        if t == "```schedule":
            inside = True
            continue
        if inside and t.startswith("```"):
            break
        if inside and t and not t.startswith("#"):
            head = t.split()[0]
            if head.isdigit() and 1 <= int(head) <= 7:
                days.add(int(head))
    return days


def remaining_runs(until, now=None):
    """いまから `until`（秒）までに、定期起動が何回残っているか。"""
    import datetime
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(SCHEDULE_TZ)
    except Exception:                                    # noqa: BLE001
        return 0
    days = _scheduled_days()
    if not days or not isinstance(until, (int, float)):
        return 0
    now = _now() if now is None else now
    d = datetime.datetime.fromtimestamp(now, tz).date()
    n = 0
    for i in range(0, 9):
        day = d + datetime.timedelta(days=i)
        slot = datetime.datetime(day.year, day.month, day.day, SCHEDULE_HOUR,
                                 SCHEDULE_MINUTE, tzinfo=tz).timestamp()
        if now < slot < until and day.isoweekday() in days:
            n += 1
    return n


def reserve_per_run():
    """1回の実行が7日枠をどれだけ使うか（実測の中央値）。実測が無ければ既定値。"""
    deltas = []
    try:
        with open(RATELIMIT_HISTORY, encoding="utf-8") as f:
            for line in f:
                try:
                    h = json.loads(line)
                    a, b = h["start"]["seven_day"], h["end"]["seven_day"]
                except (ValueError, KeyError, TypeError):
                    continue
                # 途中で枠がリセットされた回は差が負になり、1回ぶんを表さない
                if a and b and a.get("reset") == b.get("reset") and b["u"] > a["u"]:
                    deltas.append(b["u"] - a["u"])
    except OSError:
        pass
    if not deltas:
        return SEVEN_DAY_RESERVE_DEFAULT
    recent = sorted(deltas[-6:])
    mid = recent[len(recent) // 2]
    return min(SEVEN_DAY_RESERVE_MAX, max(SEVEN_DAY_RESERVE_MIN, mid))


def seven_day_line(sample, now=None):
    """7日枠で「新しい波を投げない」線と、その根拠（残りの回数・1回ぶん）。"""
    seven = sample.get("seven_day") or {}
    left = remaining_runs(seven.get("reset"), now)
    per = reserve_per_run()
    return max(0.0, SEVEN_DAY_CEILING - per * left), left, per


def meter_verdict(sample, now=None):
    """標本から判定する。(水準, 理由の文) を返す。水準 0=投げてよい 1=新しい波を止める 2=撤退。"""
    level, why = 0, []
    five, seven = sample.get("five_hour"), sample.get("seven_day")
    if sample.get("status") == "rejected":
        level = 2
        why.append("利用上限に達しています（status=rejected）")
    if five:
        if five["u"] >= FIVE_HOUR_RETREAT:
            level = max(level, 2)
            why.append(f"5時間枠が {five['u']:.0%}（撤退の線 {FIVE_HOUR_RETREAT:.0%}）")
        elif five["u"] >= FIVE_HOUR_NO_NEW_WAVE:
            level = max(level, 1)
            why.append(f"5時間枠が {five['u']:.0%}（新しい波を投げない線 {FIVE_HOUR_NO_NEW_WAVE:.0%}）")
    if seven:
        line, left, per = seven_day_line(sample, now)
        if seven["u"] >= SEVEN_DAY_RETREAT:
            level = max(level, 2)
            why.append(f"7日枠が {seven['u']:.0%}（撤退の線 {SEVEN_DAY_RETREAT:.0%}）")
        elif seven["u"] >= line:
            level = max(level, 1)
            why.append(f"7日枠が {seven['u']:.0%}（新しい波を投げない線 {line:.0%}"
                       f"＝リセットまでに残る定期実行{left}回×1回ぶん{per:.0%}を残す位置）")
    return level, why


def meter_line(sample, now=None):
    """`--report` に載せる1行。"""
    import datetime
    parts = []
    for name, label in (("five_hour", "5時間枠"), ("seven_day", "7日枠")):
        w = sample.get(name)
        if not w:
            continue
        reset = ""
        if isinstance(w.get("reset"), (int, float)):
            reset = datetime.datetime.fromtimestamp(w["reset"]).strftime("%m/%d %H:%M")
            reset = f"・リセット {reset}"
        parts.append(f"{label} {w['u']:.0%}{reset}")
    age = (_now() - sample.get("at", _now())) / 60.0
    line, left, per = seven_day_line(sample, now) if sample.get("seven_day") else (None, 0, 0)
    tail = (f"。線: 5時間枠 {FIVE_HOUR_NO_NEW_WAVE:.0%}で新しい波を止め {FIVE_HOUR_RETREAT:.0%}で撤退"
            + (f"・7日枠 {line:.0%}で新しい波を止める（残り{left}回×{per:.0%}を後の回に残す）"
               if line is not None else ""))
    return f"[利用率] {' / '.join(parts)}（{age:.0f}分前に測定）{tail}"


def run_mark(which, skill=""):
    """実行の開始・終了の利用率を記録する。終了時に1回ぶんの実測を履歴へ足す。

    `claude-routine.sh` が本体の起動前と終了後に呼ぶ。**何があっても 0 を返す。**
    """
    try:
        sample = probe() or meter(max_age=120)
        if which == "start":
            _write_json(RATELIMIT_RUN, {"start": sample, "skill": skill, "at": _now()})
        else:
            try:
                with open(RATELIMIT_RUN, encoding="utf-8") as f:
                    run = json.load(f)
            except (OSError, ValueError):
                run = {}
            if isinstance(run, dict) and run.get("start") and sample:
                import datetime
                os.makedirs(STATE_DIR, exist_ok=True)
                with open(RATELIMIT_HISTORY, "a", encoding="utf-8") as f:
                    f.write(json.dumps({
                        "date": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
                        "skill": run.get("skill") or skill,
                        "start": run["start"], "end": sample,
                    }, ensure_ascii=False) + "\n")
        if sample:
            print(meter_line(sample))
        else:
            print("[利用率] 測れませんでした（文脈再送の線で判定を続けます）")
    except Exception as e:                               # noqa: BLE001
        print(f"[利用率] 記録に失敗しました: {e}")
    return 0


def gate():
    """新しい波を投げてよいかを終了コードで返す。`agent-guard.sh` が呼ぶ。

    ## なぜ表示では足りなかったのか

    25M / 40M の線は `--report` が文字で出していた。**出ているだけでは守られなかった。**
    2026-08-29 15:30 の実行は、線のどちらにも届いていないのに4波で畳んでいる（早すぎた側）。
    2026-08-27 の実行は 40M の警告の3分16秒後に殺されており、そのとき親は波の帰りを待って
    停止していた——警告を読める位置に居なかった（遅すぎた側）。表示は**どちらの方向にも
    外れる**。判断を表示に委ねている限り、外れたことに誰も気づけない。

    そこで「次の波を投げるか」を決める瞬間、つまり `Agent` の起動そのものを門にする。
    `wave_gate.py` が「前の波を書き切ったか」を見るのと同じ位置で、こちらは
    「まだ投げてよい残量があるか」を見る。

    ## 終了コード

      0 : 投げてよい（線に届いていない）
      1 : 投げてはいけない（`CACHE_READ_NO_NEW_WAVE`以上）。理由を stderr に書く
      2 : 判定できない（セッションの記録が読めない等）

    **2 では止めない。** 計測できないことを理由に収集そのものを止めると、被害のほうが
    大きい（`wave_gate.py` と同じ倒し方。`fetch_gate.py` が逆に倒しているのは、あちらが
    外部への迷惑を見ているためである）。
    """
    # 実際の利用率が読めるなら、それで決める（代わりの数字より優先する）。
    sample = meter(max_age=GATE_PROBE_AGE_SEC) or probe()
    if sample:
        level, why = meter_verdict(sample)
        if level == 0:
            return 0
        head = "、".join(why) + "。"
        if level >= 2:
            print(f"{head}**撤退の手順に入ってください。**\n\n"
                  "新しい調査はやめ、終了工程（追記・処分・検証・報告）だけを通します。"
                  "未処理の前回行は `tools/prev_rows.py <ds> --carry-rest --apply` で片付けられます"
                  "（これから調べる予定の行が残っているうちは使わないこと）。", file=sys.stderr)
        else:
            print(f"{head}**この波は投げられません。**\n\n"
                  "動いている波があれば受け取り、`append_rows.py` で書き切ってから終了工程へ進んでください。"
                  "ここから波を投げると、上限に当たったときに動いている子へ割り込む手段がありません。",
                  file=sys.stderr)
        return 1

    tk = token_usage()
    if not tk:
        print("# 利用率も文脈再送も読めませんでした。判定を見送ります。",
              file=sys.stderr)
        return 2
    cr = tk["total"]["cache_read"]
    if cr < CACHE_READ_NO_NEW_WAVE:
        return 0

    if cr >= CACHE_READ_RETREAT:
        head = (f"文脈再送が {_m(cr)} で、撤退の線（{_m(CACHE_READ_RETREAT)}）を越えています。"
                "**撤退の手順に入ってください。**")
        body = ("新しい調査はやめ、終了工程（追記・処分・検証・報告）だけを通します。"
                "未処理の前回行は `tools/prev_rows.py <ds> --carry-rest --apply` で片付けられます"
                "（これから調べる予定の行が残っているうちは使わないこと）。")
    else:
        head = (f"文脈再送が {_m(cr)} で、新しい波を投げない線（{_m(CACHE_READ_NO_NEW_WAVE)}）を"
                "越えています。**この波は投げられません。**")
        body = ("動いている波があれば受け取り、`append_rows.py` で書き切ってから終了工程へ進んでください。"
                "（利用率が読めないため、代わりに文脈再送の線で判定しています。）ここから波を投げると、"
                "打ち切られたときに動いている子へ割り込む手段がありません。")
    print(f"{head}\n\n{body}", file=sys.stderr)
    return 1


def gate_fetch():
    """**波の途中でも**、この1回の取得（`fetch_page.py` / `WebSearch`）をしてよいかを
    終了コードで返す。`.claude/hooks/fetch-budget-guard.sh` が呼ぶ。

    ## `gate()` だけでは間に合わなかった実例

    `gate()` は `Agent` の起動、つまり**次の波を投げる瞬間**にしか門を置けない。
    2026-09-04 の lives 収集は、**最初の波**（フェス調査・東京バッチA・東京バッチB）
    の中でホール系の会場に通信障害（DNS不通・SSL証明書不一致・タイムアウト）が
    連鎖し、1体が `SUBAGENT_TURN_WARN`（60ターン）の倍を超える141ターンまで
    膨らんで文脈再送39.4Mに達した。まだ「次の波」が一度も投げられていないので、
    `gate()` の門は一度も開く機会がないまま、3分足らず後にアカウントの利用上限
    （セッション制限）で子・親とも強制終了された。

    親が波の帰りを待って停止している間は割り込む手段が無い（`gate()` の docstring
    と同じ制約）が、**動いている子自身がその都度呼ぶ取得ツールなら話が違う。**
    `fetch_page.py` の呼び出しと `WebSearch` は子から見ても「次の1回」であり、
    その呼び出し自体を門にすれば、次の波を待たずに撤退させられる。

    ## 線は撤退（`CACHE_READ_RETREAT`）だけを見る

    `gate()` の `CACHE_READ_NO_NEW_WAVE`（新しい波を止める）は流用しない。
    その間は「動いている波は受け取って書き切る」設計（`gate()` 参照）で、
    その間の取得まで止めると波を書き切れなくなる。撤退の線を越えた取得だけを
    止める——**ここを超えたら、いつ殺されてもおかしくない**という同じ意味で、
    取得を続ける猶予がもう無い。

    ## 終了コード

      0 : 取得してよい（線に届いていない）
      1 : 取得してはいけない（`CACHE_READ_RETREAT`以上）。理由を stderr に書く
      2 : 判定できない（セッションの記録が読めない等）

    **2 では止めない。** `gate()` と同じ理由で、計測できないことを理由に取得を
    止めると被害のほうが大きい。
    """
    # ここでは測り直さない。取得のたびに呼ばれるので、6秒の測定を挟むと調査が
    # 目に見えて遅くなる。標本は `claude-routine.sh` が数分おきに更新している。
    sample = meter()
    if sample:
        level, why = meter_verdict(sample)
        if level < 2:
            return 0
        head = "、".join(why) + "。"
    else:
        tk = token_usage()
        if not tk:
            print("# 利用率も文脈再送も読めませんでした。判定を見送ります。",
                  file=sys.stderr)
            return 2
        cr = tk["total"]["cache_read"]
        if cr < CACHE_READ_RETREAT:
            return 0
        head = f"文脈再送が {_m(cr)} で、撤退の線（{_m(CACHE_READ_RETREAT)}）を越えています。"
    print(f"{head}\n\n"
          "**波の途中でも、これ以上は取得しないでください。** ここまでに調べた行を "
          "temp/rows-<波の名前>.jsonl に書き出し、返答にはパスと件数だけを書いてターンを終えてください。"
          "新しい波はもちろん、動いている波の中の取得もここで打ち切ります。", file=sys.stderr)
    return 1


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
    p.add_argument("--gate", action="store_true",
                   help="新しい波を投げてよいかを終了コードで返す（フックが呼ぶ）")
    p.add_argument("--gate-fetch", action="store_true",
                   help="波の途中でも、この1回の取得をしてよいかを終了コードで返す（フックが呼ぶ）")
    p.add_argument("--probe", action="store_true",
                   help="最小の claude -p で実際の利用率を測って保存する（claude-routine.sh が呼ぶ）")
    p.add_argument("--record-ratelimit", action="store_true",
                   help="標準入力の stream-json から rate_limit_event を拾って保存する")
    p.add_argument("--run-start", action="store_true", help="実行開始時の利用率を記録する")
    p.add_argument("--run-end", action="store_true", help="実行終了時の利用率を記録し、1回ぶんを履歴に足す")
    p.add_argument("--skill", default="", help="--run-start / --run-end に添えるスキル名")
    args = p.parse_args()

    if args.record_ratelimit:
        record_stream(sys.stdin)
        return 0

    if args.probe:
        sample = probe()
        print(meter_line(sample) if sample else "[利用率] 測れませんでした")
        return 0 if sample else 1

    if args.run_start or args.run_end:
        return run_mark("start" if args.run_start else "end", args.skill)

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

    if args.gate:
        return gate()

    if args.gate_fetch:
        return gate_fetch()

    st = load()

    if args.as_json:
        json.dump({**st, "elapsed_min": round(elapsed_min(st), 1),
                   "tokens": token_usage(), "ratelimit": meter()},
                  sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    report(st, args.verbose)
    return 0


if __name__ == "__main__":
    sys.exit(main())
