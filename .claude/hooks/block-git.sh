#!/bin/bash
#
# PreToolUse(Bash): 週次ルーチンの実行中、Claude 自身による git の書き込みを拒否する。
#
# git の pull / commit / push は `.claude/scripts/claude-routine.sh` の責任で、
# 「検証を通った回だけ push する」というゲートはそこにしか無い。
# `.claude/routines/event.txt` はそれを散文で伝えているが、散文は守られないことが
# ある。守らせたい規則は仕組みに置く、という方針をここでも採る（DESIGN 第9.4節）。
#
# ルーチンは `--permission-mode bypassPermissions` で起動するため、settings.json の
# permissions.deny に頼ることはできない。PreToolUse フックの deny は**どの権限モードの
# 判定よりも先に**評価されるので、bypassPermissions でもツールを止められる。
# つまりこの形が、無人実行で確実に効く唯一の手段である。
#
# 対話セッションでは発火させない。人間が git を使うのは当然で、そちらまで止めると
# このリポジトリで普通の作業ができなくなる。見分けには claude-routine.sh が export
# する CLAUDE_ROUTINE を使う。フックのプロセスは claude プロセスの子なので、この
# 変数を継承している。
#
# matcher は "Bash" だけにして `if: "Bash(git *)"` は使っていない。`if` の
# コマンド解析はドキュメント上「ベストエフォート」で、解析できない書き方が
# 素通りしうる。素通りが即ち規則の穴になる用途なので、全 Bash 呼び出しを受けて
# 自前で判定する（ルーチン外なら下の1行で即座に抜けるので、費用はほぼ無い）。
#
set -u

[ "${CLAUDE_ROUTINE:-0}" = "1" ] || exit 0

CMD="$(jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$CMD" ] || exit 0

# 作業ツリーか origin を書き換えるサブコマンドだけを止める。
# status / log / diff / show / rev-parse のような読み取りは通す——現状を確認する
# こと自体は妨げる理由がないし、塞ぐと「何が起きているか分からない」報告になる。
SUB="$(printf '%s\n' "$CMD" | awk '
  BEGIN {
    split("add commit push pull fetch merge rebase reset checkout restore switch stash cherry-pick revert clean", b, " ")
    for (k in b) blocked[b[k]] = 1
  }
  {
    # `a && git push`、`(git commit)`、`x; git add` のいずれでも `git` を1語として
    # 取り出せるよう、シェルの区切り文字を空白に均してから語に割る。
    line = $0
    gsub(/[;&|()]/, " ", line)
    n = split(line, t, /[[:space:]]+/)
    for (i = 1; i <= n; i++) {
      if (t[i] != "git") continue
      for (j = i + 1; j <= n; j++) {
        # `git -C <path> commit` / `git -c k=v commit` の値を読み飛ばす
        if (t[j] == "-C" || t[j] == "-c" || t[j] == "--git-dir" || t[j] == "--work-tree") { j++; continue }
        if (substr(t[j], 1, 1) == "-") continue
        if (t[j] in blocked) { print t[j]; exit }
        break   # 読み取り系のサブコマンドだった
      }
    }
  }
')"

[ -n "$SUB" ] || exit 0

cat >&2 <<MSG
git ${SUB} は実行できません。git の操作は週次ルーチンのスクリプト
（.claude/scripts/claude-routine.sh）が行います。

  - 実行前の取り込みは、あなたが起動される前に済んでいます
  - commit と push は、validate_data.py と diff_data.py が**どちらも通ったときだけ**
    スクリプトが行います

あなたの仕事は data/ を更新し、検証を通る状態にして終了工程まで通し切ることです。
git には触らず、作業を続けてください。
MSG
exit 2
