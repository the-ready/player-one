#!/bin/bash
#
# 失敗した週次収集回の、機械的な後始末だけを行うスクリプト。
# GitHub Actions の `.github/workflows/routine-repair.yml`（weekly-collect.yml の
# workflow_run、conclusion != success で発火）から、同じ self-hosted runner 上で呼ばれる。
#
# ============================================================
# このスクリプトがやること／やらないこと
# ============================================================
# self-hosted runner は非使い捨てで、checkout も clean:false にしてあるため、
# weekly-collect.yml が強制終了された回の作業ツリー（data/・temp/・.claude/logs/）が
# そのままこのジョブに残っている。artifact 経由で受け渡す必要が無いのはこのためである
# （docs/DESIGN.md 第13.4節）。
#
# ここでやるのは claude-routine.sh の終了工程（prev_rows --carry-rest・purge_ended・
# run_gate・validate_data・diff_data）をそのまま再実行することだけで、**Claude は
# 起動しない**。判断の要る処理（説明のない消滅の処分・renamed の判定など）はできないので、
# 機械的な検証を通せた場合だけ commit して push し、通せなければ生成物を退避して
# data/ docs/ を HEAD に戻し、Issue を起票して人に返す。
#
# data/ docs/ に未コミットの変更が最初から無い回（典型は認証切れ・0ツール呼び出しで
# 何も調べていない回）は、直すものが無いのでここでは何もしない。その種の異常は
# `.github/workflows/watchdog.yml` が「直近の成功実行が無い」で拾う——ここで毎回
# Issueを立てると、見張りの通知と二重になる。
#
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(git -C "$CLAUDE_DIR" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_DIR" ] || { echo "git リポジトリを特定できません（$CLAUDE_DIR）" >&2; exit 1; }
cd "$REPO_DIR" || exit 1

LOG_DIR="$CLAUDE_DIR/logs"
mkdir -p "$LOG_DIR" || { echo "ログディレクトリを作成できません: $LOG_DIR" >&2; exit 1; }
LOG_FILE="$LOG_DIR/repair_$(date '+%Y-%m-%d').log"

log() {
  local msg
  msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg"
  printf '%s\n' "$msg" >>"$LOG_FILE"
}
log_output() {
  local text="$1"
  [ -n "$text" ] || return 0
  echo "$text"
  printf '%s\n' "$text" >>"$LOG_FILE"
}

log "===== 修復スクリプト開始 ====="
log "対象の失敗実行: ${FAILED_RUN_NAME:-不明}（${FAILED_RUN_CONCLUSION:-不明}） ${FAILED_RUN_URL:-}"

CHANGED_BEFORE="$(git status --porcelain -- data docs)"
if [ -z "$CHANGED_BEFORE" ]; then
  log "data/ docs/ に未コミットの変更がありません。機械的に直すものが無いため終了します"
  log "===== 修復スクリプト終了（対象なし） ====="
  exit 0
fi
log "未コミットの変更を検出しました:"
log_output "$CHANGED_BEFORE"

run_check() {
  local desc="$1"
  shift
  local out rc
  out="$("$@" 2>&1)"
  rc=$?
  log_output "$out"
  if [ "$rc" -eq 0 ]; then
    log "OK: $desc"
  else
    log "ERROR: $desc が失敗しました (exit=$rc)"
  fi
  return "$rc"
}

VERIFY_OK=1

# 打ち切られた行の後始末（claude-routine.sh の同名工程と同じ判断基準）
for ds in events lives movies; do
  run_check "python3 tools/prev_rows.py $ds --carry-rest --apply" \
    python3 tools/prev_rows.py "$ds" --carry-rest --apply || VERIFY_OK=0
done
run_check "python3 tools/purge_ended.py" python3 tools/purge_ended.py || VERIFY_OK=0

run_gate_out="$(python3 tools/run_gate.py --check 2>&1)"
run_gate_rc=$?
log_output "$run_gate_out"
if [ "$run_gate_rc" -eq 1 ]; then
  VERIFY_OK=0
  log "ERROR: python3 tools/run_gate.py --check が失敗しました（調べていない回はコミットしません）"
else
  log "OK: python3 tools/run_gate.py --check"
fi

run_check "python3 tools/validate_data.py" python3 tools/validate_data.py || VERIFY_OK=0
run_check "python3 tools/diff_data.py" python3 tools/diff_data.py || VERIFY_OK=0

# GITHUB_TOKEN + REST API だけで完結させる。self-hosted runner に gh CLI が
# 入っている保証が無いため、Pi 側の追加インストールを前提にしない。
open_issue() {
  local title="$1" body="$2"
  if [ -z "${GITHUB_TOKEN:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ]; then
    log "WARNING: GITHUB_TOKEN/GITHUB_REPOSITORY が無いためIssueを起票できません"
    return 1
  fi
  GH_TITLE="$title" GH_BODY="$body" python3 <<'PY'
import json
import os
import urllib.request

repo = os.environ["GITHUB_REPOSITORY"]
token = os.environ["GITHUB_TOKEN"]
label = os.environ.get("REPAIR_ISSUE_LABEL", "routine-repair")

req = urllib.request.Request(
    f"https://api.github.com/repos/{repo}/issues",
    data=json.dumps(
        {
            "title": os.environ["GH_TITLE"],
            "body": os.environ["GH_BODY"],
            "labels": [label],
        }
    ).encode(),
    headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "player-one-routine-repair",
    },
    method="POST",
)
with urllib.request.urlopen(req, timeout=20) as resp:
    out = json.load(resp)
print(out.get("html_url", "(URL不明)"))
PY
}

if [ "$VERIFY_OK" -eq 1 ]; then
  log "検証を通りました。commit して push します"

  git add -A -- data docs
  staged="$(git diff --cached --name-only)"
  if [ -z "$staged" ]; then
    log "WARNING: コミットする変更がありませんでした（後始末だけで実質的な差分が消えた可能性があります）"
    log "===== 修復スクリプト終了（変更なし） ====="
    exit 0
  fi
  log "コミット対象:"
  log_output "$staged"

  name="$(git config user.name 2>/dev/null || true)"
  email="$(git config user.email 2>/dev/null || true)"
  git_id=()
  [ -z "$name" ] && git_id+=(-c "user.name=claude-routine-repair")
  [ -z "$email" ] && git_id+=(-c "user.email=claude-routine-repair@localhost")

  changed_csv="$(git diff --cached --name-only -- data | sed 's#.*/##' | tr '\n' ' ' | sed 's/ *$//')"
  msg="週次データ更新（自動修復） $(date '+%Y-%m-%d')"
  [ -n "$changed_csv" ] && msg="$msg（$changed_csv）"

  out="$(git "${git_id[@]}" commit -m "$msg" 2>&1)"
  rc=$?
  log_output "$out"
  if [ "$rc" -ne 0 ]; then
    log "ERROR: コミットに失敗しました (exit=$rc)"
    exit 1
  fi
  log "コミットしました: $msg"

  branch="$(git rev-parse --abbrev-ref HEAD)"
  attempt=1
  delay=2
  while :; do
    out="$(git push -u origin "$branch" 2>&1)"
    rc=$?
    log_output "$out"
    if [ "$rc" -eq 0 ]; then
      log "origin/$branch に push しました"
      break
    fi
    if [ "$attempt" -ge 4 ]; then
      log "ERROR: push に失敗しました（${attempt}回試行）。コミットはローカルに残っています"
      exit 1
    fi
    log "WARNING: push に失敗しました。${delay}秒後に再試行します（${attempt}/4）"
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done

  log "===== 修復スクリプト終了（修復・push 完了） ====="
  exit 0
fi

# ============================================================
# 直せなかった: 生成物を退避して HEAD に戻し、Issue を起票する
# （claude-routine.sh の quarantine_and_restore と同じ考え方）
# ============================================================
ts="$(date '+%Y%m%d-%H%M%S')"
stash_dir="$LOG_DIR/failed/$ts"
changed="$(git -c core.quotePath=false status --porcelain -- data docs | cut -c4-)"
if [ -n "$changed" ]; then
  mkdir -p "$stash_dir" || log "WARNING: 退避先を作成できません: $stash_dir"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$REPO_DIR/$f" ] || continue
    mkdir -p "$stash_dir/$(dirname "$f")"
    cp -p "$REPO_DIR/$f" "$stash_dir/$f" 2>>"$LOG_FILE"
  done <<<"$changed"
  log "検証を通らなかった生成物を $stash_dir に退避しました"
fi

if git checkout -- data docs 2>>"$LOG_FILE"; then
  log "data/ docs/ を HEAD の内容に戻しました"
else
  log "WARNING: data/ docs/ を HEAD に戻せませんでした。手動で確認してください"
fi

tail_log="$(tail -c 4000 "$LOG_FILE" 2>/dev/null)"
issue_body="$(
  cat <<EOF
週次収集（[失敗した実行](${FAILED_RUN_URL:-}) / conclusion=${FAILED_RUN_CONCLUSION:-不明}）が失敗し、
機械的な修復（\`prev_rows --carry-rest\` / \`purge_ended\` / \`run_gate\` / \`validate_data\` / \`diff_data\`）でも
検証を通せませんでした。生成物は Pi 上の \`.claude/logs/failed/${ts}/\` に退避し、
\`data/\` \`docs/\` は HEAD の内容へ戻しています（今回の分は push していません）。

判断の要る後始末（説明のない消滅の処分・表記ゆれの \`renamed\` 判定など）はこのワークフローの
対象外です。人が \`.claude/skills/weekly-routine/SKILL.md\` の手順に沿って対応してください。

直近のログ末尾（\`.claude/logs/repair_$(date '+%Y-%m-%d').log\`）:

\`\`\`
${tail_log}
\`\`\`

このワークフロー実行: ${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}
EOF
)"
issue_url="$(open_issue "週次収集の機械的修復に失敗しました（$(date '+%Y-%m-%d')）" "$issue_body")"
[ -n "$issue_url" ] && log "Issueを起票しました: $issue_url"

log "===== 修復スクリプト終了（修復失敗・Issue起票） ====="
exit 1
