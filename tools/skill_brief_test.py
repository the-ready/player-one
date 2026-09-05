#!/usr/bin/env python3
"""`tools/skill_brief.py` が規則を落としていないかを検証する（ネットワーク不要）。

    python3 tools/skill_brief_test.py

## この検証だけは、通ることより「落ちないこと」を見る

抜粋は**捨てる処理**である。捨て方を間違えると、サブエージェントは列名や
キーの規則を知らないまま行を書き、`append_rows.py` に弾かれるか——最悪、
弾かれずに公開される。トークンを削るために品質を落とすのでは本末転倒なので、
「この語が抜粋に必ず在ること」を3スキルぶん固定する。

外す節は `SKILL.md` の見出しに依存するので、**見出しの改名で外し損ねる／
外しすぎる**ことも起こりうる。外した節の名前もここで突き合わせる。
"""

import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import skill_brief as sb                                      # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# どのスキルの抜粋にも必ず残っていなければならない語。
# 「行をどう書くか」と「何をしてはいけないか」だけを選んである。
COMMON = [
    "CSV列",            # 列の順序と名前
    "日程の書き方",      # 3スキル共通の日付規則
    "推測",              # 「推測で書かない」
    "robots",            # 取得してよいかの判定
    "fetch_page.py",     # 取得の手段
    "--schedule",        # 日程行だけを取る（2026-08-27 に追加）
    "append_rows.py",    # 書き出しの入口
    "_carry",            # 持ち越しの規則
    # **調査の技法**。最初の版はここを丸ごと外していた（`## 調査手順` を
    # 親の仕事に数えていた）。子が自分の作業のやり方を知らないまま調べることに
    # なるので、残っていることを明示的に固定する。
    "深掘りを打ち切る基準",
    "ステップ1",
    "ステップ4",
]

# 逆に、**外れていなければならない**もの（親の工程）。
# 残っていても品質は落ちないが、削る意味が無くなるので見張る。
MUST_DROP = ["前回分の棚卸し", "完走条件"]

# 親向けの抜粋（`--for parent`）に必ず残っていなければならない語。
# **親が自分の工程を失っていないか**だけを見る——ここが落ちると、親は終了工程や
# 撤退の手順を知らないまま実行することになり、その週の収集が丸ごと消えうる。
PARENT_MUST_KEEP = [
    "終了工程",            # 省略不可の締め
    "撤退の手順",          # 打ち切り方
    "初期化",              # append_rows.py --init（親のみ実行）
    "実行手順まとめ",      # 手順0〜18
    "並行して調べてよい",  # 波の分け方・起動の規則
    "工程ごとの検索の枠",  # 予算配分
    "品質チェック",        # 提出前の点検
    "前回分の棚卸し",      # prev_rows --worklist
    "budget.py",           # 残量の見方
    "diff_data.py",        # 差分の確定
]

PARENT_PER_DATASET = {
    # フェスの日割りは「親のみ実行」と明記された工程なので、親の抜粋に要る
    "lives": ["日割りの書き込み手順", "append_lineup.py"],
    "movies": ["消えた行の説明"],
    "events": ["消えた行の説明"],
}

HEAD_LINE_RE = re.compile(r"^#{2,3} +\S")

PER_DATASET = {
    "movies": ["上映形態キー", "ジャンルキー", "`theater` 列の書き方", "画像は扱わない",
               "price_official", "onsale_"],
    "lives":  ["転売サイトの絶対禁止", "公演形態キー", "ジャンルキー", "onsale_",
               "limited_sale", "tour_id"],
    "events": ["カテゴリキー", "coupon_note", "price_condition", "onsale_",
               "parking", "lat"],
}

fails = 0


def check(desc, ok, detail=""):
    global fails
    if not ok:
        fails += 1
        print(f"  NG   {desc}")
        if detail:
            print(f"        {detail}")
    else:
        print(f"  OK   {desc}")


def main():
    for ds in ("movies", "lives", "events"):
        print(f"\n{ds}")
        out = subprocess.run(
            [sys.executable, os.path.join(ROOT, "tools", "skill_brief.py"), ds],
            capture_output=True, text=True,
        )
        check(f"{ds}: 正常終了", out.returncode == 0, out.stderr[-200:])
        brief = out.stdout
        full = open(sb.skill_path(ds), encoding="utf-8").read()

        for kw in COMMON + PER_DATASET[ds]:
            in_full = kw in full
            if not in_full:
                # 全文に無いものを抜粋に求めても意味が無い。規則側の変更を疑う
                check(f"{ds}: {kw!r} が SKILL.md 本体にある", False,
                      "全文から消えています。規則が消えたのか、名前が変わったのかを確認してください")
                continue
            check(f"{ds}: {kw!r} が抜粋に残っている", kw in brief)

        # 語そのものは他節からの参照（「「完走条件」参照」等）で残ってよい。
        # 見出しとして残っていないことを見る。
        for kw in MUST_DROP:
            heads = [l for l in brief.split("\n")
                     if l.startswith("#") and kw in l and not l.startswith("# ")]
            check(f"{ds}: {kw!r} の節が抜粋から外れている", not heads, f"残っている見出し: {heads}")

        # 外した節が、意図した「親の工程」だけであること
        kept, dropped, _full_len = sb.build(ds)
        stray = [h for h in dropped
                 if not sb.is_excluded(h, "child")
                 and not any(k in h for k in sb.PARENT_ONLY_SUB)]
        check(f"{ds}: 外したのは親の工程だけ", not stray, f"想定外に外した節: {stray}")
        check(f"{ds}: 抜粋が空でない", len("\n".join(b for _h, b in kept).strip()) > 5000)

        # 縮んでいること（縮まないなら、この道具を挟む意味が無い）
        ratio = len(brief) / len(full)
        check(f"{ds}: 全文より縮んでいる（{ratio:.0%}）", ratio < 0.85)

        # ---- 親向けの抜粋（--for parent）----------------------------------
        pout = subprocess.run(
            [sys.executable, os.path.join(ROOT, "tools", "skill_brief.py"), ds, "--for", "parent"],
            capture_output=True, text=True,
        )
        check(f"{ds}: 親向けが正常終了", pout.returncode == 0, pout.stderr[-200:])
        parent = pout.stdout

        # **いちばん危ない誤り。** サブエージェント向けの前置きは「data/ に書かない・
        # --init を実行しない」——親がやらなければならないことの逆であり、これが
        # 親の抜粋に混ざると、親は自分の中心的な工程を禁止されたと読む。
        for forbidden in ("data/ には書かない", "--init は実行しない"):
            check(f"{ds}: 親向けに子への前置きが混ざっていない（{forbidden}）",
                  forbidden not in parent)

        for kw in PARENT_MUST_KEEP + PARENT_PER_DATASET.get(ds, []):
            if kw not in full:
                check(f"{ds}: {kw!r} が SKILL.md 本体にある", False, "全文から消えています")
                continue
            check(f"{ds}: 親向けに {kw!r} が残っている", kw in parent)

        pkept, pdropped, _ = sb.build(ds, "parent")
        pstray = [h for h in pdropped if any(k in h for k in sb.PARENT_ONLY_SUB)]
        check(f"{ds}: 親の工程の小節を外していない", not pstray, f"外してしまった: {pstray}")
        pratio = len(parent) / len(full)
        check(f"{ds}: 親向けが全文より縮んでいる（{pratio:.0%}）", pratio < 0.85)

        # ---- 2つの抜粋を合わせると、全文の見出しが1つも欠けない --------------
        #
        # 除外リストを2つに増やしたので、**どちらからも漏れる**という新しい壊れ方が
        # 生まれた（片方の名前を変えた・両方の表に載せた等）。見出し行の単位で
        # 突き合わせて、その穴を塞ぐ。見出し行（`## ` / `### `）で比べるのは、
        # 抜粋の先頭に「外した節: …」と名前だけが載るため（名前で比べると素通りする）。
        head_lines = [l for l in full.split("\n") if HEAD_LINE_RE.match(l)]
        missing = [l for l in head_lines if l not in brief and l not in parent]
        check(f"{ds}: 子＋親で全文の節をすべて覆っている（{len(head_lines)}節）",
              not missing, f"どちらにも入っていない節: {missing[:5]}")

        # ---- 表の余白潰しが「見た目だけ」であること
        #
        # 抜粋の3割が Prettier のテーブル整列だったので潰しているが、
        # **潰し方を間違えると規則そのものが壊れる。** とくに `art\|ent` の
        # ようにセルの中でエスケープした `|` は、素朴に `|` で切ると
        # 複数値の書き方の規則が別のセルに割れて子に届く。
        squeezed = sb.squeeze_table_padding(full)
        check(f"{ds}: 表の余白が潰れている",
              squeezed.count(" ") < full.count(" ") * 0.8,
              f"{full.count(' ')} → {squeezed.count(' ')}")
        check(f"{ds}: 潰しても行数が変わらない",
              squeezed.count("\n") == full.count("\n"))
        check(f"{ds}: エスケープした `|` が壊れていない",
              squeezed.count("\\|") == full.count("\\|"),
              f"{full.count(chr(92) + '|')} → {squeezed.count(chr(92) + '|')}")
        # コードブロックの中は1文字も変えない（CSVヘッダーの見本・実行例が入っている）
        def fenced(text):
            out, on = [], False
            for line in text.split("\n"):
                if line.lstrip().startswith("```"):
                    on = not on
                elif on:
                    out.append(line)
            return out
        check(f"{ds}: コードブロックの中身は変えていない", fenced(squeezed) == fenced(full))
        # 表の外の行も変えない（余白を潰すのは表の行だけ）
        non_table = lambda t: [l for l in t.split("\n") if not sb.TABLE_ROW_RE.match(l)]
        check(f"{ds}: 表以外の行は変えていない", non_table(squeezed) == non_table(full))

    print(f"\n{'NG が %d 件あります' % fails if fails else 'すべて期待どおり'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
