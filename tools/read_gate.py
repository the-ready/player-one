#!/usr/bin/env python3
"""その `Read` が「安い読み方のある大物」を全文読もうとしていないかを、終了コードで返す。

## なぜ要るのか —— `Read` にはバイト数の上限が無い

`Read` の既定の上限は**行数**（2000行）で、1行の長さは見ない。`data/events.csv` は
406行しかないので、上限に一度も触れないまま **178,387文字**が丸ごと文脈に入る。
しかも文脈は毎ターン送り直されるので、**1回の `Read` が以後のターン数だけ課金される**。

    data/events.csv                        178,387文字
    kanto-live-collector/SKILL.md 全文       84,822文字（親向け抜粋は 49,870文字）
    kanto-event-collector/SKILL.md 全文      74,530文字（親向け抜粋は 42,376文字）

親が残り60ターン回るなら、CSVを1回読んだだけで文脈再送は5〜7M増える。**撤退の線
（40M）の2割近くを、「CSVが更新されたか確認する」ためだけに使う**ことになる。

これは机上の心配ではない。2026-09-02 の events は、`skill_brief.py` の出力が
Bash の出力上限を越えて `tool-results/` のファイルに落ち、**親がそれを丸ごと
`Read` した**（`docs/routine-postmortems.md`）。

## 何を見るか —— 「高い」ことではなく「安い代替がある」こと

大きいことは理由にならない。子が読む抜粋（`temp/brief-*.md`）は約4万文字あるが、
あれは**読まれるために作った**ファイルで、塞いだら子が規則を受け取れなくなる。

止めるのは、**同じ情報をもっと安く取れる道具がこのリポジトリにある場合だけ**である。

    .claude/skills/kanto-*/SKILL.md   → tools/skill_brief.py（抜粋）／offset 指定で該当節だけ
    data/*.csv・data/.prev/*.csv      → tools/prev_rows.py --worklist / --uid、tools/roster.py --list
    temp/rows-*.jsonl                 → tools/append_rows.py（行は親の文脈を経由させない設計）
    */tool-results/*                  → 出力を絞るコマンドで取り直す

**代替の道具が無ければ通す。** `skill_brief.py` が壊れている回にまで全文への
フォールバックを塞ぐと、親が手順書に一度も到達できなくなる——このゲートが防ごうと
している損失より、そちらのほうが大きい（`wave_gate.py` / `budget.py --gate` と同じ倒し方）。

`offset` か `limit` が付いていれば通す。節だけを読むのは、まさに勧めている読み方である。

## 終了コード

  0 : 読んでよい
  1 : 安い代替がある。理由と代替コマンドを stderr に書く
  2 : 判定できない（入力を読めない・リポジトリを特定できない）

**2 では止めない。** `block-git.sh` が判定不能で拒否側に倒れるのは、あちらが
「検証を通っていないデータの push」という外部に出る事故を見ているためである。
こちらが見ているのは自分の取りこぼしなので、倒し方が逆になる。

使い方:
    python3 tools/read_gate.py --hook            # PreToolUse(Read) から。JSONを標準入力で受ける
    python3 tools/read_gate.py --check <path>    # 単体で判定を確かめる
"""

import argparse
import json
import os
import sys

# 安い代替がある大物だけを見る。ここに無いものは、どれだけ大きくても通す。
FLOOR_CHARS = 20_000

SKILL_DS = {
    "kanto-event-collector": "events",
    "kanto-live-collector": "lives",
    "kanto-movie-collector": "movies",
}

ROSTERS = ("spots", "venues", "theaters", "festivals")


def repo_root(start=None):
    """リポジトリのルート。`CLAUDE_PROJECT_DIR` が無ければ自分の位置から求める。"""
    env = (os.environ.get("CLAUDE_PROJECT_DIR") or "").strip()
    if env and os.path.isdir(env):
        return os.path.abspath(env)
    here = os.path.dirname(os.path.abspath(start or __file__))
    return os.path.abspath(os.path.join(here, ".."))


def rel_path(path, root):
    """リポジトリからの相対パス（区切りは `/`）。外のファイルなら None。"""
    try:
        rel = os.path.relpath(os.path.abspath(path), root)
    except (ValueError, OSError):
        return None
    if rel.startswith(".."):
        return None
    return rel.replace(os.sep, "/")


def char_count(path):
    """文字数。読めなければ None（＝大きさを理由に止めない）。"""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return len(f.read())
    except OSError:
        return None


def _has(root, tool):
    return os.path.isfile(os.path.join(root, "tools", tool))


def judge(rel, root, has_range=False, size=None):
    """(終了コード, 理由) を返す。`rel` はリポジトリからの相対パス。

    `size` は文字数（None なら実ファイルから数える）。テストが実ファイルを
    用意せずに線の内外を確かめられるように、外から渡せるようにしてある。
    """
    if not rel:
        return 2, "読もうとしているファイルを特定できませんでした。判定を見送ります。"

    # 節だけを読むのは、まさに勧めている読み方である。
    if has_range:
        return 0, ""

    if size is None:
        size = char_count(os.path.join(root, rel))

    def big():
        # 大きさを測れないときは「小さい」とみなす（止めない側に倒す）。
        return size is not None and size >= FLOOR_CHARS

    def n():
        return f"{size:,}文字" if size is not None else "サイズ不明"

    # --- 収集スキルの全文 -------------------------------------------------
    if rel.startswith(".claude/skills/kanto-") and rel.endswith("/SKILL.md"):
        if not _has(root, "skill_brief.py"):
            return 0, ""
        name = rel.split("/")[2]
        ds = SKILL_DS.get(name, "<events|lives|movies>")
        return 1, (
            f"SKILL.md の全文を Read しないでください（{rel} = {n()}）。\n"
            "読むと、この分が**毎ターン再送**されます。\n"
            "\n"
            f"  親の抜粋:  python3 tools/skill_brief.py {ds} --for parent --out temp/brief-parent-{ds}.md\n"
            f"  子の抜粋:  python3 tools/skill_brief.py {ds} --out temp/brief-{ds}.md\n"
            "\n"
            "特定の節だけが要るときは、Read に offset と limit を付けて該当節だけを読んでください"
            "（節の位置は `grep -n '^#' <path>` で引けます）。")

    # --- 収集物のCSV・前回分 ---------------------------------------------
    if (rel.startswith("data/") and rel.endswith(".csv")) and big():
        stem = os.path.basename(rel)[: -len(".csv")]
        if stem in ROSTERS:
            if not _has(root, "roster.py"):
                return 0, ""
            return 1, (
                f"名簿を全文 Read しないでください（{rel} = {n()}）。読むと、この分が毎ターン再送されます。\n"
                "\n"
                f"  一覧とURL:  python3 tools/roster.py {stem} --list --urls [--pref <都県>]\n"
                f"  件数だけ:    python3 tools/roster.py {stem} --list --urls | wc -l")
        if not _has(root, "prev_rows.py"):
            return 0, ""
        ds = stem if stem in ("events", "lives", "movies") else "<events|lives|movies>"
        return 1, (
            f"CSVを全文 Read しないでください（{rel} = {n()}）。読むと、この分が毎ターン再送されます。\n"
            "\n"
            f"  前回行の一覧:  python3 tools/prev_rows.py {ds} --worklist [--pref <都県>]\n"
            f"  1行だけ引く:    python3 tools/prev_rows.py {ds} --uid <uid>\n"
            f"  更新されたかの確認:  wc -l {rel}\n"
            "\n"
            "**`--worklist` の表記は表示用に切り詰めてあります**（末尾が `…`）。"
            "書き戻す表記が要るときは `--uid` で引き直してください。")

    # --- 子が書いた行 -----------------------------------------------------
    # ここだけは大きさを見ない。**行を親の文脈に通さない**というのは、
    # 大きさの問題ではなく受け渡しの設計そのものだからである
    # （`docs/COLLECTION-PROTOCOL.md` 第11.4節）。
    if rel.startswith("temp/rows-") and rel.endswith(".jsonl"):
        if not _has(root, "append_rows.py"):
            return 0, ""
        return 1, (
            f"子が書いた行を Read しないでください（{rel}）。\n"
            "行は親の文脈を経由させない設計です（`docs/COLLECTION-PROTOCOL.md` 第11.4節）。\n"
            "読むと、同じ行を3回払うことになります——子が書き、親が読み（以後毎ターン再送）、"
            "親が書き直す。\n"
            "\n"
            f"  python3 tools/append_rows.py <events|lives|movies> < {rel}\n"
            f"  件数だけ:  wc -l {rel}")

    # --- Bash の出力が落ちたファイル --------------------------------------
    # 2026-09-02 の events はこの経路で 100,676 バイトの抜粋を丸ごと読んでいる。
    if "/tool-results/" in f"/{rel}" and big():
        return 1, (
            f"Bash の出力が落ちたファイルを全文 Read しないでください（{n()}）。\n"
            "読むと、この分が毎ターン再送されます。2026-09-02 の events は、"
            "この経路で 100,676 バイトの抜粋を丸ごと読み込んでいます。\n"
            "\n"
            "  - 要るのが一部なら、Read に offset と limit を付けてください\n"
            "  - 要るのが要約なら、出力を絞るコマンド（`wc -l` / `grep` / `--out` 付きの再実行）で取り直してください")

    return 0, ""


def hook():
    """PreToolUse(Read) として呼ばれたときの入口。

    ルーチンかどうかの判定をシェルの側に置かないのは、`Read` が**最も回数の多い
    ツールのひとつ**だからである。ラッパーを1枚挟むとその回数だけプロセスが増える。
    """
    if (os.environ.get("CLAUDE_ROUTINE") or "0") != "1":
        return 0

    try:
        data = json.load(sys.stdin)
    except (ValueError, OSError):
        # 入力を読めないことを理由に読み取りを止めない（上の docstring の倒し方）。
        return 0
    if not isinstance(data, dict):
        return 0

    ti = data.get("tool_input")
    if not isinstance(ti, dict):
        return 0
    path = ti.get("file_path") or ""
    has_range = bool(ti.get("offset") or ti.get("limit"))

    root = repo_root()
    rc, reason = judge(rel_path(path, root), root, has_range=has_range)
    if rc == 1:
        print(reason, file=sys.stderr)
        return 2                                   # PreToolUse は exit 2 で拒否する
    return 0


def main():
    p = argparse.ArgumentParser(description="安い代替のある大物の全文 Read を見分ける")
    p.add_argument("--hook", action="store_true", help="PreToolUse(Read) の入口。JSONを標準入力で受ける")
    p.add_argument("--check", metavar="PATH", help="単体で判定を確かめる")
    p.add_argument("--range", action="store_true", help="--check に offset/limit 付きとして判定させる")
    args = p.parse_args()

    if args.hook:
        return hook()
    if not args.check:
        p.error("--hook または --check を指定してください")

    root = repo_root()
    rc, reason = judge(rel_path(args.check, root), root, has_range=args.range)
    if reason:
        print(reason, file=sys.stderr)
    return rc


if __name__ == "__main__":
    sys.exit(main())
