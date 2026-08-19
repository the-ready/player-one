#!/bin/bash
#
# PreToolUse(Agent): 週次ルーチンの実行中、サブエージェントの**背景起動**を拒否する。
#
# 並行調査そのものは禁じない。7都県を分割して同時に調べるのは予算配分として
# 正しく、このタスクの調査能力を伸ばせる数少ない手段でもある。壊れたのは
# 起動の形のほうである。
#
# 2026-08-14 の events 収集は、4地域の調査を背景のサブエージェントに委ねた。
# 親セッションは結果を待たずに自分のターンを終えようとし、Stop フック
# （--init 直後の未完成CSVを検知）に止められて data/.prev/ から復元し、
# 「検証が通る状態に戻しました」で終了した。その約1秒後、ログに
#
#     Background tasks still running after 600s; terminating.
#
# が出ている。**4体ぶんの調査結果は、誰にも受け取られないまま破棄された。**
# 検索115回・取得154回・$3.65 を消費して、新規0件・変更0件である。
#
# 原因は「親が待てなかったこと」に尽きる。背景起動は、親に待つ義務を課さない
# ——待つかどうかがモデルの判断に委ねられ、判断を誤っても誰も気づけない。
# だから起動の形の側を塞ぐ。前景で起動すれば、結果が返るまで親のターンは
# 進まないので、**待ち忘れが原理的に起きない。**
#
# Agent ツールの既定は背景起動である。したがって「true のときだけ拒否」では
# 素通りする。**run_in_background に false が明示されていないものを拒否する。**
# 既定値に依存しない書き方を求めるのは冗長に見えるが、既定が変わったときに
# 黙って壊れるのはこの種のガードで最も起きやすい壊れ方である。
#
# 対話セッションでは発火させない。人が背景エージェントを使うのは当然で、
# 待つかどうかをその場で判断できる。見分けには claude-routine.sh が export する
# CLAUDE_ROUTINE を使う（block-git.sh と同じ）。
#
set -u

[ "${CLAUDE_ROUTINE:-0}" = "1" ] || exit 0

INPUT="$(cat)"

# 入力を読めなかったときは拒否側に倒す（block-git.sh と同じ判断）。
# 素通しは「待たれないサブエージェント」を通すことであり、それは
# このフックが唯一防いでいる事故そのものである。判定できないなら止める。
#
# jq の `//` は使えない。あれは左辺が false のときも右辺に落ちる演算子なので、
# `run_in_background: false`（＝まさに通したい入力）が「未指定」と同じ値になる。
# 有無は has() で見て、値は別に取り出す。
BG=""
if command -v jq >/dev/null 2>&1; then
  BG="$(printf '%s' "$INPUT" | jq -r '
        (.tool_input // {})
        | if has("run_in_background")
          then (.run_in_background | tostring)
          else "__ABSENT__" end')" \
    || BG="__PARSE_FAILED__"
elif command -v python3 >/dev/null 2>&1; then
  BG="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    v = json.load(sys.stdin).get("tool_input", {}).get("run_in_background", "__ABSENT__")
except Exception:
    print("__PARSE_FAILED__"); raise SystemExit(0)
print("__ABSENT__" if v == "__ABSENT__" else str(bool(v)).lower())' 2>/dev/null)" \
    || BG="__PARSE_FAILED__"
else
  BG="__PARSE_FAILED__"
fi

[ -n "$BG" ] || BG="__PARSE_FAILED__"

if [ "$BG" = "false" ]; then
  exit 0
fi

if [ "$BG" = "__PARSE_FAILED__" ]; then
  echo "フックの入力を解析できませんでした（jq / python3 が使えない可能性）。安全側に倒して Agent を拒否します。" >&2
  exit 2
fi

# reason は Claude へのフィードバックとしてそのまま戻る。何が駄目かだけでなく、
# 代わりに何を書けばよいかまで書く（＝直す動機と手順がこの中で完結する）。
cat >&2 <<'MSG'
週次ルーチンでは、サブエージェントを背景で起動できません。

  run_in_background: false を明示して起動し直してください。

並行調査そのものは禁止していません。禁止しているのは「親が待たない形」だけです。
背景で起動すると、親が先にターンを終えたときにサブエージェントは強制終了され、
調査結果はまるごと失われます（2026-08-14 に実際に起きました。検索115回を
消費して新規0件）。

あわせて、以下を守ってください。

  - サブエージェントは**調査のみ**を行い、data/ には書かない
  - 結果は JSONL（append_rows.py にそのまま渡せる形）で親に返す
  - **親が全ての結果を append_rows.py で書き終えるまで、ターンを終えない**
  - worktree 隔離（isolation: "worktree"）は不要です。サブエージェントは
    書き込まないので隔離する対象が無く、隔離すると名簿の更新も破棄されます
MSG
exit 2
