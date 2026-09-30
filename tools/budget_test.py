#!/usr/bin/env python3
"""`tools/budget.py --gate` / `--gate-fetch` が、止めるべきものだけを止めるかを検証する
（ネットワーク不要）。

    python3 tools/budget_test.py

## なぜ念入りにやるか

`--gate` は `PreToolUse(Agent)` から、`--gate-fetch` は `PreToolUse(WebSearch/Bash)`
から自動で走り、どちらも**サブエージェントの取得を拒否できる**。`wave_gate.py` と
同じ位置にあり、同じ危うさを持つ——誤って止めれば収集が進まないまま利用上限まで空転する。

線そのもの（`CACHE_READ_NO_NEW_WAVE` / `CACHE_READ_RETREAT`）の値は実測の警告線でしかなく、
ここで固定したいのはその値ではない。固定するのは**倒し方**である。

  - 線に届いていなければ通す
  - 線を越えたら止め、次に何をすべきかを stderr に書く（フックはこれをそのまま Claude に返す）
  - **判定できないときは通す。** 計測できないことを理由に収集を止めると、被害のほうが大きい

`--gate` と `--gate-fetch` の違いは1点だけである。`--gate` は `CACHE_READ_NO_NEW_WAVE`
（新しい波を止める）と `CACHE_READ_RETREAT`（撤退）の2段だが、`--gate-fetch` は
**撤退の線だけ**を見る——その間は「動いている波は受け取って書き切る」設計なので、
波の途中の取得まで止めると波を書き切れなくなる。
"""

import contextlib
import io
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import budget                                                 # noqa: E402

# main() が既定で差し替える前の本物（標本の読み書きそのものを確かめる検証が使う）
REAL_METER = budget.meter


def run_gate(cache_read):
    """`token_usage()` を差し替えて `gate()` を呼び、終了コードと stderr を返す。

    セッションの記録（`~/.claude/projects/.../*.jsonl`）を作って読ませる方式は採らない。
    あの形式は Claude Code 側の都合で変わりうるもので、ここで確かめたいのは
    「読めた数字をどう扱うか」だけである。
    """
    orig = budget.token_usage
    budget.token_usage = lambda: (None if cache_read is None
                                  else {"total": {"cache_read": cache_read}})
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            rc = budget.gate()
    finally:
        budget.token_usage = orig
    return rc, err.getvalue()


def check_under_line_passes():
    rc, err = run_gate(budget.CACHE_READ_NO_NEW_WAVE - 1)
    if rc != 0:
        return f"線の手前なのに exit={rc}"
    return err == "" or f"線の手前で何か出力している: {err!r}"


def check_zero_passes():
    rc, _ = run_gate(0)
    return rc == 0 or f"消費0なのに exit={rc}"


def check_no_new_wave_blocks():
    rc, err = run_gate(budget.CACHE_READ_NO_NEW_WAVE)
    if rc != 1:
        return f"NO_NEW_WAVE ちょうどで止まらなかった: exit={rc}"
    # 何をすべきかが書かれていること（フックの reason がそのまま指示になる）
    return "append_rows.py" in err or f"次の行動が書かれていない: {err!r}"


def check_retreat_blocks_with_retreat_wording():
    rc, err = run_gate(budget.CACHE_READ_RETREAT)
    if rc != 1:
        return f"RETREAT で止まらなかった: exit={rc}"
    if "撤退" not in err:
        return f"撤退の指示になっていない: {err!r}"
    # NO_NEW_WAVE と RETREAT で言うことが違わないと、線を2段に分けた意味が無い
    _, mild = run_gate(budget.CACHE_READ_NO_NEW_WAVE)
    return mild != err or "NO_NEW_WAVE と RETREAT で同じ文言を返している"


def check_unmeasurable_passes():
    """**ここがいちばん大事。** 計測できないときに素通しにする。"""
    rc, err = run_gate(None)
    if rc == 1:
        return "計測できないことを理由に起動を拒否している（素通しにすべき）"
    if rc != 2:
        return f"判定不能は exit=2 のはずが exit={rc}"
    return err.strip() != "" or "理由が書かれていない"


# ---------------------------------------------------------- gate_fetch()
#
# `gate()` が「次の波を投げてよいか」（PreToolUse:Agent）を見るのに対し、
# `gate_fetch()` は「波の途中の1回の取得をしてよいか」（PreToolUse:WebSearch/Bash）
# を見る。2026-09-04 は最初の波そのものが40M（当時の撤退の線）を越えて殺され、
# `gate()` の門が一度も開く機会を持たなかった（`gate_fetch()` の docstring）。
# 線は撤退（`CACHE_READ_RETREAT`）だけを見て、その手前（「動いている波は受け取って
# 書き切る」区間）は取得を止めない——`gate()` との違いはここに集約されるので、そこを固定する。

def run_gate_fetch(cache_read):
    orig = budget.token_usage
    budget.token_usage = lambda: (None if cache_read is None
                                  else {"total": {"cache_read": cache_read}})
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            rc = budget.gate_fetch()
    finally:
        budget.token_usage = orig
    return rc, err.getvalue()


def check_fetch_under_retreat_passes():
    rc, err = run_gate_fetch(budget.CACHE_READ_RETREAT - 1)
    if rc != 0:
        return f"撤退線の手前なのに exit={rc}"
    return err == "" or f"線の手前で何か出力している: {err!r}"


def check_fetch_between_no_new_wave_and_retreat_passes():
    """**`gate()` との違いの核心。** NO_NEW_WAVE〜RETREATの間では「動いている波は書き切る」ので、
    `gate()` は止めても `gate_fetch()` は止めてはいけない。
    """
    cr = (budget.CACHE_READ_NO_NEW_WAVE + budget.CACHE_READ_RETREAT) // 2
    rc, err = run_gate_fetch(cr)
    if rc != 0:
        return f"NO_NEW_WAVE〜RETREATの間は取得を止めないはずが exit={rc}（err={err!r}）"
    return True


def check_fetch_retreat_blocks():
    rc, err = run_gate_fetch(budget.CACHE_READ_RETREAT)
    if rc != 1:
        return f"RETREAT ちょうどで止まらなかった: exit={rc}"
    return ("波の途中でも" in err and "temp/rows-" in err) or f"次の行動が書かれていない: {err!r}"


def check_fetch_unmeasurable_passes():
    rc, err = run_gate_fetch(None)
    if rc == 1:
        return "計測できないことを理由に取得を拒否している（素通しにすべき）"
    if rc != 2:
        return f"判定不能は exit=2 のはずが exit={rc}"
    return err.strip() != "" or "理由が書かれていない"


# ---------------------------------------------------------- 重複を除いた数え方
#
# 記録は応答1回をブロックごとに1行ずつ書き、どの行にも同じ usage を載せる。
# 行を素朴に足していた頃は実際の1.85〜2.36倍を数え、`maxTurns: 60` で止まった
# 子を「119ターン」と表示していた（`_scan()` の docstring）。

def _write_transcript(lines):
    fd, path = tempfile.mkstemp(suffix=".jsonl")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        for rec in lines:
            f.write(json.dumps(rec) + "\n")
    return path


def _resp(mid, cr, out=10, block="text"):
    return {"type": "assistant", "requestId": "req_" + str(mid),
            "message": {"id": mid, "content": [{"type": block}],
                        "usage": {"cache_read_input_tokens": cr,
                                  "cache_creation_input_tokens": 5,
                                  "input_tokens": 1, "output_tokens": out}}}


def check_scan_dedupes_blocks():
    # 応答A（思考・本文・ツール呼び出しの3行）と応答B（1行）
    path = _write_transcript([
        _resp("msg_A", 1000, block="thinking"), _resp("msg_A", 1000, block="text"),
        _resp("msg_A", 1000, block="tool_use"),
        {"type": "user", "message": {"content": [{"type": "tool_result"}]}},
        _resp("msg_B", 2000),
    ])
    try:
        t, turns = budget._scan(path)
    finally:
        os.remove(path)
    if turns != 2:
        return f"応答2回のはずが {turns}ターン（ブロックの行数を数えている）"
    if t["cache_read"] != 3000:
        return f"文脈再送は 3000 のはずが {t['cache_read']}"
    if t["output"] != 20:
        return f"出力は 20 のはずが {t['output']}"
    return t["context"] == 2006 or f"現在の文脈は最後の応答の 2006 のはずが {t['context']}"


def check_scan_counts_lines_without_id():
    # id も requestId も無い行は重複を判定できないので、1行を1回として数える
    rec = {"type": "assistant", "message": {"usage": {"cache_read_input_tokens": 7}}}
    path = _write_transcript([rec, rec])
    try:
        t, turns = budget._scan(path)
    finally:
        os.remove(path)
    return (turns == 2 and t["cache_read"] == 14) or f"id の無い行: turns={turns} cr={t['cache_read']}"


# ---------------------------------------------------------- 実際の利用率

EVENT_NEW = {"type": "rate_limit_event", "rate_limit_info": {
    "status": "allowed", "resetsAt": 1790770200, "rateLimitType": "five_hour",
    "unifiedWindows": {"five_hour": {"utilization": 0.7, "resetsAt": 1790770200},
                       "seven_day": {"utilization": 0.63, "resetsAt": 1791061200}}}}
EVENT_OLD = {"type": "rate_limit_event", "rate_limit_info": {
    "status": "allowed_warning", "rateLimitType": "five_hour", "utilization": 0.93,
    "resetsAt": 1790770200}}


def check_parse_event():
    a = budget.parse_rate_limit_event(EVENT_NEW)
    if not a or a["five_hour"]["u"] != 0.7 or a["seven_day"]["u"] != 0.63:
        return f"新しい形式を読めていない: {a}"
    b = budget.parse_rate_limit_event(EVENT_OLD)
    if not b or b["five_hour"]["u"] != 0.93 or b["seven_day"] is not None:
        return f"最上位だけの形式を読めていない: {b}"
    for other in ({"type": "result"}, {"type": "rate_limit_event"}, "x", None):
        if budget.parse_rate_limit_event(other) is not None:
            return f"対象外を標本にしている: {other!r}"
    return True


@contextlib.contextmanager
def isolated_state(history=None):
    """標本・履歴の置き場を一時ディレクトリへ移す（本物の data/.run を汚さない）。"""
    names = ("RATELIMIT", "RATELIMIT_RUN", "RATELIMIT_HISTORY", "PROBE_LOCK", "STATE_DIR")
    saved = {n: getattr(budget, n) for n in names}
    with tempfile.TemporaryDirectory() as d:
        budget.STATE_DIR = d
        for n in names[:-1]:
            setattr(budget, n, os.path.join(d, os.path.basename(saved[n])))
        if history is not None:
            with open(budget.RATELIMIT_HISTORY, "w", encoding="utf-8") as f:
                for h in history:
                    f.write(json.dumps(h) + "\n")
        try:
            yield d
        finally:
            for n, v in saved.items():
                setattr(budget, n, v)


def check_record_and_staleness():
    with isolated_state():
        n = budget.record_stream([json.dumps({"type": "system"}), json.dumps(EVENT_NEW)])
        if n != 1:
            return f"イベント1件のはずが {n}件保存"
        m = REAL_METER()
        if not m or m["five_hour"]["u"] != 0.7:
            return f"保存した標本を読めない: {m}"
        orig = budget._now
        budget._now = lambda: orig() + budget.METER_MAX_AGE_SEC + 1
        try:
            stale = REAL_METER()
        finally:
            budget._now = orig
        return stale is None or "古い標本を判定に使っている"


def _sample(five=None, seven=None, status="allowed", seven_reset=None):
    return {"five_hour": None if five is None else {"u": five, "reset": None},
            "seven_day": None if seven is None else {"u": seven, "reset": seven_reset},
            "status": status, "at": budget._now()}


def check_verdict_five_hour():
    v = lambda f: budget.meter_verdict(_sample(five=f))[0]
    got = (v(budget.FIVE_HOUR_NO_NEW_WAVE - 0.01), v(budget.FIVE_HOUR_NO_NEW_WAVE),
           v(budget.FIVE_HOUR_RETREAT))
    if got != (0, 1, 2):
        return f"5時間枠の水準が (0,1,2) のはずが {got}"
    return budget.meter_verdict(_sample(status="rejected"))[0] == 2 or "rejected を撤退にしていない"


def check_remaining_runs():
    # 2026-09-30（水）20:00 JST から 10/04（日）06:00 JST まで → 木・金の2回
    import datetime
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("Asia/Tokyo")
    now = datetime.datetime(2026, 9, 30, 20, 0, tzinfo=tz).timestamp()
    until = datetime.datetime(2026, 10, 4, 6, 0, tzinfo=tz).timestamp()
    orig = budget._scheduled_days
    budget._scheduled_days = lambda: {3, 4, 5}
    try:
        a = budget.remaining_runs(until, now)
        # 水曜 02:00（起動の30分前）なら、その日の回も数える
        early = datetime.datetime(2026, 9, 30, 2, 0, tzinfo=tz).timestamp()
        b = budget.remaining_runs(until, early)
        c = budget.remaining_runs(None, now)
    finally:
        budget._scheduled_days = orig
    if (a, b, c) != (2, 3, 0):
        return f"残りの回数が (2,3,0) のはずが {(a, b, c)}"
    real = budget._scheduled_days()
    return bool(real) or "weekly-routine/SKILL.md の ```schedule から曜日を読めない"


def check_reserve_from_history():
    h = lambda a, b, r1=1, r2=1: {"start": {"seven_day": {"u": a, "reset": r1}},
                                  "end": {"seven_day": {"u": b, "reset": r2}}}
    with isolated_state(history=[]):
        if budget.reserve_per_run() != budget.SEVEN_DAY_RESERVE_DEFAULT:
            return "実測が無いのに既定値を使っていない"
    # 最後の3件は途中で枠がリセットされた回。差は1回ぶんを表さないので数えない
    # （数えると中央値が 0.07 から動く。負の差だけでなく、正の差でも除くこと）
    with isolated_state(history=[h(0.1, 0.16), h(0.2, 0.28), h(0.3, 0.37),
                                 h(0.5, 0.1, 1, 2), h(0.1, 0.9, 1, 2), h(0.1, 0.9, 1, 2)]):
        got = budget.reserve_per_run()
        if abs(got - 0.07) > 1e-9:
            return f"中央値 0.07 のはずが {got}"
    with isolated_state(history=[h(0.1, 0.9)]):
        if budget.reserve_per_run() != budget.SEVEN_DAY_RESERVE_MAX:
            return "上限で抑えていない"
    return True


def check_verdict_seven_day_reserves_later_runs():
    with isolated_state(history=[]):
        orig = budget.remaining_runs
        budget.remaining_runs = lambda until, now=None: 2
        try:
            line = budget.SEVEN_DAY_CEILING - 2 * budget.SEVEN_DAY_RESERVE_DEFAULT
            lo = budget.meter_verdict(_sample(seven=line - 0.01))[0]
            hi = budget.meter_verdict(_sample(seven=line))[0]
            top = budget.meter_verdict(_sample(seven=budget.SEVEN_DAY_RETREAT))[0]
        finally:
            budget.remaining_runs = orig
    return (lo, hi, top) == (0, 1, 2) or f"7日枠の水準が (0,1,2) のはずが {(lo, hi, top)}"


@contextlib.contextmanager
def meter_is(sample):
    om, op = budget.meter, budget.probe
    budget.meter = lambda max_age=None: sample
    budget.probe = lambda timeout=None: None
    try:
        yield
    finally:
        budget.meter, budget.probe = om, op


def check_gate_prefers_meter():
    # 利用率が読めるなら、文脈再送が線を越えていても利用率で決める（逆も同じ）
    with meter_is(_sample(five=0.5, seven=0.1)):
        rc, _ = run_gate(budget.CACHE_READ_RETREAT * 2)
        if rc != 0:
            return f"利用率に余裕があるのに文脈再送で止めた: exit={rc}"
    with meter_is(_sample(five=budget.FIVE_HOUR_NO_NEW_WAVE, seven=0.1)):
        rc, err = run_gate(0)
        if rc != 1 or "append_rows.py" not in err:
            return f"5時間枠が線を越えたのに止めない／次の行動が無い: exit={rc} {err!r}"
    return True


def check_gate_fetch_meter_only_retreat():
    with meter_is(_sample(five=budget.FIVE_HOUR_NO_NEW_WAVE)):
        rc, _ = run_gate_fetch(0)
        if rc != 0:
            return "新しい波を止める水準で、波の途中の取得まで止めている"
    with meter_is(_sample(five=budget.FIVE_HOUR_RETREAT)):
        rc, err = run_gate_fetch(0)
        if rc != 1 or "temp/rows-" not in err:
            return f"撤退の水準で取得を止めない: exit={rc} {err!r}"
    return True


def check_probe_env_drops_session():
    os.environ["CLAUDE_CODE_SESSION_ID"] = "parent-session"
    os.environ["CLAUDE_ROUTINE"] = "1"
    try:
        env = budget._probe_env()
    finally:
        del os.environ["CLAUDE_CODE_SESSION_ID"], os.environ["CLAUDE_ROUTINE"]
    if "CLAUDE_CODE_SESSION_ID" in env or "CLAUDE_ROUTINE" in env:
        return "測定用のセッションに本体の素性を渡している"
    return "PATH" in env or "環境をまるごと捨てている（認証・PATHが届かない）"


CHECKS = [
    ("線の手前は通す", check_under_line_passes),
    ("消費0は通す", check_zero_passes),
    ("NO_NEW_WAVEで止め、次の行動を書く", check_no_new_wave_blocks),
    ("RETREATは撤退の文言で止める", check_retreat_blocks_with_retreat_wording),
    ("判定できないときは通す", check_unmeasurable_passes),
    ("gate_fetch: 撤退線の手前は通す", check_fetch_under_retreat_passes),
    ("gate_fetch: NO_NEW_WAVE〜RETREATは取得を止めない（波を書き切る猶予）", check_fetch_between_no_new_wave_and_retreat_passes),
    ("gate_fetch: RETREATで波の途中でも取得を止める", check_fetch_retreat_blocks),
    ("gate_fetch: 判定できないときは通す", check_fetch_unmeasurable_passes),
    ("記録: 応答1回をブロックの行数で重ねて数えない", check_scan_dedupes_blocks),
    ("記録: id の無い行は1行を1回として数える", check_scan_counts_lines_without_id),
    ("利用率: rate_limit_event を読む（新旧の形式・対象外）", check_parse_event),
    ("利用率: 保存した標本を読み、古い標本は使わない", check_record_and_staleness),
    ("利用率: 5時間枠の2段の線と rejected", check_verdict_five_hour),
    ("利用率: リセットまでに残る定期実行の回数", check_remaining_runs),
    ("利用率: 1回ぶんを履歴の中央値から取る", check_reserve_from_history),
    ("利用率: 7日枠は後の回の分を残す位置で止める", check_verdict_seven_day_reserves_later_runs),
    ("gate: 利用率が読めればそちらで決める", check_gate_prefers_meter),
    ("gate_fetch: 利用率でも撤退の水準だけを見る", check_gate_fetch_meter_only_retreat),
    ("probe: 測定用セッションに本体の素性を渡さない", check_probe_env_drops_session),
]


def main():
    fails = 0
    # **本物の利用率を読ませない・測らせない。** 既定を「読めない」にしておくと、
    # 文脈再送の線の検証（上の9件）がこの機体の data/.run の標本に左右されず、
    # 本物の `claude -p` を起動して課金することも無い。
    budget.meter = lambda max_age=None: None
    budget.probe = lambda timeout=None: None
    for name, fn in CHECKS:
        try:
            got = fn()
        except Exception as e:                                # noqa: BLE001
            got = f"{type(e).__name__}: {e}"
        if got is not True:
            print(f"✗ {name}\n    {got}")
            fails += 1
    print(f"\n{len(CHECKS) - fails}/{len(CHECKS)} 件が期待どおり")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
