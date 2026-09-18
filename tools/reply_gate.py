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

# 返答の長さの線。契約どおりの返答（「temp/rows-tokyo-a.jsonl に32件書きました」）は
# 100文字前後で収まる。3,000文字は「文章で報告している」と言い切れる線である。
LONG_CHARS = 3_000

# JSONLらしき行とみなす最短の長さ。`{"uid": ...}` を1件だけ例示するような返答を
# 巻き込まないよう、2行以上あって初めて止める。
ROW_MIN_CHARS = 80

ROWS_PATH = re.compile(r"temp/rows-[\w.\-]+\.jsonl")


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

    text = last_assistant_text(path)
    if text is None:
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

    text = last_assistant_text(args.check)
    if text is None:
        print(f"記録を読めませんでした: {args.check}", file=sys.stderr)
        return 0
    rc, reason = judge(text)
    if reason:
        print(reason, file=sys.stderr)
    return rc


if __name__ == "__main__":
    sys.exit(main())
