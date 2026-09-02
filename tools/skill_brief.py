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

## 抜粋は「貼る」のではなく「ファイルで渡す」

2026-09-02 の events 収集で、この道具は**一度も使われなかった**。抜粋は
100,676バイトあり、Bash の出力上限を超えて `tool-results/` のファイルに落ちる。
親はそれを Read して（＝自分の文脈に約22kトークン払って）から、4体ぶんの指示に
貼る代わりに**自分で1〜2KBに要約した**。要約の過程で「価格比較の第0〜1段階」が
落ち、子は `price_official` を1件も書かなかった（新規90件中0件）。

貼る形は、親に「抜粋ぶんの出力トークン × 体数」を払わせる。払えないと判断した
親は要約に逃げ、**規則が落ちたことは誰にも見えない**。だから貼らせない。
`--out` でファイルに書き、指示にはそのパスだけを書く。子が Read すれば、
子の文脈に入る量は貼る場合と同じで、親の負担だけが消える。

親が抜粋のパスを指示に書き忘れる経路は `.claude/hooks/agent-guard.sh` が塞ぐ
（パスへの参照が無い波は起動できない）。

使い方:
    python3 tools/skill_brief.py movies                        # 標準出力に出す
    python3 tools/skill_brief.py events --out temp/brief-events.md   # ファイルに書く（子に読ませる）
    python3 tools/skill_brief.py movies --sections             # 残した節・外した節を一覧する
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
    "初期化",                # `append_rows.py <ds> --init` はCSVを空にする。子に実行させると
                             # 他の波が書いた分もろとも消える（2026-08-29 に見つかった漏れ）
    "日割りの書き込み手順",  # lives固有。`append_lineup.py --init` が同じ理由で危険
)

SUB_RE = re.compile(r"^### +(.*?)\s*$")

# ------------------------------------------------------------------ 余白を潰す
#
# 抜粋の**30.9%が半角スペース**だった（2026-09-02 実測。events の抜粋 55,938文字
# のうち 17,258文字）。ほぼ全部が Prettier のテーブル整列——`| \`id\` ... |` の
# 規則の列を、その表でいちばん長いセル（250字を超えるものがある）の幅に合わせて
# 詰めているぶんである。
#
# **これは削っても規則が1文字も減らない。** 節を削る方向（許可リスト化）は
# 「規則が黙って落ちる」壊れ方をするのでこの道具が避けている手だが、
# 余白の除去は見た目が変わるだけで、機械的に元の意味を保つ。
# 実測で 55,938文字 → 39,000文字弱（約30%減）になる。
#
# 表の区切り行（`| --- | --- |`）も `---` に潰す。整列のために `-` を数十個
# 並べているだけなので、これも意味を持たない。
TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")
# セルの区切りは `|` だが、この文書は `art\|ent` のようにエスケープした `|` を
# セルの中で多用する。**エスケープ済みの `|` で切ると、複数値の書き方の規則が
# 壊れた表になって子に届く。** 直前が `\` でないものだけを区切りとして扱う。
CELL_SPLIT_RE = re.compile(r"(?<!\\)\|")
SEP_CELL_RE = re.compile(r"^:?-{2,}:?$")


def squeeze_table_padding(text):
    """表の整列用の余白を潰す。中身は変えない。

    コードブロックの中は触らない——`fetch_page.py` の実行例やCSVヘッダーの
    見本が入っており、あそこの空白は意味を持つ。
    """
    out, in_fence = [], False
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            out.append(line)
            continue
        if in_fence or not TABLE_ROW_RE.match(line):
            out.append(line)
            continue
        cells = [c.strip() for c in CELL_SPLIT_RE.split(line.strip())][1:-1]
        if cells and all(SEP_CELL_RE.match(c) for c in cells):
            cells = ["---"] * len(cells)
        out.append("| " + " | ".join(cells) + " |")
    return "\n".join(out)

# 「サブエージェントへの指示に必ず含めること」章と同じ規則を、抜粋の側にも
# 固定文で埋め込んでおく。あちらは親がプロンプトに書き写す前提の一覧であり、
# 親が書き忘れれば子には一度も届かない——2026-08-21 の実測では、これが指示に
# 無かったために15体中3体がJSONLを1件も返さなかった。ここに置けば、
# 親の書き忘れに関わらず、抜粋を読んだ子には必ず届く。
SUBAGENT_PREAMBLE = """#
# あなたはサブエージェントとして起動されている。次を必ず守ること。
#   - data/ には書かない。書くのは親だけ。
#   - append_rows.py <ds> --init / append_lineup.py --init は実行しない（CSVを空にする。他の波が書いた分もろとも消える）
#   - 結果は temp/rows-<波の名前>.jsonl に自分でJSONL（1行1件）で書く
#   - 返答には、書いたファイルのパスと件数だけを書く。行そのものを返答に含めない
#   - **料金は、このタスクの中核である。** 一覧ページに料金が無いのが普通なので、
#     会場ごとに1回だけ料金ページ（利用案内・入館料・チケット）を開いて
#     `price` `price_official` `price_checked` を書く。手順は「価格比較とクーポン検知」章の第1段階。
#     取得は `WebFetch` ではなく `fetch_page.py --text` を使う（料金は表で書かれており、要約では落ちる）"""

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
        kept.append((head, squeeze_table_padding(body)))
    return kept, dropped, len(text)


def main():
    p = argparse.ArgumentParser(description="SKILL.md から子に要る部分だけを抜く")
    p.add_argument("dataset", help="events / lives / movies")
    p.add_argument("--sections", action="store_true", help="残した節・外した節を一覧する")
    p.add_argument("--out", metavar="PATH",
                   help="抜粋をファイルに書き、標準出力にはパスだけを出す"
                        "（子に Read させる。親の文脈に抜粋を載せないための既定の使い方）")
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
    text = "\n".join([
        f"# これは `{rel}` の抜粋です（調査担当のサブエージェント向け）。",
        f"# 外してあるのは親の工程だけです（{'・'.join(d or '' for d in dropped)}）。",
        "# **ここに書かれていない判断が要る場合だけ**、上のファイルを読んでください。",
        SUBAGENT_PREAMBLE,
        "",
        body,
    ])

    if args.out:
        path = args.out if os.path.isabs(args.out) else os.path.join(ROOT, args.out)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        # **標準出力に抜粋そのものを出さない。** ここに出すと、ファイルに書いた
        # 意味が無くなる（親の文脈に全文が載る）。出すのは、指示にそのまま
        # 書き写せる1行だけにする。
        print(os.path.relpath(path, ROOT))
        print(f"# 抜粋 {len(body):,}文字 / 全文 {full:,}文字。"
              f"サブエージェントへの指示には、このパスを Read させる1文だけを書くこと",
              file=sys.stderr)
        return 0

    print(text)
    print(f"\n# 抜粋 {len(body):,}文字 / 全文 {full:,}文字",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
