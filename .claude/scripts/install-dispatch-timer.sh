#!/bin/bash
#
# Raspberry Pi に「水木金 02:30 JST に週次収集を起動するタイマー」を入れる（docs/DESIGN.md 第13.7節）
#
#   sudo .claude/scripts/install-dispatch-timer.sh                  初回の導入（トークンを尋ねる）
#   sudo .claude/scripts/install-dispatch-timer.sh --rotate-token   トークンだけを差し替える
#
# 何度実行してもよい。dispatch-routine.sh やユニットを直したときも、これを実行し直せば反映される。
# トークンは標準入力から読む（画面には表示しない）。貼り付けたら Enter。
#
# 導入後の最後に `dispatch-routine.sh --check` で、トークンで実際にワークフローを読めるかを
# 確かめる（起動はしない）。ここで失敗したら、タイマーは入っていても 02:30 には起動できない。
#
# INSTALL_ROOT / SYSTEMCTL はテスト用（tools/dispatch_routine_test.py）。
#
set -u
set -o pipefail

ROOT="${INSTALL_ROOT:-}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_SCRIPT="$HERE/dispatch-routine.sh"
SRC_UNITS="$HERE/../systemd"
LIB_DIR="$ROOT/usr/local/lib/player-one"
UNIT_DIR="$ROOT/etc/systemd/system"
CONF_DIR="$ROOT/etc/player-one"
TOKEN_FILE="$CONF_DIR/dispatch-token"

ROTATE=0
case "${1:-}" in
  "") ;;
  --rotate-token) ROTATE=1 ;;
  *)
    echo "不明な引数: $1（--rotate-token のみ）" >&2
    exit 64
    ;;
esac

die() {
  echo "ERROR: $*" >&2
  exit 1
}

if [ -z "$ROOT" ] && [ "$(id -u)" != 0 ]; then
  die "root で実行してください（sudo $0）"
fi
for f in "$SRC_SCRIPT" "$SRC_UNITS/player-one-dispatch.service" "$SRC_UNITS/player-one-dispatch.timer"; do
  [ -r "$f" ] || die "見つかりません: $f（リポジトリの中から実行してください）"
done
command -v curl >/dev/null || die "curl がありません（sudo apt install curl）"
command -v python3 >/dev/null || die "python3 がありません"

# OnCalendar の時刻帯指定は 235 以降、LoadCredential は 247 以降でしか使えない
ver="$("$SYSTEMCTL" --version | awk 'NR==1{print $2}')"
case "$ver" in
  '' | *[!0-9]*) die "systemd の版を読めません（$ver）" ;;
esac
[ "$ver" -ge 247 ] || die "systemd $ver は古すぎます（247 以上が必要。Raspberry Pi OS bullseye 以降）"

install -d -m 0755 "$LIB_DIR" "$UNIT_DIR"
install -d -m 0700 "$CONF_DIR"
install -m 0755 "$SRC_SCRIPT" "$LIB_DIR/dispatch-routine.sh"
install -m 0644 "$SRC_UNITS/player-one-dispatch.service" "$SRC_UNITS/player-one-dispatch.timer" "$UNIT_DIR/"

if [ "$ROTATE" = 1 ] || [ ! -s "$TOKEN_FILE" ]; then
  printf 'GitHub のトークン（github_pat_…）を貼り付けて Enter: ' >&2
  IFS= read -rs token || true
  echo >&2
  token="$(printf '%s' "$token" | tr -d '[:space:]')"
  [ -n "$token" ] || die "トークンが空です。何も書き換えていません"
  (umask 077 && printf '%s\n' "$token" >"$TOKEN_FILE.new") && mv "$TOKEN_FILE.new" "$TOKEN_FILE"
  echo "トークンを $TOKEN_FILE に保存しました（root のみ読める）"
else
  echo "既存のトークンを使います（差し替えるときは --rotate-token）"
fi

"$SYSTEMCTL" daemon-reload
"$SYSTEMCTL" enable --now player-one-dispatch.timer

echo "--- トークンでワークフローを読めるかを確かめます（起動はしません）"
if ! DISPATCH_TOKEN_FILE="$TOKEN_FILE" "$LIB_DIR/dispatch-routine.sh" --check; then
  die "確認に失敗しました。トークンの権限（このリポジトリの Actions: Read and write）と期限を見直し、--rotate-token で入れ直してください"
fi

echo "--- 次の起動予定"
"$SYSTEMCTL" list-timers player-one-dispatch.timer --no-pager || true
