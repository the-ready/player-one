#!/bin/bash
#
# 週次データ収集ルーチンの起動スクリプト（cron から呼ばれる想定）
#
#   .claude/scripts/claude-routine.sh [--no-push] [--check-env] [--help]
#
# ============================================================
# このスクリプトが責任を持つこと
# ============================================================
#   1. 多重起動の防止（ロック）
#   2. 実行前に origin から最新を取り込む（git fetch + fast-forward マージ）
#   3. Claude Code を起動し、`/weekly-routine` の手順を実行させる
#      （不変規則は --append-system-prompt-file で invariants.md を渡す）
#   4. 終了日を過ぎた行の後始末（purge_ended.py）と生成物の検証
#      （validate_data.py / diff_data.py の終了コード）
#   5. **検証を通ったときだけ** commit して push する
#   6. 検証を通らなかったときは生成物を logs/failed/ に退避し、data/ を HEAD に戻す
#
# 「最初に git pull、最後に git push」という手順は、以前は
# 手順の側（現 `.claude/skills/weekly-routine/SKILL.md`）に書かれていた
# （＝Claude 自身にやらせていた）。
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
#   ROUTINE_CLAUDE_BIN   使う claude の実体を固定する（既定は自動検出）
#   ROUTINE_SKILL        実行するスキルを固定する（既定は weekly-routine スキルの対応表から曜日で自動選択。
#                        水〜金以外の曜日にcronで試験実行するときに使う。下記参照）
#   ROUTINE_MODEL        使うモデルを固定する（既定は ROUTINE_SKILL に対応するモデルを自動選択）
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
  --check-env 実行環境（claude が起動できるか等）だけ確かめて終わる
  --help      このヘルプを表示する

環境変数:
  ROUTINE_TIMEOUT_SEC  Claude 実行の上限秒数（既定 21600）
  ROUTINE_GIT_RETRY    fetch / push の試行回数（既定 4）
  ROUTINE_BRANCH       push 先ブランチ（既定は現在のブランチ）
  ROUTINE_PUSH         0 で push を行わない
  ROUTINE_CLAUDE_BIN   使う claude の実体を固定する（既定は自動検出）
  ROUTINE_SKILL        実行するスキルを固定する（既定は weekly-routine スキルの対応表から曜日で自動選択）
  ROUTINE_MODEL        使うモデルを固定する（既定は ROUTINE_SKILL に対応するモデルを自動選択）
USAGE
}

ROUTINE_TIMEOUT_SEC="${ROUTINE_TIMEOUT_SEC:-21600}"
ROUTINE_GIT_RETRY="${ROUTINE_GIT_RETRY:-4}"
ROUTINE_BRANCH="${ROUTINE_BRANCH:-}"
ROUTINE_PUSH="${ROUTINE_PUSH:-1}"
ROUTINE_CLAUDE_BIN="${ROUTINE_CLAUDE_BIN:-}"
ROUTINE_SKILL="${ROUTINE_SKILL:-}"
ROUTINE_MODEL="${ROUTINE_MODEL:-}"
CHECK_ENV_ONLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-push) ROUTINE_PUSH=0 ;;
    --check-env) CHECK_ENV_ONLY=1 ;;
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
# 手順の正本は `weekly-routine` スキル、不変規則の正本は invariants.md である。
#
# 以前はこの2つが `.claude/routines/event.txt` に同居していて、起動プロンプトで
# 「このファイルを読んで従え」と言っていた。**規則が会話の履歴に乗る形だった**、
# というのがこの分け方の理由である。Claude Code は文脈が埋まると会話を要約するので、
# 冒頭で1度読んだだけの指示は終盤まで残る保証が無い（公式ドキュメント How Claude Code
# works「instructions from early in the conversation can get lost」）。6時間・文脈再送
# 25M〜40M を前提にした運用で、規則がいつ消えたか分からないのは割に合わない。
#
#   invariants.md  → --append-system-prompt-file で渡す。システムプロンプトは会話履歴では
#                    ないので圧縮の対象外で、最後のターンまで必ず残る
#   SKILL.md       → -p "/weekly-routine <スキル名>" で展開させる。手順は会話に乗ってよい
#                    （消えても致命的でなく、消えるほど長い実行では既に終了工程にいる）
#
# 事故の記録そのものは docs/routine-postmortems.md に移してある。実行時には読ませない。
ROUTINE_SKILL_FILE="$CLAUDE_DIR/skills/weekly-routine/SKILL.md"
INVARIANTS_FILE="$CLAUDE_DIR/routines/invariants.md"

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
#
# cron のデフォルト PATH（/usr/bin:/bin 程度）には /usr/local/bin が
# 含まれないことがある。claude はそこに置かれたシンボリックリンク
# （実体は単体実行ファイルで node には依存しない）なので、
# git/jq/python3 は見つかるのに claude だけ見つからない、という
# 壊れ方をする（2026-08-13 に実際に発生）。ここで明示的に加えておく。
# ============================================================
export PATH="/usr/local/bin:$PATH"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# ここも「在るか」ではなく「動くか」で見る。jq と python3 は
# .claude/hooks/ の2本が拠り所にしていて、壊れていると
# フックが判定できないまま素通りする側の事故になる。確認は一瞬で済む。
check_cmd() {
  local cmd="$1"; shift
  command -v "$cmd" >/dev/null 2>&1 || \
    die "$cmd コマンドが見つかりません（cron から実行する場合、PATH が対話シェルと違う点に注意）"
  "$@" >/dev/null 2>&1 || die "$cmd は見つかりましたが正しく動きません（$*）"
}

check_cmd jq      jq -n .
check_cmd python3 python3 -c ''
check_cmd git     git --version

# ============================================================
# claude の健全性確認 —— 「在るか」ではなく「動くか」を見る
#
# npm 版の claude は、パッケージに入っている bin/claude.exe が
# 「native binary not installed」と出して exit 1 するだけのスタブで、
# postinstall（install.cjs）がプラットフォーム別の実体で上書きして
# はじめて動く。アップグレード時に postinstall が走らないと、
# PATH には claude が居るのに起動だけが失敗する状態が残る
# （2026-08-19 に発生。存在確認を通過して git の fetch・rebase・
# push 事前確認まで進んでから、起動の瞬間に落ちた）。
#
# command -v はこの壊れ方を素通しするため、実際に --version を
# 実行して確かめる。確認は git に触る前に済ませる。ここで落とせば
# リポジトリに副作用が何も残らない。
# ============================================================

# 候補を1つ実行してみる。起動できれば 0 を返し、標準出力にバージョンを出す
claude_probe() {
  local bin="$1" out
  if command -v timeout >/dev/null 2>&1; then
    out="$(timeout 60 "$bin" --version 2>&1)" || return 1
  else
    out="$("$bin" --version 2>&1)" || return 1
  fi
  [ -n "$out" ] || return 1
  printf '%s' "$out"
}

# スタブだった場合に postinstall を代行する。復旧できたら 0
claude_repair() {
  local bin="$1" real pkg_dir
  real="$(readlink -f "$bin" 2>/dev/null)" || return 1
  # .../@anthropic-ai/claude-code/bin/claude.exe → .../claude-code
  pkg_dir="$(dirname "$(dirname "$real")")"
  [ -f "$pkg_dir/install.cjs" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  log "  postinstall が未実行のようです。$pkg_dir/install.cjs を実行して復旧を試みます"
  log_output "$(cd "$pkg_dir" && node install.cjs 2>&1)"
  claude_probe "$bin" >/dev/null 2>&1
}

# PATH 上のものを第一候補に、他のインストール先も控えに置く。
# nvm の bin は PATH の先頭に来るので、そこが壊れていると
# /usr/local/bin にある健全な実体が使われない、という順序依存がある。
CLAUDE_BIN=""
CLAUDE_CANDIDATES=()
if [ -n "$ROUTINE_CLAUDE_BIN" ]; then
  # 実体が複数入っている機械で、どれを使うかを固定したいときに使う
  [ -x "$ROUTINE_CLAUDE_BIN" ] || die "ROUTINE_CLAUDE_BIN に実行できないパスが指定されています: $ROUTINE_CLAUDE_BIN"
  CLAUDE_CANDIDATES=("$ROUTINE_CLAUDE_BIN")
else
  if command -v claude >/dev/null 2>&1; then
    CLAUDE_CANDIDATES+=("$(command -v claude)")
  fi
  for c in /usr/local/bin/claude "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" \
           "$NVM_DIR"/versions/node/*/bin/claude; do
    [ -x "$c" ] && CLAUDE_CANDIDATES+=("$c")
  done
fi

for c in "${CLAUDE_CANDIDATES[@]}"; do
  ver="$(claude_probe "$c")" && { CLAUDE_BIN="$c"; break; }
  log "WARNING: $c は起動できません（スタブ／破損の可能性）"
  if claude_repair "$c"; then
    ver="$(claude_probe "$c")" && { CLAUDE_BIN="$c"; log "  復旧しました"; break; }
  fi
done

if [ -z "$CLAUDE_BIN" ]; then
  if [ "${#CLAUDE_CANDIDATES[@]}" -eq 0 ]; then
    die "claude コマンドが見つかりません（cron から実行する場合、PATH が対話シェルと違う点に注意）"
  fi
  die "claude は見つかりましたが起動できません（${CLAUDE_CANDIDATES[0]}）。npm 版なら 'npm i -g @anthropic-ai/claude-code' で入れ直してください"
fi
log "CLAUDE_BIN = $CLAUDE_BIN（$ver）"

[ -f "$ROUTINE_SKILL_FILE" ] || die "手順スキルが見つかりません: $ROUTINE_SKILL_FILE"
log "手順スキルを確認しました: $ROUTINE_SKILL_FILE"
# 不変規則が読めない回は起動しない。あれはシステムプロンプトに載る唯一の経路で、
# 無いまま起動すると「規則が届いていないこと」に誰も気づけないまま6時間走る。
[ -f "$INVARIANTS_FILE" ] || die "不変規則が見つかりません: $INVARIANTS_FILE"
log "不変規則を確認しました: $INVARIANTS_FILE"

# リポジトリのルート。.claude が別の場所へ移されても追随できるよう git に聞く
REPO_DIR="$(git -C "$CLAUDE_DIR" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_DIR" ] || die "git リポジトリを特定できません（$CLAUDE_DIR）"
log "REPO_DIR   = $REPO_DIR"

cd "$REPO_DIR" || die "リポジトリのルートに移動できません: $REPO_DIR"

for f in tools/purge_ended.py tools/validate_data.py tools/diff_data.py; do
  [ -f "$REPO_DIR/$f" ] || die "検証スクリプトが見つかりません: $f"
done

# ここまでが「何にも触らずに確かめられること」の全部である。
# --check-env はこの地点で終わる。cron の実行日とは無関係に、
# 環境が壊れていないかを副作用ゼロで確かめるための入口。
if [ "$CHECK_ENV_ONLY" = "1" ]; then
  log "OK: 実行環境の確認のみ完了（--check-env）"
  log "===== スクリプト終了 (exit=0) ====="
  exit 0
fi

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
#
# まず、実行するスキル・モデル・サブエージェントの同時実行数を決める。
#
# 【同時実行数】上限の既定は 20 だが、この収集タスクには過剰である。並列化が
# 効くのは**取得先のホストが分かれている分だけ**で、同じホストへ複数体を当てると
# fetch_gate.py の間隔制御（ホスト単位）で互いに待ち合うだけになる。
# 待つ時間は増え、体数ぶんのトークンはそのまま払う。名簿の実測は次のとおり。
#
#   lives  : venues 152件 / 133ホスト → 競合はほぼ起きない
#   movies : theaters 85件 /  25ホスト → チェーンが同一ホストに集中している。
#            さらにステップ1（新作カレンダー）が集約サイト数件に偏るため、
#            並列度を上げてもゲート待ちの行列が伸びるだけになる
#   events : spots 201件 / 184ホスト → 競合はほぼ起きない（2026-08-22、栃木・群馬を除外後）
#
# movies だけ低いのはこのためで、件数の少なさが理由ではない。
#
# 【モデル】親は3スキルとも Sonnet、子は events だけ Haiku（表の5列目）。
#
# 2026-08-21 の実測で Haiku は「JSONLを返さず要約だけ返す」失敗が起きやすく、
# 前回分の再発見率も低かった。当初は events だけコストと速度を優先して
# 親子ともに Haiku で走らせていたが、2026-09-02 の回で**親に使うと被害が
# 全工程に及ぶ**ことがはっきりした。親は `skill_brief.py` の抜粋（子への手順書）を
# 貼らずに自作の1〜2KBの指示に要約し、その要約から価格の列が丸ごと落ちて、
# 新規90件の `price_official` が0件になっている（`docs/routine-postmortems.md`）。
#
# 親の成果は「規則を落とさずに指示を組み立てられるか」で決まり、落ちたことは
# 誰にも見えない。子の仕事は「渡されたURLを開いて行を書く」で範囲が狭く、
# 抜粋という手順書も付くので Haiku で足りる。**分けて払うのが安い。**
#
# 子のモデルは `CLAUDE_CODE_SUBAGENT_MODEL` で渡す。この環境変数は Agent ツールの
# `model` 引数よりも優先されるので、**親が何を指定しても子は表のモデルになる**
# ——親の判断に委ねない（`.claude/routines/invariants.md` と同じ考え方）。
# ROUTINE_MODEL / ROUTINE_SUBAGENT_MODEL で個別に上書きできる。
#
# 【曜日→スキル→モデルの対応】正本は weekly-routine スキルの ```schedule ブロックだけに
# 置く。**このスクリプトは自前の対応表を持たず、そこを読むだけにしてある。**
#
# 以前はここに曜日→モデルの対応を独自の case 文で複製していたが、対応表側の
# 表を変えた際にこちらの更新が漏れ、2026-08-29 の無人実行で「金曜日は
# kanto-live-collector（Sonnet）」のはずが「該当する case が無く既定の Haiku」に
# 落ちる事故が起きた（さらにモデル自身も当日を金曜日と暗算し間違えるという
# 別の誤りが重なった）。対応表を1箇所にし、モデルにも曜日を自分で選ばせず
# このスクリプトが決めた `ROUTINE_SKILL` を渡す形にして、両方の再発を防ぐ。
#
# ROUTINE_SKILL を先に環境変数で渡せば（cronでの水〜金以外の試験実行など）、
# 曜日に関わらずそのスキル・対応モデルが使われる。表に無いスキル名ならエラーで
# 止まる（「気づかないまま既定に落ちる」より、止まって気づけるほうを選んでいる）。
#
# settings.json の env・model はセッション全体にしか効かず、スキル単位で
# 差し替える仕組みが存在しない。シェルの環境変数・CLIフラグは settings.json
# より優先されるので、ここで export した値・渡したフラグが当日のセッションを
# 支配する——スキルごとに値を変えられる場所は実質ここしかない。
# なお孫エージェントの禁止（CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1）は曜日で
# 変わらないので settings.json 側に置いたままにしてあり、ここでは扱わない。
# ============================================================
SCHEDULE_BLOCK="$(awk '/^[[:space:]]*```schedule[[:space:]]*$/{f=1; next} /^[[:space:]]*```[[:space:]]*$/{f=0} f' "$ROUTINE_SKILL_FILE")"
[ -n "$SCHEDULE_BLOCK" ] || die "${ROUTINE_SKILL_FILE} に \`\`\`schedule ブロック（曜日対応表）が見つかりません"

find_schedule_row() {
  # $1: 検索する列番号（1=曜日番号/other、2=スキル名） $2: 探す値
  awk -v f="$1" -v v="$2" '$1 !~ /^#/ && $f == v { print; exit }' <<< "$SCHEDULE_BLOCK"
}

if [ -n "$ROUTINE_SKILL" ]; then
  ROW="$(find_schedule_row 2 "$ROUTINE_SKILL")"
  [ -n "$ROW" ] || die "ROUTINE_SKILL=${ROUTINE_SKILL} が ${ROUTINE_SKILL_FILE} の対応表にありません。表に行を追加してください"
else
  ROW="$(find_schedule_row 1 "$(date +%u)")"
  [ -n "$ROW" ] || ROW="$(find_schedule_row 1 "other")"
  [ -n "$ROW" ] || die "${ROUTINE_SKILL_FILE} の対応表に other 行（既定）がありません"
  ROUTINE_SKILL="$(awk '{print $2}' <<< "$ROW")"
fi
export ROUTINE_SKILL

DEFAULT_MODEL="$(awk '{print $3}' <<< "$ROW")"
SUBAGENT_LIMIT="$(awk '{print $4}' <<< "$ROW")"
DEFAULT_SUBAGENT_MODEL="$(awk '{print $5}' <<< "$ROW")"
export CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS="$SUBAGENT_LIMIT"
ROUTINE_MODEL="${ROUTINE_MODEL:-$DEFAULT_MODEL}"

# 5列目が無い行（列を足す前の表）は「親と同じ」として扱う。表を書き換え忘れた
# 回に既定の別モデルへ落ちるより、親と同じで走るほうが事故が小さい
# ——2026-08-29 は case 文の更新漏れで既定の Haiku に落ちる事故を起こしている。
ROUTINE_SUBAGENT_MODEL="${ROUTINE_SUBAGENT_MODEL:-${DEFAULT_SUBAGENT_MODEL:-inherit}}"
if [ "$ROUTINE_SUBAGENT_MODEL" = "inherit" ]; then
  unset CLAUDE_CODE_SUBAGENT_MODEL
else
  export CLAUDE_CODE_SUBAGENT_MODEL="$ROUTINE_SUBAGENT_MODEL"
fi

log "実行スキル: ${ROUTINE_SKILL} / サブエージェントの同時実行数: ${SUBAGENT_LIMIT}（孫の起動は settings.json で禁止） / 親モデル: ${ROUTINE_MODEL} / 子モデル: ${ROUTINE_SUBAGENT_MODEL}"

RUN_STATE="$(mktemp -d "$LOG_DIR/.run.XXXXXX")" || die "一時ディレクトリを作成できません"

# 手順は「ファイルを読め」ではなくスラッシュコマンドで渡す。
#
# `-p` モードでもユーザー起動のスキルは展開される（公式ドキュメント Headless
# 「include /skill-name in the prompt string and Claude Code expands it before
# running」）。Read を1回挟む形と違い、**モデルが読みに行くかどうかに依存しない**
# ——展開はモデルに届く前に済んでいる。
#
# スキル本文の `` !`date` `` も同じ理由でここに効く。曜日はシェルが数えて注入するので、
# モデルの暗算が入り込む余地が無い（2026-08-29 の事故。docs/routine-postmortems.md）。
PROMPT="/weekly-routine ${ROUTINE_SKILL}"

# ============================================================
# フックに「これは無人のルーチンである」と伝える
#
# .claude/hooks/ の3本は、対話セッションとルーチンで振る舞いを変える必要がある。
#   - block-git.sh   : ルーチン中だけ git の書き込みを拒否する（人の git は妨げない）
#   - agent-guard.sh : ルーチン中だけサブエージェントの背景起動を拒否する
#   - verify-data.sh : ルーチンでは終了前の検証を必ず回す
# フックのプロセスは claude プロセスの子なので、ここで export すれば届く。
#
# 直前の PROMPT の文言と役割が重なるが、片方は「お願い」、こちらは「仕組み」である。
# ルーチンは bypassPermissions で走るので、permissions.deny では止められない。
# ============================================================
export CLAUDE_ROUTINE=1

# 実行の上限を tools/budget.py に伝える。あちらは「残り何分か」を報告に載せる。
#
# **6時間の枠があることが、これまでスキル側に一度も伝わっていなかった。**
# モデルに届いていたのは「予算が尽きたら打ち切ってよい」「コンテキストが逼迫
# したら撤退」だけで、まだ余っていることを知る手段が無い。実際 2026-08-14 の回は
# 18分で終わっている。残りを知らせずに撤退を促せば、早く撤退する。
#
# ただし**この枠が実行を止めたことは一度も無い。** 止めているのはアカウントの
# 利用上限（トークン）で、2026-08-26 の回は経過39分の時点で殺されている。
# 時間は「まだ続けてよいか」の判断材料にはならないので、budget.py は
# セッションの記録からトークンも読んで併記する（第8.7.1節）。
export ROUTINE_TIMEOUT_SEC

CLAUDE_CMD=("$CLAUDE_BIN")
if command -v timeout >/dev/null 2>&1; then
  # 応答しなくなったセッションがロックを抱えたまま居座るのを防ぐ
  CLAUDE_CMD=(timeout -k 60 "$ROUTINE_TIMEOUT_SEC" "$CLAUDE_BIN")
else
  log "WARNING: timeout コマンドが無いため、実行時間の上限を設定できません"
fi

# 予算の計測を、起動の直前に数え直す。
#
# budget.py は12時間で自動的に数え直すが、**それでは足りない場面がある。**
# 2026-08-27 の実行は、開始56秒後の最初の予算表示が
#
#     経過 388分/360分（残り0分）
#
# だった。前夜20:02に対話セッションで fetch_page.py を試した際の起点が
# data/.run/budget.json に残っており、6時間半しか経っていなかったためである。
# `append_rows.py --init` が数え直すので実害までは至らなかったが、モデルは
# **着手の時点で「残り0分」を見ている**。撤退を促す表示を根拠なく出すのは、
# 「残りを知らせないまま撤退を促せば、早く撤退する」の裏返しでしかない。
if python3 "$REPO_DIR/tools/budget.py" --reset >/dev/null 2>&1; then
  log "予算の計測を数え直しました"
else
  log "WARNING: 予算の数え直しに失敗しました（計測がずれるだけで、収集には影響しません）"
fi

# temp/ の残骸を片付ける。
#
# サブエージェントは temp/ に作業ファイルを置くが、誰も消していなかったため
# 367ファイルまで溜まっていた。2026-08-27 の子は `ls temp/` を実行して、
# **その全件を自分の文脈に取り込んでいる**。
#
# 2日より新しいものは残す。前回の実行が打ち切られたとき、temp/ の
# `rows-*.jsonl` は**唯一残った調査結果**であり、人が拾い直せる必要がある。
if [ -d "$REPO_DIR/temp" ]; then
  removed="$(find "$REPO_DIR/temp" -maxdepth 1 -type f -mtime +2 -print -delete 2>/dev/null | wc -l)"
  [ "${removed:-0}" -gt 0 ] && log "temp/ の2日より古いファイルを ${removed}件 片付けました"
fi

# 資格情報の期限を先に見る。**止めはしない**（判定できないときに収集を止める
# ほうが害が大きい。他のゲートと同じ倒し方）。ただし失効が近いことは、失敗して
# から気づくより前に知りたい——リフレッシュトークンの再取得は人にしかできず、
# 気づくのが翌朝の失敗ログだと1回ぶんの収集が丸ごと落ちる。
if command -v python3 >/dev/null 2>&1; then
  CRED_WARN="$(python3 - <<'PYCRED' 2>/dev/null
import datetime, json, os
p = os.path.expanduser("~/.claude/.credentials.json")
try:
    o = json.load(open(p)).get("claudeAiOauth") or {}
except Exception:
    raise SystemExit(0)
ms = o.get("refreshTokenExpiresAt")
if not ms:
    raise SystemExit(0)
t = datetime.datetime.fromtimestamp(ms / 1000)
left = t - datetime.datetime.now()
if left.total_seconds() <= 0:
    print(f"認証の refresh token が {t:%Y-%m-%d %H:%M} に失効しています。"
          "この実行は認証に失敗する見込みです（claude を起動して /login）")
elif left.days <= 7:
    print(f"認証の refresh token があと{left.days}日で失効します（{t:%Y-%m-%d %H:%M}）。"
          "失効するとルーチンは起動できません（claude を起動して /login）")
PYCRED
)"
  [ -n "$CRED_WARN" ] && log "WARNING: $CRED_WARN"
fi

log "Claude Code を起動します（上限 ${ROUTINE_TIMEOUT_SEC} 秒）"

"${CLAUDE_CMD[@]}" -p "$PROMPT" \
  --model "$ROUTINE_MODEL" \
  --append-system-prompt-file "$INVARIANTS_FILE" \
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
          printf '%s\n' "${result_text:-}" > "$RUN_STATE/result_text"
          echo "[$ts] [FINAL] subtype=${result_subtype} is_error=${is_error} cost=\$${cost} : ${result_text}" >> "$LOG_FILE"
          ;;
      esac
    done

CLAUDE_EXIT=${PIPESTATUS[0]}

RESULT_SUBTYPE=""
IS_ERROR=""
[ -f "$RUN_STATE/result_subtype" ] && RESULT_SUBTYPE="$(cat "$RUN_STATE/result_subtype" 2>/dev/null)"
[ -f "$RUN_STATE/is_error" ] && IS_ERROR="$(cat "$RUN_STATE/is_error" 2>/dev/null)"
RESULT_TEXT=""
[ -f "$RUN_STATE/result_text" ] && RESULT_TEXT="$(cat "$RUN_STATE/result_text" 2>/dev/null)"

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
# 認証に失敗した回は、「収集の失敗」ではない
#
# 2026-09-03 の movies は、OAuth のリフレッシュトークンが起動の79分前に失効して
# いたため、セッションが1度も動かないまま（ツール呼び出し0件で）終わった。
# それでも下の工程はそのまま走り、`carry-rest` と `purge_ended` が data/ を
# 書き換えてから巻き戻すので、ログの結びは
#
#     検証を通らなかった生成物を … に退避しました
#     data/ docs/ を HEAD の内容に戻しました
#
# になる。**調べもしなかった回が「検証に落ちた回」に見える。** 読んだ人は
# 収集側の不具合を探すことになり、実際に必要な対処（ログインし直す）に
# たどり着けない。原因が違えば、伝える文面も止まる場所も変えるべきである。
#
# セッションが動いていない以上、救い出す成果も無い。退避・巻き戻しの工程を
# 通さずにここで終える（data/ は触られていないので、戻すものが無い）。
# ============================================================
case "$RESULT_TEXT" in
  *"Failed to authenticate"*|*"OAuth session expired"*|*"Invalid API key"*|*"run /login"*)
    log "ERROR: 認証に失敗しました。セッションは1度も動いていません（収集の失敗ではありません）"
    log "  → 対話セッションで claude を起動し、/login でログインし直してください"
    log "  → 資格情報: ${HOME}/.claude/.credentials.json（refresh token が失効すると自動更新できません）"
    if command -v python3 >/dev/null 2>&1; then
      log_output "$(python3 - <<'PYEXP' 2>/dev/null
import datetime, json, os
p = os.path.expanduser("~/.claude/.credentials.json")
try:
    o = json.load(open(p)).get("claudeAiOauth") or {}
except Exception:
    raise SystemExit(0)
ms = o.get("refreshTokenExpiresAt")
if ms:
    t = datetime.datetime.fromtimestamp(ms / 1000)
    state = "失効済み" if t < datetime.datetime.now() else "有効"
    print(f"  → refresh token の期限: {t:%Y-%m-%d %H:%M}（{state}）")
PYEXP
)"
    fi
    log "  → data/ は触っていないので、退避も巻き戻しも行いません"
    exit 1
    ;;
esac

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

# 再確認が終わる前に打ち切られた行を、機械的に片付ける。
#
# **ここが無いと、打ち切りがそのまま全損になる。** append_rows.py --init は
# CSVをヘッダーだけに切り詰めるので、前回行は能動的に書き直されない限り消える
# ——つまり**未処理の行の既定値が「消滅」**である。2026-08-26 の lives 収集は
# 開始50分でアカウントの利用上限に殺され、書けていた94行と日割り217行が、
# 前回78行のうち41行を未処分のまま残したせいで「説明のない消滅」と判定され、
# 下の quarantine_and_restore に丸ごと巻き戻された。
#
# 各SKILL.mdの「撤退の手順」は同じ後始末をモデルの仕事として書いているが、
# **撤退は生きているセッションにしか実行できない。** 利用上限による打ち切りは
# その猶予を与えず、Stop フック（verify-data.sh）も走らないまま終わる。
# 終了日と今日を比べるだけで決まる処理なので、ここで機械的に適用する。
#
# 空回りを成功と誤認する穴は開かない——下の diff_data.py の「収穫が0件なら
# 落ちる」検査は残るので、何も調べずに前回分を書き戻しただけの回は依然として落ちる。
for ds in events lives movies; do
  run_check "python3 tools/prev_rows.py $ds --carry-rest --apply" \
    python3 tools/prev_rows.py "$ds" --carry-rest --apply || VERIFY_OK=0
done

# 終了日を過ぎた行の後始末（判断を要しない機械的な処理）は、検証より先に
# 直接適用する。Claude のセッションが purge_ended.py を呼ばずに終えた回でも、
# ここで必ず適用されるので、「終わったイベントがコミットされたまま残る」ことがない。
# diff_data.py はこの後始末で書かれた dispositions を読むので、順序が重要（先に実行）。
run_check "python3 tools/purge_ended.py" python3 tools/purge_ended.py || VERIFY_OK=0

# diff_data.py は2つのことで落ちる。
#
#   1. 説明のない消滅がある（＝開催中の催しを黙って落とした可能性）
#   2. **収穫が0件**（新規・変更・消滅がすべて0）
#
# 2 は 2026-08-14 の回で開いた穴を塞ぐためのものである。あの回は検索115回・
# 取得154回を消費したあと、data/.prev/ から前回のCSVをそのまま復元して終わった。
# 壊れてはいないので検証は素通りし、ここが「週次データ更新」としてコミットして
# push した。**この門は「壊れていないか」しか見ておらず、「何か産んだか」を
# 見ていなかった。** 空回りの回を成功として記録に残さない。
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

    # data/.prev/ は .gitignore 対象なので、上の checkout では戻らない。
    # 今回の回が --init していれば、taken_at（「今日 --init した」記録）が
    # そのまま残り、**翌日以降の無関係なセッションを is_noop 判定に巻き込む**
    # （前日の失敗した movies 収集の taken_at が残ったせいで、翌日 events だけを
    # 触った無関係なセッションが movies の「収穫0件」判定に巻き込まれて足止め
    # された実例がある。`docs/COLLECTION-PROTOCOL.md` 第11章）。
    # 「今日は --init していない」状態に戻すため、今回変更されていた
    # データセットの meta.json だけを消す（無ければ prev_taken_at() は
    # None を返し、is_noop の対象から外れる）。
    while IFS= read -r f; do
      case "$f" in
        data/events.csv) rm -f "$REPO_DIR/data/.prev/events.meta.json" ;;
        data/lives.csv)  rm -f "$REPO_DIR/data/.prev/lives.meta.json" ;;
        data/movies.csv) rm -f "$REPO_DIR/data/.prev/movies.meta.json" ;;
      esac
    done <<< "$changed"
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
