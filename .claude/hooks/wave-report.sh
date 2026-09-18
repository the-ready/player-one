#!/bin/bash
#
# PostToolUse(Agent): 波を受け取った直後に、残量と「最長の子◯ターン」を親に見せる。
#
# `docs/skill-feedback.md` の 2026-09-05 が要求している件である。
#
# > 指示文の「60ターン以下」は目安の記載のみでサブエージェント側に強制力がないため、
# > `budget.py` のターン数を `agent-guard.sh` 側で波の間に警告表示する
# > （次の波を投げる前に「前波の最長ターン数」を親に見せる）といった機械的な
# > 気づきの手段も有効かもしれない
#
# 起動の側（`agent-guard.sh`）には置けない。あちらが数字を見せられるのは**拒否した
# ときだけ**で、拒否は線を越えてからしか起きない——「次の波は小さく割ろう」と決める
# のに間に合わない。受け取った直後なら、次の分割を決める前に必ず目に入る。
#
# **止めない。** ここで止めても、既に回り終えた子のターン数は減らない。できるのは
# 次の波の分け方を変えることだけなので、伝えるだけでよい（`PostToolUse` は
# そもそも exit 2 で拒否できない）。
#
# 伝え方は `hookSpecificOutput.additionalContext` を使う。これはフックの出力を
# 会話に1メッセージとして挿す仕組みで、`PreToolUse` / `PostToolUse` の両方が
# 対応している（`cli.js` の `case"PostToolUse": _.additionalContext=...` を確認）。
# stdout に素で書くとユーザーのトランスクリプトに出るだけで、モデルには届かない。
#
# 対話セッションでは発火させない（他のフックと同じ理由）。
#
set -u

[ "${CLAUDE_ROUTINE:-0}" = "1" ] || exit 0

cat >/dev/null                      # 入力は使わないが、読み捨てないと書き込み側が詰まる

REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$REPO" ] && [ -f "$REPO/tools/budget.py" ] || exit 0

OUT="$(cd "$REPO" && python3 tools/budget.py --report 2>&1)" || exit 0
[ -n "$OUT" ] || exit 0

# `--report` は「文脈再送 未計測」だけを返すことがある（自分のセッションを同定
# できない瞬間。`budget.transcript_files()` の docstring）。そのときは何も伝えない
# ——中身の無い1行を毎波差し込むほうが、読む側の邪魔になる。
case "$OUT" in
  *未計測*) exit 0 ;;
esac

BODY="波を受け取りました。次の波を投げる前に、この数字で分け方を決めてください。

${OUT}

  - 「最長の子」が60ターンを超えていたら、次の波は担当範囲をさらに割ること
  - 線（25M／40M）に届いていないなら、波数をこなしたことを理由に畳まないこと"

if command -v jq >/dev/null 2>&1; then
  printf '%s' "$BODY" | jq -Rs '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: .}}' && exit 0
elif command -v python3 >/dev/null 2>&1; then
  printf '%s' "$BODY" | python3 -c 'import json,sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse",
                                         "additionalContext": sys.stdin.read()}}, ensure_ascii=False))' && exit 0
fi

# JSON を組み立てられなければ黙って抜ける。これは助言であって門ではないので、
# 伝えられないことを理由に何かを止める筋合いはない。
exit 0
