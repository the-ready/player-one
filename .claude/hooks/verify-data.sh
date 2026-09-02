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
# 読み出しに jq が使えなければ python3 で読む。どちらも無ければ false 扱いで
# 進む——ここは「2周目なら黙って通す」ための最適化でしかなく、判定できない場合に
# 検証をやめる理由にはならない（下の出力側は、判定できないなら止める側に倒す）。
stop_active="false"
if command -v jq >/dev/null 2>&1; then
  stop_active="$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)"
elif command -v python3 >/dev/null 2>&1; then
  stop_active="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try: print(str(json.load(sys.stdin).get("stop_hook_active", False)).lower())
except Exception: print("false")' 2>/dev/null)"
fi
[ "$stop_active" = "true" ] && exit 0

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

# 問題を2種類に分ける。
#
# `purge_ended` / `validate_data` / `diff_data` が落ちた回は、claude-routine.sh も
# 同じ3本で落ちるので**コミットされず data/ が巻き戻る**（＝その週の収集が消える）。
# 一方、価格の下限（report_stats --check-fresh）はここにしか無い門で、**コミットは
# 止まらない**。
#
# 両方をまとめて「このまま終えると収集が失われます」と伝えると、**下限割れの回に
# 嘘をつくことになる。** 嘘の脅しは最悪の逃げ道を用意する——料金を集め直す代わりに、
# 推測で `price` を埋めれば門は通る。このスキルが最も禁じている行為をこちらから
# 誘発してしまう。だから何が起きるかは、種類ごとに正しく書く。
PROBLEMS=""
add_problem() { PROBLEMS="${PROBLEMS}$1"$'\n'; }
SOFT_PROBLEMS=""
add_soft_problem() { SOFT_PROBLEMS="${SOFT_PROBLEMS}$1"$'\n'; }

# 落ちた出力の要約。**末尾を切り出すだけでは、肝心の ERROR が見えない。**
#
# validate_data.py は ERROR を出したあとに WARNING をまとめて出す。`http://` の
# 警告は80件ぶんの行番号が1行に並ぶので、末尾3000バイトはその行番号だけで
# 埋まり、**なぜ落ちたのかがフィードバックから消える。** 実測（lives の
# lineup_id 参照切れ）では、モデルに届いたのは `events.csv:169, events.csv:170,
# …` という無意味な列だけだった。
#
# ERROR 行があればそれを先に出し、そのうえで末尾も添える（diff_data.py の
# 「説明のない消滅」のように、ERROR という語を使わない落ち方もあるため）。
summarize_fail() {
  local out="$1" errs
  errs="$(printf '%s\n' "$out" | grep -E '^[[:space:]]*ERROR' | head -20)"
  [ -n "$errs" ] && printf '%s\n\n' "$errs"
  printf '%s' "$out" | tail -c 2000
}

# purge_ended.py / diff_data.py は「実際に触ったデータセットだけ」に絞る。
#
# 以前は引数なし（＝events/lives/movies の3つとも）で回していた。対話セッションで
# events.csv だけを更新したところ、無関係な movies.csv の終了日超過行が
# purge_ended.py によって黙って書き換わり、その movies.csv が「新規・変更・消滅が
# すべて0件」という diff_data.py の空回り検知に引っかかって足止めされたことがある
# （`docs/COLLECTION-PROTOCOL.md` 第11章）。触っていないデータセットにまで
# 検証の副作用が及ぶのは、対話セッションでは筋が通らない。
#
# ルーチン実行（週次）は、Claude のセッションが purge_ended.py を呼ばずに終えた
# 回の安全網として、これまでどおり3つとも回す（claude-routine.sh 側の設計）。
# こちらのフックは「今回のターンが何を壊したか」だけを見ればよい。
if [ "$IS_ROUTINE" -eq 1 ]; then
  DATASETS="events lives movies"
else
  changed_csv="$(git status --porcelain -- data/events.csv data/lives.csv data/movies.csv 2>/dev/null)"
  DATASETS=""
  printf '%s\n' "$changed_csv" | grep -q "data/events.csv" && DATASETS="$DATASETS events"
  printf '%s\n' "$changed_csv" | grep -q "data/lives.csv"  && DATASETS="$DATASETS lives"
  printf '%s\n' "$changed_csv" | grep -q "data/movies.csv" && DATASETS="$DATASETS movies"
fi

# 終了日を過ぎた行を先に機械的に片付ける。終了日と今日を比べるだけの判断で、
# モデルの確認を要らないので、検証で落として直させるのではなくここで直接適用する
# （決定論的に守らせたい規則はフックに置く。設計書 第9.1.5節）。説明のない消滅を
# diff_data.py が拾わないよう、必ず下の検証より先に走らせる。
for ds in $DATASETS; do
  if ! out="$(python3 "tools/purge_ended.py" "$ds" 2>&1)"; then
    add_problem "python3 tools/purge_ended.py ${ds} が失敗しました:"$'\n'"$(summarize_fail "$out")"
  fi
done

# validate_data.py はデータセットを跨いだ整合性（会場名の名簿との一致など）を
# 見る設計で引数を取らないため、絞らずに常に全体を回す。「収集が途中で終わった」
# 形——ヘッダーだけ・ファイルごと欠損・0バイト——はすべてここが ERROR で落とす
# （「データ行がありません」「ファイルがありません」）。行数を別途数えても
# 同じことを二度言うだけなので、数えない。
if ! out="$(python3 "tools/validate_data.py" 2>&1)"; then
  add_problem "python3 tools/validate_data.py が失敗しました:"$'\n'"$(summarize_fail "$out")"
fi

for ds in $DATASETS; do
  if ! out="$(python3 "tools/diff_data.py" "$ds" 2>&1)"; then
    add_problem "python3 tools/diff_data.py ${ds} が失敗しました:"$'\n'"$(summarize_fail "$out")"
  fi
done

# 今週あらたに書いた行が、中核の列で下限を割っていないか。
#
# 2026-09-02 の events は、この門が無いまま ERROR 0 で通ってコミットされた。
# 新規90件の `price_official` が0件・`price` が29件（32%）で、
# `report_stats.py` はその数字を**画面に出していた**が、良し悪しを判定しない
# 設計なので誰も止めなかった。「出ているだけでは守られない」という、
# agent-guard.sh の予算ゲートとまったく同じ壊れ方である（設計書 第9.1.5節）。
#
# **判定するのは今週そのスキルが集めたデータセットだけ**である。ここだけは
# DATASETS（ルーチン中は3つとも）を使わない。
#
# `data/.prev/<ds>.csv` は `append_rows.py <ds> --init` のときにしか更新されない。
# つまり **events を集めた翌日に movies を集めると、events 側は「現行455件 /
# 前回443件」のまま**で、新規90件・price 32% がそこに居座り続ける。DATASETS で
# 回すと、movies の回が「先週の events が薄い」ことを理由に止まる——その回の
# セッションには直しようがなく、8回の連続ブロックを空回りするだけになる。
# （実測: 2026-09-02 の直後、lives も fresh=55 で同じ状態にあった）
#
# 網羅性（`--check`）を置かないのも同じ理由だが、あちらはさらに強い——都県の
# 網羅性は「今週その都県を調べたか」の話なので、調べていないデータセットに
# 問うこと自体に意味が無い。網羅性は各SKILL.mdの終了工程がモデル自身に回させる。
#
# **コミットの門（claude-routine.sh）には足さない。** あちらで落とすと data/ が
# 巻き戻り、価格が薄いことを理由に**その週の収集がまるごと消える**——薄い週より
# 悪い結果になる。ここで止めれば、捨てずにその場で集め直せる。
# Stop フックは2周目に素通しするので、これは「1回だけの強い催促」である。
case "${ROUTINE_SKILL:-}" in
  kanto-event-collector) FRESH_DS="events" ;;
  kanto-live-collector)  FRESH_DS="lives" ;;
  kanto-movie-collector) FRESH_DS="movies" ;;
  *)                     FRESH_DS="" ;;
esac

if [ "$IS_ROUTINE" -eq 1 ] && [ -n "$FRESH_DS" ]; then
  if ! out="$(python3 "tools/report_stats.py" "$FRESH_DS" --check-fresh 2>&1)"; then
    add_soft_problem "python3 tools/report_stats.py ${FRESH_DS} --check-fresh が下限割れを検知しました:"$'\n'"$(summarize_fail "$out")"
  fi
fi

[ -n "$PROBLEMS" ] || [ -n "$SOFT_PROBLEMS" ] || exit 0

# decision:"block" の reason は Claude へのフィードバックとして戻り、そのまま
# 次に何をすべきかの指示になる。何が落ちたかだけでなく、直さずに終えると
# どうなるかまで書く（＝直す動機がフィードバックの中で完結する）。
build_reason() {
  if [ -n "$PROBLEMS" ]; then
    printf '%s\n' "終了前の検証が通っていません。以下を解消してから終えてください。"
    printf '\n%s\n' "$PROBLEMS"
    if [ "$IS_ROUTINE" -eq 1 ]; then
      printf '%s\n' "このまま終えると claude-routine.sh はコミットせず、data/ と docs/ を実行前の状態に戻します（今回の収集は失われます）。"
    fi
    printf '%s\n' "消滅の説明が要るなら tools/prev_rows.py <events|lives|movies> --dispose を、行の追記・持ち越しは tools/append_rows.py <events|lives|movies> を使ってください。"
    printf '%s\n' "残った前回行をまとめて片付けるなら tools/prev_rows.py <events|lives|movies> --carry-rest --apply（終了日を過ぎた行は expired で処分、残りは前回値のまま書き戻す）。ただし**これから調べる予定の行があるうちは使わないこと**——後から同じ公演を追記すると重複します。"
  fi

  if [ -n "$SOFT_PROBLEMS" ]; then
    [ -n "$PROBLEMS" ] && printf '\n%s\n' "----"
    printf '%s\n' "今週の収穫が、中核の列で下限を割っています。"
    printf '\n%s\n' "$SOFT_PROBLEMS"
    # 静的な文は**クォート付きヒアドキュメント**で出す。printf の書式に
    # 二重引用符を使うと、その中のバッククォートがコマンド置換として実行され、
    # 文面から黙って消える（実際に `budget.py --report` が消えた）。
    # このリポジトリの散文はコマンド名をバッククォートで囲む書き方で統一して
    # あるので、フックの文面でも同じ書き方が安全に通る形にしておく。
    cat <<'SOFT'
**この門はコミットを止めません。** 検証（validate_data.py / diff_data.py）が通っていれば、今週の収集はそのまま保存されます。止めているのはこのターンだけで、催促は1回だけです。
**だからこそ、推測で埋めて通さないこと。** 確認していない料金を書くのは、このスキルが最も強く禁じている行為です（空欄のほうが正しい）。予算が残っているなら、会場の料金ページを開いて実際に集めてください——残りは `python3 tools/budget.py --report` で確認できます。
本当に確認できないものばかりだったなら、`report_stats.py` に `--allow-thin <列名>` を付けて承知したことにし、**その理由を報告に書いてください**。
SOFT
  fi
}

# JSON を組み立てられなかったときに黙って exit 0 で抜けると、**検証が落ちている
# のにターンが終わる。** 以前は `| jq -Rs` の1本だけで、jq が使えない環境では
# 標準出力が空のまま exit 0 になっていた（＝止めるはずのフックが素通しになる）。
# 止められないなら止められないなりに、止める側へ倒す。
#
# Stop フックは exit 2 でもブロックでき、そのとき stderr がそのまま Claude への
# フィードバックになる。JSON が出せない場合はこちらを使う。
if command -v jq >/dev/null 2>&1; then
  build_reason | jq -Rs '{decision: "block", reason: .}' && exit 0
elif command -v python3 >/dev/null 2>&1; then
  build_reason | python3 -c 'import json,sys
print(json.dumps({"decision": "block", "reason": sys.stdin.read()}, ensure_ascii=False))' && exit 0
fi

build_reason >&2
exit 2
