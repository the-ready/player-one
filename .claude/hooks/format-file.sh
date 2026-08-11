#!/bin/bash
#
# PostToolUse(Edit|Write): 編集したファイルを prettier で整形する。
#
# 以前はフックのコマンド欄に
#   jq -r '.tool_input.file_path' | xargs npx prettier --write
# と直接書いていた。これは prettier に parser が無い拡張子でも呼んでしまう。
# このリポジトリで最も頻繁に書き換わるのは data/*.csv と tools/*.py で、
# どちらも prettier は「No parser could be inferred」で落ちる。xargs はそれを
# exit 123 に変えるので、**CSVを1行書くたびにフックがエラーを返していた。**
# 週次収集はCSVを大量に書くため、ログが本物の異常を見分けられなくなる。
#
# 整形できる拡張子だけを通し、それ以外は黙って抜ける。
#
# prettier が失敗しても exit 0 を返す（＝編集は取り消さない）。整形器は後始末で
# あって、通らなかったことを理由に編集を無かったことにする筋合いはない。加えて
# prettier はローカルに無く npx がレジストリを引くので、ネットワークの調子で
# 編集がブロックされるのは割に合わない。理由は stderr に出す（トランスクリプトに
# 「hook error」として1行出るので、本当に失敗したときだけ目に入る）。
#
set -u

INPUT="$(cat)"
FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"

# file_path を持たないツールや、書き込み前に消えたファイルでは何もしない。
# 空のまま prettier に渡すと「対象ファイルなし」でまたエラーになる。
[ -n "$FILE" ] || exit 0
[ -f "$FILE" ] || exit 0

# prettier が標準で解釈できる拡張子のうち、このリポジトリに実在するものだけ。
# .csv .py .txt .sh は意図的に含めない（parser が無い）。
case "${FILE##*/}" in
  *.js | *.mjs | *.cjs | *.ts | *.mts | *.cts) ;;
  *.json | *.jsonc) ;;
  *.css | *.scss | *.html) ;;
  *.md | *.yml | *.yaml) ;;
  *) exit 0 ;;
esac

# --log-level warn で「整形しました」の1行を黙らせる（成功時は無音にする）。
# --yes は npx の「インストールしてよいか」の問い合わせを回避する。フックは
# 非対話シェルで動くので、聞かれた時点で固まるか失敗するかのどちらかになる。
if ! out="$(npx --yes prettier --log-level warn --write "$FILE" 2>&1)"; then
  printf 'prettier が失敗しました: %s\n' "$FILE" >&2
  [ -n "$out" ] && printf '%s\n' "$out" >&2
fi

exit 0
