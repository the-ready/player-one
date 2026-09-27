#!/usr/bin/env python3
"""`tools/diff_data.py` のフェス名簿を使ったリネーム検知を検証する（ネットワーク不要）。

    python3 tools/diff_data_test.py

## なぜここを固定するのか

2026-08-29 の無人実行で、会場ベース調査が「ポムフェス2026（ポムポムプリン
30周年記念）」を「ポムフェス POMPOMPURIN FESTIVAL」という別表記で新規発見し、
既存の登録行と同一だと認識できなかった。タイトルの編集距離ベースの類似度
だけでは、大きく書き換わった表記を拾いきれない（`similarity()`は逆に
「FUJI ROCK」と「ROCK IN JAPAN」のような無関係な行を誤って高スコアにする
弱点もある）。`data/festivals.csv`（フェス名簿）に載っている名前をタイトルへの
部分文字列一致で照合し、同じフェスに属す gone/added のペアを強く結びつける
——この判定をここで固定する。
"""

import contextlib
import csv
import json
import io
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import diff_data as dd                                        # noqa: E402


def _write_festivals(tmp, names):
    path = os.path.join(tmp, "festivals.csv")
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["name", "venue", "pref", "month_hint", "url", "status",
                    "first_seen", "last_hit", "hit_count", "note"])
        for n in names:
            w.writerow([n, "", "chiba", "9月", "", "active",
                        "2026-08-02", "2026-08-12", "3", ""])


def _row(title, venue="会場", start_date="2026-09-01"):
    return {"title": title, "venue": venue, "start_date": start_date, "end_date": start_date}


class _Sandbox:
    """diff_data.DATA / prev_rows.PREV を一時ディレクトリへ差し替える。

    `diff_one()` を丸ごと通して検証したいので、モジュール変数を差し替える
    （collect-fallback系のテストと同じ手法）。
    """

    def __enter__(self):
        import prev_rows as pr
        self.tmp = tempfile.mkdtemp(prefix="diff_data_sandbox_")
        self.prev_dir = os.path.join(self.tmp, ".prev")
        os.makedirs(self.prev_dir, exist_ok=True)
        self.orig = (dd.DATA, pr.DATA, pr.PREV)
        dd.DATA = self.tmp
        pr.DATA = self.tmp
        pr.PREV = self.prev_dir
        return self

    def __exit__(self, *a):
        import prev_rows as pr
        dd.DATA, pr.DATA, pr.PREV = self.orig

    def put_prev(self, name, headers, rows):
        _write_csv(os.path.join(self.prev_dir, name), headers, rows)

    def put_current(self, name, headers, rows):
        _write_csv(os.path.join(self.tmp, name), headers, rows)


def _write_csv(path, headers, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for r in rows:
            w.writerow({h: r.get(h, "") for h in headers})


EVENTS_HEADERS = [
    "id", "title", "kana", "cats", "area", "venue", "venue_url", "pref",
    "start_date", "end_date", "date", "dates", "open_time", "start_time", "end_time",
    "date_note", "backup_date", "status", "rank", "series_id", "announced_date",
    "is_additional", "onsale_label", "onsale_start", "onsale_start_time",
    "onsale_end", "onsale_end_time", "limited_sale", "price", "price_official",
    "price_best", "discount_pct", "best_source", "coupon_note", "price_checked",
    "price_condition", "source", "url", "official_url", "lat", "lng", "desc",
    "note", "parking", "nearest_station",
]


CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


@check("フェス名簿に載った名前で、書き換わったタイトルどうしを対にする")
def _():
    tmp = tempfile.mkdtemp(prefix="diff_data_test_")
    _write_festivals(tmp, ["ポムフェス"])
    orig = dd.DATA
    dd.DATA = tmp
    try:
        gone = {"g1": _row("ポムフェス2026（ポムポムプリン30周年記念）", venue="横浜赤レンガ倉庫")}
        added = {"a1": _row("ポムフェス POMPOMPURIN FESTIVAL", venue="横浜赤レンガ倉庫")}
        pairs = dd.fuzzy_pairs("lives.csv", gone, added)
    finally:
        dd.DATA = orig
    return pairs == [("g1", "a1", dd.FESTIVAL_MATCH_SCORE)] or f"対になっていない: {pairs}"


@check("フェス名簿に載っていても、一致しない行どうしは対にしない")
def _():
    tmp = tempfile.mkdtemp(prefix="diff_data_test_")
    _write_festivals(tmp, ["ROCK IN JAPAN FESTIVAL", "氣志團万博"])
    orig = dd.DATA
    dd.DATA = tmp
    try:
        gone = {"g1": _row("ROCK IN JAPAN FESTIVAL 2026 第1週")}
        added = {"a1": _row("氣志團万博2026 ～房総爆音リゾート～")}
        pairs = dd.fuzzy_pairs("lives.csv", gone, added)
    finally:
        dd.DATA = orig
    return pairs == [] or f"無関係な行を対にしてしまった: {pairs}"


@check("festivals.csv が無くても壊れない（events.csv 等）")
def _():
    tmp = tempfile.mkdtemp(prefix="diff_data_test_")   # festivals.csv を置かない
    orig = dd.DATA
    dd.DATA = tmp
    try:
        gone = {"g1": _row("ABC Live Tour 2026")}
        added = {"a1": _row("XYZ演奏会")}
        pairs = dd.fuzzy_pairs("lives.csv", gone, added)
    finally:
        dd.DATA = orig
    return pairs == [] or f"festivals.csv 不在で例外にならず変な結果: {pairs}"


@check("lives.csv 以外では festivals.csv 照合を行わない")
def _():
    tmp = tempfile.mkdtemp(prefix="diff_data_test_")
    _write_festivals(tmp, ["ポムフェス"])
    orig = dd.DATA
    dd.DATA = tmp
    try:
        gone = {"g1": _row("ポムフェス2026（ポムポムプリン30周年記念）")}
        added = {"a1": _row("ポムフェス POMPOMPURIN FESTIVAL")}
        pairs = dd.fuzzy_pairs("events.csv", gone, added)
    finally:
        dd.DATA = orig
    return pairs == [] or f"events.csv でもフェス名簿照合が効いてしまった: {pairs}"


@check("同じ枠を取り合うときは、真の完全一致がフェス名簿一致より優先される")
def _():
    tmp = tempfile.mkdtemp(prefix="diff_data_test_")
    _write_festivals(tmp, ["ポムフェス"])
    orig = dd.DATA
    dd.DATA = tmp
    try:
        # g1 は a1 と表記が完全一致。g2 は「ポムフェス」を含むだけの別行で、
        # フェス名簿経由でも a1 と対になりうるが、枠は g1 に取られるべき
        gone = {
            "g1": _row("ポムフェス2026（ポムポムプリン30周年記念）"),
            "g2": _row("ポムフェス OLD EVENT"),
        }
        added = {"a1": _row("ポムフェス2026（ポムポムプリン30周年記念）")}
        pairs = dd.fuzzy_pairs("lives.csv", gone, added)
    finally:
        dd.DATA = orig
    if len(pairs) != 1:
        return f"1対に絞れていない: {pairs}"
    return pairs[0][:2] == ("g1", "a1") or f"完全一致でない方が枠を取った: {pairs}"



@check("_still_carried_verbatim: id・受付欄・lineup_id 以外が同じなら「触られていない」")
def _():
    prev_row = {"id": "5", "title": "展覧会A", "price": "1000円",
                "onsale_start": "2026-09-01", "lineup_id": "old-slug"}
    cur_row = {"id": "12", "title": "展覧会A", "price": "1000円",
               "onsale_start": "", "lineup_id": ""}
    return dd._still_carried_verbatim(prev_row, cur_row) or "id/受付/lineup_id 以外は同じなのに False になった"


@check("_still_carried_verbatim: 監視対象の列が1つでも変われば「触られた」")
def _():
    prev_row = {"id": "5", "title": "展覧会A", "price": "1000円"}
    cur_row = {"id": "12", "title": "展覧会A", "price": "1200円"}
    return not dd._still_carried_verbatim(prev_row, cur_row) or "price が変わっているのに True になった"


@check("diff_one: carry-rest で書き戻したまま未確認の行が改名候補として検出される")
def _():
    with _Sandbox() as sb:
        prev = [dict(id="1", title="展覧会A", venue="美術館X", start_date="2026-10-01",
                     end_date="2026-10-31", pref="tokyo", desc="もとの説明"*10,
                     official_url="https://a.example/")]
        # carry-rest が実際に書くのと同じ形（id は振り直され、受付欄は空）を模す
        carried = [dict(id="99", title="展覧会A", venue="美術館X", start_date="2026-10-01",
                        end_date="2026-10-31", pref="tokyo", desc="もとの説明"*10,
                        official_url="https://a.example/")]
        new = dict(id="100", title="展覧会A（副題つき）", venue="美術館X",
                   start_date="2026-10-01", end_date="2026-10-31", pref="tokyo",
                   desc="もとの説明"*10 + "追記", official_url="https://a.example/x")
        sb.put_prev("events.csv", EVENTS_HEADERS, prev)
        sb.put_current("events.csv", EVENTS_HEADERS, carried + [new])
        res, _ = dd.diff_one("events.csv")
    cands = res["rename_candidates"]
    if len(cands) != 1:
        return f"改名候補が1件でない: {cands}"
    return bool(cands[0]["prev_uid"] and cands[0]["new_uid"]) or f"uidが空: {cands}"


@check("diff_one: 実際に再確認された行（内容が変わった）は改名候補の元にしない")
def _():
    with _Sandbox() as sb:
        prev = [dict(id="1", title="展覧会A", venue="美術館X", start_date="2026-10-01",
                     end_date="2026-10-31", pref="tokyo", desc="もとの説明"*10)]
        # 再確認済み：price が今週入った（carry-rest はこの列を持ち越さない）
        reconfirmed = [dict(id="99", title="展覧会A", venue="美術館X",
                            start_date="2026-10-01", end_date="2026-10-31",
                            pref="tokyo", desc="もとの説明"*10, price="1000円")]
        unrelated_new = dict(id="100", title="まったく別の展覧会B", venue="別会場",
                             start_date="2026-11-01", end_date="2026-11-30", pref="chiba")
        sb.put_prev("events.csv", EVENTS_HEADERS, prev)
        sb.put_current("events.csv", EVENTS_HEADERS, reconfirmed + [unrelated_new])
        res, _ = dd.diff_one("events.csv")
    return not res["rename_candidates"] or f"再確認済みの行が誤って候補に入った: {res['rename_candidates']}"


@check("diff_one: 物理的に消えた行の改名検知は従来どおり動く（回帰）")
def _():
    with _Sandbox() as sb:
        prev = [dict(id="1", title="展覧会A", venue="美術館X", start_date="2026-10-01",
                     end_date="2026-10-31", pref="tokyo", desc="もとの説明"*10)]
        new = dict(id="2", title="展覧会A（改題）", venue="美術館X",
                   start_date="2026-10-01", end_date="2026-10-31", pref="tokyo",
                   desc="もとの説明"*10)
        sb.put_prev("events.csv", EVENTS_HEADERS, prev)
        sb.put_current("events.csv", EVENTS_HEADERS, [new])   # 旧行は物理的に無い
        res, _ = dd.diff_one("events.csv")
    return len(res["rename_candidates"]) == 1 or f"物理消失の改名検知が壊れた: {res['rename_candidates']}"


# ------------------------------------------------ 書き戻しただけの行を [変更] に出さない
#
# 前回分を調査の前に書き戻す工程順では、受付欄を持つ行は全部「受付欄が空になった」
# 見かけの変更を持つ。これを [変更] に出すと「受付が進んだ」と読め、空回りの検査
# （is_noop）も素通りする。区別の手がかりは pending（書き戻して、まだ書き直していない行）。

def _pending(sb, name, uids):
    import prev_rows as pr
    path = pr.unverified_pending_path(name)
    with open(path, "w", encoding="utf-8") as f:
        for u in uids:
            f.write(json.dumps({"uid": u, "title": ""}, ensure_ascii=False) + "\n")


_ONSALE_PREV = dict(id="1", title="公演A", venue="ホールX", start_date="2026-10-10",
                    end_date="2026-10-10", pref="tokyo", onsale_label="先着受付中",
                    onsale_end="2026-10-01", price="5,000円")


def _carried(**kw):
    r = dict(_ONSALE_PREV, id="7", onsale_label="", onsale_end="")
    r.update(kw)
    return r


@check("書き戻しただけの行（pending にあり、受付欄が空になっただけ）は [変更] に出さない")
def _():
    import rowkey
    with _Sandbox() as sb:
        sb.put_prev("events.csv", EVENTS_HEADERS, [_ONSALE_PREV])
        sb.put_current("events.csv", EVENTS_HEADERS, [_carried()])
        _pending(sb, "events.csv", [rowkey.uid("events.csv", _ONSALE_PREV)])
        res, _ = dd.diff_one("events.csv")
    if res["changed"]:
        return f"見かけの変更が [変更] に出た: {res['changed']}"
    return len(res["carried_unverified"]) == 1 or f"持ち越しとして数えられていない: {res}"


@check("書き直した行（pending に無い）は、受付欄が空になっただけでも [変更] に出す（受付終了の事実）")
def _():
    with _Sandbox() as sb:
        sb.put_prev("events.csv", EVENTS_HEADERS, [_ONSALE_PREV])
        sb.put_current("events.csv", EVENTS_HEADERS, [_carried()])
        res, _ = dd.diff_one("events.csv")          # pending なし＝今回書き直した
    fields = res["changed"][0]["fields"] if res["changed"] else {}
    return ("onsale_label" in fields and not res["carried_unverified"]) or f"changed={res['changed']}"


@check("pending にあっても、受付欄以外が変わっていれば [変更] に出す")
def _():
    import rowkey
    with _Sandbox() as sb:
        sb.put_prev("events.csv", EVENTS_HEADERS, [_ONSALE_PREV])
        sb.put_current("events.csv", EVENTS_HEADERS, [_carried(price="6,000円")])
        _pending(sb, "events.csv", [rowkey.uid("events.csv", _ONSALE_PREV)])
        res, _ = dd.diff_one("events.csv")
    fields = res["changed"][0]["fields"] if res["changed"] else {}
    return "price" in fields or f"実際の変更が隠れた: {res}"


@check("書き戻しただけの回は、空回り（is_noop）として検出される")
def _():
    import rowkey
    import prev_rows as pr
    from datetime import date
    today = date(2026, 10, 1)
    with _Sandbox() as sb:
        sb.put_prev("events.csv", EVENTS_HEADERS, [_ONSALE_PREV])
        sb.put_current("events.csv", EVENTS_HEADERS, [_carried()])
        _pending(sb, "events.csv", [rowkey.uid("events.csv", _ONSALE_PREV)])
        with open(pr.meta_path("events.csv"), "w", encoding="utf-8") as f:
            json.dump({"taken_at": today.isoformat(), "rows": 1}, f)
        res, _ = dd.diff_one("events.csv")
        noop = dd.is_noop(res, today)
    return noop or f"何も調べていない回が空回りと判定されない: {res}"


@check("_still_carried_verbatim: 前回空だった自動補完列（lat 等）が埋まっただけなら「触られていない」")
def _():
    a = dict(title="A", venue="X", lat="", lng="", desc="説明")
    b = dict(title="A", venue="X", lat="35.1", lng="139.7", desc="説明")
    return dd._still_carried_verbatim(a, b) or "座標が埋まっただけで「触った」と判定した"


@check("_still_carried_verbatim: 自動補完列でも、値が変わった・消えたなら「触られた」")
def _():
    changed = dd._still_carried_verbatim(dict(lat="35.1"), dict(lat="35.2"))
    cleared = dd._still_carried_verbatim(dict(desc="説明"), dict(desc=""))
    return (not changed and not cleared) or f"changed={changed} cleared={cleared}"


@check("座標が埋まった書き戻し行も持ち越しに数え、空回りの検査を素通りさせない（2026-09-28）")
def _():
    import rowkey
    import prev_rows as pr
    from datetime import date
    today = date(2026, 10, 1)
    with _Sandbox() as sb:
        sb.put_prev("events.csv", EVENTS_HEADERS, [_ONSALE_PREV])
        sb.put_current("events.csv", EVENTS_HEADERS, [_carried(lat="35.57", lng="140.11")])
        _pending(sb, "events.csv", [rowkey.uid("events.csv", _ONSALE_PREV)])
        with open(pr.meta_path("events.csv"), "w", encoding="utf-8") as f:
            json.dump({"taken_at": today.isoformat(), "rows": 1}, f)
        res, _ = dd.diff_one("events.csv")
        noop = dd.is_noop(res, today)
    return (not res["changed"] and noop) or f"changed={res['changed']} noop={noop}"


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
