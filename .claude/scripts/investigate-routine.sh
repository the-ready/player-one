#!/bin/bash
#
# 失敗した週次収集回の原因を Claude に調べさせ、小さく直せるものだけを main に push する。
# `.github/workflows/routine-investigate.yml`（weekly-collect.yml の失敗時に、その
# ジョブ自身から workflow_dispatch される）から、同じ self-hosted runner 上で呼ばれる。
#
# ============================================================
# routine-repair.sh との違い
# ============================================================
# repair は**機械的な後始末**だけを行い、Claude を起動しない（docs/DESIGN.md 第13.4節）。
# こちらは逆に Claude を起動して**原因を調べさせる**。両者は排他ではなく、repair が
# 直せなかった回の次の一手として位置づけている。
#
# ============================================================
# なぜ Claude に push させないのか
# ============================================================
# このリポジトリは「Claude が書き、スクリプトが検証して push する」という分業を既に
# 持っている（`.claude/routines/invariants.md` と `.claude/hooks/block-git.sh`）。
# 調査ルーチンでもその分業をそのまま使う。**main へ直接 push する以上、push してよいかの
# 判断を、判断を誤りうる側に置かない。**
#
# 差分は次の5つの関門を全部通ったときだけ push される。1つでも引っかかれば
# 「診断のみ」に落ちるだけで、実行そのものは正常終了する（既定が診断で、push が例外）。
#
#   1. 禁止パス   安全装置（フック・規則・ワークフロー・ゲート本体）に触れていないか
#   2. data/      収集の領分を書き換えていないか
#   3. 規模       3ファイル・80行を超えていないか
#   4. 弱体化     検査を消す・黙らせる方向の変更が混じっていないか
#   5. ゲート     tools/run_all_tests.py が全部通るか
#
# ============================================================
# 循環について
# ============================================================
# **このスクリプトは weekly-collect.yml を起動しない。** 起動すると
# 「調査 → push → 再収集 → 失敗 → 調査」が閉じた輪になる。再実行は水木金の定期回に
# 任せることで、利用上限の残量に頼らず、設計だけで輪を開いたままにしている。
#
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(git -C "$CLAUDE_DIR" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_DIR" ] || { echo "git リポジトリを特定できません（$CLAUDE_DIR）" >&2; exit 1; }
cd "$REPO_DIR" || exit 1

# ---- 関門の定数 ----------------------------------------------------------
# `.claude/routines/investigate-invariants.md` に散文で書いてある上限と同じ値。
# 片方だけ変えると規則と仕組みがずれるので、変えるときは両方を直すこと。
MAX_FILES="${INVESTIGATE_MAX_FILES:-3}"
MAX_LINES="${INVESTIGATE_MAX_LINES:-80}"

# 触られたら push しないパス。自分の拘束具を外せる位置にあるものを並べる。
FORBIDDEN_PREFIXES=(
  ".claude/hooks/"
  ".claude/routines/"
  ".github/workflows/"
  "tools/run_all_tests.py"
)

# 追加された行に現れたら push しない語。検査を消す・黙らせる方向の変更を止める。
WEAKENING_PATTERNS=(
  "continue-on-error"
  "--no-verify"
  "|| true"
  "pytest.mark.skip"
  "unittest.skip"
  "@skip"
  "xfail"
)

CLAUDE_BIN_OVERRIDE="${INVESTIGATE_CLAUDE_BIN:-}"
TIMEOUT_SEC="${INVESTIGATE_TIMEOUT_SEC:-3600}"
MODEL="${INVESTIGATE_MODEL:-}"
DO_PUSH="${INVESTIGATE_PUSH:-1}"
API="${GITHUB_API_URL:-https://api.github.com}"

INVARIANTS_FILE="$CLAUDE_DIR/routines/investigate-invariants.md"
SKILL_FILE="$CLAUDE_DIR/skills/routine-investigate/SKILL.md"

LOG_DIR="$CLAUDE_DIR/logs"
mkdir -p "$LOG_DIR" || { echo "ログディレクトリを作成できません: $LOG_DIR" >&2; exit 1; }
LOG_FILE="$LOG_DIR/investigate_$(date '+%Y-%m-%d').log"

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

# ---- 差分の取り出し ------------------------------------------------------
# 作業ツリーは前のジョブから引き継がれており、失敗した収集回が残した data/ の
# 書きかけがそのまま載っていることがある。**それを調査の成果と取り違えて
# コミットしないために**、起動前の汚れを基準線として控えておき、その差分だけを
# 候補にする。基準線に載っていたパスは、あとで Claude が触っていても候補にしない
# （安全側に倒す。取りこぼしても push しないだけで済む）。
dirty_paths() {
  # -uall が要る。既定の `git status --porcelain` は未追跡ファイルを
  # ディレクトリ1件に畳んで `?? tools/newdir/` のように報告するため、
  # **新しいディレクトリに何ファイル置かれても「1ファイル・0行」と数えられ、
  # 規模の関門をそのまま素通りしてしまう**（ディレクトリは `[ -f ]` が偽なので
  # 行数が 0 になる）。1件ずつ展開させて、数え落としを無くす。
  git -c core.quotePath=false status --porcelain -uall 2>/dev/null \
    | cut -c4- \
    | sed 's/.* -> //' \
    | sed '/^$/d'
}

# 基準線ファイルに載っていないパスだけを返す
candidate_paths() {
  local baseline="$1"
  local now
  now="$(dirty_paths)"
  [ -n "$now" ] || return 0
  if [ -s "$baseline" ]; then
    printf '%s\n' "$now" | grep -vxF -f "$baseline" || true
  else
    printf '%s\n' "$now"
  fi
}

# 1ファイルぶんの変更行数（追加＋削除）。未追跡の新規ファイルは全行を追加とみなす。
lines_for() {
  local p="$1"
  if git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
    git diff --numstat -- "$p" 2>/dev/null \
      | awk '{a+=$1; d+=$2} END {print (a+d)+0}'
  elif [ -f "$p" ]; then
    wc -l <"$p" 2>/dev/null | tr -d ' ' || echo 0
  else
    echo 0
  fi
}

# 候補の「追加された行」をまとめて出す（弱体化の判定に使う）
added_lines() {
  local p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
      git diff -U0 -- "$p" 2>/dev/null | grep '^+' | grep -v '^+++' || true
    elif [ -f "$p" ]; then
      sed 's/^/+/' "$p" 2>/dev/null || true
    fi
  done
}

# ---- 関門 ----------------------------------------------------------------
# 判定結果を BLOCK_REASONS に積む。空のまま戻れば push してよい。
BLOCK_REASONS=()

evaluate_guards() {
  local baseline="$1"
  local cands
  BLOCK_REASONS=()

  cands="$(candidate_paths "$baseline")"
  if [ -z "$cands" ]; then
    CHANGED_FILE_COUNT=0
    CHANGED_LINE_COUNT=0
    CANDIDATES=""
    return 0
  fi
  CANDIDATES="$cands"

  # 1. 禁止パス
  local p prefix
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    for prefix in "${FORBIDDEN_PREFIXES[@]}"; do
      case "$p" in
        "$prefix"*)
          BLOCK_REASONS+=("安全装置に触れています: $p（$prefix）")
          ;;
      esac
    done
  done <<<"$cands"

  # 2. data/
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$p" in
      data/*) BLOCK_REASONS+=("data/ を書き換えています: $p") ;;
    esac
  done <<<"$cands"

  # 3. 規模
  local n=0 total=0 l
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    n=$((n + 1))
    l="$(lines_for "$p")"
    [ -n "$l" ] || l=0
    total=$((total + l))
  done <<<"$cands"
  CHANGED_FILE_COUNT="$n"
  CHANGED_LINE_COUNT="$total"
  [ "$n" -le "$MAX_FILES" ] || BLOCK_REASONS+=("変更が${n}ファイルで、上限の${MAX_FILES}を超えています")
  [ "$total" -le "$MAX_LINES" ] || BLOCK_REASONS+=("変更が${total}行で、上限の${MAX_LINES}を超えています")

  # 4. 弱体化（テストの削除と、検査を黙らせる語の追加）
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$p" in
      *_test.py|*_test.mjs)
        [ -f "$p" ] || BLOCK_REASONS+=("テストを削除しています: $p")
        ;;
    esac
  done <<<"$cands"

  local adds pat
  adds="$(printf '%s\n' "$cands" | added_lines)"
  if [ -n "$adds" ]; then
    for pat in "${WEAKENING_PATTERNS[@]}"; do
      if printf '%s\n' "$adds" | grep -qF -- "$pat"; then
        BLOCK_REASONS+=("検査を弱める変更が含まれています: 「$pat」を追加しています")
      fi
    done
  fi

  return 0
}

# 5. ゲート。関門1〜4を通ったときだけ回す（落ちる差分にテスト時間を使わない）。
run_gate() {
  local out rc
  out="$(python3 tools/run_all_tests.py 2>&1)"
  rc=$?
  GATE_OUTPUT="$out"
  return "$rc"
}

# ---- 単独実行モード（テストと手元確認用） --------------------------------
# 本番と同じ判定をそのまま呼ぶ。判定を二重に書かないことが目的である。
if [ "${1:-}" = "--check-diff" ]; then
  BASELINE="${2:-/dev/null}"
  evaluate_guards "$BASELINE"
  echo "変更: ${CHANGED_FILE_COUNT}ファイル / ${CHANGED_LINE_COUNT}行"
  if [ "${#BLOCK_REASONS[@]}" -eq 0 ]; then
    echo "判定: push してよい"
    exit 0
  fi
  echo "判定: push しない"
  for r in "${BLOCK_REASONS[@]}"; do echo "  - $r"; done
  exit 1
fi

if [ "${1:-}" = "--help" ]; then
  cat <<'USAGE'
使い方:
  investigate-routine.sh                 失敗回を調べ、関門を全部通れば main に push する
  investigate-routine.sh --check-diff [基準線ファイル]
                                         いまの作業ツリーが関門を通るかだけを判定する
  investigate-routine.sh --help          この表示

主な環境変数:
  FAILED_RUN_URL / FAILED_RUN_CONCLUSION  調べる対象の実行
  INVESTIGATE_PUSH=0                      push を行わない（診断のみ）
  INVESTIGATE_TIMEOUT_SEC                 Claude の実行上限（既定 3600 秒）
  INVESTIGATE_MODEL                       使うモデル（未指定なら既定に任せる）
  INVESTIGATE_CLAUDE_BIN                  claude の実体を固定する
USAGE
  exit 0
fi

# ---- Issue 起票 ----------------------------------------------------------
# repair-routine.sh の同名関数と同じ作り（gh CLI を前提にしない）。
# 標準出力は URL だけに保つこと——呼び出し側が $() で拾うため、警告が混ざると
# 「Issueを起票しました: <警告文>」という偽の成功ログになる。
open_issue() {
  local title="$1" body="$2"
  if [ -z "${GITHUB_TOKEN:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ]; then
    echo "WARNING: GITHUB_TOKEN/GITHUB_REPOSITORY が無いためIssueを起票できません" >&2
    return 1
  fi
  GH_TITLE="$title" GH_BODY="$body" GH_API="$API" python3 <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

repo = os.environ["GITHUB_REPOSITORY"]
token = os.environ["GITHUB_TOKEN"]
api = os.environ.get("GH_API", "https://api.github.com").rstrip("/")
label = os.environ.get("INVESTIGATE_ISSUE_LABEL", "routine-investigate")

req = urllib.request.Request(
    f"{api}/repos/{repo}/issues",
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
        "Content-Type": "application/json",
        "User-Agent": "player-one-routine-investigate",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        out = json.load(resp)
except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
    print(f"Issue APIの呼び出しに失敗しました: {type(e).__name__}: {e}", file=sys.stderr)
    raise SystemExit(1)
print(out.get("html_url", "(URL不明)"))
PY
}

# ログや報告に混ざったトークンを伏せる。`.claude/logs/` には認証まわりの
# 文字列が載りうるので、Issue に貼る前に必ず通す。
redact() {
  sed -E \
    -e 's/gh[pousr]_[A-Za-z0-9]{16,}/***REDACTED***/g' \
    -e 's/github_pat_[A-Za-z0-9_]{16,}/***REDACTED***/g' \
    -e 's/sk-ant-[A-Za-z0-9_-]{16,}/***REDACTED***/g' \
    -e 's/(Authorization|Bearer)[[:space:]]*:?[[:space:]]*[A-Za-z0-9._-]{16,}/\1 ***REDACTED***/g'
}

# ---- ここから本番の流れ --------------------------------------------------
log "===== 調査スクリプト開始 ====="
log "対象の失敗実行: ${FAILED_RUN_NAME:-不明}（${FAILED_RUN_CONCLUSION:-不明}） ${FAILED_RUN_URL:-}"

# 1. Claude が起動できるかを先に見る。
#    収集が落ちる原因の上位は Claude 自身（トークン失効・利用上限）で、その回は
#    調査役の Claude も同じ理由で起動できない。--check-env は「在るか」ではなく
#    「動くか」を見るので、ここで切り分けて通知に降格させる。
CHECK_ENV_CMD=("$CLAUDE_DIR/scripts/claude-routine.sh" --check-env)
env_out=""
env_rc=0
if [ -n "$CLAUDE_BIN_OVERRIDE" ]; then
  env_out="$(ROUTINE_CLAUDE_BIN="$CLAUDE_BIN_OVERRIDE" "${CHECK_ENV_CMD[@]}" 2>&1)" || env_rc=$?
else
  env_out="$("${CHECK_ENV_CMD[@]}" 2>&1)" || env_rc=$?
fi
log_output "$env_out"

if [ "$env_rc" -ne 0 ]; then
  log "Claude を起動できません（--check-env が exit=$env_rc）。調査は行わず、通知だけ残します"
  body="$(
    cat <<EOF
週次収集（[失敗した実行](${FAILED_RUN_URL:-}) / conclusion=${FAILED_RUN_CONCLUSION:-不明}）が失敗しました。

原因を自動で調べようとしましたが、**Claude 自体が起動できないため調査を行えませんでした。**
収集が落ちる原因の上位は認証の失効と利用上限で、その場合は調査役も同じ理由で動きません。
以下の \`--check-env\` の出力を確認してください。

\`\`\`
$(printf '%s' "$env_out" | tail -c 3000 | redact)
\`\`\`

このワークフロー実行: ${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}
EOF
  )"
  url="$(open_issue "週次収集が失敗し、調査も起動できませんでした（$(date '+%Y-%m-%d')）" "$body" 2>>"$LOG_FILE")"
  if [ -n "$url" ]; then
    log "Issueを起票しました: $url"
  else
    log "WARNING: Issueの起票に失敗しました（直前の警告を参照）"
  fi
  log "===== 調査スクリプト終了（起動不能・通知のみ） ====="
  exit 0
fi
log "OK: Claude を起動できます"

# 2. 起動前の汚れを基準線として控える
BASELINE_FILE="$(mktemp)"
trap 'rm -f "$BASELINE_FILE"' EXIT
dirty_paths >"$BASELINE_FILE"
log "起動前の未コミット: $(wc -l <"$BASELINE_FILE" | tr -d ' ') 件（これらは調査の成果に数えません）"

# 3. Claude を起動する。
#    CLAUDE_ROUTINE ではなく CLAUDE_INVESTIGATE を立てる。read_gate / fetch_mix など
#    収集向けに調整された門を調査で発火させると、ソースやログを読む動作まで
#    拒まれてしまうため。git を止める block-git.sh だけは両方で効く。
export CLAUDE_INVESTIGATE=1

CLAUDE_BIN="$CLAUDE_BIN_OVERRIDE"
if [ -z "$CLAUDE_BIN" ]; then
  CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
fi
if [ -z "$CLAUDE_BIN" ]; then
  log "ERROR: claude コマンドが見つかりません（--check-env は通ったのに実体を解決できません）"
  exit 1
fi

CLAUDE_CMD=("$CLAUDE_BIN")
if command -v timeout >/dev/null 2>&1; then
  CLAUDE_CMD=(timeout -k 60 "$TIMEOUT_SEC" "$CLAUDE_BIN")
else
  log "WARNING: timeout コマンドが無いため、実行時間の上限を設定できません"
fi

MODEL_ARGS=()
[ -n "$MODEL" ] && MODEL_ARGS=(--model "$MODEL")

[ -f "$INVARIANTS_FILE" ] || { log "ERROR: 不変規則が見つかりません: $INVARIANTS_FILE"; exit 1; }
[ -f "$SKILL_FILE" ] || { log "ERROR: 手順スキルが見つかりません: $SKILL_FILE"; exit 1; }

log "Claude Code を起動します（上限 ${TIMEOUT_SEC} 秒）"
REPORT=""
claude_rc=0
REPORT="$("${CLAUDE_CMD[@]}" -p "/routine-investigate" \
  ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} \
  --append-system-prompt-file "$INVARIANTS_FILE" \
  --permission-mode bypassPermissions \
  2>>"$LOG_FILE")" || claude_rc=$?
log "Claude Code が終了しました（exit=$claude_rc）"
printf '%s\n' "$REPORT" >>"$LOG_FILE"

# 4. 関門にかける
evaluate_guards "$BASELINE_FILE"
log "調査による変更: ${CHANGED_FILE_COUNT}ファイル / ${CHANGED_LINE_COUNT}行"
[ -n "${CANDIDATES:-}" ] && log_output "$CANDIDATES"

PUSHED=0
GATE_OUTPUT=""
PUSH_NOTE=""

if [ "$CHANGED_FILE_COUNT" -eq 0 ]; then
  PUSH_NOTE="変更はありません（診断のみ）。"
  log "変更がないため、診断のみで終わります"
elif [ "${#BLOCK_REASONS[@]}" -ne 0 ]; then
  PUSH_NOTE="次の理由で push していません:"
  for r in "${BLOCK_REASONS[@]}"; do PUSH_NOTE="$PUSH_NOTE"$'\n'"- $r"; done
  log "関門に引っかかりました。push しません"
  for r in "${BLOCK_REASONS[@]}"; do log "  - $r"; done
elif ! run_gate; then
  PUSH_NOTE="\`tools/run_all_tests.py\` が通らなかったため push していません。"
  log "ゲートが通りませんでした。push しません"
  log_output "$GATE_OUTPUT"
elif [ "$DO_PUSH" != "1" ]; then
  PUSH_NOTE="INVESTIGATE_PUSH=0 のため push していません（関門とゲートは通っています）。"
  log "関門とゲートは通りましたが、INVESTIGATE_PUSH=0 のため push しません"
else
  log "関門とゲートを通りました。commit して push します"
  # 候補だけを明示的に stage する。`git add -A` にすると、基準線に載っていた
  # 収集の書きかけまで巻き込む。
  add_failed=0
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    git add -- "$p" 2>>"$LOG_FILE" || add_failed=1
  done <<<"$CANDIDATES"
  staged="$(git diff --cached --name-only)"
  if [ "$add_failed" -ne 0 ] || [ -z "$staged" ]; then
    PUSH_NOTE="stage に失敗したため push していません。"
    log "ERROR: stage に失敗しました"
  else
    name="$(git config user.name 2>/dev/null || true)"
    email="$(git config user.email 2>/dev/null || true)"
    git_id=()
    [ -z "$name" ] && git_id+=(-c "user.name=claude-routine-investigate")
    [ -z "$email" ] && git_id+=(-c "user.email=claude-routine-investigate@localhost")

    msg="週次収集の失敗を自動調査して修正（$(date '+%Y-%m-%d')）"
    out="$(git "${git_id[@]+${git_id[@]}}" commit -m "$msg" 2>&1)"
    rc=$?
    log_output "$out"
    if [ "$rc" -ne 0 ]; then
      PUSH_NOTE="コミットに失敗したため push していません。"
      log "ERROR: コミットに失敗しました (exit=$rc)"
    else
      branch="$(git rev-parse --abbrev-ref HEAD)"
      attempt=1
      delay=2
      while :; do
        out="$(git push -u origin "$branch" 2>&1)"
        rc=$?
        log_output "$out"
        if [ "$rc" -eq 0 ]; then
          PUSHED=1
          PUSH_NOTE="関門とゲートを通ったため、\`$branch\` に push しました。"
          log "origin/$branch に push しました"
          break
        fi
        if [ "$attempt" -ge 4 ]; then
          PUSH_NOTE="push に4回失敗しました。コミットは Pi 上にローカルで残っています。"
          log "ERROR: push に失敗しました（${attempt}回試行）"
          break
        fi
        log "WARNING: push に失敗しました。${delay}秒後に再試行します（${attempt}/4）"
        sleep "$delay"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
      done
    fi
  fi
fi

# 5. push の有無によらず、必ず報告を残す
gate_section=""
[ -n "$GATE_OUTPUT" ] && gate_section="$(
  printf '\n### ゲートの出力\n\n```\n%s\n```\n' "$(printf '%s' "$GATE_OUTPUT" | tail -c 3000)"
)"

issue_body="$(
  cat <<EOF
週次収集（[失敗した実行](${FAILED_RUN_URL:-}) / conclusion=${FAILED_RUN_CONCLUSION:-不明}）が失敗したため、
自動で原因を調べました。

**結果**: ${PUSH_NOTE}

変更の規模: ${CHANGED_FILE_COUNT}ファイル / ${CHANGED_LINE_COUNT}行（上限 ${MAX_FILES}ファイル・${MAX_LINES}行）
${gate_section}

---

$(printf '%s' "$REPORT" | tail -c 8000 | redact)

---

このワークフロー実行: ${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}
EOF
)"

if [ "$PUSHED" -eq 1 ]; then
  title="週次収集の失敗を自動修正しました（$(date '+%Y-%m-%d')）"
else
  title="週次収集が失敗しました（$(date '+%Y-%m-%d')）"
fi

issue_url="$(open_issue "$title" "$issue_body" 2>>"$LOG_FILE")"
if [ -n "$issue_url" ]; then
  log "Issueを起票しました: $issue_url"
else
  log "WARNING: Issueの起票に失敗しました（直前の警告を参照）"
fi

log "===== 調査スクリプト終了（push=${PUSHED}） ====="
exit 0
