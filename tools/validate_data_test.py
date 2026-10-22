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


# --- バーゲン（cats=sale）と駐車場（event_parking） ---------------------------

@check("cats=sale は許可されている（config.js の CATS から読むので、追加しただけで通る）")
def _():
    msg = _messages([_row(title="三井アウトレットパーク BLACK FRIDAY", cats="sale", venue="三井アウトレットパーク 木更津",
                          pref="chiba", start_date="2026-11-14", end_date="2026-11-30", series_id="mop-bf-2026")])
    return "未知の値" not in msg or msg


@check("cats=sale の行に料金の列が入っていたら警告する（無料の絞り込みへの混入・値引きとの取り違え）")
def _():
    msg = _messages([_row(title="三井アウトレットパーク BLACK FRIDAY", cats="sale", venue="三井アウトレットパーク 木更津",
                          pref="chiba", start_date="2026-11-14", end_date="2026-11-30", price="無料")])
    return ("料金の列が入っています" in msg and "price" in msg) or msg


@check("cats=sale の行の料金が空なら、料金の警告は出ない")
def _():
    msg = _messages([_row(title="三井アウトレットパーク BLACK FRIDAY", cats="sale", venue="三井アウトレットパーク 木更津",
                          pref="chiba", start_date="2026-11-14", end_date="2026-11-30")])
    return "料金の列が入っています" not in msg or msg


@check("sale 以外の行の price は、この警告の対象にしない")
def _():
    msg = _messages([_row(title="展覧会", cats="art", venue="美術館", pref="tokyo", price="一般1,200円",
                          start_date="2026-11-14", end_date="2026-11-30")])
    return "料金の列が入っています" not in msg or msg


@check("event_parking は temp / closed / temp_only / 空だけ。未知の値は ERROR")
def _():
    ok = _messages([_row(title="花火大会", cats="fest", venue="河川敷", pref="tokyo", event_parking="temp",
                         parking="臨時駐車場 約800台・要予約", start_date="2026-11-14", end_date="2026-11-14")])
    bad = _messages([_row(title="花火大会", cats="fest", venue="河川敷", pref="tokyo", event_parking="あり",
                          start_date="2026-11-14", end_date="2026-11-14")])
    return ("event_parking に未知の値" not in ok and "event_parking に未知の値" in bad) or f"{ok!r} / {bad!r}"


@check("event_parking を書いたのに parking の文が空なら警告する（バッジだけでは行き先を決められない）")
def _():
    msg = _messages([_row(title="花火大会", cats="fest", venue="河川敷", pref="tokyo", event_parking="temp",
                          start_date="2026-11-14", end_date="2026-11-14")])
    return "parking が空です" in msg or msg


# --- 出演者（guests / guest_dates / guest_note） -----------------------------------

from datetime import date as _date                            # noqa: E402

_TODAY = _date(2026, 10, 20)


def _guest_messages(name="events.csv", **kw):
    """出演者の3列だけを検査する（今日を固定して、他の列の警告に埋もれさせない）。"""
    r = _row(title="展", venue="V", start_date="2026-10-01", end_date="2026-11-30", **kw) \
        if name == "events.csv" else {c: "" for c in vd.EXPECTED_HEADERS[name]} | kw
    rep = vd.Report()
    start = vd.parse_date(r.get("start_date") or r.get("release_date"))
    end = vd.parse_date(r.get("end_date"))
    vd.check_guests(rep, "x:2", r, start, end, today=_TODAY)
    return "\n".join(rep.warning_lines()), "\n".join(rep.errors)


def _expect_clean(**kw):
    w, e = _guest_messages(**kw)
    return (not w and not e) or f"何も出ないはずが出た: warn={w!r} err={e!r}"


@check("出演者の3列は events / movies のヘッダーにあり、lives には無い")
def _():
    h = vd.EXPECTED_HEADERS
    cols = ["guests", "guest_dates", "guest_note"]
    # 映画は出演者の3列の後ろに `formats`（上映フォーマット）を持つ
    return (h["events.csv"][-3:] == cols and h["movies.csv"][-4:-1] == cols
            and not any(c in h["lives.csv"] for c in cols)) or "ヘッダーの位置・対象が違う"


# --- 上映フォーマット（`formats`。映画だけ） --------------------------------------

def _format_messages(raw):
    rep = vd.Report()
    vd.check_formats(rep, "x:2", {"formats": raw}, vd.load_enums()["movie_format"])
    return "\n".join(rep.warning_lines()), "\n".join(rep.errors)


@check("formats は映画のヘッダーの末尾にだけあり、選択肢は config.js から読める")
def _():
    h = vd.EXPECTED_HEADERS
    keys = vd.load_enums()["movie_format"]
    return (h["movies.csv"][-1] == "formats"
            and "formats" not in h["events.csv"] and "formats" not in h["lives.csv"]
            and {"imax", "4dx", "screenx"} <= keys) or f"ヘッダーか選択肢が違う: {sorted(keys)}"


@check("formats が空（確かめていない）・既知のキーだけなら何も言わない")
def _():
    out = [_format_messages(raw) for raw in ("", "imax", "imax|4dx|screenx")]
    return all(not w and not e for w, e in out) or f"何も出ないはずが出た: {out!r}"


@check("formats に劇場の呼び名をそのまま書くと ERROR（チップが劇場の数だけ割れる）")
def _():
    w, e = _format_messages("IMAXレーザー/GT")
    return "formats に未知の値" in e or f"ERROR にならない: warn={w!r} err={e!r}"


@check("formats の空の要素・重複は WARNING")
def _():
    w1, _e = _format_messages("imax|")
    w2, _e = _format_messages("imax|imax")
    return ("空の要素" in w1 and "同じ値が2回" in w2) or f"警告が出ない: {w1!r} / {w2!r}"


@check("出演者が空の行には何も言わない（大半の行はこちら）")
def _():
    return _expect_clean()


@check("正しい書き方（氏名・出演日・注記）は何も言わない")
def _():
    return _expect_clean(guests="青山龍|白石凛", guest_dates="2026-10-25|2026-11-03",
                         guest_note="10/25 14:00 トーク／11/3 サイン会")


@check("出演日が空でも、出演者がいれば何も言わない（出演日を推測しない）")
def _():
    return _expect_clean(guests="青山龍")


@check("guest_dates の書式崩れは ERROR（日付の比較が壊れ、期限切れの判定が嘘になる）")
def _():
    w, e = _guest_messages(guests="青山龍", guest_dates="10/25")
    return "guest_dates の書式が YYYY-MM-DD ではありません" in e or f"ERROR にならない: {e!r}"


@check("存在しない日付（2026-02-30）も ERROR")
def _():
    w, e = _guest_messages(guests="A", guest_dates="2026-11-31")
    return "存在しない日付" in e or f"ERROR にならない: {e!r}"


@check("guests が空なのに guest_dates / guest_note があれば WARNING（画面に出ない値）")
def _():
    w, e = _guest_messages(guest_dates="2026-10-25", guest_note="トーク")
    return ("guest_dates があるのに guests が空" in w and "guest_note があるのに guests が空" in w and not e) \
        or f"w={w!r} e={e!r}"


@check("人名ではない語（ほか・豪華ゲスト・スペシャルゲスト…）は WARNING")
def _():
    out = []
    for bad in ("ほか豪華ゲスト多数", "スペシャルゲスト", "出演者未定", "調整中", "他"):
        w, _e = _guest_messages(guests=f"青山龍|{bad}")
        out.append(("人名ではない語" in w, bad))
    return all(ok for ok, _ in out) or f"拾えなかった: {[b for ok, b in out if not ok]}"


@check("敬称・肩書付き（さん・様・氏・先生・監督・選手）は WARNING（肩書は guest_note へ）")
def _():
    out = []
    for bad in ("青山龍さん", "白石様", "黒田氏", "赤松先生", "ダニエル・フイ監督", "緑川選手"):
        w, _e = _guest_messages(guests=bad)
        out.append(("敬称・肩書" in w, bad))
    return all(ok for ok, _ in out) or f"拾えなかった: {[b for ok, b in out if not ok]}"


@check("肩書の語が名前の先頭・途中にあるだけなら誤検知しない（末尾にあるときだけ拾う）")
def _():
    for ok_name in ("ヴィッキー・ヤン", "氏家恵", "選手村太郎", "監督院花子", "Mr.Children"):
        w, _e = _guest_messages(guests=ok_name)
        if "敬称・肩書" in w:
            return f"誤検知: {ok_name}"
    return True


@check("`||`・末尾の `|`・同名の重複・区切り違い（、 ／ ｜ ，）は WARNING。AC/DC や ・ は人名の一部なので拾わない")
def _():
    a, _ = _guest_messages(guests="A||B")
    b, _ = _guest_messages(guests="A|B|")
    c, _ = _guest_messages(guests="A|A")
    d, _ = _guest_messages(guests="A、B")
    e = [_guest_messages(guests=g)[0] for g in ("A／B", "A｜B", "A，B", "A,B")]
    ok_names = [_guest_messages(guests=g)[0] for g in ("AC/DC", "ヴィッキー・ヤン")]
    return ("空の要素" in a and "空の要素" in b and "2回あります" in c and "区切りは半角の `|`" in d
            and all("区切りは半角の `|`" in w for w in e) and not any(ok_names)) \
        or f"a={a!r} b={b!r} c={c!r} d={d!r} e={e} ok={ok_names}"


@check("1件が30字を超える（文章を書いている）・9人以上は WARNING")
def _():
    a, _ = _guest_messages(guests="あ" * 31)
    b, _ = _guest_messages(guests="|".join(f"名{i}" for i in range(9)))
    c, _ = _guest_messages(guests="|".join(f"名{i}" for i in range(8)))
    return ("30字を超えて" in a and "8人を超えて" in b and "8人を超えて" not in c) \
        or f"a={a!r} b={b!r} c={c!r}"


@check("出演日の並び順・重複・会期外・すべて過去を WARNING で挙げる")
def _():
    a, _ = _guest_messages(guests="A", guest_dates="2026-11-03|2026-10-25")
    b, _ = _guest_messages(guests="A", guest_dates="2026-10-25|2026-10-25")
    c, _ = _guest_messages(guests="A", guest_dates="2026-09-20|2026-10-25")       # 会期前
    d, _ = _guest_messages(guests="A", guest_dates="2026-12-24")                  # 会期後
    e, _ = _guest_messages(guests="A", guest_dates="2026-10-10")                  # すべて過去
    return ("日付順に並んでいません" in a and "同じ日が2回" in b and "開始日" in c
            and "終了日" in d and "すべて過去" in e) or f"a={a!r} b={b!r} c={c!r} d={d!r} e={e!r}"


@check("出演日が今日ならまだ過去ではない（当日は残す）")
def _():
    w, _e = _guest_messages(guests="A", guest_dates="2026-10-20")
    return "すべて過去" not in w or f"当日を過去扱いした: {w!r}"


@check("guest_note が長すぎれば WARNING")
def _():
    w, _e = _guest_messages(guests="A", guest_note="あ" * 121)
    return "120字を超えて" in w or f"拾えない: {w!r}"


@check("映画（release_date）でも同じ検査が効く／ライブには適用しない")
def _():
    mv = {c: "" for c in vd.EXPECTED_HEADERS["movies.csv"]}
    mv.update(title="m", theater="t", release_date="2026-10-10", end_date="2026-11-10",
              url="https://example.com/", guests="監督太郎さん", guest_dates="2026-10-24")
    rep = vd.Report()
    vd.validate_main("movies.csv", [mv], vd.load_enums(), rep)
    msg = "\n".join(rep.warning_lines() + rep.errors)
    lv = {c: "" for c in vd.EXPECTED_HEADERS["lives.csv"]}
    lv.update(title="l", venue="v", start_date="2026-10-10", end_date="2026-10-10",
              url="https://example.com/", artists="A|B")
    rep2 = vd.Report()
    vd.validate_main("lives.csv", [lv], vd.load_enums(), rep2)
    msg2 = "\n".join(rep2.warning_lines() + rep2.errors)
    return ("敬称・肩書" in msg and "guest" not in msg2) or f"映画={msg!r} ライブ={msg2!r}"


@check("validate_main を通しても、正常な出演者行は ERROR を出さない（配線）")
def _():
    msg = _messages([_row(title="トーク付き展", venue="V", start_date="2026-10-01", end_date="2099-12-31",
                          url="https://example.com/", guests="青山龍", guest_dates="2099-10-25")])
    return "guest" not in msg or f"正常な行に出た: {msg}"


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
