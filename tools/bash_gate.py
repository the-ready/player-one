#!/usr/bin/env python3
"""`Bash` の1回分を見て、検証の出力を切る呼び出しを拒否し、取得の内訳を数える。

## 1つめ —— 検証の出力を `head` / `tail` / `grep` に通さない

`.claude/routines/invariants.md` にこう書いてある。

> `diff_data.py` の出力を `head` / `tail` / `grep` に通さない。
> `[表記が変わった可能性]` は `[新規]` の一覧の直後に出るので、切ると見えないまま
> 二重掲載になる。

**これは散文のままだった。** 2026-08-29 15:30 の events は `| head -20` に通して
`[表記が変わった可能性]` を見落とし、表記ゆれだけの催しを**新規行と持ち越し行の
両方として8件二重掲載**している（`docs/routine-postmortems.md`）。

見るのは `diff_data.py` と `validate_data.py` の2つだけである。`report_stats.py` は
含めない——不変規則が名指ししているのは前者で、後者を切ることは規則違反ではないし、
`| head -3` のような使い方が実際にありうる。**規則が言っていないものまで止めると、
規則そのものが信用されなくなる。**

**ファイルへのリダイレクトも、パイプと同じ扱いにする。** `| head` を塞いだだけでは、

    python3 tools/diff_data.py events > /tmp/out.txt && head -20 /tmp/out.txt

のように**書き出してから別のコマンドで切り詰める**という抜け道が残る。シミュレーションで
実際に見つかった——1コマンドの中に `head` が無ければ `cuts_verification()` は
何も検知しない。書き出す側（`> file`）を検証ツールの直後で止めてしまえば、後段が
同じ Bash 呼び出しでも次の呼び出しでも、切り詰められたファイルはそもそも作られない。

見分けるのは「標準出力を実際にファイルへ逃がしているか」だけである。`2>&1` のような
**fd 間のリダイレクトは対象にしない**——あれは標準エラーを標準出力に合流させる
だけで、標準出力そのものは変わらず表示される。直前の文字が数字の `>` は
`2> file.txt`（標準エラーだけをファイルへ）とみなして通す。**`1> file.txt` は
`2>` と同じ形で書かれるが実質は標準出力の切り詰めであり、ここでは捕まえられない**
——ただしこの書き方は不自然で、モデルが自然に書く経路ではない。捕まえられないと
分かったうえで、現実的な脅威（バックティック無しの素朴な `>` リダイレクト）を
優先して塞ぐ。

## 2つめ —— `curl` / `wget` で外のページを取らない

`fetch_page.py` の docstring が既に書いている。

> **`curl` はフックを通らないので、robots.txt の判定も `Crawl-delay` の消化も
> 行われない。**

`fetch_gate.py`（`PreToolUse(WebFetch)`）と `fetch_page.py` の2経路だけが
robots.txt を見て間隔を空ける。`curl` はそのどちらも通らないので、**取得の作法が
まるごと外れる**——しかもこれは自分の取りこぼしではなく、相手のサイトへの迷惑である。

**書いてあるだけでは守られなかった。** `fetch_mix.py` の催促（`WebFetch` に偏った
回を1度だけ止める）を実際に Haiku へ当てたところ、代わりに提案されたのは
`curl -s https://example.com/ | grep ...` だった。**片方を塞ぐと、塞いでいない
抜け道へ寄る**ので、こちらも塞ぐ。

`localhost` と `127.0.0.1` は通す（`smoke_test.mjs` が立てるローカルサーバーが
そこに居る）。URLを伴わない `curl --version` のような呼び出しも通す——見るのは
「外のページを取ろうとしているか」だけである。

## 3つめ —— `fetch_page.py` を呼んだ回数を数える

`tools/fetch_mix.py` の docstring を参照。`budget.py` の `fetch` カウンタは
`WebFetch` と `fetch_page.py` が合流していて内訳が残らないので、ここで数える。

**拒否が決まったあとには数えない。** 拒否された呼び出しは実行されないので、
数えると内訳が実態からずれる。なお `fetch-budget-guard.sh`（撤退の線）が
後段で拒否した場合は1回だけ多く数えうるが、`page` を多めに数えることは
`fetch_mix` の門を**鳴りにくくする**方向にしか効かないので、そちらに倒しておく。

## 終了コード（`--hook`）

  0 : 実行してよい
  2 : 拒否する（理由は stderr）

判定できないときは通す。`Bash` はこのタスクで最も回数の多いツールで、
**入力を読めないことを理由に止めると、波を書き切って終える手段そのものが塞がる**
（`fetch-budget-guard.sh` と同じ倒し方。`block-git.sh` が逆に倒れているのは、
あちらが「検証を通っていないデータの push」という外に出る事故を見ているため）。

使い方:
    python3 tools/bash_gate.py --hook              # PreToolUse(Bash) から。JSONを標準入力で受ける
    python3 tools/bash_gate.py --check '<cmd>'     # 単体で判定を確かめる
"""

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fetch_mix                                               # noqa: E402

# 不変規則が名指ししている2つだけ。`report_stats.py` は入れない（上の docstring）。
VERIFY_TOOLS = re.compile(r"tools/(diff_data|validate_data)\.py")

# 出力を切る道具。`sed -n` と `awk ... NR` も、行を選ぶ用途では同じ働きをする。
CUTTERS = re.compile(r"\|\s*(?:sudo\s+)?(?:head|tail|grep|egrep|fgrep|rg|sed\s+-n|awk\b[^|]*\bNR\b)")

# ファイルへのリダイレクトも、出力を捨てて別のコマンドで読み直す経路になるので
# 同じ扱いにする（上の docstring「ファイルへのリダイレクトも、パイプと同じ扱いにする」）。
#
# `2>&1` のような fd 間のリダイレクトは対象にしない——標準エラーを標準出力に
# 合流させるだけで、標準出力そのものは変わらず表示される。直前が数字の `>`
# （`2> file.txt` など）は標準エラーだけをファイルへ逃がす書き方とみなして通す
# （`1> file.txt` は実質そのまま同じ形になるが、不自然な書き方でモデルが自然に
# 書く経路ではないため、ここでは捕まえない——上の docstring に明記してある）。
FILE_REDIRECT = re.compile(r"(?<![0-9])>{1,2}(?!&)")

FETCH_PAGE = "tools/fetch_page.py"

# 外のページを生で取りに行く道具。`http(s)://` を伴うときだけ見る。
#
# `curl` という語の前は、シェルの区切り・`sudo `・**フルパスの区切り（`/`）** の
# いずれかであることを求める。素の語形一致だけだと `/usr/bin/curl` が
# 素通りする——シミュレーションで実際に確認した抜け道で、対話的に試した
# だけでも1回で見つかっている。大文字小文字も見ない（`CURL` も同じ抜け道）。
RAW_FETCHER = re.compile(r"(?:^|[\s;&|(/])(?:sudo\s+)?(curl|wget)(?:\s|$)", re.IGNORECASE)
REMOTE_URL = re.compile(r"https?://(?!localhost[:/\s]|127\.0\.0\.1[:/\s])[^\s'\"`)]+")

# シェルの区切り。`&&` で繋いだ後段の `| head` も見逃さないために、
# まず区切りで割ってから1つずつ見る。
SEPARATORS = re.compile(r"&&|\|\||;|\n")


def cuts_verification(cmd):
    """検証の出力を切っているなら、その道具の名前。切っていなければ None。"""
    if not cmd:
        return None
    for seg in SEPARATORS.split(cmd):
        m = VERIFY_TOOLS.search(seg)
        if not m:
            continue
        # 検証ツールより**後ろ**だけを見る。
        # `cat x | python3 tools/validate_data.py` のように前段にパイプがあるのは、
        # 出力を切っていることにならない。
        after = seg[m.end():]
        if CUTTERS.search(after) or FILE_REDIRECT.search(after):
            return m.group(1) + ".py"
    return None


def raw_fetch(cmd):
    """`curl` / `wget` で外のページを取ろうとしているなら、その道具の名前。"""
    if not cmd:
        return None
    for seg in SEPARATORS.split(cmd):
        m = RAW_FETCHER.search(seg)
        if m and REMOTE_URL.search(seg):
            return m.group(1)
    return None


def reason_for_raw_fetch(tool):
    return (
        f"`{tool}` で外のページを取らないでください。\n"
        "\n"
        f"**`{tool}` はフックを通らないので、robots.txt の判定も `Crawl-delay` の消化も\n"
        "行われません**（`tools/fetch_page.py` の docstring）。取得の作法が通るのは\n"
        "次の2つだけです。\n"
        "\n"
        "  python3 tools/fetch_page.py <URL> --text       本文だけ（表はタブ区切りで残る）\n"
        "  python3 tools/fetch_page.py <URL> --schedule   日付行とその配下だけ\n"
        "  WebFetch                                       （fetch_gate.py が robots を見る）\n"
        "\n"
        "これは自分の取りこぼしではなく、相手のサイトへの迷惑です。取得したいページが\n"
        "あるなら `fetch_page.py` を使ってください。")


def calls_fetch_page(cmd):
    return bool(cmd) and FETCH_PAGE in cmd


def reason_for(tool):
    return (
        f"検証の出力を `head` / `tail` / `grep` に通さないでください"
        f"（`.claude/routines/invariants.md`）。検出: `{tool}`\n"
        "\n"
        "`diff_data.py` の `[表記が変わった可能性]` は `[新規]` の一覧の**直後**に出ます。\n"
        "切ると見えないまま二重掲載になります——2026-08-29 の events は `| head -20` で、\n"
        "表記ゆれだけの催しを新規行と持ち越し行の**両方として8件**掲載しました。\n"
        "\n"
        "**ファイルへのリダイレクト（`>` `>>`）も同じ扱いです。** 書き出してから別の\n"
        "コマンドで切り詰めるのは、パイプで直接切り詰めるのと同じ結果になります。\n"
        "\n"
        "そのまま実行してください。長くても、全部が判断の材料です。")


def hook():
    """PreToolUse(Bash) として呼ばれたときの入口。"""
    if (os.environ.get("CLAUDE_ROUTINE") or "0") != "1":
        return 0

    try:
        data = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    if not isinstance(data, dict):
        return 0
    ti = data.get("tool_input")
    if not isinstance(ti, dict):
        return 0
    cmd = ti.get("command") or ""

    tool = cuts_verification(cmd)
    if tool:
        print(reason_for(tool), file=sys.stderr)
        return 2

    raw = raw_fetch(cmd)
    if raw:
        print(reason_for_raw_fetch(raw), file=sys.stderr)
        return 2

    if calls_fetch_page(cmd):
        fetch_mix.bump("page")
    return 0


def main():
    p = argparse.ArgumentParser(description="検証の出力を切る Bash を見分け、取得の内訳を数える")
    p.add_argument("--hook", action="store_true", help="PreToolUse(Bash) の入口。JSONを標準入力で受ける")
    p.add_argument("--check", metavar="CMD", help="単体で判定を確かめる（数えない）")
    args = p.parse_args()

    if args.hook:
        return hook()
    if args.check is None:
        p.error("--hook または --check を指定してください")

    tool = cuts_verification(args.check)
    if tool:
        print(reason_for(tool), file=sys.stderr)
        return 1
    raw = raw_fetch(args.check)
    if raw:
        print(reason_for_raw_fetch(raw), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
