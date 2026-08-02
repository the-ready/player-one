#!/usr/bin/env python3
"""週をまたいで「同じ行」を同定するためのキーを作る。

差分検知（前回のCSVと今回のCSVを突き合わせる）を成立させるには、
週をまたいで安定した識別子が要る。ところが `id` は append_rows.py が毎回
1から振り直すので、**週をまたぐ識別子としては使えない**。

かといって新しく uid 列をCSVに足すと、収集スキルが毎回それを正しく書き写す
必要が生まれ、書き間違いという新しい事故の種になる。そこで uid は列として
持たず、**既にある列から決定論的に計算する**方式にした。行の同定に使う列
（タイトル・会場・日付）は、そもそも間違えてはいけない列なので、
これらが合っていれば同じ行、というのは無理のない前提になる。

表記ゆれ（全角/半角、ひらがな/カタカナ、記号、空白）で別行と判定されないよう、
キーを作る前に強く正規化する。それでも取り違える場合（タイトルの言い換え等）に
備えて、diff_data.py 側が類似度によるあいまい照合を別途行う。
"""

import difflib
import hashlib
import re
import unicodedata
from collections import Counter

# 正規化で落とす記号。「」『』【】〜・！？などの装飾は同定に使わない。
_DROP = re.compile(r"[\s　\-‐‑–—―ー~〜:：;；,，.．/／\\|｜"
                   r"'\"“”‘’`（）\(\)\[\]「」『』【】〈〉《》〔〕!！?？*＊+＋=＝&＆#＃@＠…·・]+")


def _kata_to_hira(s: str) -> str:
    """カタカナをひらがなに寄せる。`ワンマン` と `わんまん` を同じ行と見なすため。"""
    out = []
    for ch in s:
        code = ord(ch)
        # 全角カタカナ（ァ〜ヶ）の範囲だけをひらがなにずらす。長音符・記号は触らない。
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def norm(value) -> str:
    """同定用の正規化。表示には使わない（情報を落とすため）。"""
    s = "" if value is None else str(value)
    s = unicodedata.normalize("NFKC", s)
    s = _kata_to_hira(s)
    s = s.casefold()
    s = _DROP.sub("", s)
    return s


def _first_token(value: str) -> str:
    """`|` 区切りの複数値から先頭だけを取る（映画の複数チェーン表記など）。"""
    return (value or "").split("|")[0].strip()


def natural_key(name: str, row: dict) -> tuple:
    """データセットごとの「自然キー」。uid の材料になる列の組。

    events / lives … タイトル × 会場 × 開始日
        同じ会場で同じ日に同じ名前の催しが2つあることは実質ない。

    movies … タイトル × 公開日 × 上映形態（+ 新作以外は会場）
        新作行の `theater` は上映チェーンの一覧で、週によって増減する
        （例：翌週 `109シネマズ` が追加される）。これをキーに含めると
        同じ作品が「消えて新しく現れた」ことになってしまうため、
        新作だけは会場をキーから外す。名画座・野外上映・映画祭は
        「どこでやるか」が企画そのものなので会場を含める。
    """
    if name == "movies.csv":
        stype = (row.get("screening_type") or "").strip()
        place = "" if stype.startswith("new") else _first_token(row.get("theater"))
        return (norm(row.get("title")), norm(row.get("release_date")), norm(stype), norm(place))
    return (norm(row.get("title")), norm(_first_token(row.get("venue"))), norm(row.get("start_date")))


def uid(name: str, row: dict) -> str:
    """自然キーから決まる8桁の識別子。CSVには保存しない（毎回計算する）。"""
    raw = "\x1f".join(natural_key(name, row))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]


def title_key(row: dict) -> str:
    """あいまい照合に使う、タイトルだけの正規化文字列。"""
    return norm(row.get("title"))


def similarity(a: str, b: str) -> float:
    """タイトル同士の似ている度合い（0〜1）。

    差分の並び替えに強くしてある。展覧会名は
    `開創700年記念 特別展「大徳寺」` → `特別展「大徳寺」―開創700年をめぐって`
    のように**語順が入れ替わる**形で書き換えられることが多く、
    編集距離ベースの比較だけだと 0.39 のような低い値になって別物と判定されてしまう。
    そこで「共通する文字がどれだけ含まれているか」も併せて見る。
    """
    if not a or not b:
        return 0.0
    seq = difflib.SequenceMatcher(None, a, b).ratio()
    ca, cb = Counter(a), Counter(b)
    common = sum((ca & cb).values())
    contain = common / min(len(a), len(b))
    return max(seq, contain)
