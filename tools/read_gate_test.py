#!/usr/bin/env python3
"""`tools/read_gate.py` が、止めるべき `Read` だけを止めるかを検証する（ネットワーク不要）。

    python3 tools/read_gate_test.py

## なぜ念入りにやるか

このゲートは**読み取りを塞ぐ**。誤って止めると、親は手順書に、子は抜粋に
到達できなくなり、**収集そのものが始まらない**。止めすぎの害が止めなさすぎの
害より大きい、数少ないゲートである。

固定したいのは線の値ではなく**倒し方**である。

  - 子が読むために作ったファイル（`temp/brief-*.md` `temp/worklist-*.md`）は必ず通す
  - `offset` / `limit` が付いていれば通す（節だけ読むのは勧めている読み方）
  - 代替の道具がリポジトリに無ければ通す（`skill_brief.py` が壊れた回の逃げ道）
  - 小さいファイルは通す（大きさが理由ではなく、安い代替があることが理由）
  - リポジトリの外は見ない
"""

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import read_gate                                               # noqa: E402

ROOT = None                       # main() が用意する偽リポジトリ


def j(path, has_range=False, size=None):
    return read_gate.judge(path, ROOT, has_range=has_range, size=size)


# --- 止めるべきもの -------------------------------------------------------

def check_skill_full_blocks():
    rc, why = j(".claude/skills/kanto-event-collector/SKILL.md", size=74_530)
    if rc != 1:
        return f"SKILL.md の全文を通してしまった: exit={rc}"
    return ("skill_brief.py" in why) or f"代替が書かれていない: {why!r}"


def check_skill_names_its_dataset():
    """催促に出す抜粋のコマンドが、そのスキルのデータセットを指していること。"""
    _, why = j(".claude/skills/kanto-live-collector/SKILL.md", size=84_822)
    return ("skill_brief.py lives" in why) or f"データセットが違う: {why!r}"


def check_big_csv_blocks():
    rc, why = j("data/events.csv", size=178_387)
    if rc != 1:
        return f"178,387文字のCSVを通してしまった: exit={rc}"
    return ("prev_rows.py events --worklist" in why) or f"代替が書かれていない: {why!r}"


def check_prev_csv_blocks():
    """`data/.prev/` も同じ大きさの同じ内容である。"""
    rc, _ = j("data/.prev/events.csv", size=178_387)
    return rc == 1 or f"前回分のCSVを通してしまった: exit={rc}"


def check_roster_points_at_roster_tool():
    rc, why = j("data/spots.csv", size=25_000)
    if rc != 1:
        return f"名簿を通してしまった: exit={rc}"
    return ("roster.py spots --list" in why) or f"名簿の代替が書かれていない: {why!r}"


def check_rows_jsonl_blocks_regardless_of_size():
    """行の受け渡しは大きさの問題ではないので、小さくても止める。"""
    rc, why = j("temp/rows-tokyo-a.jsonl", size=120)
    if rc != 1:
        return f"子の書いた行を通してしまった: exit={rc}"
    return ("append_rows.py" in why) or f"追記のコマンドが書かれていない: {why!r}"


def check_tool_results_blocks():
    """2026-09-02 の経路。Bash の出力が落ちたファイルを丸ごと読む。"""
    rc, _ = j("temp/tool-results/abc123.txt", size=100_676)
    return rc == 1 or f"Bash の出力の落ち先を通してしまった: exit={rc}"


# --- 通すべきもの（ここを間違えると収集が止まる） -------------------------

def check_brief_passes():
    """**ここがいちばん大事。** 子が規則を受け取る唯一の経路である。"""
    rc, _ = j("temp/brief-events.md", size=39_755)
    return rc == 0 or f"子の抜粋を塞いだ（規則が子に届かなくなる）: exit={rc}"


def check_parent_brief_passes():
    rc, _ = j("temp/brief-parent-events.md", size=42_376)
    return rc == 0 or f"親の抜粋を塞いだ: exit={rc}"


def check_worklist_passes():
    rc, _ = j("temp/worklist-events-tokyo.md", size=28_922)
    return rc == 0 or f"前回行の一覧を塞いだ: exit={rc}"


def check_range_passes():
    rc, _ = j(".claude/skills/kanto-event-collector/SKILL.md", has_range=True, size=74_530)
    return rc == 0 or f"offset 付きの節読みを塞いだ: exit={rc}"


def check_small_csv_passes():
    rc, _ = j("data/festivals.csv", size=3_714)
    return rc == 0 or f"小さいCSVを塞いだ: exit={rc}"


def check_ordinary_file_passes():
    rc, _ = j("tools/append_rows.py", size=28_042)
    return rc == 0 or f"普通のソースを塞いだ: exit={rc}"


def check_docs_pass():
    """散文の設計文書は大きいが、安い代替が無いので通す。"""
    rc, _ = j("docs/DESIGN.md", size=120_000)
    return rc == 0 or f"設計文書を塞いだ: exit={rc}"


def check_unknown_size_passes():
    """大きさを測れないときは「小さい」とみなす（止めない側に倒す）。"""
    rc, _ = j("data/events.csv", size=None)
    return rc == 0 or f"サイズ不明のCSVを止めた: exit={rc}"


def check_missing_tool_passes():
    """**逃げ道。** `skill_brief.py` が無い回に全文を塞ぐと、親が手順書に到達できない。"""
    path = os.path.join(ROOT, "tools", "skill_brief.py")
    os.rename(path, path + ".off")
    try:
        rc, _ = j(".claude/skills/kanto-event-collector/SKILL.md", size=74_530)
    finally:
        os.rename(path + ".off", path)
    return rc == 0 or f"代替の道具が無いのに全文を塞いだ: exit={rc}"


def check_outside_repo_is_undecidable():
    rel = read_gate.rel_path("/etc/hosts", ROOT)
    if rel is not None:
        return f"リポジトリ外を相対パスに落としてしまった: {rel!r}"
    rc, _ = j(rel)
    return rc == 2 or f"特定できないときは exit=2 のはずが exit={rc}"


def check_hook_reads_absolute_path():
    """フックが受け取るのは絶対パスである。相対に落として判定できること。"""
    rel = read_gate.rel_path(os.path.join(ROOT, "data/events.csv"), ROOT)
    return rel == "data/events.csv" or f"相対パスに落とせていない: {rel!r}"


def check_floor_boundary():
    """線の上下で判定が変わること（線の値そのものは動かしてよい）。"""
    below, _ = j("data/movies.csv", size=read_gate.FLOOR_CHARS - 1)
    at, _ = j("data/movies.csv", size=read_gate.FLOOR_CHARS)
    if below != 0:
        return f"線の下を止めた: exit={below}"
    return at == 1 or f"線の上を通した: exit={at}"


CHECKS = [
    ("SKILL.md の全文は止め、抜粋のコマンドを出す", check_skill_full_blocks),
    ("催促はそのスキルのデータセットを指す", check_skill_names_its_dataset),
    ("大きいCSVは止め、prev_rows.py を出す", check_big_csv_blocks),
    ("data/.prev/ のCSVも止める", check_prev_csv_blocks),
    ("名簿は roster.py を出す", check_roster_points_at_roster_tool),
    ("子の書いた行は大きさに関係なく止める", check_rows_jsonl_blocks_regardless_of_size),
    ("Bash の出力の落ち先も止める", check_tool_results_blocks),
    ("子の抜粋は必ず通す", check_brief_passes),
    ("親の抜粋は必ず通す", check_parent_brief_passes),
    ("前回行の一覧は必ず通す", check_worklist_passes),
    ("offset/limit 付きは通す", check_range_passes),
    ("小さいCSVは通す", check_small_csv_passes),
    ("普通のソースは通す", check_ordinary_file_passes),
    ("設計文書は大きくても通す", check_docs_pass),
    ("大きさを測れないときは通す", check_unknown_size_passes),
    ("代替の道具が無ければ通す（逃げ道）", check_missing_tool_passes),
    ("リポジトリ外は判定しない", check_outside_repo_is_undecidable),
    ("絶対パスを相対に落とせる", check_hook_reads_absolute_path),
    ("線の上下で判定が変わる", check_floor_boundary),
]


def main():
    global ROOT
    tmp = tempfile.mkdtemp(prefix="read_gate_test_")
    ROOT = tmp
    # 判定は「代替の道具がリポジトリに在るか」を見るので、空の偽物を置く。
    os.makedirs(os.path.join(tmp, "tools"), exist_ok=True)
    for t in ("skill_brief.py", "prev_rows.py", "append_rows.py", "roster.py"):
        open(os.path.join(tmp, "tools", t), "w").close()

    fails = 0
    try:
        for name, fn in CHECKS:
            try:
                got = fn()
            except Exception as e:                            # noqa: BLE001
                got = f"{type(e).__name__}: {e}"
            if got is not True:
                print(f"✗ {name}\n    {got}")
                fails += 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{len(CHECKS) - fails}/{len(CHECKS)} 件が期待どおり")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
