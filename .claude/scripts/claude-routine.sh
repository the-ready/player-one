#!/bin/bash
set -u

# ============================================================
# スクリプト自身の場所から、リポジトリのルートディレクトリを動的に取得する。
# cronはカレントディレクトリを$HOMEにして実行するため、単純な pwd では
# スクリプトの置き場所は分からない。dirname "${BASH_SOURCE[0]}" で自分自身の
# パスを取り、cd ... && pwd で絶対パスに解決する。
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROUTINE_FILE="$PROJECT_DIR/routines/event.txt"

# ログは専用フォルダ(logs/)に、日付別のファイルで保存する。
# 同じ日に複数回実行された場合は同じファイルに追記される。
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/routine_$(date '+%Y-%m-%d').log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log "===== スクリプト開始 ====="
log "SCRIPT_DIR  = $SCRIPT_DIR"
log "PROJECT_DIR = $PROJECT_DIR"
log "LOG_FILE    = $LOG_FILE"

source ~/.bashrc

# --- 依存コマンドの確認 ---
if ! command -v claude >/dev/null 2>&1; then
  log "エラー: claude コマンドが見つかりません(PATHが通っているか確認してください)"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  log "エラー: jq がインストールされていません。'sudo apt install -y jq' を実行してください"
  exit 1
fi

# --- 手順ファイルの確認 ---
if [ ! -f "$ROUTINE_FILE" ]; then
  log "エラー: 手順ファイルが見つかりません: $ROUTINE_FILE"
  exit 1
fi
log "手順ファイルを確認しました: $ROUTINE_FILE"

cd "$PROJECT_DIR" || { log "エラー: PROJECT_DIRに移動できませんでした"; exit 1; }

log "Claude Codeを起動します"

# ============================================================
# claudeの出力を --output-format stream-json で受け取り、1行(=1イベント)ずつ
# jqで解析してログに残す。これにより「今どのツールを実行しているか」
# 「何を読み書きしたか」「最終的に何を返したか」が逐一わかる。
# stderr(claude自体の警告など)はそのままログファイルに追記する。
# ============================================================
set -o pipefail
claude -p "作業ディレクトリは ${PROJECT_DIR} です。まずこのディレクトリに移動し、${ROUTINE_FILE} を読み込んで、その指示に従って作業を実行してください。" \
  --permission-mode bypassPermissions \
  --output-format stream-json \
  --verbose \
  2>> "$LOG_FILE" \
  | while IFS= read -r line; do
      ts="$(date '+%Y-%m-%d %H:%M:%S')"
      type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)

      case "$type" in
        system)
          subtype=$(echo "$line" | jq -r '.subtype // empty')
          echo "[$ts] [SYSTEM:$subtype] セッション開始" >> "$LOG_FILE"
          ;;
        assistant)
          echo "$line" | jq -c '.message.content[]?' 2>/dev/null | while IFS= read -r block; do
            btype=$(echo "$block" | jq -r '.type')
            if [ "$btype" = "tool_use" ]; then
              name=$(echo "$block" | jq -r '.name')
              input=$(echo "$block" | jq -c '.input' | head -c 300)
              echo "[$ts] [TOOL] ${name} ${input}" >> "$LOG_FILE"
            elif [ "$btype" = "text" ]; then
              text=$(echo "$block" | jq -r '.text')
              echo "[$ts] [CLAUDE] ${text}" >> "$LOG_FILE"
            fi
          done
          ;;
        user)
          echo "$line" | jq -c '.message.content[]?' 2>/dev/null | while IFS= read -r block; do
            btype=$(echo "$block" | jq -r '.type // empty')
            if [ "$btype" = "tool_result" ]; then
              content=$(echo "$block" | jq -r 'if (.content|type)=="array" then (.content[0].text // "") else (.content // "") end' 2>/dev/null | head -c 300)
              echo "[$ts] [RESULT] ${content}" >> "$LOG_FILE"
            fi
          done
          ;;
        result)
          result_text=$(echo "$line" | jq -r '.result // empty')
          cost=$(echo "$line" | jq -r '.total_cost_usd // empty')
          echo "[$ts] [FINAL] cost=\$${cost} : ${result_text}" >> "$LOG_FILE"
          ;;
      esac
    done

CLAUDE_EXIT=${PIPESTATUS[0]}

if [ "$CLAUDE_EXIT" -eq 0 ]; then
  log "Claude Codeは正常終了しました (exit=$CLAUDE_EXIT)"
else
  log "Claude Codeが異常終了しました (exit=$CLAUDE_EXIT)"
fi

log "===== スクリプト終了 ====="
exit "$CLAUDE_EXIT"