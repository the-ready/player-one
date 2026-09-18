#!/usr/bin/env python3
"""`tools/reply_gate.py` が、契約を破った返答だけを止めるかを検証する（ネットワーク不要）。

    python3 tools/reply_gate_test.py

## なぜ念入りにやるか

このゲートは**調べ終えた子をもう1ターン回す**。子の文脈はまるごと再送されるので、
1回の誤検知が10〜20万トークンになる。割が合うのは「行が親の文脈に入り、親の
ターン数だけ再送される」場合だけなので、**曖昧なものは通す**側に倒してある。

固定したいのは線の値ではなく倒し方である。

  - パスと件数だけの返答は通す
  - 行そのものを貼った返答は、長さに関係なく止める
  - 短い返答は、パスが無くても通す（「0件でした」は正しい返答）
  - 記録が読めない・2周目・返答が空 —— どれも通す
"""

import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reply_gate                                              # noqa: E402

TMP = None


def rows(n):
    return "\n".join(
        '{"uid": "ev-%03d", "title": "架空美術館 特別展 その%d", "venue": "架空美術館",'
        ' "start_date": "2026-10-01", "price": "1,800円"}' % (i, i) for i in range(n))


def transcript(*texts):
    """本文のある応答を順に並べた記録を作り、そのパスを返す。"""
    path = os.path.join(TMP, f"t{len(os.listdir(TMP))}.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        for t in texts:
            f.write(json.dumps({"type": "assistant",
                                "message": {"content": [{"type": "text", "text": t}]}}) + "\n")
    return path


# --- 止めるべきもの -------------------------------------------------------

def check_inline_rows_block():
    rc, why = reply_gate.judge("調査結果:\n" + rows(12))
    if rc != 1:
        return f"行を貼った返答を通してしまった: exit={rc}"
    return ("3回払う" in why) or f"理由が書かれていない: {why!r}"


def check_two_rows_are_enough():
    """2行でも止める。「少しなら貼ってよい」線を作ると、そこが上限になる。"""
    rc, _ = reply_gate.judge(rows(2))
    return rc == 1 or f"2行の貼り付けを通してしまった: exit={rc}"


def check_long_prose_without_path_blocks():
    rc, why = reply_gate.judge("各施設の調査結果を報告します。\n" * 400)
    if rc != 1:
        return f"長い文章報告を通してしまった: exit={rc}"
    return ("rows-" in why) or f"書き先が示されていない: {why!r}"


# --- 通すべきもの ---------------------------------------------------------

def check_contract_reply_passes():
    rc, _ = reply_gate.judge("temp/rows-tokyo-a.jsonl に 32件 書きました。")
    return rc == 0 or f"契約どおりの返答を止めた: exit={rc}"


def check_zero_result_passes():
    rc, _ = reply_gate.judge("対象期間内の新規公演は見つかりませんでした。0件です。")
    return rc == 0 or f"0件の返答を止めた: exit={rc}"


def check_one_example_row_passes():
    """1行だけの例示は止めない（曖昧なものは通す）。"""
    rc, _ = reply_gate.judge("こういう形で書きました:\n" + rows(1) + "\ntemp/rows-a.jsonl に18件です。")
    return rc == 0 or f"1行の例示を止めた: exit={rc}"


def check_long_reply_with_path_passes():
    """長くても、ファイルに書いたと言っているなら止めない。"""
    text = "temp/rows-kanagawa.jsonl に 41件 書きました。\n" + ("補足: 通信障害が3件ありました。\n" * 200)
    rc, _ = reply_gate.judge(text)
    return rc == 0 or f"パスを示した長い返答を止めた: exit={rc}"


def check_short_json_line_passes():
    """短い JSON 断片（`{"ok": true}` 等）は行ではない。"""
    rc, _ = reply_gate.judge('{"ok": true}\n{"n": 3}\n終わりました。')
    return rc == 0 or f"短いJSON断片を行と誤認した: exit={rc}"


def check_empty_passes():
    rc, _ = reply_gate.judge("")
    return rc == 0 or f"空の返答を止めた: exit={rc}"


def check_long_boundary():
    below, _ = reply_gate.judge("あ" * (reply_gate.LONG_CHARS))
    above, _ = reply_gate.judge("あ" * (reply_gate.LONG_CHARS + 1))
    if below != 0:
        return f"線ちょうどを止めた: exit={below}"
    return above == 1 or f"線を越えたのに通した: exit={above}"


# --- 記録の読み取り -------------------------------------------------------

def check_reads_last_text_message():
    """最後の「本文のある」応答を採ること（末尾がツール呼び出しだけでも遡る）。"""
    p = transcript("途中経過です。", "temp/rows-a.jsonl に 7件 書きました。")
    return (reply_gate.last_assistant_text(p) == "temp/rows-a.jsonl に 7件 書きました。") \
        or f"最後の本文を採れていない: {reply_gate.last_assistant_text(p)!r}"


def check_missing_transcript_passes():
    """**ここがいちばん大事。** 記録が読めないことを理由に子を回し直さない。"""
    return (reply_gate.last_assistant_text(os.path.join(TMP, "no-such-file.jsonl")) is None) \
        or "存在しない記録から本文を作ってしまった"


def check_broken_lines_are_skipped():
    path = os.path.join(TMP, "broken.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        f.write('{"type": "assistant" 壊れたJSON\n')
        f.write(json.dumps({"type": "assistant",
                            "message": {"content": [{"type": "text", "text": "0件です。"}]}}) + "\n")
    return (reply_gate.last_assistant_text(path) == "0件です。") or "壊れた行で読み取りが止まった"


def check_no_text_returns_none():
    path = os.path.join(TMP, "notext.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps({"type": "assistant",
                            "message": {"content": [{"type": "tool_use", "name": "Bash"}]}}) + "\n")
    return (reply_gate.last_assistant_text(path) is None) or "本文の無い記録から本文を作ってしまった"


CHECKS = [
    ("行を貼った返答は止め、3回払うことを伝える", check_inline_rows_block),
    ("2行でも止める", check_two_rows_are_enough),
    ("パスの無い長文報告は止める", check_long_prose_without_path_blocks),
    ("契約どおりの返答は通す", check_contract_reply_passes),
    ("0件の返答は通す", check_zero_result_passes),
    ("1行の例示は通す", check_one_example_row_passes),
    ("パスを示した長い返答は通す", check_long_reply_with_path_passes),
    ("短いJSON断片は行と数えない", check_short_json_line_passes),
    ("空の返答は通す", check_empty_passes),
    ("長さの線の上下で判定が変わる", check_long_boundary),
    ("最後の本文のある応答を採る", check_reads_last_text_message),
    ("記録が読めないときは通す", check_missing_transcript_passes),
    ("壊れた行は読み飛ばす", check_broken_lines_are_skipped),
    ("本文が無ければ None", check_no_text_returns_none),
]


def main():
    global TMP
    TMP = tempfile.mkdtemp(prefix="reply_gate_test_")
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
        shutil.rmtree(TMP, ignore_errors=True)
    print(f"\n{len(CHECKS) - fails}/{len(CHECKS)} 件が期待どおり")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
