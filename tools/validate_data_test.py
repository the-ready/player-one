#!/usr/bin/env python3
"""`tools/validate_data.py` の「価格の書式」と「同一CSV内の重複」の判定を固定する（ネットワーク不要）。

    python3 tools/validate_data_test.py

## なぜこの2つなのか

どちらも 2026-08-30 の週次実行で起きた1つの事故の、別々の側面である
（`docs/skill-feedback.md` 2026-09-21）。同じ実行の中で、同じ展覧会が

  - 経路A（既存行の再確認）: `一般2,300円`・展覧会個別ページのURL・具体的な desc
  - 経路B（同じ実行内の新規発見）: `2600` という裸の数字・`pref` 空欄・会場トップのURL

という2行としてCSVに入り、タイトルのプレフィックス（`東京都美術館開館100周年記念`）の
有無だけで uid が一致せず `append_rows.py` の重複検知をすり抜けた。
**手作業の突き合わせに何十回もの grep と目視が必要で、3週間以上気づかれなかった。**

片方だけでは足りない。裸の数字のチェックは「その行が劣化している」ことしか言わず、
重複のチェックは「正しい行が別にある」ことしか言わない。事故の形は2つ揃って現れる。

## 判定の線を、ここで固定する理由

重複判定のしきい値（`DUP_TITLE_MIN`）は実データを見て決めた値で、上げれば本物を
取りこぼし、下げれば「同じ会場で同時に走る別の企画」を毎週挙げ続ける。**どちらに
倒れても、次に触る人には「なんとなく動いている」ようにしか見えない。**
線がどちら側に何を落とすかを、実例で書き留めておく。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import validate_data as vd                                    # noqa: E402

CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


def _row(**kw):
    """events.csv の1行。指定しなかった列は空でよい（検証は欠損に耐える側にある）。"""
    r = {c: "" for c in vd.EXPECTED_HEADERS["events.csv"]}
    r.update(kw)
    return r


def _messages(rows, name="events.csv"):
    """その行の集まりを検証したときに出る WARNING / ERROR の全文（1つの文字列）。"""
    rep = vd.Report()
    vd.validate_main(name, rows, vd.load_enums(), rep)
    return "\n".join(rep.warning_lines() + rep.errors)


def _dup_messages(rows, name="events.csv"):
    """重複判定だけを切り出して回す（他の列の警告に埋もれさせない）。"""
    rep = vd.Report()
    vd.check_same_file_duplicates(name, rows, rep)
    return "\n".join(rep.warning_lines())


# --- 価格の書式 ---------------------------------------------------------------

@check("裸の数字の price を挙げる（事故で実際に書かれた 2600）")
def _():
    msg = _messages([_row(title="大英博物館日本美術コレクション", venue="東京都美術館",
                          start_date="2026-09-01", end_date="2026-11-30", price="2600")])
    return "2600" in msg or f"挙がりませんでした: {msg}"


@check("カンマ区切りだけの price も挙げる（2,300 には券種も通貨も無い）")
def _():
    msg = _messages([_row(title="展", venue="V", start_date="2026-09-01", price="2,300")])
    return "price が '2,300' です" in msg or f"挙がりませんでした: {msg}"


@check("整形済みの price は挙げない")
def _():
    for ok in ("一般2,300円", "おとな2,800円／小中学生1,300円", "無料", "要問合せ",
               "入館料に含まれる（大人2,600円）"):
        msg = _messages([_row(title="展", venue="V", start_date="2026-09-01", price=ok)])
        if "券種と円表記を付けて" in msg:
            return f"{ok!r} を誤って挙げました"
    return True


@check("price が空欄なら何も言わない（確認できない値は空欄にするのが正しい）")
def _():
    msg = _messages([_row(title="展", venue="V", start_date="2026-09-01", price="")])
    return "券種と円表記を付けて" not in msg or f"空欄を挙げました: {msg}"


@check("整数であることが仕様の price_official は、この判定の対象にしない")
def _():
    msg = _messages([_row(title="展", venue="V", start_date="2026-09-01",
                          price="一般2,300円", price_official="2300",
                          price_checked="2026-09-01")])
    return "券種と円表記を付けて" not in msg or f"price_official を挙げました: {msg}"


# --- 同一CSV内の重複 ----------------------------------------------------------

@check("プレフィックスの有無だけが違う同じ展覧会を挙げる（事故そのものの形）")
def _():
    msg = _dup_messages([
        _row(title="東京都美術館開館100周年記念 大英博物館日本美術コレクション 百花繚乱",
             venue="東京都美術館", start_date="2026-09-01", end_date="2026-11-30",
             price="一般2,300円"),
        _row(title="大英博物館日本美術コレクション 百花繚乱",
             venue="東京都美術館", start_date="2026-09-01", end_date="2026-11-30",
             price="2600"),
    ])
    return "同じ催しの可能性があります" in msg or f"挙がりませんでした: {msg}"


@check("会場が違えば挙げない（同名の巡回展は別の行として正しい）")
def _():
    msg = _dup_messages([
        _row(title="松本零士展", venue="東京都美術館", start_date="2026-09-01", end_date="2026-11-30"),
        _row(title="松本零士展", venue="横浜美術館", start_date="2026-09-01", end_date="2026-11-30"),
    ])
    return msg == "" or f"別会場を挙げました: {msg}"


@check("会期がずれていれば挙げない（同じ会場の入れ替わりは重複ではない）")
def _():
    msg = _dup_messages([
        _row(title="松本零士展", venue="東京都美術館", start_date="2026-09-01", end_date="2026-10-31"),
        _row(title="松本零士展", venue="東京都美術館", start_date="2026-11-01", end_date="2026-12-31"),
    ])
    return msg == "" or f"会期違いを挙げました: {msg}"


@check("同じ会場・同じ会期でも、題が別物なら挙げない")
def _():
    msg = _dup_messages([
        _row(title="奥村土牛展", venue="山種美術館", start_date="2026-09-01", end_date="2026-11-30"),
        _row(title="速水御舟と日本画の煌めき", venue="山種美術館", start_date="2026-09-01", end_date="2026-11-30"),
    ])
    return msg == "" or f"別の企画を挙げました: {msg}"


@check("uid が一致する重複はここで言わない（append_rows.py が追記時に弾く側）")
def _():
    same = dict(title="松本零士展", venue="東京都美術館", start_date="2026-09-01", end_date="2026-11-30")
    msg = _dup_messages([_row(**same), _row(**same)])
    return msg == "" or f"二重に言いました: {msg}"


@check("短い題が、その文字を含むだけの別の題に一致しない（similarity を使わない理由）")
def _():
    # `rowkey.similarity()` は「共通する文字がどれだけ含まれているか」も見るので、
    # この2つを 1.0 で一致させてしまう。週をまたぐ照合なら候補が絞られていて実害が
    # 無いが、同一CSV内では全対が候補になるため、編集距離だけを使っている。
    msg = _dup_messages([
        _row(title="ワークショップ", venue="印刷博物館", start_date="2026-09-01", end_date="2026-09-30"),
        _row(title="「ひらく、めくる、めぐるー印刷博物館の美しい印刷」常設ワークショップ",
             venue="印刷博物館", start_date="2026-09-01", end_date="2026-09-30"),
    ])
    return msg == "" or f"短い題に引きずられました: {msg}"


@check("movies の新作行は対象外（theater がチェーンの一覧で、同定にも使っていない）")
def _():
    def mrow(**kw):
        r = {c: "" for c in vd.EXPECTED_HEADERS["movies.csv"]}
        r.update(kw)
        return r
    msg = _dup_messages([
        mrow(title="怪獣大戦争 リマスター", theater="TOHOシネマズ|イオンシネマ",
             screening_type="new", release_date="2026-10-01", end_date="2026-12-31"),
        mrow(title="怪獣大戦争 リマスター版", theater="TOHOシネマズ|イオンシネマ",
             screening_type="new", release_date="2026-10-01", end_date="2026-12-31"),
    ], name="movies.csv")
    return msg == "" or f"新作行を挙げました: {msg}"


@check("movies の名画座の特集は対象にする（どこでやるかが企画そのもの）")
def _():
    def mrow(**kw):
        r = {c: "" for c in vd.EXPECTED_HEADERS["movies.csv"]}
        r.update(kw)
        return r
    msg = _dup_messages([
        mrow(title="ラピュタ阿佐ヶ谷「野村芳太郎監督特集」", theater="ラピュタ阿佐ヶ谷",
             screening_type="revival", release_date="2026-10-01", end_date="2026-10-31"),
        mrow(title="ラピュタ阿佐ヶ谷 野村芳太郎監督特集 追悼上映", theater="ラピュタ阿佐ヶ谷",
             screening_type="revival", release_date="2026-10-01", end_date="2026-10-31"),
    ], name="movies.csv")
    return "同じ催しの可能性があります" in msg or f"挙がりませんでした: {msg}"


@check("包含: プレフィックスが付いただけの実際の重複を拾う（編集距離では届かない）")
def _():
    # data/events.csv に実在した組。編集距離は 0.70 に届かないが、
    # 短いほうが長いほうの末尾に丸ごと入っており、長さ比も 0.40 を超える。
    msg = _dup_messages([
        _row(title="開園120周年記念 三溪園大茶会", venue="三溪園",
             start_date="2026-10-01", end_date="2026-10-02"),
        _row(title="三溪園大茶会", venue="三溪園",
             start_date="2026-10-01", end_date="2026-10-02"),
    ])
    return "同じ催しの可能性があります" in msg or f"挙がりませんでした: {msg}"


@check("包含: 短い題は長さ比で落とす（ワークショップ問題の再発防止）")
def _():
    msg = _dup_messages([
        _row(title="ワークショップ", venue="印刷博物館", start_date="2026-09-01", end_date="2026-09-30"),
        _row(title="「ひらく、めくる、めぐるー印刷博物館の美しい印刷」常設ワークショップ",
             venue="印刷博物館", start_date="2026-09-01", end_date="2026-09-30"),
    ])
    return msg == "" or f"短い題を拾いました: {msg}"


@check("包含: 題の途中に含まれるだけでは拾わない（先頭か末尾のみ）")
def _():
    msg = _dup_messages([
        _row(title="秋の特別展について", venue="V", start_date="2026-09-01", end_date="2026-11-30"),
        _row(title="特別展あき", venue="V", start_date="2026-09-01", end_date="2026-11-30"),
    ])
    return msg == "" or f"中間一致で拾いました: {msg}"


@check("長さ比の足切りは、編集距離の判定を変えない（2r/(1+r) が 0.70 に届かない）")
def _():
    # r=0.40 のときの上限は 0.571。足切りで落ちる組が DUP_TITLE_MIN を超えることは
    # 構造的に起きない——この不等式が崩れたら、足切りは判定を変える最適化になる。
    r = vd.DUP_LEN_RATIO_MIN
    return (2 * r) / (1 + r) < vd.DUP_TITLE_MIN or \
        f"足切りが判定を変えます: 上限{2*r/(1+r):.3f} >= しきい値{vd.DUP_TITLE_MIN}"


@check("会場が空欄の行では判定しない（束ねる手がかりが無い）")
def _():
    msg = _dup_messages([
        _row(title="夏祭り", venue="", start_date="2026-09-01", end_date="2026-09-02"),
        _row(title="夏祭り2026", venue="", start_date="2026-09-01", end_date="2026-09-02"),
    ])
    return msg == "" or f"会場空欄で挙げました: {msg}"


@check("ERROR にはしない（同じ会場・同じ会期の別企画は実在するため）")
def _():
    rep = vd.Report()
    vd.check_same_file_duplicates("events.csv", [
        _row(title="闇の魔術のハロウィーン期間限定アフタヌーンティー", venue="ワーナー ブラザース スタジオツアー東京",
             start_date="2026-09-01", end_date="2026-11-04"),
        _row(title="闇の魔術のハロウィーン期間限定ハイティー", venue="ワーナー ブラザース スタジオツアー東京",
             start_date="2026-09-01", end_date="2026-11-04"),
    ], rep)
    return (rep.errors == [] and rep.warnings != []) or f"errors={rep.errors}"


@check("完全重複（同じ uid）を find_exact_duplicates が拾う")
def _():
    rows = [
        {"id": "1", "title": "展覧会A", "venue": "美術館X", "start_date": "2026-10-01", "end_date": "2026-10-31"},
        {"id": "2", "title": "展覧会A", "venue": "美術館X", "start_date": "2026-10-01", "end_date": "2026-10-31"},
        {"id": "3", "title": "展覧会B", "venue": "美術館X", "start_date": "2026-10-01", "end_date": "2026-10-31"},
    ]
    got = vd.find_exact_duplicates("events.csv", rows)
    if len(got) != 1:
        return f"1組にならない: {[(u, [i for i, _ in it]) for u, it in got]}"
    u, items = got[0]
    return [i for i, _ in items] == [2, 3] or f"行番号が違う: {[i for i, _ in items]}"


@check("uid が違えば完全重複には数えない（近似重複の担当）")
def _():
    rows = [
        {"id": "1", "title": "展覧会A", "venue": "美術館X", "start_date": "2026-10-01", "end_date": "2026-10-31"},
        {"id": "2", "title": "特別展 展覧会A", "venue": "美術館X", "start_date": "2026-10-01", "end_date": "2026-10-31"},
    ]
    return not vd.find_exact_duplicates("events.csv", rows) or "uid が違う組を完全重複にした"


@check("完全重複が無ければ空を返す")
def _():
    rows = [
        {"id": "1", "title": "展覧会A", "venue": "美術館X", "start_date": "2026-10-01", "end_date": "2026-10-31"},
        {"id": "2", "title": "展覧会B", "venue": "美術館Y", "start_date": "2026-10-02", "end_date": "2026-10-31"},
    ]
    return vd.find_exact_duplicates("events.csv", rows) == [] or "重複でないものを挙げた"


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
