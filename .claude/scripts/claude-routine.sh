#!/bin/bash
#
# 週次データ収集ルーチンの起動スクリプト（cron から呼ばれる想定）
#
#   .claude/scripts/claude-routine.sh [--no-push] [--help]
#
# ============================================================
# このスクリプトが責任を持つこと
# ============================================================
#   1. 多重起動の防止（ロック）
#   2. 実行前に origin から最新を取り込む（git fetch + fast-forward マージ）
#   3. Claude Code を起動し、.claude/routines/event.txt の手順を実行させる
#   4. 生成物の検証（validate_data.py / diff_data.py の終了コード）
#   5. **検証を通ったときだけ** commit して push する
#   6. 検証を通らなかったときは生成物を logs/failed/ に退避し、data/ を HEAD に戻す
#
# 「最初に git pull、最後に git push」という手順は、以前は
# .claude/routines/event.txt に書かれていた（＝Claude 自身にやらせていた）。
# これには2つの弱点があった。
#
#   - Claude の実行が途中で終わると、pull も push も実行されない
#   - 検証に失敗したデータでも、Claude が push まで進めてしまう余地があった
#
# そこで git 操作をスクリプトの責任に移し、push を検証の後段に置いてある。
# 「壊れたデータは push されない」ことを、指示文でのお願いではなく仕組みで担保する。
#
# 6 の巻き戻しは、次回の実行を守るためのものである。append_rows.py --init は
# 実行時点の data/*.csv を「前回分」として data/.prev/ に退避するので、
# 中断で切り詰められたCSVを置いたままにすると、翌週それが前回分として扱われ、
# 「静かな欠落」の検知が丸ごと機能しなくなる。
#
# ============================================================
# 環境変数（すべて任意）
# ============================================================
#   ROUTINE_TIMEOUT_SEC  Claude 実行の上限秒数（既定 21600 = 6時間）
#   ROUTINE_GIT_RETRY    fetch / push の試行回数（既定 4。2,4,8秒…と待つ）
#   ROUTINE_BRANCH       push 先ブランチ（既定は現在のブランチ）
#   ROUTINE_PUSH         0 にすると commit までで push しない
#
set -u
set -o pipefail

# ============================================================
# 引数
# ============================================================
usage() {
  cat <<'USAGE'
使い方: claude-routine.sh [オプション]

  --no-push   コミットまで行い、push はしない
  --help      このヘルプを表示する

環境変数:
  ROUTINE_TIMEOUT_SEC  Claude 実行の上限秒数（既定 21600）
  ROUTINE_GIT_RETRY    fetch / push の試行回数（既定 4）
  ROUTINE_BRANCH       push 先ブランチ（既定は現在のブランチ）
  ROUTINE_PUSH         0 で push を行わない
USAGE
}

ROUTINE_TIMEOUT_SEC="${ROUTINE_TIMEOUT_SEC:-21600}"
ROUTINE_GIT_RETRY="${ROUTINE_GIT_RETRY:-4}"
ROUTINE_BRANCH="${ROUTINE_BRANCH:-}"
ROUTINE_PUSH="${ROUTINE_PUSH:-1}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-push) ROUTINE_PUSH=0 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "不明なオプション: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

case "$ROUTINE_TIMEOUT_SEC" in
  ''|*[!0-9]*) echo "ROUTINE_TIMEOUT_SEC は秒数（整数）で指定してください: $ROUTINE_TIMEOUT_SEC" >&2; exit 2 ;;
esac
case "$ROUTINE_GIT_RETRY" in
  ''|*[!0-9]*) echo "ROUTINE_GIT_RETRY は整数で指定してください: $ROUTINE_GIT_RETRY" >&2; exit 2 ;;
esac
[ "$ROUTINE_GIT_RETRY" -lt 1 ] && ROUTINE_GIT_RETRY=1

# ============================================================
# パスの解決
#
# cron はカレントディレクトリを $HOME にして実行するため、pwd では自分の
# 置き場所が分からない。dirname "${BASH_SOURCE[0]}" で自身のパスを取り、
# cd ... && pwd で絶対パスに解決する。
#
# 以前はここで求めた .claude ディレクトリを PROJECT_DIR と呼び、そのまま
# 作業ディレクトリとして Claude に渡していた。しかし手順の中で使う
# `python3 tools/...` や `data/` はリポジトリのルートからの相対パスなので、
# .claude を作業ディレクトリにすると解決できない。ルートを別に持つ。
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROUTINE_FILE="$CLAUDE_DIR/routines/event.txt"

# ログは .claude/logs/ に日付別で保存する（.gitignore の `logs` が効く）。
# 同じ日に複数回実行された場合は同じファイルに追記される。
LOG_DIR="$CLAUDE_DIR/logs"
mkdir -p "$LOG_DIR" || { echo "ログディレクトリを作成できません: $LOG_DIR" >&2; exit 1; }
LOG_FILE="$LOG_DIR/routine_$(date '+%Y-%m-%d').log"

log() {
  local msg
  msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  printf '%s\n' "$msg" >> "$LOG_FILE"
  if [ -t 1 ]; then
    printf '%s\n' "$msg"
  fi
  return 0
}

# 標準出力・標準エラーをそのままログへ流したいコマンド用
log_output() {
  local text="$1"
  if [ -n "$text" ]; then
    printf '%s\n' "$text" >> "$LOG_FILE"
  fi
  return 0
}

die() {
  log "ERROR: $*"
  log "===== スクリプト異常終了 ====="
  exit 1
}

# ============================================================
# ロック（多重起動の防止）
#
# 収集は数時間かかることがあり、前回の実行が終わらないうちに次の cron が
# 発火すると、同じCSVを2つのセッションが同時に書くことになる。
# mkdir は「存在したら失敗する」原子的な操作なので、これをロックに使う。
# ============================================================
LOCK_DIR="$LOG_DIR/.routine.lock"
LOCK_HELD=0

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_HELD=1
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  local pid=""
  [ -f "$LOCK_DIR/pid" ] && pid="$(cat "$LOCK_DIR/pid" 2>/dev/null)"

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    return 1   # 本当に実行中
  fi

  # プロセスが居ない＝前回の実行が異常終了して残ったロック
  log "WARNING: 残存ロックを回収します（pid=${pid:-不明}）"
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_HELD=1
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi
  return 1
}

RUN_STATE=""

cleanup() {
  if [ "$LOCK_HELD" -eq 1 ]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null
    LOCK_HELD=0
  fi
  if [ -n "$RUN_STATE" ] && [ -d "$RUN_STATE" ]; then
    rm -rf "$RUN_STATE"
    RUN_STATE=""
  fi
}
trap cleanup EXIT
trap 'log "WARNING: シグナルを受け取ったため中断します"; exit 130' INT TERM

log "===== スクリプト開始 ====="
log "SCRIPT_DIR = $SCRIPT_DIR"
log "CLAUDE_DIR = $CLAUDE_DIR"
log "LOG_FILE   = $LOG_FILE"

if ! acquire_lock; then
  log "別の実行が進行中のため、今回はスキップします（$LOCK_DIR）"
  log "===== スクリプト終了（スキップ） ====="
  exit 0
fi

# ============================================================
# git 認証を対話セッションから分離する
#
# このスクリプトは手動起動でも cron でも同じように動く必要があるが、
# 手動起動の場合は VS Code の統合ターミナルなどから叩かれることがあり、
# その環境変数（GIT_ASKPASS / VSCODE_GIT_ASKPASS_*）を引き継いでしまう。
# これらは対話セッション（エディタのウィンドウ）に紐づく IPC ソケット
# 経由で git の認証を仲介する仕組みで、そのソケットはウィンドウの
# 再接続などで入れ替わる。
#
# 収集処理は数時間かかることがあり、起動時に有効だったソケットが
# push する頃には失効している——というタイミング依存の失敗が実際に
# 起きた（2026-08-07: push が "Missing or invalid credentials" で
# 認証失敗し、13時間分の収集がpushできず終わった）。
#
# 無人実行は起動元のセッションの生死に依存すべきではないので、
# それらの環境変数は明示的に外し、認証まわりで git がプロンプトに
# 固まらないよう GIT_TERMINAL_PROMPT=0 にしておく。
# credential.helper（storeやSSH鍵ベースの設定）自体はここでは触らない。
# ============================================================
unset GIT_ASKPASS SSH_ASKPASS
unset VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_EXTRA_ARGS VSCODE_GIT_ASKPASS_MAIN VSCODE_GIT_IPC_HANDLE
export GIT_TERMINAL_PROMPT=0

# ============================================================
# 実行環境の確認
# ============================================================
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

for cmd in claude jq git python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "$cmd コマンドが見つかりません（cron から実行する場合、PATH が対話シェルと違う点に注意）"
  fi
done

[ -f "$ROUTINE_FILE" ] || die "手順ファイルが見つかりません: $ROUTINE_FILE"
log "手順ファイルを確認しました: $ROUTINE_FILE"

# リポジトリのルート。.claude が別の場所へ移されても追随できるよう git に聞く
REPO_DIR="$(git -C "$CLAUDE_DIR" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_DIR" ] || die "git リポジトリを特定できません（$CLAUDE_DIR）"
log "REPO_DIR   = $REPO_DIR"

cd "$REPO_DIR" || die "リポジトリのルートに移動できません: $REPO_DIR"

for f in tools/validate_data.py tools/diff_data.py; do
  [ -f "$REPO_DIR/$f" ] || die "検証スクリプトが見つかりません: $f"
done

# ============================================================
# git ヘルパ
# ============================================================
git_q() {
  # 出力をログに流しつつ git を実行する。終了コードをそのまま返す
  local out rc
  out="$(git -C "$REPO_DIR" "$@" 2>&1)"
  rc=$?
  log_output "$out"
  return "$rc"
}

git_retry() {
  # git_retry <説明> <git の引数...>  ネットワーク越しの操作を指数バックオフで再試行する
  local desc="$1"; shift
  local attempt=1 delay=2 rc=0
  while :; do
    if git_q "$@"; then
      return 0
    fi
    rc=$?
    if [ "$attempt" -ge "$ROUTINE_GIT_RETRY" ]; then
      log "ERROR: ${desc}に失敗しました（${attempt}回試行, exit=$rc）"
      return "$rc"
    fi
    log "WARNING: ${desc}に失敗しました（exit=$rc）。${delay}秒後に再試行します（${attempt}/${ROUTINE_GIT_RETRY}）"
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

# ---- ブランチの決定 ----
if [ -n "$ROUTINE_BRANCH" ]; then
  BRANCH="$ROUTINE_BRANCH"
else
  BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
fi
[ -n "$BRANCH" ] || die "ブランチ名を取得できません"
[ "$BRANCH" = "HEAD" ] && die "detached HEAD です。ブランチをチェックアウトしてから実行してください"
log "BRANCH     = $BRANCH"

git -C "$REPO_DIR" remote get-url origin >/dev/null 2>&1 || die "リモート origin が設定されていません"

# ============================================================
# 実行前の同期（旧: 手順ファイルの「1. git pull」）
#
# pull（fetch + merge）ではなく fetch + `merge --ff-only` を使う。
# 自動実行の中でマージコミットが増えてほしくないためである。
# ローカルが origin より進んでいるだけ（前回 push に失敗した等）の場合、
# --ff-only は "Already up to date" として成功するので、翌週も自然に回復する。
# 本当に分岐しているときだけ rebase を1回試し、競合したら abort して中断する
# （自動実行の中で競合を解決させない、というのがここでの線引き）。
# ============================================================
sync_with_origin() {
  # fetch してから origin/$BRANCH に追いつく。
  #   1. 早送りできるならそれで終わり（マージコミットを作らない）
  #   2. 分岐していたら rebase を1回だけ試す（前回 push できなかったコミットが
  #      手元に残っている、というのが現実的に一番多い分岐の原因）
  #   3. 競合したら abort して失敗を返す。自動実行の中で競合の解決はしない
  git_retry "origin/$BRANCH の取得" fetch --prune origin "$BRANCH" || return 1

  if git_q merge --ff-only "origin/$BRANCH"; then
    return 0
  fi

  log "WARNING: origin/$BRANCH に早送りできません。rebase を試します"
  if git_q rebase "origin/$BRANCH"; then
    log "origin/$BRANCH の上に rebase しました"
    return 0
  fi

  log "ERROR: rebase に失敗しました（競合、または作業ツリーが汚れています）。中断します"
  git_q rebase --abort
  return 1
}

DIRTY_BEFORE="$(git -C "$REPO_DIR" status --porcelain)"
if [ -n "$DIRTY_BEFORE" ]; then
  log "WARNING: 実行前の作業ツリーに未コミットの変更があります:"
  log_output "$DIRTY_BEFORE"
fi

log "origin/$BRANCH を取得します"
sync_with_origin \
  || die "origin/$BRANCH に追いつけませんでした。ネットワーク・認証、または競合を手動で確認してください"
log "最新の origin/$BRANCH を取り込みました（$(git -C "$REPO_DIR" rev-parse --short HEAD)）"

# ============================================================
# push 権限の事前確認（fail fast）
#
# Claude Code の実行（収集処理）は数時間かかることがある。push できない
# 状態（認証切れ・書き込み権限なし等）に気づくのが最後の push 直前だと、
# その数時間がまるごと無駄になる（2026-08-07 に実際に起きた）。
#
# `git push --dry-run` は実際には何も送らないが、リモートに接続して
# 認証・書き込み権限までは検証する。ここで弾いておけば、収集処理に
# 入る前の数秒で気づける。
# ============================================================
if [ "$ROUTINE_PUSH" = "1" ]; then
  log "push 権限を事前確認します（--dry-run）"
  git_retry "push 権限の事前確認" push --dry-run origin "$BRANCH" \
    || die "push 権限の事前確認に失敗しました。credential.helper / SSH鍵 / トークンの有効期限を確認してください（収集処理は実行せずに中断します）"
else
  log "ROUTINE_PUSH=0 のため push 権限の事前確認はスキップします"
fi

# ============================================================
# Claude Code の実行
#
# --output-format stream-json で受け取り、1行(=1イベント)ずつ jq で解析して
# ログに残す。これにより「今どのツールを実行しているか」「何を読み書きしたか」
# 「最終的に何を返したか」が逐一わかる。
#
# while ループはパイプの右側＝サブシェルなので、そこで立てた変数は親に返らない。
# 最終結果（result イベントの subtype）は一時ディレクトリのファイル経由で受け取る。
# ============================================================
RUN_STATE="$(mktemp -d "$LOG_DIR/.run.XXXXXX")" || die "一時ディレクトリを作成できません"

PROMPT="作業ディレクトリは ${REPO_DIR} です。まずこのディレクトリに移動し、${ROUTINE_FILE} を読み込んで、その指示に従って作業を最後まで実行してください。git の pull / commit / push はこのスクリプトが行うので、あなたは git 操作を行わないでください。"

# ============================================================
# フックに「これは無人のルーチンである」と伝える
#
# .claude/hooks/ の2本は、対話セッションとルーチンで振る舞いを変える必要がある。
#   - block-git.sh   : ルーチン中だけ git の書き込みを拒否する（人の git は妨げない）
#   - verify-data.sh : ルーチンでは終了前の検証を必ず回す
# フックのプロセスは claude プロセスの子なので、ここで export すれば届く。
#
# 直前の PROMPT の文言と役割が重なるが、片方は「お願い」、こちらは「仕組み」である。
# ルーチンは bypassPermissions で走るので、permissions.deny では止められない。
# ============================================================
export CLAUDE_ROUTINE=1

CLAUDE_CMD=(claude)
if command -v timeout >/dev/null 2>&1; then
  # 応答しなくなったセッションがロックを抱えたまま居座るのを防ぐ
  CLAUDE_CMD=(timeout -k 60 "$ROUTINE_TIMEOUT_SEC" claude)
else
  log "WARNING: timeout コマンドが無いため、実行時間の上限を設定できません"
fi

log "Claude Code を起動します（上限 ${ROUTINE_TIMEOUT_SEC} 秒）"

"${CLAUDE_CMD[@]}" -p "$PROMPT" \
  --permission-mode bypassPermissions \
  --output-format stream-json \
  --verbose \
  2>> "$LOG_FILE" \
  | while IFS= read -r line; do
      ts="$(date '+%Y-%m-%d %H:%M:%S')"
      type=$(printf '%s' "$line" | jq -r '.type // empty' 2>/dev/null)

      case "$type" in
        system)
          subtype=$(printf '%s' "$line" | jq -r '.subtype // empty' 2>/dev/null)
          echo "[$ts] [SYSTEM:$subtype] セッション開始" >> "$LOG_FILE"
          ;;
        assistant)
          printf '%s' "$line" | jq -c '.message.content[]?' 2>/dev/null | while IFS= read -r block; do
            btype=$(printf '%s' "$block" | jq -r '.type // empty' 2>/dev/null)
            if [ "$btype" = "tool_use" ]; then
              name=$(printf '%s' "$block" | jq -r '.name // empty' 2>/dev/null)
              input=$(printf '%s' "$block" | jq -c '.input' 2>/dev/null | head -c 300)
              echo "[$ts] [TOOL] ${name} ${input}" >> "$LOG_FILE"
            elif [ "$btype" = "text" ]; then
              text=$(printf '%s' "$block" | jq -r '.text // empty' 2>/dev/null)
              echo "[$ts] [CLAUDE] ${text}" >> "$LOG_FILE"
            fi
          done
          ;;
        user)
          printf '%s' "$line" | jq -c '.message.content[]?' 2>/dev/null | while IFS= read -r block; do
            btype=$(printf '%s' "$block" | jq -r '.type // empty' 2>/dev/null)
            if [ "$btype" = "tool_result" ]; then
              content=$(printf '%s' "$block" | jq -r 'if (.content|type)=="array" then (.content[0].text // "") else (.content // "") end' 2>/dev/null | head -c 300)
              echo "[$ts] [RESULT] ${content}" >> "$LOG_FILE"
            fi
          done
          ;;
        result)
          result_subtype=$(printf '%s' "$line" | jq -r '.subtype // empty' 2>/dev/null)
          result_text=$(printf '%s' "$line" | jq -r '.result // empty' 2>/dev/null)
          # `.is_error // empty` では false が拾えない（jq では false も空扱いになる）
          is_error=$(printf '%s' "$line" | jq -r 'if has("is_error") then (.is_error|tostring) else "" end' 2>/dev/null)
          cost=$(printf '%s' "$line" | jq -r '.total_cost_usd // empty' 2>/dev/null)
          printf '%s\n' "${result_subtype:-unknown}" > "$RUN_STATE/result_subtype"
          printf '%s\n' "${is_error:-}" > "$RUN_STATE/is_error"
          echo "[$ts] [FINAL] subtype=${result_subtype} is_error=${is_error} cost=\$${cost} : ${result_text}" >> "$LOG_FILE"
          ;;
      esac
    done

CLAUDE_EXIT=${PIPESTATUS[0]}

RESULT_SUBTYPE=""
IS_ERROR=""
[ -f "$RUN_STATE/result_subtype" ] && RESULT_SUBTYPE="$(cat "$RUN_STATE/result_subtype" 2>/dev/null)"
[ -f "$RUN_STATE/is_error" ] && IS_ERROR="$(cat "$RUN_STATE/is_error" 2>/dev/null)"

# ============================================================
# 実行結果の判定
#
# 終了コードだけでは足りない。stream-json の result イベントは
# subtype=success 以外（error_max_turns / error_during_execution）でも
# プロセス自体は正常終了しうるので、そこまで見て「完走したか」を判断する。
# ============================================================
RUN_OK=1

if [ "$CLAUDE_EXIT" -ne 0 ]; then
  RUN_OK=0
  log "ERROR: Claude Code が異常終了しました (exit=$CLAUDE_EXIT)"
  if [ "$CLAUDE_EXIT" -eq 124 ] || [ "$CLAUDE_EXIT" -eq 137 ]; then
    log "  → 実行が上限時間（${ROUTINE_TIMEOUT_SEC}秒）を超えたため打ち切られました"
  fi
else
  log "Claude Code は正常終了しました (exit=0)"
fi

if [ -z "$RESULT_SUBTYPE" ]; then
  RUN_OK=0
  log "ERROR: 最終結果イベントを受け取れませんでした（セッションが途中で切れた可能性があります）"
elif [ "$RESULT_SUBTYPE" != "success" ]; then
  RUN_OK=0
  log "ERROR: セッションが success 以外で終了しました (subtype=$RESULT_SUBTYPE)"
fi

if [ "$IS_ERROR" = "true" ]; then
  RUN_OK=0
  log "ERROR: 最終結果が is_error=true でした"
fi

# ============================================================
# 生成物の検証（コミットの門番）
# ============================================================
run_check() {
  # run_check <説明> <コマンド...>
  local desc="$1"; shift
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

# 空のCSV（--init の直後に中断した状態）を確実に弾く。
# validate_data.py も「データ行がありません」で同じ状態を ERROR にするが、こちらは
# 検証スクリプトが動かなくても（import に失敗する・0バイトで例外になる等）成立する
# 判定として残してある。押してよいかの最終判定なので、検証の健全性に依存させない。
for csv in data/events.csv data/lives.csv data/movies.csv; do
  if [ ! -f "$REPO_DIR/$csv" ]; then
    VERIFY_OK=0
    log "ERROR: $csv が存在しません"
    continue
  fi
  lines="$(wc -l < "$REPO_DIR/$csv" | tr -d ' ')"
  if [ "${lines:-0}" -le 1 ]; then
    VERIFY_OK=0
    log "ERROR: $csv がヘッダーだけの状態です（収集が途中で終わった可能性が高い）"
  fi
done

log "検証を実行します（validate_data.py / diff_data.py）"
run_check "python3 tools/validate_data.py" python3 tools/validate_data.py || VERIFY_OK=0
run_check "python3 tools/diff_data.py" python3 tools/diff_data.py || VERIFY_OK=0

# ============================================================
# 失敗時：生成物を退避して data/ を HEAD に戻す
# ============================================================
quarantine_and_restore() {
  local changed stash_dir ts f rest
  changed="$(git -C "$REPO_DIR" -c core.quotePath=false status --porcelain -- data docs | cut -c4-)"
  if [ -z "$changed" ]; then
    log "data/ docs/ に未コミットの変更はありません（退避・復元は不要）"
    return 0
  fi

  ts="$(date '+%Y%m%d-%H%M%S')"
  stash_dir="$LOG_DIR/failed/$ts"
  mkdir -p "$stash_dir" || { log "WARNING: 退避先を作成できません: $stash_dir"; return 1; }

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$REPO_DIR/$f" ] || continue
    mkdir -p "$stash_dir/$(dirname "$f")"
    cp -p "$REPO_DIR/$f" "$stash_dir/$f" 2>>"$LOG_FILE"
  done <<< "$changed"

  log "検証を通らなかった生成物を $stash_dir に退避しました"

  if git_q checkout -- data docs; then
    log "data/ docs/ を HEAD の内容に戻しました（検証を通らなかった回は、丸ごと無かったことにする）"
    log "  （切り詰められたCSVを置いたままにすると、翌週それが「前回分」として扱われ、差分検知が壊れるため）"
  else
    log "WARNING: data/ docs/ を HEAD に戻せませんでした。手動で確認してください"
  fi

  rest="$(git -C "$REPO_DIR" -c core.quotePath=false status --porcelain -- data docs | cut -c4-)"
  if [ -n "$rest" ]; then
    log "WARNING: data/ docs/ に追跡外のファイルが残っています（自動では消しません）:"
    log_output "$rest"
  fi
  return 0
}

# ============================================================
# 成功時：コミットして push（旧: 手順ファイルの「4. git push」）
# ============================================================
push_with_retry() {
  local attempt=1 delay=2
  if [ "$ROUTINE_PUSH" != "1" ]; then
    log "ROUTINE_PUSH=0 のため push はしません（コミットはローカルに残ります）"
    return 0
  fi
  while :; do
    if git_q push -u origin "$BRANCH"; then
      log "origin/$BRANCH に push しました"
      return 0
    fi
    if [ "$attempt" -ge "$ROUTINE_GIT_RETRY" ]; then
      log "ERROR: push に失敗しました（${attempt}回試行）。コミットはローカルに残っています"
      return 1
    fi
    log "WARNING: push に失敗しました。${delay}秒後に再試行します（${attempt}/${ROUTINE_GIT_RETRY}）"
    sleep "$delay"
    # 失敗の理由が「実行中に origin が進んだ」ことなら、追いついてから押し直す
    if ! sync_with_origin; then
      log "ERROR: origin/$BRANCH に追いつけないため push を諦めます。コミットはローカルに残っています"
      return 1
    fi
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

commit_and_push() {
  local staged others changed_csv msg name email ahead rc
  local -a git_id=()

  git_q add -A -- data docs || { log "ERROR: git add に失敗しました"; return 1; }

  staged="$(git -C "$REPO_DIR" diff --cached --name-only)"
  if [ -z "$staged" ]; then
    log "WARNING: コミットする変更がありませんでした（週次更新としては異常です。ログを確認してください）"
    # 前回 push できずに残っていたコミットがあれば、ここで押し直す
    ahead="$(git -C "$REPO_DIR" rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null)"
    if [ "${ahead:-0}" -gt 0 ] 2>/dev/null; then
      log "未 push のコミットが ${ahead}件 残っています。push を試みます"
      push_with_retry || return 1
    fi
    return 0
  fi

  log "コミット対象:"
  log_output "$staged"

  others="$(git -C "$REPO_DIR" -c core.quotePath=false status --porcelain | cut -c4- | grep -Ev '^(data|docs)/' || true)"
  if [ -n "$others" ]; then
    log "WARNING: data/ docs/ 以外にも変更があります（コミットには含めません）:"
    log_output "$others"
  fi

  # cron のユーザに git の identity が無いと commit が落ちるので、その場だけ補う
  name="$(git -C "$REPO_DIR" config user.name 2>/dev/null || true)"
  email="$(git -C "$REPO_DIR" config user.email 2>/dev/null || true)"
  [ -z "$name" ] && git_id+=(-c "user.name=claude-routine")
  [ -z "$email" ] && git_id+=(-c "user.email=claude-routine@localhost")

  changed_csv="$(git -C "$REPO_DIR" diff --cached --name-only -- data \
                 | sed 's#.*/##' | tr '\n' ' ' | sed 's/ *$//')"
  msg="週次データ更新 $(date '+%Y-%m-%d')"
  [ -n "$changed_csv" ] && msg="$msg（$changed_csv）"

  local out
  out="$(git -C "$REPO_DIR" ${git_id[@]+"${git_id[@]}"} commit -m "$msg" 2>&1)"
  rc=$?
  log_output "$out"
  if [ "$rc" -ne 0 ]; then
    log "ERROR: コミットに失敗しました (exit=$rc)"
    return 1
  fi
  log "コミットしました: $msg"

  push_with_retry
}

# ============================================================
# 後始末
# ============================================================
EXIT_CODE=0

if [ "$RUN_OK" -eq 1 ] && [ "$VERIFY_OK" -eq 1 ]; then
  log "実行と検証がどちらも通りました。コミットと push に進みます"
  if ! commit_and_push; then
    EXIT_CODE=1
  fi
else
  log "ERROR: 実行または検証に失敗したため、コミットも push も行いません"
  log "  RUN_OK=$RUN_OK VERIFY_OK=$VERIFY_OK claude_exit=$CLAUDE_EXIT subtype=${RESULT_SUBTYPE:-なし}"
  quarantine_and_restore
  EXIT_CODE=1
fi

log "===== スクリプト終了 (exit=$EXIT_CODE) ====="
exit "$EXIT_CODE"
