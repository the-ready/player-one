#!/usr/bin/env python3
"""追記しようとしている波が「前回CSVの言い換え」になっていないかを見る。

## 何が起きたのか

2026-09-06 の events 収集で、東京105施設を2波に分けてHaikuのサブエージェントへ渡した。
片方は2回目の応答で「72施設全体を処理した」として92件を返したが、実体は前回CSV
（`data/.prev/events.csv`）の該当行をほぼ改変なしで再出力し、`price_checked` を全件
実行日に一律で書き換えていただけだった（`_carry:"*"` を100%の行に付与、個別の会場
ページへの取得は行われた形跡がない）。同時に走ったもう1波の86件も前回CSVの
pref フィルタ再出力に留まっていた。**両方とも破棄した**（`docs/skill-feedback.md`
2026-09-06）。

そのときセッション全体で記録されていた取得回数は44回である。145施設を回るには
構造的に足りない回数だが、**親がそれに気づいたのは、自分で個別にCSVを突き合わせた
後だった。** 判定に必要な数字はすべて機械の側にあったのに、誰も突き合わせていなかった。

## なぜ4条件の AND なのか

「`_carry:"*"` が多い」だけでは捏造と言えない。前回から続く催しを会場ページで
再確認し、変わっていないことを確かめて持ち越すのは、このタスクの**正しい主要動線**
である。「`price_checked` が実行日」も同じで、今日その価格を確認したなら正しい。

区別できるのは**取得回数**だけである。会場ページを開かずに「今日確認した」と書ける
行は、確認していない行しかない。だから

  1. 波が十分に大きい（小さい波は誤差で揺れる）
  2. `_carry:"*"` が大半
  3. `price_checked` が実行日の行が大半
  4. **前回の追記以降の取得回数が、この波の会場数より少ない**

の4つが揃ったときだけ言う。4が本体で、1〜3はそれだけでは何も意味しない。

## 止めない

警告だけを出し、追記そのものは通す。捏造かどうかを最終的に決めるのは中身であって、
この4条件ではない——**正しい仕事を機械が止めてしまうほうが、被害が大きい**
（取得の大半をキャッシュや一覧ページ1枚で済ませられる週は実在する）。
止める代わりに、親が破棄を判断できるだけの数字を並べる。

使い方（`append_rows.py` が自動で呼ぶ。手で叩く必要はない）:
    python3 -c "import carry_audit; print(carry_audit.audit('events.csv', rows))"
"""

import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import budget                                                 # noqa: E402
from validate_data import EXPECTED_HEADERS                    # noqa: E402

# この列を持たないデータセットでは何も見ない。`price_checked` は「今日その価格を
# 確認した」という主張そのもので、持ち越しが禁じられている列（`append_rows.py` の
# `CARRY_NEVER`）でもある。lives.csv にはこの列が無いので、対象は events / movies。
CHECKED_COL = "price_checked"

# 「場所の列」。取得回数と突き合わせる単位になる。1施設1回の取得で、その施設の
# 全行を確認できる設計なので、**会場数が、その波に最低限必要な取得回数**にあたる。
PLACE_COL = {"events.csv": "venue", "movies.csv": "theater", "lives.csv": "venue"}

# 小さい波では割合が揺れる（3行のうち3行が持ち越しでも何も言えない）。
MIN_ROWS = 20

# 「大半」の線。2026-09-06 の波は `_carry:"*"` 100% / `price_checked` 実行日 100% だった。
CARRY_RATIO = 0.8
CHECKED_RATIO = 0.8

# 前回の追記時点の取得回数を覚えておく場所。`budget.load()` は知らないキーを
# そのまま保持して返す（`setdefault` で足りない分だけ補う）ので、状態ファイルの
# 形を壊さずに1つ増やせる。`--reset` すれば一緒に消える。
FETCH_MARK = "fetch_at_last_append"


def _today():
    return datetime.date.today().isoformat()


def _fetch_delta():
    """前回の追記以降の取得回数と、いまの累計。数えられなければ (None, None)。

    累計ではなく差分を見る。累計は波を重ねるほど増えるので、後の波ほど
    「足りている」と誤って判定する側に倒れてしまう。

    **「計測できない」を「取得0回」と読まないこと。** `budget.load()` は状態ファイルが
    壊れていても・古くて数え直しになっても、例外ではなく全カウンタ0の状態を返す
    （収集の付随物である計測のせいで追記が落ちないための設計）。それをそのまま
    受け取ると、計測が効いていない回のすべての波が「取得0回」として疑われる。
    ここは `budget.py --gate` と同じく、**判定できないときは通す**側に倒す。
    """
    try:
        st = budget.load()
        totals = st.get("totals", {})
        total = int(totals.get("fetch", 0))
    except Exception:                                         # noqa: BLE001
        return None, None

    # カウンタが1つも動いていない＝この回の計測そのものが立ち上がっていない
    # （状態ファイルが無い・壊れている・12時間より古くて数え直された）。
    # 取得を1回もせずに追記まで来る回は、そもそも `run_gate.py` が検証で落とす。
    try:
        if not any(int(totals.get(k, 0)) > 0 for k in ("search", "fetch", "rows")):
            return None, None
    except (TypeError, ValueError):
        return None, None

    try:
        prev = int(st.get(FETCH_MARK, 0))
    except (TypeError, ValueError):
        prev = 0
    return max(total - prev, 0), total


def _remember_fetch(total):
    """いまの取得回数を「前回の追記時点」として記録する。失敗しても黙って諦める。"""
    if total is None:
        return
    try:
        st = budget.load()
        st[FETCH_MARK] = total
        budget.save(st)
    except Exception:                                         # noqa: BLE001
        pass


def audit(name, records, today=None):
    """疑わしければ警告文を、そうでなければ None を返す。**副作用として取得回数を記録する。**

    `records` は `append_rows.py` が標準入力から読んだ生のJSONL（`_carry` がまだ
    残っている状態）。`apply_carryover()` が `_carry` を pop する前に呼ぶこと。
    """
    place_col = PLACE_COL.get(name)
    delta, total = _fetch_delta()
    _remember_fetch(total)

    # そのデータセットが `price_checked` を**列として持っている**ことを確かめる。
    # 行に入っているかどうかで見ると、lives のように列を持たないCSVでも、子が
    # 間違えて付けた `price_checked` を根拠に判定してしまう（`append_rows.py` が
    # 「ない列があります」と警告して捨てる値であり、判断の根拠にはできない）。
    if CHECKED_COL not in EXPECTED_HEADERS.get(name, ()):
        return None

    if place_col is None or not records:
        return None

    n = len(records)
    if n < MIN_ROWS:
        return None

    # `_carry: "*"`（持ち越せる列すべて）だけを数える。列名を並べた指定は
    # 「どこを持ち越すか選んだ」＝中身を見た形跡なので、ここでは数えない。
    carried = sum(1 for r in records if str(r.get("_carry", "")).strip() == "*")
    if carried / n < CARRY_RATIO:
        return None

    today = today or _today()
    checked = sum(1 for r in records if (r.get(CHECKED_COL) or "").strip() == today)
    if checked / n < CHECKED_RATIO:
        return None

    places = {(r.get(place_col) or "").split("|")[0].strip()
              for r in records if (r.get(place_col) or "").strip()}
    if delta is None or not places:
        return None
    if delta >= len(places):
        return None

    return (
        f"この波の{n}件は、前回CSVの再出力かもしれません。中身を確かめてください。\n"
        f"    _carry:\"*\" が {carried}/{n}件（{carried / n:.0%}）"
        f" / {CHECKED_COL} が実行日({today}) の行が {checked}/{n}件（{checked / n:.0%}）\n"
        f"    ところが前回の追記以降の取得は {delta}回で、この波の会場数 {len(places)} に足りません。\n"
        "    会場ページを開かずに「今日確認した」と書ける行はありません。\n"
        "    2026-09-06 の events は同じ形（_carry 100% / price_checked 実行日 100% /\n"
        "    145施設に対し取得44回）で、92件と86件の2波をまるごと破棄しています。\n"
        "    本当に再確認した波なら、そのまま進めて構いません（この判定は止めません）。"
    )
