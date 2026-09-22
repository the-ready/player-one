#!/usr/bin/env python3
"""子（サブエージェント）の最後の返答が、契約どおり「パスと件数だけ」かを終了コードで返す。

## なぜ要るのか —— 行を返答に載せると、同じ行を3回払う

契約は各SKILL.mdにこう書いてある。

> 結果は `temp/rows-<波の名前>.jsonl` に自分で書き、返答にはそのパスと件数だけを書け。
> 行そのものを返答に含めるな。

払う回数が3回になる、というのがこの契約の理由である——子が返答に書き（出力）、
親の文脈に入り（入力。**以後、親のターン数だけ再送される**）、親が書き直す（出力）。
2026-08-26 の lives 収集は88行でこれをやり、`03:07:48 → 03:11:21` の3分半がほぼ
純粋な出力生成に消えている（`docs/routine-postmortems.md`）。

**そして、この契約にだけ門が無かった。** 背景起動は `agent-guard.sh`、波の書き切りは
`wave_gate.py`、抜粋の受け渡しは `agent-guard.sh` が見ているが、**子が終わってから
親が受け取るまでの間には、これまで何も無かった。**

## 何を見るか —— 「行が載っているか」と「パスを返したか」

`SubagentStop` の入力には `agent_transcript_path` が入るので、子の最後の返答を
読める。見るのは2つだけである。

  1. **JSONLらしき行が2行以上ある** —— 行そのものを貼っている。長さに関係なく止める
  2. **`temp/rows-*.jsonl` への参照が無く、返答が長い** —— ファイルに書かずに
     文章で報告している。0件だったのなら「0件」の一言で足りる

閾値を緩くしてはいけない。**止めると子はもう1ターン回り、その子の文脈がまるごと
再送される**（実測で10〜20万トークン）。割が合うのは、載っている行が親のターン数
だけ再送される場合だけである。曖昧なものは通す。

`stop_hook_active` が立っている2周目は黙って通す。同じ催促を繰り返しても、
連続ブロックの上限に当たるだけになる（`verify-data.sh` と同じ）。

## 記録は、フックが呼ばれた時点でまだ書き終わっていないことがある

**これは実測で見つけた。** 同じ試験（子に行を貼らせる）を繰り返したところ、
`SubagentStop` が発火した時点の `agent_transcript_path` が

    156,667バイト（書き終わっている）→ 検知する
     50,629バイト（本文がまだ無い）  → 見逃す

の2通りに割れ、素直に1回読むだけの実装では**3回に1回しか検知できなかった**。
記録への書き込みはフックの発火と同期していない。

そこで**本文が現れるまで短く待つ**（`SETTLE_WAIT_SEC`）。実測では待ちが要った
回でも 0.2秒で現れ、この待ちを入れた4回はすべて検知している。上限を3秒にして
あるのは、フックの持ち時間（`settings.json` の20秒）に対して十分短く、かつ
測った値の10倍以上あるためである。**待ち切っても本文が無ければ通す**
——記録が読めないことを理由に子を回し直さない、という下の倒し方は変わらない。

## `maxTurns` で打ち切られた子との関係

子には `maxTurns: 60` が入っている（`.claude/agents/kanto-collector-worker.md`）。
打ち切られた子は最後の返答を書き終えていないので、このゲートに引っかかる形は
**「3,000字を超えていて `temp/rows-*.jsonl` に一度も触れていない」1通りだけ**である。

実際には引っかかりにくい。子は「1件書けるたびに `temp/rows-*.jsonl` へ追記する」
と指示されており、追記のたびにパスが返答に現れるためである。
引っかかった場合も、止めたぶんの子はもう1ターン回れずに `maxTurns` で再び終わり、
2周目は `stop_hook_active` で黙って通すので、**催促が往復し続けることはない。**

## 終了コード

  0 : 契約どおり（または判定できない）
  1 : 行が載っている／ファイルに書いていない。理由を stderr に書く

**判定できないときは通す。** 記録が読めないことを理由に、調べ終えた子を
もう1ターン回すのは、このゲートが防ごうとしている損失より大きい。

使い方:
    python3 tools/reply_gate.py --hook             # SubagentStop から。JSONを標準入力で受ける
    python3 tools/reply_gate.py --check <path>     # 子の記録を指定して判定を確かめる
"""

import argparse
import json
import os
import re
import sys
import time

# 返答の長さの線。契約どおりの返答（「temp/rows-tokyo-a.jsonl に32件書きました」）は
# 100文字前後で収まる。3,000文字は「文章で報告している」と言い切れる線である。
LONG_CHARS = 3_000

# JSONLらしき行とみなす最短の長さ。`{"uid": ...}` を1件だけ例示するような返答を
# 巻き込まないよう、2行以上あって初めて止める。
ROW_MIN_CHARS = 80

ROWS_PATH = re.compile(r"temp/rows-[\w.\-]+\.jsonl")

# 本文が記録に現れるまで待つ上限と間隔（上の「記録は書き終わっていないことがある」）。
SETTLE_WAIT_SEC = 3.0
SETTLE_POLL_SEC = 0.2


def last_assistant_text(path):
    """記録の中の、最後の「本文のある応答」。読めなければ None。

    `json.loads` を全行に掛けない。子の記録は数MBあり、その大半は本文を持たない行
    （ツール結果の添付など）である（`budget.py` の `_tally()` と同じ理由）。
    """
    last = None
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if '"assistant"' not in line:
                    continue
                try:
                    msg = json.loads(line).get("message")
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                text = "".join(
                    c.get("text", "") for c in (msg.get("content") or [])
                    if isinstance(c, dict) and c.get("type") == "text")
                if text.strip():
                    last = text
    except OSError:
        return None
    return last


def settled_text(path, wait=SETTLE_WAIT_SEC, poll=SETTLE_POLL_SEC, sleep=time.sleep, clock=time.monotonic):
    """本文が現れるまで短く待って、子の最後の返答を返す。現れなければ None。

    `sleep` と `clock` を差し替えられるようにしてあるのは、テストが実際に
    待たずに「待つ挙動」そのものを確かめられるようにするためである。
    """
    text = last_assistant_text(path)
    if text:
        return text
    deadline = clock() + wait
    while clock() < deadline:
        sleep(poll)
        text = last_assistant_text(path)
        if text:
            return text
    return text


def judge(text):
    """(終了コード, 理由) を返す。`text` は子の最後の返答。"""
    if not text or not text.strip():
        return 0, ""

    rows = sum(1 for line in text.splitlines()
               if line.lstrip().startswith('{"') and len(line) >= ROW_MIN_CHARS)
    has_path = bool(ROWS_PATH.search(text))
    size = len(text)

    if rows >= 2:
        return 1, (
            f"返答に行そのものが載っています（JSONLらしき行 {rows}行・全体{size:,}文字）。\n"
            "\n"
            "  1. 行は `temp/rows-<担当範囲>.jsonl` に自分で書いてください（1行1件のJSONL）\n"
            "  2. 返答には**そのパスと件数だけ**を書いてください\n"
            "\n"
            "このままだと同じ行を3回払うことになります——あなたが返答に書き（出力）、"
            "親の文脈に入り（入力・以後**毎ターン再送**）、親が書き直す（出力）。"
            "ファイル経由なら1回で済みます。")

    if not has_path and size > LONG_CHARS:
        return 1, (
            f"返答が{size:,}文字あり、`temp/rows-*.jsonl` への参照がありません。\n"
            "\n"
            "調べた結果は `temp/rows-<担当範囲>.jsonl` に書き、返答には**パスと件数だけ**を"
            "書いてください。まだ書いていないなら、いま書いてから返答し直してください。\n"
            "1件も無かったのなら「0件」とだけ書けば十分です（理由の列挙は要りません）。")

    return 0, ""


def hook():
    """SubagentStop として呼ばれたときの入口。"""
    if (os.environ.get("CLAUDE_ROUTINE") or "0") != "1":
        return 0

    try:
        data = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    if not isinstance(data, dict):
        return 0

    # 2周目は黙って通す。同じ催促を繰り返すと連続ブロックの上限に当たるだけになる。
    if data.get("stop_hook_active"):
        return 0

    path = data.get("agent_transcript_path") or ""
    if not path:
        return 0

    text = settled_text(path)
    if not text:
        return 0

    rc, reason = judge(text)
    if rc == 1:
        print(reason, file=sys.stderr)
        return 2                                   # SubagentStop は exit 2 で続行させる
    return 0


def main():
    p = argparse.ArgumentParser(description="子の返答が「パスと件数だけ」かを見る")
    p.add_argument("--hook", action="store_true", help="SubagentStop の入口。JSONを標準入力で受ける")
    p.add_argument("--check", metavar="TRANSCRIPT", help="子の記録を指定して判定を確かめる")
    args = p.parse_args()

    if args.hook:
        return hook()
    if not args.check:
        p.error("--hook または --check を指定してください")

    text = settled_text(args.check)
    if not text:
        print(f"記録に本文がありません: {args.check}", file=sys.stderr)
        return 0
    rc, reason = judge(text)
    if reason:
        print(reason, file=sys.stderr)
    return rc


if __name__ == "__main__":
    sys.exit(main())
