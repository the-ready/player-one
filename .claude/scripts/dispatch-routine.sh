#!/bin/bash
#
# weekly-collect.yml を workflow_dispatch で起動する（Raspberry Pi の systemd タイマーから呼ばれる）
#
#   dispatch-routine.sh           起動する（既定）
#   dispatch-routine.sh --check   トークンとワークフローの状態を確かめるだけで、起動はしない
#
# GitHub Actions の schedule には保証された発火時刻が無く、2026-09-22 の回は予定の
# 02:30 JST から2時間46分遅れて始まった。収集を時刻どおりに始めるため、正確な時計を持つ
# Pi 自身が API で起動を依頼する（docs/DESIGN.md 第13.3節）。ジョブはもともと Pi の上で
# 動くので、起動役を Pi に置いても「Pi が止まれば収集も止まる」という条件は変わらない。
#
# この回が起動できなかったときの代わりの起動役は居ない（予備の collect-fallback.yml は
# 2026-09-25 に廃止した。docs/DESIGN.md 第13.3節）。枠を1つ落とすとそのデータは翌週まで
# 更新されないので、失敗は人が気づいて手動で起動し直す前提である。再試行の上限は
# systemd の TimeoutStartSec（15分）に収まるよう決める。
#
# ============================================================
# 環境変数（すべて任意。テストと検証のためにある）
# ============================================================
#   DISPATCH_TOKEN_FILE     トークンのファイル（既定は systemd の LoadCredential が置く場所）
#   DISPATCH_REPO           既定 the-ready/player-one
#   DISPATCH_WORKFLOW       既定 weekly-collect.yml
#   DISPATCH_REF            既定 main
#   DISPATCH_RETRY_DELAYS   再試行までの待ち秒数（空白区切り。既定 "30 60 120 240"）
#   DISPATCH_CURL_MAX_TIME  1回の通信の上限秒数（既定 30）
#   GITHUB_API_URL          既定 https://api.github.com
#
# 終了コード: 0 起動した（または既に起動済み） / 1 設定の不備 / 2 GitHub が拒否した（再試行しても
# 直らない） / 3 通信の失敗が続いた / 64 引数の誤り
#
set -u
set -o pipefail

REPO="${DISPATCH_REPO:-the-ready/player-one}"
WORKFLOW="${DISPATCH_WORKFLOW:-weekly-collect.yml}"
REF="${DISPATCH_REF:-main}"
API="${GITHUB_API_URL:-https://api.github.com}"
API="${API%/}"
RETRY_DELAYS="${DISPATCH_RETRY_DELAYS-30 60 120 240}"
MAX_TIME="${DISPATCH_CURL_MAX_TIME:-30}"
if [ -n "${DISPATCH_TOKEN_FILE:-}" ]; then
  TOKEN_FILE="$DISPATCH_TOKEN_FILE"
elif [ -n "${CREDENTIALS_DIRECTORY:-}" ]; then
  TOKEN_FILE="$CREDENTIALS_DIRECTORY/dispatch-token"
else
  TOKEN_FILE="/etc/player-one/dispatch-token"
fi

MODE=dispatch
case "${1:-}" in
  "") ;;
  --check) MODE=check ;;
  -h | --help)
    sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "不明な引数: $1（--check / --help のみ）" >&2
    exit 64
    ;;
esac

log() { echo "[dispatch-routine] $*"; }

if [ ! -r "$TOKEN_FILE" ]; then
  log "ERROR: トークンのファイルを読めません: $TOKEN_FILE"
  exit 1
fi
TOKEN="$(tr -d '[:space:]' <"$TOKEN_FILE")"
if [ -z "$TOKEN" ]; then
  log "ERROR: トークンのファイルが空です: $TOKEN_FILE"
  exit 1
fi

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

# トークンは curl の引数に載せず、設定を標準入力から渡す。引数は /proc/<pid>/cmdline から
# 同じ機体の他ユーザーにも読めてしまうため。
# 出力: HTTP ステータス（通信自体に失敗したときは 000）。本文は $BODY_FILE に残る。
api() {
  local method="$1" url="$2" data="${3:-}"
  local args=(--silent --show-error --max-time "$MAX_TIME" --output "$BODY_FILE"
    --write-out '%{http_code}' --request "$method" --config -)
  [ -n "$data" ] && args+=(--data "$data")
  printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/vnd.github+json"\nheader = "X-GitHub-Api-Version: 2022-11-28"\nheader = "User-Agent: player-one-dispatch"\nurl = "%s"\n' \
    "$TOKEN" "$url" | curl "${args[@]}" 2>/dev/null || true
}

# 拒否されたときに、GitHub が返した理由だけを短く出す（本文にトークンは含まれない）
reason() {
  python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("message","")[:200])
except Exception: print(open(sys.argv[1],errors="replace").read(200))' "$BODY_FILE" 2>/dev/null
}

WF_URL="$API/repos/$REPO/actions/workflows/$WORKFLOW"

if [ "$MODE" = check ]; then
  code="$(api GET "$WF_URL")"
  if [ "$code" != 200 ]; then
    log "ERROR: ワークフローを読めません（HTTP $code）: $(reason)"
    [ "$code" = 000 ] && exit 3
    exit 2
  fi
  state="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("state",""))' "$BODY_FILE")"
  if [ "$state" != active ]; then
    log "ERROR: $WORKFLOW が有効ではありません（state=$state）"
    exit 2
  fi
  log "OK: $REPO の $WORKFLOW を読めました（state=active）。起動はしていません"
  exit 0
fi

# 起動の依頼が GitHub に届いたのに応答だけが失われた（タイムアウト・5xx）場合、そのまま
# 再送すると収集が2回走る。再試行の前に、この起動を始めてから作られた実行が既に無いかを見る。
# 時計のずれを見込んで開始の1分前から数える。
SINCE="$(date -u -d '-60 seconds' +%Y-%m-%dT%H:%M:%SZ)"
already_created() {
  local code count
  code="$(api GET "$WF_URL/runs?event=workflow_dispatch&per_page=1&created=%3E%3D$SINCE")"
  [ "$code" = 200 ] || return 1
  count="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("total_count",0))' "$BODY_FILE" 2>/dev/null)"
  [ "${count:-0}" -gt 0 ]
}

attempt=0
for delay in 0 $RETRY_DELAYS; do
  if [ "$attempt" -gt 0 ]; then
    log "${delay}秒後に再試行します"
    sleep "$delay"
    if already_created; then
      log "OK: 直前の依頼で実行が作られていました（再送はしません）"
      exit 0
    fi
  fi
  attempt=$((attempt + 1))
  code="$(api POST "$WF_URL/dispatches" "{\"ref\":\"$REF\"}")"
  case "$code" in
    2??)
      log "OK: $REPO の $WORKFLOW を ref=$REF で起動しました（HTTP $code・試行$attempt回目）"
      exit 0
      ;;
    000 | 429 | 5??)
      log "WARN: 起動に失敗しました（HTTP $code・試行$attempt回目）"
      ;;
    *)
      # 401/403/404/422 は設定の問題（トークン失効・権限不足・ワークフロー無効）で、
      # 待っても直らない。粘らずに落として、人に気づかせる。
      log "ERROR: GitHub が起動を拒否しました（HTTP $code）: $(reason)"
      exit 2
      ;;
  esac
done

log "ERROR: $attempt 回試みましたが起動できませんでした。この枠は落ちます（手動で weekly-collect.yml を起動してください）"
exit 3
