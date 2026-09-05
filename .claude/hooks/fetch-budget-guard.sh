#!/bin/bash
#
# PreToolUse(WebSearch, Bash): 週次ルーチンの実行中、**波の途中でも**撤退の線
# （文脈再送40M）を越えた取得を止める。
#
# `agent-guard.sh` の予算ゲート（`budget.py --gate`）は `Agent` の起動、つまり
# 「次の波を投げる瞬間」にしか門を置けない。2026-09-04 の lives 収集は、
# **最初の波**（フェス調査・東京バッチA・東京バッチB）の中で1体が通信障害
# （DNS不通・SSL証明書不一致・タイムアウト）の連鎖で141ターンまで膨らみ、
# 「次の波」が一度も投げられないまま文脈再送39.4Mに達し、その数分後にアカウントの
# 利用上限で子・親とも強制終了された。次の波を止める門は、一度も開く機会が
# 無かった。
#
# 親が波の帰りを待って停止している間は割り込む手段が無いが、**動いている子自身が
# 取得のたびに通るツール呼び出し**なら話が違う。`fetch_page.py`（Bash 経由）と
# `WebSearch` は子から見ても「次の1回」なので、その呼び出し自体を門にすれば
# 次の波を待たずに撤退させられる（`tools/budget.py` の `gate_fetch()` を参照）。
#
# 対話セッションでは発火させない（agent-guard.sh・block-git.sh と同じ理由）。
#
set -u

[ "${CLAUDE_ROUTINE:-0}" = "1" ] || exit 0

MODE="${1:-}"

INPUT="$(cat)"

# 入力を読めなかったときは通す側に倒す。**このゲートが見ているのは自分の取りこぼし
# （撤退の線を越えて殺されること）であって、外部への迷惑ではない**——
# `wave_gate.py` / `budget.py --gate` と同じ倒し方（`fetch_gate.py` が逆に
# 倒しているのは、あちらが外部への迷惑を見ているため）。判定できないのに取得を
# 止めると、被害のほうが大きい。
if [ "$MODE" = "bash" ]; then
  CMD=""
  if command -v jq >/dev/null 2>&1; then
    CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')" || CMD=""
  elif command -v python3 >/dev/null 2>&1; then
    CMD="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get("tool_input", {}).get("command", "") or "")
except Exception:
    pass' 2>/dev/null)"
  fi
  # 取得ツール（fetch_page.py）を呼ぶ Bash だけを対象にする。それ以外の Bash
  # （temp/ への書き出し・append_rows.py・validate_data.py 等）まで止めると、
  # 波を書き切って終える手段そのものを塞いでしまう。
  case "$CMD" in
    *tools/fetch_page.py*) ;;
    *) exit 0 ;;
  esac
fi

GATE_REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$GATE_REPO" ] && [ -f "$GATE_REPO/tools/budget.py" ] || exit 0

GATE_OUT="$(python3 "$GATE_REPO/tools/budget.py" --gate-fetch 2>&1)"
GATE_RC=$?
if [ "$GATE_RC" -eq 1 ]; then
  printf '%s\n' "$GATE_OUT" >&2
  exit 2
fi
exit 0
