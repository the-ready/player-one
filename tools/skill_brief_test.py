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
                 if not sb.is_parent_only(h)
                 and not any(k in h for k in sb.PARENT_ONLY_SUB)]
        check(f"{ds}: 外したのは親の工程だけ", not stray, f"想定外に外した節: {stray}")
        check(f"{ds}: 抜粋が空でない", len("\n".join(b for _h, b in kept).strip()) > 5000)

        # 縮んでいること（縮まないなら、この道具を挟む意味が無い）
        ratio = len(brief) / len(full)
        check(f"{ds}: 全文より縮んでいる（{ratio:.0%}）", ratio < 0.85)

    print(f"\n{'NG が %d 件あります' % fails if fails else 'すべて期待どおり'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
