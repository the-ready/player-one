#!/usr/bin/env python3
"""SKILL.md から、調査担当のサブエージェントに要る部分だけを抜き出す。

## なぜ要るのか

2026-08-27 の movies 収集では、親が3体すべてのサブエージェントに
「まず SKILL.md を読むこと」と指示していた。movies の SKILL.md は57,522文字ある。

    子の平均文脈  115.1k / 121.6k / 98.7k トークン

SKILL.md 全文は**その3割強を占める**。しかも文脈は毎ターン送り直されるので、
196ターン回った子では、この1ファイルだけで数百万トークンが再送された計算になる。

**この分は、体を分けても減らない。** 1体あたりのターン数を k 分の1にしても、
SKILL.md は k 回読まれるので合計は変わらない（積み上がった取得結果のほうは
k 分の1になる）。だから独立した対策が要る。

## 許可リストではなく除外リストにしてある

「子に要る節」を並べる方式は採らない。節が増えたり見出しが変わったりしたとき、
**規則が黙って落ちる**方向に壊れるからである。落ちた規則は、間違った列名や
書式の行として現れ、`append_rows.py` や `validate_data.py` に弾かれるか、
最悪そのまま公開される。

代わりに、**親の仕事だと分かっている節だけを外す**。新しい節が増えたら既定で
残るので、壊れる方向は「余分に入ってトークンを食う」側になる。品質を落とす側に
倒れない。

外すのは、いずれも子には実行できない・実行させてはいけない工程である。

  - 完走条件（終了工程・撤退の手順）: 子は data/ に書かないので実行できない
  - 並行して調べてよい: サブエージェントを起動するのは親（孫は禁止されている）
  - 調査手順: どこを担当するかは親が決めて指示に書く
  - 実行手順まとめ / 品質チェック / 実行時の出力について: 親の締めの工程

残るのは、**行をどう書くか**（列・日程・料金・受付・キー・禁止事項）と、
**どう取得するか**（robots・fetch_page の使い分け・検索を使わない経路）である。
子が要るのはそこだけで、そこは丸ごと残る。

使い方:
    python3 tools/skill_brief.py movies              # 抜粋を出す（指示に貼る）
    python3 tools/skill_brief.py movies --sections   # 残した節・外した節を一覧する
"""

import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS = os.path.join(ROOT, ".claude", "skills")

NAME_MAP = {
    "events": "kanto-event-collector",
    "lives": "kanto-live-collector",
    "movies": "kanto-movie-collector",
}

# 親の仕事の節。見出し（`## `）の先頭一致で外す。
#
# 完全一致にしないのは、見出しに「（着手前に読むこと）」のような但し書きが
# 付く・外れるためである。先頭一致なら、その揺れでは外し損ねない。
# **`調査予算` と `品質チェック` は外さない。** どちらも親向けの内容（枠表・
# 終了工程の確認）と子向けの内容（`fetch_page.py` の使い分け、行の形式の
# 自己点検）が同じ節に同居していて、`##` の粒度では切り分けられない。
# 節の中を切りに行けば、そこは許可リストと同じ壊れ方（規則が黙って落ちる）を
# 始めるので、粒度を上げずに丸ごと残す——余分に入るほうの誤りを選ぶ。
PARENT_ONLY = (
    "完走条件",
    "並行して調べてよい",
    "実行手順まとめ",
    "実行時の出力について",
)

# `## 調査手順` は**丸ごと外してはいけない。**
#
# 最初はここも親の仕事に数えていた（担当範囲を決めるのは親だから）。だが中身を
# 読み直すと、ステップ1〜4は**子が実際に行う技法**である——名簿の回り方、
# 深掘りの手順、そして「深掘りを打ち切る基準」。これを落とすと、子は自分が
# やる作業のやり方を知らないまま調べることになる。**トークンを削るために
# 品質を落とす**、この作業でいちばんやってはいけない誤りだった。
#
# 親の工程はこの節の中の2つだけなので、そこだけを見出しの語で外す。
# 位置（ステップ0／ステップ5）では判定しない——lives の「ステップ5」は
# 各公演の深掘り（子の仕事）で、movies / events の「ステップ5」は消えた行の
# 説明（親の仕事）であり、番号と内容が一致しないためである。
PARENT_ONLY_SUB = (
    "前回分の棚卸し",        # 親が worklist を取り、担当分を切り出して子へ渡す
    "消えた行の説明",        # 処分の記録と差分の確定。子は data/ に書かない
)

SUB_RE = re.compile(r"^### +(.*?)\s*$")

HEAD_RE = re.compile(r"^## +(.*?)\s*$")


def skill_path(ds):
    if ds not in NAME_MAP:
        raise SystemExit(f"ERROR: 不明なデータセット名です: {ds!r}（events / lives / movies）")
    return os.path.join(SKILLS, NAME_MAP[ds], "SKILL.md")


def split_sections(text):
    """[(見出し or None, 本文)] に分ける。先頭の frontmatter・前書きは見出し None。"""
    out, head, buf = [], None, []
    for line in text.split("\n"):
        m = HEAD_RE.match(line)
        if m:
            out.append((head, "\n".join(buf)))
            head, buf = m.group(1), [line]
        else:
            buf.append(line)
    out.append((head, "\n".join(buf)))
    return out


def is_parent_only(head):
    return bool(head) and any(head.startswith(p) for p in PARENT_ONLY)


def strip_parent_subsections(body):
    """節の中から、親の工程の小節（`### …`）だけを落とす。

    落とした小節名も返す。何が消えたかを `--sections` で見えるようにするため
    ——見えない削除は、この道具でいちばん危ない壊れ方である。
    """
    out, dropped, skipping = [], [], False
    for line in body.split("\n"):
        m = SUB_RE.match(line)
        if m:
            head = m.group(1)
            skipping = any(k in head for k in PARENT_ONLY_SUB)
            if skipping:
                dropped.append(head)
                continue
        if not skipping:
            out.append(line)
    return "\n".join(out), dropped


def build(ds):
    with open(skill_path(ds), encoding="utf-8") as f:
        text = f.read()
    # frontmatter（--- で挟まれた先頭）は落とす。スキルの起動用メタで、内容ではない
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            text = text[end + 4:]
    kept, dropped = [], []
    for head, body in split_sections(text):
        if is_parent_only(head):
            dropped.append(head)
            continue
        body, sub_dropped = strip_parent_subsections(body)
        dropped.extend(sub_dropped)
        kept.append((head, body))
    return kept, dropped, len(text)


def main():
    p = argparse.ArgumentParser(description="SKILL.md から子に要る部分だけを抜く")
    p.add_argument("dataset", help="events / lives / movies")
    p.add_argument("--sections", action="store_true", help="残した節・外した節を一覧する")
    args = p.parse_args()

    kept, dropped, full = build(args.dataset)

    if args.sections:
        print("# 残す（子に要る）")
        for head, _ in kept:
            print(f"  {head or '（前書き）'}")
        print("# 外す（親の仕事）")
        for head in dropped:
            print(f"  {head}")
        return 0

    rel = os.path.relpath(skill_path(args.dataset), ROOT)
    body = "\n".join(b for _h, b in kept).strip()
    print(f"# これは `{rel}` の抜粋です（調査担当のサブエージェント向け）。")
    print(f"# 外してあるのは親の工程だけです（{'・'.join(d or '' for d in dropped)}）。")
    print("# **ここに書かれていない判断が要る場合だけ**、上のファイルを読んでください。")
    print()
    print(body)
    print(f"\n# 抜粋 {len(body):,}文字 / 全文 {full:,}文字",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
