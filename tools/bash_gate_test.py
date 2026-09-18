#!/usr/bin/env python3
"""`tools/bash_gate.py` が、検証の出力を切る呼び出しだけを止めるかを検証する（ネットワーク不要）。

    python3 tools/bash_gate_test.py

## なぜ念入りにやるか

このゲートは `Bash` を塞ぐ。`Bash` はこのタスクで最も回数の多いツールで、
誤検知は**波を書き切って終える手段そのもの**を奪う（`append_rows.py` も
`validate_data.py` も `Bash` から呼ぶ）。

固定したいのは、**不変規則が名指ししている2つだけを見ること**である。

  - `diff_data.py` / `validate_data.py` の**後ろ**のパイプだけを見る
  - `&&` `;` `||` で繋いだ後段も見る（1コマンドに複数入る）
  - `report_stats.py` は見ない（規則が名指ししていない）
  - 検証ツールの**前**のパイプは、出力を切っていない
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bash_gate                                               # noqa: E402


def cut(cmd):
    return bash_gate.cuts_verification(cmd)


# --- 止めるべきもの -------------------------------------------------------

def check_diff_head_blocks():
    """2026-08-29 15:30 の events。`| head -20` で8件を二重掲載した。"""
    return cut("python3 tools/diff_data.py events | head -20") == "diff_data.py" \
        or "diff_data.py | head を見逃した"


def check_diff_grep_blocks():
    return cut("python3 tools/diff_data.py lives | grep 新規") == "diff_data.py" \
        or "grep を見逃した"


def check_validate_blocks():
    return cut("python3 tools/validate_data.py | tail -30") == "validate_data.py" \
        or "validate_data.py | tail を見逃した"


def check_second_segment_blocks():
    """`&&` で繋いだ後段も見る。"""
    cmd = ("python3 tools/append_rows.py events < temp/rows-a.jsonl"
           " && python3 tools/diff_data.py events | head -5")
    return cut(cmd) == "diff_data.py" or "&& の後段を見逃した"


def check_semicolon_segment_blocks():
    return cut("cd /repo; python3 tools/diff_data.py movies | rg 消滅") == "diff_data.py" \
        or "; の後段を見逃した"


def check_sed_n_blocks():
    return cut("python3 tools/diff_data.py events | sed -n '1,20p'") == "diff_data.py" \
        or "sed -n を見逃した"


# --- 通すべきもの ---------------------------------------------------------

def check_plain_diff_passes():
    return cut("python3 tools/diff_data.py events") is None or "素の実行を止めた"


def check_report_stats_passes():
    """規則が名指ししていないものまで止めると、規則そのものが信用されなくなる。"""
    return cut("python3 tools/report_stats.py events --check | head -3") is None \
        or "report_stats.py を止めた（規則が名指ししていない）"


def check_prev_rows_passes():
    return cut("python3 tools/prev_rows.py events --worklist | head -40") is None \
        or "prev_rows.py を止めた"


def check_budget_passes():
    return cut("python3 tools/budget.py --report | head -3") is None or "budget.py を止めた"


def check_upstream_pipe_passes():
    """検証ツールの**前**のパイプは、出力を切っていない。"""
    return cut("cat temp/rows-a.jsonl | python3 tools/validate_data.py") is None \
        or "前段のパイプを出力の切り詰めと誤認した"


def check_unrelated_head_passes():
    return cut("cat temp/brief-events.md | head -5") is None or "無関係な head を止めた"


def check_empty_passes():
    return cut("") is None or "空のコマンドで止めた"


def check_separate_segment_head_passes():
    """別のコマンドの `head` を、前の検証コマンドに紐づけない。"""
    cmd = "python3 tools/diff_data.py events && wc -l data/events.csv | head -1"
    return cut(cmd) is None or "別コマンドの head を検証に紐づけた"


# --- curl / wget -----------------------------------------------------------
#
# **塞ぐ理由が他と違う。** これは自分の取りこぼしではなく相手のサイトへの迷惑で、
# `curl` は robots.txt の判定も Crawl-delay の消化も通らない。
# 実測で必要性が出た経路でもある——`fetch_mix.py` の催促を Haiku に当てたところ、
# 代わりに `curl -s https://example.com/ | grep ...` を提案してきた。

def check_curl_remote_blocks():
    return bash_gate.raw_fetch("curl -s https://example.com/theater/schedule") == "curl" \
        or "curl の外部取得を見逃した"


def check_wget_remote_blocks():
    return bash_gate.raw_fetch("wget -qO- https://example.com/x") == "wget" \
        or "wget の外部取得を見逃した"


def check_curl_in_pipeline_blocks():
    return bash_gate.raw_fetch("echo start && curl -sL https://example.com/ | head -5") == "curl" \
        or "&& の後段の curl を見逃した"


def check_curl_localhost_passes():
    """`smoke_test.mjs` が立てるローカルサーバーは塞がない。"""
    if bash_gate.raw_fetch("curl -s http://localhost:8000/index.html"):
        return "localhost への curl を止めた"
    return (bash_gate.raw_fetch("curl -s http://127.0.0.1:8000/") is None) \
        or "127.0.0.1 への curl を止めた"


def check_curl_without_url_passes():
    if bash_gate.raw_fetch("curl --version"):
        return "URL を伴わない curl を止めた"
    return (bash_gate.raw_fetch("which curl") is None) or "which curl を止めた"


def check_url_in_other_command_passes():
    """URL を含むだけの無関係なコマンドは止めない。"""
    return (bash_gate.raw_fetch("echo https://example.com/ >> temp/memo.txt") is None) \
        or "curl でないのに止めた"


def check_fetch_page_with_url_passes():
    return (bash_gate.raw_fetch("python3 tools/fetch_page.py https://example.com/ --text") is None) \
        or "fetch_page.py を止めた"


# --- fetch_page の見分け --------------------------------------------------

def check_detects_fetch_page():
    return bash_gate.calls_fetch_page("python3 tools/fetch_page.py https://x/ --text") \
        or "fetch_page.py の呼び出しを見逃した"


def check_ignores_other_commands():
    return (not bash_gate.calls_fetch_page("python3 tools/append_rows.py events")) \
        or "無関係なコマンドを fetch_page と数えた"


CHECKS = [
    ("diff_data.py | head は止める", check_diff_head_blocks),
    ("diff_data.py | grep は止める", check_diff_grep_blocks),
    ("validate_data.py | tail は止める", check_validate_blocks),
    ("&& の後段も見る", check_second_segment_blocks),
    ("; の後段も見る", check_semicolon_segment_blocks),
    ("sed -n も切り詰めとみなす", check_sed_n_blocks),
    ("素の実行は通す", check_plain_diff_passes),
    ("report_stats.py は見ない", check_report_stats_passes),
    ("prev_rows.py | head は通す", check_prev_rows_passes),
    ("budget.py | head は通す", check_budget_passes),
    ("検証ツールの前のパイプは通す", check_upstream_pipe_passes),
    ("無関係な head は通す", check_unrelated_head_passes),
    ("空のコマンドは通す", check_empty_passes),
    ("別コマンドの head は紐づけない", check_separate_segment_head_passes),
    ("curl での外部取得は止める", check_curl_remote_blocks),
    ("wget での外部取得は止める", check_wget_remote_blocks),
    ("&& の後段の curl も止める", check_curl_in_pipeline_blocks),
    ("localhost への curl は通す", check_curl_localhost_passes),
    ("URL を伴わない curl は通す", check_curl_without_url_passes),
    ("URL を含むだけの別コマンドは通す", check_url_in_other_command_passes),
    ("fetch_page.py は通す", check_fetch_page_with_url_passes),
    ("fetch_page.py の呼び出しを見分ける", check_detects_fetch_page),
    ("無関係なコマンドは数えない", check_ignores_other_commands),
]


def main():
    fails = 0
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
