#!/bin/bash
#
# PreToolUse(Agent): 週次ルーチンの実行中、サブエージェントの**背景起動**を拒否する。
#
# 並行調査そのものは禁じない。7都県を分割して同時に調べるのは予算配分として
# 正しく、このタスクの調査能力を伸ばせる数少ない手段でもある。壊れたのは
# 起動の形のほうである。
#
# 2026-08-14 の events 収集は、4地域の調査を背景のサブエージェントに委ねた。
# 親セッションは結果を待たずに自分のターンを終えようとし、Stop フック
# （--init 直後の未完成CSVを検知）に止められて data/.prev/ から復元し、
# 「検証が通る状態に戻しました」で終了した。その約1秒後、ログに
#
#     Background tasks still running after 600s; terminating.
#
# が出ている。**4体ぶんの調査結果は、誰にも受け取られないまま破棄された。**
# 検索115回・取得154回・$3.65 を消費して、新規0件・変更0件である。
#
# 原因は「親が待てなかったこと」に尽きる。背景起動は、親に待つ義務を課さない
# ——待つかどうかがモデルの判断に委ねられ、判断を誤っても誰も気づけない。
# だから起動の形の側を塞ぐ。前景で起動すれば、結果が返るまで親のターンは
# 進まないので、**待ち忘れが原理的に起きない。**
#
# Agent ツールの既定は背景起動である。したがって「true のときだけ拒否」では
# 素通りする。**run_in_background に false が明示されていないものを拒否する。**
# 既定値に依存しない書き方を求めるのは冗長に見えるが、既定が変わったときに
# 黙って壊れるのはこの種のガードで最も起きやすい壊れ方である。
#
# 対話セッションでは発火させない。人が背景エージェントを使うのは当然で、
# 待つかどうかをその場で判断できる。見分けには claude-routine.sh が export する
# CLAUDE_ROUTINE を使う（block-git.sh と同じ）。
#
# ## もうひとつ拒否するもの —— 前の波を書き切らないまま次を投げること
#
# 背景起動を塞いでも、**受け取った結果を追記しないまま次の波を投げる**という
# 抜け方が残っていた。2026-08-27 の movies 収集は、2つの波が90行を調べ終えて
# ファイルに書きながら、一度も append_rows.py を通さずに打ち切られている
# （あとで追記して検証を流し直すと通る＝調査は成功していた）。
#
# 「1つの波を書き切ってから次を投げる」は各SKILL.mdが以前から書いている規則で、
# **書いてあるだけでは守られなかった。** 判定は tools/wave_gate.py に置く
# （行がCSVに在るかを数えるだけなので、shell では書けない）。
#
# ## 三つめ —— 子への指示に、抜粋（手順書）が付いていないこと
#
# 2026-09-02 の events 収集は、`skill_brief.py` を1回実行しておきながら、
# その抜粋を子に渡さなかった。親（当時は Haiku）は代わりに自作の1〜2KBの指示を
# 書き、そこから **`price_official` `price_checked` `price_best` `coupon_note` が
# 一語も残らなかった。** 子は書けと言われていない列を書けないので、新規90件の
# 公式料金は0件で終わっている。
#
# SKILL.md は「サブエージェントへの指示に必ず含めること（省略禁止）」として
# 5項目を挙げていたが、**挙げてあるだけでは守られなかった。** 5項目のうち
# 「抜粋を渡す」だけは機械的に確認できる（指示にパスが書いてあるか）ので、
# ここを門にする。抜粋さえ届けば、残りの4項目は抜粋の中にある。
#
# ## 四つめ —— 残量が尽きているのに投げること
#
# 同じ位置で「まだ投げてよい残量があるか」も見る（tools/budget.py --gate）。
# 25M で新しい波を止め、40M で撤退させる線は、これまで --report の表示でしか
# 伝えていなかった。表示は早すぎる側にも遅すぎる側にも外れる。
#
set -u

[ "${CLAUDE_ROUTINE:-0}" = "1" ] || exit 0

INPUT="$(cat)"

# 入力を読めなかったときは拒否側に倒す（block-git.sh と同じ判断）。
# 素通しは「待たれないサブエージェント」を通すことであり、それは
# このフックが唯一防いでいる事故そのものである。判定できないなら止める。
#
# jq の `//` は使えない。あれは左辺が false のときも右辺に落ちる演算子なので、
# `run_in_background: false`（＝まさに通したい入力）が「未指定」と同じ値になる。
# 有無は has() で見て、値は別に取り出す。
BG=""
if command -v jq >/dev/null 2>&1; then
  BG="$(printf '%s' "$INPUT" | jq -r '
        (.tool_input // {})
        | if has("run_in_background")
          then (.run_in_background | tostring)
          else "__ABSENT__" end')" \
    || BG="__PARSE_FAILED__"
elif command -v python3 >/dev/null 2>&1; then
  BG="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    v = json.load(sys.stdin).get("tool_input", {}).get("run_in_background", "__ABSENT__")
except Exception:
    print("__PARSE_FAILED__"); raise SystemExit(0)
print("__ABSENT__" if v == "__ABSENT__" else str(bool(v)).lower())' 2>/dev/null)" \
    || BG="__PARSE_FAILED__"
else
  BG="__PARSE_FAILED__"
fi

[ -n "$BG" ] || BG="__PARSE_FAILED__"

if [ "$BG" = "false" ]; then
  # 前の波の結果がCSVに入っているかを見る。入っていなければ止める。
  #
  # exit 1（未消化あり）でだけ拒否する。**判定できないときの exit 2 や、
  # python3 が無い場合の失敗では止めない**——このゲートが見ているのは
  # 「自分の取りこぼし」であって、外部への迷惑ではない。判定に失敗したことを
  # 理由に収集そのものを止めると、被害のほうが大きい（背景起動の判定を
  # 拒否側に倒しているのとは、守っている対象が違う）。
  GATE_REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
  if command -v python3 >/dev/null 2>&1 && [ -f "$GATE_REPO/tools/wave_gate.py" ]; then
    GATE_OUT="$(python3 "$GATE_REPO/tools/wave_gate.py" --check 2>&1)"
    GATE_RC=$?
    if [ "$GATE_RC" -eq 1 ]; then
      printf '%s\n' "$GATE_OUT" >&2
      exit 2
    fi
  fi

  # 子への指示に、抜粋（`temp/brief-<ds>.md`）への参照があるか。
  #
  # 中身までは見ない——見ようとすると「何が書いてあれば十分か」を shell で
  # 判定することになり、抜粋の側を変えるたびにここが古くなる。見るのは
  # 「手順書を渡したか」だけで、渡してさえいれば規則は抜粋が運ぶ。
  #
  # 倒し方は wave_gate と同じで、判定できないときは通す。ROUTINE_SKILL が
  # 無い・jq も python3 も無い、といった場合に収集そのものを止めるのは行き過ぎである。
  case "${ROUTINE_SKILL:-}" in
    kanto-event-collector) BRIEF_DS="events" ;;
    kanto-live-collector)  BRIEF_DS="lives" ;;
    kanto-movie-collector) BRIEF_DS="movies" ;;
    *)                     BRIEF_DS="" ;;
  esac
  BRIEF=""
  [ -n "$BRIEF_DS" ] && BRIEF="temp/brief-${BRIEF_DS}.md"

  if [ -n "$BRIEF" ] && command -v python3 >/dev/null 2>&1; then
    HAS_BRIEF="$(printf '%s' "$INPUT" | BRIEF="$BRIEF" python3 -c 'import json,os,sys
try:
    p = json.load(sys.stdin).get("tool_input", {}).get("prompt", "")
except Exception:
    print("unknown"); raise SystemExit(0)
print("yes" if os.environ["BRIEF"] in p else "no")' 2>/dev/null)"

    # パスを書いてあっても、ファイルが無ければ子は Read に失敗して規則を
    # 一つも受け取らないまま調べ始める。**「書いたつもり」で素通りする経路**が
    # ここに残っていると、このゲートは何も守っていないのと同じになる。
    if [ "$HAS_BRIEF" = "yes" ] && [ ! -f "$GATE_REPO/$BRIEF" ]; then
      cat >&2 <<MSG
指示は ${BRIEF} を参照していますが、そのファイルがありません。子は Read に失敗し、規則を一つも受け取らないまま調べ始めます。

  先にこれを実行してください:
    python3 tools/skill_brief.py ${BRIEF_DS} --out ${BRIEF}
MSG
      exit 2
    fi

    if [ "$HAS_BRIEF" = "no" ]; then
      cat >&2 <<MSG
サブエージェントへの指示に、抜粋（${BRIEF}）への参照がありません。

  1. まだ作っていなければ、1回だけ作る:
       python3 tools/skill_brief.py ${BRIEF_DS} --out ${BRIEF}
  2. 指示に次の1文を入れて起動し直す:
       まず ${BRIEF} を Read し、そこに書かれた規則に従って調査すること。

**抜粋を貼らないこと。** 貼ると親が「抜粋ぶんの出力トークン × 体数」を払うことになり、
払えないと判断した親は自作の要約に逃げます。2026-09-02 の events 収集が実際にそうなり、
自作の指示から料金の列（price_official / price_checked / price_best / coupon_note）が
丸ごと落ちて、新規90件の公式料金が0件になりました。
パスだけを書けば、子が自分で読みます。
MSG
      exit 2
    fi
  fi

  # 残量の側も見る。「まだ投げてよいか」を決める瞬間はここしかない。
  #
  # 25M / 40M の線は budget.py が --report に文字で出していたが、**出ているだけでは
  # 守られなかった**（2026-08-29 は線に届かないまま4波で畳み、2026-08-27 は 40M の
  # 警告の3分16秒後に殺されている。docs/routine-postmortems.md）。表示は早すぎる側にも
  # 遅すぎる側にも外れ、外れたことに誰も気づけない。判断そのものを門にする。
  #
  # 倒し方は上の wave_gate と同じで、exit 1（線を越えた）でだけ拒否する。判定できない
  # とき（exit 2）や python3 が無いときは通す——計測できないことを理由に収集を止めると、
  # 被害のほうが大きい。
  if command -v python3 >/dev/null 2>&1 && [ -f "$GATE_REPO/tools/budget.py" ]; then
    BUDGET_OUT="$(python3 "$GATE_REPO/tools/budget.py" --gate 2>&1)"
    BUDGET_RC=$?
    if [ "$BUDGET_RC" -eq 1 ]; then
      printf '%s\n' "$BUDGET_OUT" >&2
      exit 2
    fi
  fi

  exit 0
fi

if [ "$BG" = "__PARSE_FAILED__" ]; then
  echo "フックの入力を解析できませんでした（jq / python3 が使えない可能性）。安全側に倒して Agent を拒否します。" >&2
  exit 2
fi

# reason は Claude へのフィードバックとしてそのまま戻る。何が駄目かだけでなく、
# 代わりに何を書けばよいかまで書く（＝直す動機と手順がこの中で完結する）。
cat >&2 <<'MSG'
週次ルーチンでは、サブエージェントを背景で起動できません。

  run_in_background: false を明示して起動し直してください。

並行調査そのものは禁止していません。禁止しているのは「親が待たない形」だけです。
背景で起動すると、親が先にターンを終えたときにサブエージェントは強制終了され、
調査結果はまるごと失われます（2026-08-14 に実際に起きました。検索115回を
消費して新規0件）。

あわせて、以下を守ってください。

  - サブエージェントは**調査のみ**を行い、data/ には書かない
  - 結果は temp/rows-<波の名前>.jsonl に子自身が書き、返答にはパスと件数だけを返す
  - **1つの波の結果を append_rows.py で書き切ってから、次の波を投げる**
    （書いていないと、次の Agent 起動をこのフックが拒否します）
  - **親が全ての結果を append_rows.py で書き終えるまで、ターンを終えない**
  - worktree 隔離（isolation: "worktree"）は不要です。サブエージェントは
    書き込まないので隔離する対象が無く、隔離すると名簿の更新も破棄されます
MSG
exit 2
