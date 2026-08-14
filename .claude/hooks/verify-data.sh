#!/bin/bash
#
# Stop: ターンを終える前に data/ の後始末と検証を回し、落ちていたら終わらせない。
#
# claude-routine.sh も同じ3本を回すが、あれは「push してよいか」の門番である。
# 落ちた回は生成物を .claude/logs/failed/ に退避して data/ を巻き戻すので、
# **気づくのが遅すぎて、数時間かけた収集がまるごと捨てられる。**
#
# Stop フックは decision:"block" と理由を返すと、Claude に作業を続けさせられる。
# 同じ検証を「終わる前」に置けば、捨てる代わりにその場で直せる。
# purge_ended.py・validate_data.py・diff_data.py を合わせても1秒未満なので、
# 毎ターン回してよい。
#
# スクリプト側のゲートは残す。ここで直しきれなかったとき（Stop フックの連続
# ブロックは8回で打ち切られる）に、壊れたデータが push されないことを担保するのは
# 依然としてあちらである。こちらは「捨てずに済ませる」ための前段でしかない。
#
set -u

INPUT="$(cat)"

# 自分が原因で作業が続いている状態でさらにブロックすると、同じ検証を延々と
# 繰り返して 8回の上限に当たるだけになる。2周目からは黙って通す。
if [ "$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)" = "true" ]; then
  exit 0
fi

REPO_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$REPO_DIR" ] && [ -d "$REPO_DIR/data" ] || exit 0
cd "$REPO_DIR" || exit 0

IS_ROUTINE=0
[ "${CLAUDE_ROUTINE:-0}" = "1" ] && IS_ROUTINE=1

# 対話セッションでは data/ に手を入れた回だけ検証する。CSSだけ直した回に
# CSVの検証で足止めされるのは筋が通らないし、逆に data/ を触ったなら
# 「ERROR 0 であること」は CLAUDE.md が求める最低条件そのものである。
if [ "$IS_ROUTINE" -ne 1 ]; then
  [ -n "$(git status --porcelain -- data 2>/dev/null)" ] || exit 0
fi

PROBLEMS=""
add_problem() { PROBLEMS="${PROBLEMS}$1"$'\n'; }

# 終了日を過ぎた行を先に機械的に片付ける。終了日と今日を比べるだけの判断で、
# モデルの確認を要らないので、検証で落として直させるのではなくここで直接適用する
# （決定論的に守らせたい規則はフックに置く。設計書 第9.1.5節）。説明のない消滅を
# diff_data.py が拾わないよう、必ず下の検証より先に走らせる。
if ! out="$(python3 "tools/purge_ended.py" 2>&1)"; then
  add_problem "python3 tools/purge_ended.py が失敗しました:"$'\n'"$(printf '%s' "$out" | tail -c 3000)"
fi

# 「収集が途中で終わった」形——ヘッダーだけ・ファイルごと欠損・0バイト——は
# すべて validate_data.py が ERROR で落とす（「データ行がありません」「ファイルが
# ありません」）。ここで行数を別途数えても同じことを二度言うだけなので、数えない。
for tool in validate_data diff_data; do
  if out="$(python3 "tools/${tool}.py" 2>&1)"; then
    continue
  fi
  add_problem "python3 tools/${tool}.py が失敗しました:"$'\n'"$(printf '%s' "$out" | tail -c 3000)"
done

[ -n "$PROBLEMS" ] || exit 0

# decision:"block" の reason は Claude へのフィードバックとして戻り、そのまま
# 次に何をすべきかの指示になる。何が落ちたかだけでなく、直さずに終えると
# どうなるかまで書く（＝直す動機がフィードバックの中で完結する）。
{
  printf '%s\n' "終了前の検証が通っていません。以下を解消してから終えてください。"
  printf '\n%s\n' "$PROBLEMS"
  if [ "$IS_ROUTINE" -eq 1 ]; then
    printf '%s\n' "このまま終えると claude-routine.sh はコミットせず、data/ と docs/ を実行前の状態に戻します（今回の収集は失われます）。"
  fi
  printf '%s\n' "消滅の説明が要るなら tools/prev_rows.py --dispose を、行の追記・持ち越しは tools/append_rows.py を使ってください。"
} | jq -Rs '{decision: "block", reason: .}'

exit 0
