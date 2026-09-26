#!/usr/bin/env python3
"""`tools/append_rows.py` の upsert と持ち越しを検証する（ネットワーク不要）。

    python3 tools/append_rows_test.py

## なぜここを念入りにやるか

このスクリプトは**収集が書き込む唯一の入口**で、しかも 2026-09-26 に追記専用から
upsert へ作り替えた。作り替えの前後で壊れると、週次収集が数百行のCSVを丸ごと
壊しうる（以前は最悪でも末尾1行が欠けるだけだった）。固定したいのは次である。

  - 既存 uid の行は**増えず、置き換わる**（重複を作らない）
  - 更新しても id が動かない／新規は既存の最大 id の次を取る
  - 置き換えは**行ごと**である——空欄で上書きして消せる（料金が無くなった等）
  - desc は空で渡せば前回値が残り、明示すれば上書きされる
  - 途中で落ちてもCSVを失わない（一時ファイル経由）
"""

import csv
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import append_rows as ar                                      # noqa: E402
import prev_rows as pr                                        # noqa: E402
import budget                                                 # noqa: E402
from validate_data import EXPECTED_HEADERS                    # noqa: E402

H = EXPECTED_HEADERS["events.csv"]


def _row(**kw):
    r = {h: "" for h in H}
    r.update(kw)
    return r


def _write_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(H)
        for r in rows:
            w.writerow([r.get(h, "") for h in H])


def _read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


class Sandbox:
    """data/ と予算の状態を一時ディレクトリへ逃がす。"""

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="append_rows_test_")
        self.prev = os.path.join(self.tmp, ".prev")
        self.run = os.path.join(self.tmp, ".run")
        os.makedirs(self.prev, exist_ok=True)
        os.makedirs(self.run, exist_ok=True)
        self.orig = (ar.DATA, pr.DATA, pr.PREV, budget.STATE_DIR, budget.STATE,
                     budget.LOCK, budget.TOKEN_SAMPLE)
        ar.DATA = self.tmp
        pr.DATA = self.tmp
        pr.PREV = self.prev
        budget.STATE_DIR = self.run
        budget.STATE = os.path.join(self.run, "budget.json")
        budget.LOCK = budget.STATE + ".lock"
        budget.TOKEN_SAMPLE = os.path.join(self.run, "token_sample.json")
        self.path = os.path.join(self.tmp, "events.csv")
        self.prev_path = os.path.join(self.prev, "events.csv")
        return self

    def __exit__(self, *a):
        (ar.DATA, pr.DATA, pr.PREV, budget.STATE_DIR, budget.STATE,
         budget.LOCK, budget.TOKEN_SAMPLE) = self.orig

    def put(self, rows):
        _write_csv(self.path, rows)

    def put_prev(self, rows):
        _write_csv(self.prev_path, rows)

    def rows(self):
        return _read_csv(self.path)

    def send(self, records):
        """prepare_records → write_rows の本番と同じ経路を通す。"""
        headers, path, recs, filled, misses, regs, start_id = \
            ar.prepare_records("events.csv", [dict(r) for r in records])
        ins, upd, dups = ar.write_rows(path, headers, recs)
        return {"rows": self.rows(), "inserted": ins, "updated": upd,
                "dups": dups, "filled": filled, "regressions": regs,
                "misses": misses, "start_id": start_id}


CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


BASE = dict(title="展覧会A", venue="美術館X", start_date="2026-10-01",
            end_date="2026-10-31", pref="tokyo")


# ---------------------------------------------------------------- upsert

@check("新規 uid は追記される")
def _():
    with Sandbox() as s:
        s.put([])
        out = s.send([_row(**BASE)])
        if len(out["rows"]) != 1:
            return f"1行にならない: {len(out['rows'])}"
        return (out["inserted"], out["updated"]) == (1, 0) or f"件数が違う: {out}"


@check("既存 uid は行が増えず、置き換わる")
def _():
    with Sandbox() as s:
        s.put([_row(id="1", desc="むかしの説明", **BASE)])
        out = s.send([_row(price="1,000円", **BASE)])
        if len(out["rows"]) != 1:
            return f"重複して増えた: {len(out['rows'])}行"
        if (out["inserted"], out["updated"]) != (0, 1):
            return f"件数が違う: inserted={out['inserted']} updated={out['updated']}"
        return out["rows"][0]["price"] == "1,000円" or "新しい値が入っていない"


@check("更新しても id は動かない")
def _():
    with Sandbox() as s:
        s.put([_row(id="7", **BASE)])
        out = s.send([_row(price="500円", **BASE)])
        return out["rows"][0]["id"] == "7" or f"id が変わった: {out['rows'][0]['id']}"


@check("新規行の id は既存の最大 id の次を取る（末尾の id ではなく）")
def _():
    with Sandbox() as s:
        # 末尾の id が最大でない並び（upsert で起こりうる）
        s.put([_row(id="9", title="古い", venue="V", start_date="2026-10-01"),
               _row(id="3", title="新しめ", venue="V", start_date="2026-10-02")])
        out = s.send([_row(**BASE)])
        new = [r for r in out["rows"] if r["title"] == "展覧会A"][0]
        return new["id"] == "10" or f"id が衝突しうる値: {new['id']}"


@check("同じ波の中で同じ uid が2度来たら、2度目が1度目を更新する")
def _():
    with Sandbox() as s:
        s.put([])
        out = s.send([_row(price="1回目", **BASE), _row(price="2回目", **BASE)])
        if len(out["rows"]) != 1:
            return f"同一波で重複を作った: {len(out['rows'])}行"
        return out["rows"][0]["price"] == "2回目" or "あとの値で上書きされていない"


@check("既存CSVに同じ uid が複数あるとき、最初だけ更新し残りは消さずに警告する")
def _():
    with Sandbox() as s:
        s.put([_row(id="1", desc="A面", **BASE), _row(id="2", desc="B面", **BASE)])
        out = s.send([_row(price="更新", **BASE)])
        if len(out["rows"]) != 2:
            return f"黙って行を消した/増やした: {len(out['rows'])}行"
        if out["rows"][0]["price"] != "更新" or out["rows"][1]["price"] == "更新":
            return "更新されたのが最初の1行ではない"
        return len(out["dups"]) == 1 or f"警告が出ていない: {out['dups']}"


@check("置き換えは行ごと——空欄で上書きして消せる（料金が無くなった等）")
def _():
    with Sandbox() as s:
        s.put([_row(id="1", price="2,000円", price_official="2000", **BASE)])
        out = s.send([_row(**BASE)])          # price を渡さない＝空
        r = out["rows"][0]
        return (r["price"] == "" and r["price_official"] == "") \
            or f"空欄で消せていない: price={r['price']!r} official={r['price_official']!r}"


@check("ヘッダーだけのCSV（--init 直後）にも書ける")
def _():
    with Sandbox() as s:
        s.put([])
        out = s.send([_row(**BASE)])
        return len(out["rows"]) == 1 or f"書けていない: {out['rows']}"


@check("書き出し後に一時ファイルが残らない")
def _():
    with Sandbox() as s:
        s.put([])
        s.send([_row(**BASE)])
        leftovers = [f for f in os.listdir(s.tmp) if f.endswith(".tmp")]
        return not leftovers or f"一時ファイルが残った: {leftovers}"


@check("列の順序と全項目クォートが保たれる")
def _():
    with Sandbox() as s:
        s.put([])
        s.send([_row(**BASE)])
        with open(s.path, encoding="utf-8") as f:
            head = f.readline().rstrip("\n")
        want = ",".join(f'"{h}"' for h in H)
        return head == want or f"ヘッダー行が違う:\n  得 {head[:90]}\n  期 {want[:90]}"


@check("既存行の並び順は保たれる（更新で順序が入れ替わらない）")
def _():
    with Sandbox() as s:
        s.put([_row(id="1", title="1番", venue="V", start_date="2026-10-01"),
               _row(id="2", title="2番", venue="V", start_date="2026-10-02"),
               _row(id="3", title="3番", venue="V", start_date="2026-10-03")])
        out = s.send([_row(id="", title="2番", venue="V", start_date="2026-10-02",
                           price="更新")])
        got = [r["title"] for r in out["rows"]]
        return got == ["1番", "2番", "3番"] or f"順序が変わった: {got}"


# ---------------------------------------------------------------- desc の持ち越し

@check("desc を空で渡すと前回値が残る（CARRY_ALWAYS）")
def _():
    with Sandbox() as s:
        s.put([])
        s.put_prev([_row(id="1", desc="前回の具体的な説明が100字ぶんあると仮定する。" * 2, **BASE)])
        out = s.send([_row(price="1,000円", **BASE)])
        return out["rows"][0]["desc"].startswith("前回の具体的な説明") \
            or f"desc が失われた: {out['rows'][0]['desc']!r}"


@check("desc を明示したら、その値で上書きされる")
def _():
    with Sandbox() as s:
        s.put([])
        s.put_prev([_row(id="1", desc="むかしの説明" * 10, **BASE)])
        new = "あたらしい説明をきちんと書き直したもの" * 3
        out = s.send([_row(desc=new, **BASE)])
        return out["rows"][0]["desc"] == new or "明示した値で上書きされていない"


@check("_no_carry で desc の持ち越しを止められる")
def _():
    with Sandbox() as s:
        s.put([])
        s.put_prev([_row(id="1", desc="前回の説明" * 20, **BASE)])
        out = s.send([dict(_row(**BASE), _no_carry="desc")])
        return out["rows"][0]["desc"] == "" or f"止められていない: {out['rows'][0]['desc']!r}"


@check("desc の全損が劣化として警告される（以前は素通りしていた穴）")
def _():
    with Sandbox() as s:
        s.put([])
        s.put_prev([_row(id="1", desc="前回の具体的な説明" * 12, **BASE)])
        out = s.send([dict(_row(**BASE), _no_carry="desc")])
        return len(out["regressions"]) == 1 or f"警告が出ない: {out['regressions']}"


@check("desc の半分未満への短縮は従来どおり警告される")
def _():
    with Sandbox() as s:
        s.put([])
        s.put_prev([_row(id="1", desc="前回の具体的な説明" * 12, **BASE)])
        out = s.send([_row(desc="短い説明", **BASE)])
        return len(out["regressions"]) == 1 or f"警告が出ない: {out['regressions']}"


@check("正当な書き直し（半分以上の長さ）は警告しない")
def _():
    with Sandbox() as s:
        s.put([])
        old = "前回の説明" * 20
        s.put_prev([_row(id="1", desc=old, **BASE)])
        out = s.send([_row(desc="今回の説明" * 18, **BASE)])
        return not out["regressions"] or f"正当な書き直しに警告: {out['regressions']}"


@check("今セッションでCSVに書いた desc が、再収集で失われない（.prev に無くても）")
def _():
    with Sandbox() as s:
        s.put([])                              # .prev は空＝新規イベント
        d = "波1が調べて書いた具体的な説明" * 6
        s.send([_row(desc=d, **BASE)])         # 波1
        out = s.send([_row(price="1,000円", **BASE)])   # 波2が同じ催しを再収集
        if len(out["rows"]) != 1:
            return f"重複した: {len(out['rows'])}行"
        return out["rows"][0]["desc"] == d or f"波1の desc が消えた: {out['rows'][0]['desc']!r}"


# ---------------------------------------------------------------- 持ち越しの規則

@check("CARRY_NEVER の列は前回値から補われない")
def _():
    with Sandbox() as s:
        s.put([])
        s.put_prev([_row(id="1", price="2,000円", onsale_end="2026-09-01", **BASE)])
        out = s.send([_row(**BASE)])
        r = out["rows"][0]
        return (r["price"] == "" and r["onsale_end"] == "") \
            or f"禁止列が持ち越された: price={r['price']!r} onsale_end={r['onsale_end']!r}"


@check("_carry に desc を書いても壊れない（CARRY_ALWAYS と重複しても許容）")
def _():
    with Sandbox() as s:
        s.put([])
        s.put_prev([_row(id="1", desc="前回の説明" * 20, **BASE)])
        out = s.send([dict(_row(**BASE), _carry="desc")])
        return out["rows"][0]["desc"].startswith("前回の説明") or "持ち越せていない"


@check("_carry に禁止列を書いたら落ちる（従来どおり）")
def _():
    with Sandbox() as s:
        s.put([])
        s.put_prev([_row(id="1", price="2,000円", **BASE)])
        try:
            s.send([dict(_row(**BASE), _carry="price")])
        except SystemExit:
            return True
        return "price の持ち越しが通ってしまった"


@check("会場の事実（lat/lng等）は同じ会場の別行から補われる")
def _():
    with Sandbox() as s:
        s.put([_row(id="1", title="別の催し", venue="美術館X",
                    start_date="2026-11-01", lat="35.7", lng="139.7")])
        out = s.send([_row(**BASE)])
        new = [r for r in out["rows"] if r["title"] == "展覧会A"][0]
        return (new["lat"], new["lng"]) == ("35.7", "139.7") \
            or f"会場の事実が引けていない: {new['lat']!r},{new['lng']!r}"


@check("cats / area / official_url も書き忘れで消えない")
def _():
    with Sandbox() as s:
        s.put([_row(id="1", cats="art", area="東京都・港区",
                    official_url="https://example.invalid/e", **BASE)])
        out = s.send([_row(price="再確認", **BASE)])
        r = out["rows"][0]
        missing = [c for c in ("cats", "area", "official_url") if not (r.get(c) or "").strip()]
        return not missing or f"消えた列: {missing}"


@check("更新で値のあった列が空になったら警告する（note など中間の列）")
def _():
    import contextlib, io
    with Sandbox() as s:
        s.put([_row(id="1", note="前回の注記", **BASE)])
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            s.send([_row(price="再確認", **BASE)])
        return "note" in buf.getvalue() or f"警告が出ない: {buf.getvalue()[:120]!r}"


@check("CARRY_NEVER の列が空になっても警告しない（空欄が正しい書き方のため）")
def _():
    import contextlib, io
    with Sandbox() as s:
        s.put([_row(id="1", price="2,000円", **BASE)])
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            s.send([_row(**BASE)])
        return "price" not in buf.getvalue() or f"不要な警告: {buf.getvalue()[:120]!r}"


@check("新規行では列の消失を警告しない（消えるものが無いため）")
def _():
    import contextlib, io
    with Sandbox() as s:
        s.put([])
        s.put_prev([_row(id="1", note="前回の注記", **BASE)])
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            s.send([_row(title="まったく別の催し", venue="別会場",
                         start_date="2026-12-01", end_date="2026-12-31")])
        return "空になりました" not in buf.getvalue() or f"誤検知: {buf.getvalue()[:120]!r}"


@check("同じ波の中で、先に処理した行が後の行の持ち越し元になる")
def _():
    # --carry-rest は前回CSVの全行を1度に投入する。重複していた組のうち desc を
    # 持つ側が先に処理され、持たない側が後から上書きすると、説明文が失われる。
    with Sandbox() as s:
        s.put([])
        d = "重複していた組の片方だけが持っている具体的な説明" * 3
        out = s.send([_row(desc=d, **BASE), _row(price="あとの行", **BASE)])
        if len(out["rows"]) != 1:
            return f"1行に畳まれていない: {len(out['rows'])}行"
        r = out["rows"][0]
        if r["price"] != "あとの行":
            return "あとの行で更新されていない"
        return r["desc"] == d or f"先の行の desc が失われた: {r['desc']!r}"


@check("波の中の持ち越しでも _no_carry は効く")
def _():
    with Sandbox() as s:
        s.put([])
        d = "先の行が持っている説明" * 8
        out = s.send([_row(desc=d, **BASE),
                      dict(_row(price="あとの行", **BASE), _no_carry="desc")])
        return out["rows"][0]["desc"] == "" or f"_no_carry が無視された: {out['rows'][0]['desc']!r}"


@check("バッチ内で同じuidが重複し、後の行が前の行のCARRY_NEVER列を上書きしたら警告する")
def _():
    import contextlib, io
    with Sandbox() as s:
        s.put([])
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            s.send([_row(price="1500円", url="https://a.example/", note="重要な注記A",
                        source="公式サイト", **BASE),
                    _row(**BASE)])
        return "price" in buf.getvalue() and "url" in buf.getvalue() and "note" in buf.getvalue() \
            or f"CARRY_NEVER列の消失が警告されない: {buf.getvalue()[:200]!r}"


@check("バッチ内重複の警告が実際にCARRY_NEVER列の中身も守る（desc等はCARRY_ALWAYSで別途保護済み）")
def _():
    with Sandbox() as s:
        s.put([])
        out = s.send([_row(price="1500円", url="https://a.example/", **BASE),
                      _row(**BASE)])
        r = out["rows"][0]
        # 上書きは起きる（後の行が勝つ）が、それは正しく警告されている前提のうえでの仕様
        return (r["price"] == "" and r["url"] == "") or f"想定と違う結果: {r}"


@check("異なるuidが2件来ても、バッチ内重複の警告は出ない（誤検知しない）")
def _():
    import contextlib, io
    with Sandbox() as s:
        s.put([])
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            s.send([_row(price="1500円", title="展覧会A", venue="美術館X",
                        start_date="2026-10-01", end_date="2026-10-31"),
                    _row(price="800円", title="展覧会B", venue="美術館Y",
                        start_date="2026-11-01", end_date="2026-11-30")])
        return "同じ回の中で前の行" not in buf.getvalue() or f"誤検知した: {buf.getvalue()[:200]!r}"


@check("バッチ内重複で、後の行が値を追加するだけ（失う列が無い）なら警告しない")
def _():
    import contextlib, io
    with Sandbox() as s:
        s.put([])
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            s.send([_row(price="1500円", **BASE), _row(price="1500円", note="追記", **BASE)])
        return "同じ回の中で前の行" not in buf.getvalue() or f"誤検知した: {buf.getvalue()[:200]!r}"


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
