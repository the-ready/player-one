#!/usr/bin/env python3
"""`tools/backfill_parking.py`（駐車場の列の追加と、名簿の埋め）と、駐車場まわりの検証を固定する（ネットワーク不要）。

    python3 tools/backfill_parking_test.py

## なぜ固定するのか

名簿の `parking` は画面のP（駐車場）バッジの元で、**誤った「あり」は利用者を駐車場の無い場所へ
向かわせる。** 空欄は何も出さないだけで済むので、読み取りは「確実なものだけ入れ、迷ったら空欄」に
倒してある。その線が、どの文を何に分けるかを実例で書き留める。実データの90種類の文から選んだ。
"""

import csv
import io
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import backfill_parking as bp                                 # noqa: E402
import roster                                                 # noqa: E402
import validate_data as vd                                    # noqa: E402

CHECKS = []


def check(desc):
    def deco(fn):
        CHECKS.append((desc, fn))
        return fn
    return deco


# ---------------------------------------------------------------- 文の読み取り

PLACE_CASES = [
    # yes: 台数・料金・「あり」・事前予約制
    ("あり", "yes"),
    ("あり（約60台。満車時は近隣コインパーキング）", "yes"),
    ("有（無料）", "yes"),
    ("北浦和公園駐車場有（有料）", "yes"),
    ("2,200台、普通車1日1,000円(8月の土日祝ナイトズーラシア開催日は2,000円)", "yes"),
    ("普通車500円（冬期300円）", "yes"),
    ("9台(うち身障者優先車両専用スペース1台)", "yes"),
    ("事前予約制(詳細は公式サイトのパーキング案内を参照)", "yes"),
    ("夢咲くら館駐車場（3時間まで無料）", "yes"),
    ("来館者専用駐車場60台(無料)", "yes"),
    ("美術館駐車場（有料）", "yes"),
    ("見学者用駐車場あり(入構時に守衛所で通行証を受取)", "yes"),
    ("78台無料（隣接する千葉ポートパーク駐車場も利用可）", "yes"),   # 先頭は自前の台数。隣接は付け足し
    # no: 言い切り。一般的な「周辺の有料駐車場を利用」は no のまま
    ("駐車場なし", "no"),
    ("館内に駐車場なし(周辺有料駐車場を利用)", "no"),
    ("美術館専用駐車場なし(周辺の有料駐車場を利用)", "no"),
    ("専用駐車場なし", "no"),
    ("駐車場・駐輪場なし", "no"),
    ("駐輪・駐車スペースなし", "no"),
    ("なし（公共交通機関を利用）", "no"),
    ("なし（駐車場・駐輪場の用意なし。公共交通機関を利用）", "no"),
    ("専用駐車場・駐輪場なし（近隣の有料駐車場・公共交通機関を利用）", "no"),
    # nearby: 専用は無いが、特定の近隣駐車場の名前を挙げて案内している
    ("専用駐車場なし（近隣の北の丸公園第三駐車場を利用。通常時1時間600円・上限3,000円、イベント時一律3,000円）", "nearby"),
    ("専用駐車場なし(近隣の東京スカイツリータウン駐車場等を利用、割引なし)", "nearby"),
    ("専用駐車場なし（東京ミッドタウンの駐車場を利用可）", "nearby"),
    ("館内専用駐車場なし、周辺の上野パーキングセンター等有料駐車場を利用(美術館利用で割引あり)", "nearby"),
    ("なし（隣接の目黒区民センター駐車場は有料・20分300円）", "nearby"),
    ("隣接有料駐車場（150台・普通車1日500円）／第三駐車場（徒歩5分・無料）", "nearby"),
    ("弘恵会駐車場など周辺有料駐車場（徒歩3分）", "nearby"),
    # 読まない（空欄のまま）: 推測が要るもの・催しごとの事情
    ("小金井公園有料駐車場(第1駐車場)を利用", None),
    ("サンシャインシティ駐車場を利用(駐車サービスあり)", None),
    ("利用休止中（設備メンテナンスのため）", None),
    ("当イベントでは利用不可（駐車場は17:30閉鎖。近隣の私営駐車場を利用）", None),
    ("", None),
    ("   ", None),
]


@check("文の読み取り: 実例ごとに yes / no / nearby / 読まない を分ける")
def _():
    bad = []
    for text, want in PLACE_CASES:
        got = bp.classify_place(text)
        if got != want:
            bad.append(f"{text[:40]!r}: {got!r} (期待 {want!r})")
    return not bad or "\n    ".join(bad)


@check("「周辺の有料駐車場を利用」の類は、固有名が無いので nearby にしない")
def _():
    for t in ("館内に駐車場なし(周辺有料駐車場を利用)", "なし（近隣の私営駐車場を利用）",
              "専用駐車場なし（近隣の有料駐車場・公共交通機関を利用）"):
        if bp.classify_place(t) != "no":
            return f"{t!r} -> {bp.classify_place(t)!r}"
    return True


@check("催しごとの事情は、文に明記されたものだけ読む")
def _():
    cases = [
        ("当イベントでは利用不可（駐車場は17:30閉鎖。近隣の私営駐車場を利用）", "closed"),
        ("利用休止中（設備メンテナンスのため）", "closed"),
        ("一般駐車場(無料・約750台)。混雑期は隣接の臨時駐車場も無料開放", "temp"),
        # 常設の駐車場の名前に「臨時」が入っているだけのもの・満車時の予備は読まない
        ("美術館近くの府中市臨時駐車場（無料）", None),
        ("ザ・ヒロサワ・シティ会館前駐車場(無料)、満車時は千波湖南側臨時駐車場(無料)", None),
        ("あり", None),
        ("", None),
    ]
    bad = [f"{t[:30]!r}: {bp.classify_event(t)!r} (期待 {w!r})" for t, w in cases if bp.classify_event(t) != w]
    return not bad or "\n    ".join(bad)


# ---------------------------------------------------------------- 列の追加

def _write(path, rows, quote_all):
    with open(path, "w", newline="", encoding="utf-8") as f:
        csv.writer(f, quoting=csv.QUOTE_ALL if quote_all else csv.QUOTE_MINIMAL,
                   lineterminator="\r\n").writerows(rows)


def _fixture():
    d = tempfile.mkdtemp(prefix="backfill_parking_test_")
    _write(os.path.join(d, "spots.csv"),
           [["name", "kind", "pref", "area", "lat", "lng", "url", "status", "closed_until", "first_seen",
             "last_hit", "hit_count", "note"],
            ["東京国立博物館", "museum", "tokyo", "東京都・台東区", "", "", "https://e.example/", "active", "", "", "", "0", ""],
            ["東京ミッドタウン", "mall", "tokyo", "東京都・港区", "", "", "", "active", "", "", "", "0", ""],
            ["東京ミッドタウン日比谷", "mall", "tokyo", "東京都・千代田区", "", "", "", "active", "", "", "", "0", ""],
            ["手書きの館", "museum", "tokyo", "東京都・港区", "", "", "", "active", "", "", "", "0", ""]],
           quote_all=False)
    _write(os.path.join(d, "venues.csv"),
           [["venue", "kind", "pref", "area", "capacity", "lat", "lng", "url", "status", "closed_until",
             "first_seen", "last_hit", "hit_count", "note"],
            ["日本武道館", "arena", "tokyo", "東京都・千代田区", "", "", "", "", "active", "", "", "", "0", ""]],
           quote_all=False)
    _write(os.path.join(d, "theaters.csv"),
           [["chain", "name", "pref", "area", "lat", "lng", "url", "status", "first_seen", "last_hit",
             "hit_count", "note"],
            ["", "新文芸坐", "tokyo", "東京都・豊島区", "", "", "", "active", "", "", "0", ""]],
           quote_all=False)
    ev_head = ["id", "title", "venue", "parking", "nearest_station"]
    _write(os.path.join(d, "events.csv"),
           [ev_head,
            ["1", "A展", "東京国立博物館 平成館", "あり（地下駐車場100台）", "上野駅"],
            ["2", "B展", "東京国立博物館", "駐車場なし", "上野駅"],            # 同じ場所で食い違う
            ["3", "C展", "東京ミッドタウン日比谷", "駐車場なし", ""],
            ["4", "D展", "東京ミッドタウン", "普通車1,000円", ""],
            ["5", "E展", "東京ミッドタウン／東京ミッドタウン日比谷", "あり", ""],      # 複数の場所: 採らない
            ["6", "F展", "手書きの館", "当イベントでは利用不可（駐車場は17:30閉鎖）", ""],
            ["7", "G展", "どこにも無い会場", "あり", ""],
            ["8", "H展", "手書きの館", "一般駐車場(無料・約750台)。混雑期は隣接の臨時駐車場も無料開放", ""]],
           quote_all=True)
    _write(os.path.join(d, "lives.csv"),
           [["id", "title", "venue", "parking", "nearest_station", "apple_music_url"],
            ["1", "L1", "日本武道館", "専用駐車場なし（近隣の北の丸公園第三駐車場を利用）", "九段下駅", ""]],
           quote_all=True)
    return d


def _text(d, name):
    with open(os.path.join(d, name), newline="", encoding="utf-8") as f:
        return f.read()


def _dicts(d, name):
    with open(os.path.join(d, name), newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


@check("列の追加: 名簿は url の次、催しの行は nearest_station の次へ入る")
def _():
    d = _fixture()
    changed = bp.migrate(d, log=lambda *_: None)
    heads = {n: next(csv.reader(io.StringIO(_text(d, n)))) for n in
             ("spots.csv", "venues.csv", "theaters.csv", "events.csv", "lives.csv")}
    bad = []
    for n in ("spots.csv", "venues.csv", "theaters.csv"):
        h = heads[n]
        if h[h.index("url") + 1] != "parking":
            bad.append(f"{n}: {h}")
    for n in ("events.csv", "lives.csv"):
        h = heads[n]
        if h[h.index("nearest_station") + 1] != "event_parking":
            bad.append(f"{n}: {h}")
    return (set(changed) == set(heads) and not bad) or f"changed={changed} {bad}"


@check("列の追加: 書式（全項目を引用か最小限か・CRLF）を保ち、既存の値は1つも変えない")
def _():
    d = _fixture()
    before = {n: _dicts(d, n) for n in ("spots.csv", "events.csv")}
    q_before = {n: _text(d, n)[:1] for n in ("spots.csv", "events.csv")}
    bp.migrate(d, log=lambda *_: None)
    after = {n: _dicts(d, n) for n in ("spots.csv", "events.csv")}
    for n in before:
        for b, a in zip(before[n], after[n]):
            for k, v in b.items():
                if a[k] != v:
                    return f"{n} の {k} が {v!r} → {a[k]!r} に変わった"
    q_after = {n: _text(d, n)[:1] for n in ("spots.csv", "events.csv")}
    crlf = all(b"\r\n" in open(os.path.join(d, n), "rb").read() for n in ("spots.csv", "events.csv"))
    return (q_before == q_after and crlf) or f"引用 {q_before}→{q_after} crlf={crlf}"


@check("列の追加: 冪等（2回目は何も変えず、種も蒔き直さない）")
def _():
    d = _fixture()
    bp.migrate(d, log=lambda *_: None)
    snap = {n: _text(d, n) for n in ("spots.csv", "events.csv", "lives.csv")}
    # 1回目のあと、収集が event_parking を空にしたものとして、2回目が種を蒔き直さないことを見る
    rows = _dicts(d, "events.csv")
    for r in rows:
        r["event_parking"] = ""
    head = list(rows[0].keys())
    with open(os.path.join(d, "events.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
        w.writerow(head)
        for r in rows:
            w.writerow([r[h] for h in head])
    snap["events.csv"] = _text(d, "events.csv")
    again = bp.migrate(d, log=lambda *_: None)
    same = all(_text(d, n) == snap[n] for n in snap)
    return (again == [] and same) or f"again={again} same={same}"


@check("列の追加: event_parking の種は、列を新しく足した回に、文に明記されたものだけ入る")
def _():
    d = _fixture()
    bp.migrate(d, log=lambda *_: None)
    got = {r["id"]: r["event_parking"] for r in _dicts(d, "events.csv")}
    want = {"1": "", "2": "", "3": "", "4": "", "5": "", "6": "closed", "7": "", "8": "temp"}
    return got == want or f"{got}"


@check("列の追加: 足す位置の列が無ければ、黙って壊さず止まる")
def _():
    d = tempfile.mkdtemp(prefix="backfill_parking_test_")
    _write(os.path.join(d, "spots.csv"), [["name", "kind"], ["a", "b"]], quote_all=False)
    try:
        bp.migrate(d, log=lambda *_: None)
    except SystemExit as e:
        return "url" in str(e) or f"{e}"
    return "止まらなかった"


# ---------------------------------------------------------------- 名簿の埋め

def _plan(d, ds):
    fill, conflicts, *_ = bp.plan_fill(ds, d)
    return fill, conflicts


@check("名簿の埋め: 館内の会場の行も、その施設の名簿に寄せて読む")
def _():
    d = _fixture()
    bp.migrate(d, log=lambda *_: None)
    fill, _c = _plan(d, "events")
    return fill.get("東京ミッドタウン日比谷") == "no" and fill.get("東京ミッドタウン") == "yes" or f"{fill}"


@check("名簿の埋め: 同じ場所の行どうしで読み取りが食い違えば、どちらも採らない")
def _():
    d = _fixture()
    bp.migrate(d, log=lambda *_: None)
    fill, conflicts = _plan(d, "events")
    return "東京国立博物館" not in fill and conflicts == ["東京国立博物館"] or f"{fill} {conflicts}"


@check("名簿の埋め: 複数の場所にまたがる表記・名簿に無い会場・催しごとの事情は、場所の事実として採らない")
def _():
    d = _fixture()
    bp.migrate(d, log=lambda *_: None)
    fill, _c = _plan(d, "events")
    # E展（／で2か所）と G展（名簿に無い）は何も足さない。F展（当イベントでは利用不可）は
    # 催しごとの事情なので場所の値にせず、同じ場所のH展（台数あり）だけが手書きの館を yes にする
    return set(fill) == {"東京ミッドタウン", "東京ミッドタウン日比谷", "手書きの館"} and fill["手書きの館"] == "yes" or f"{fill}"


@check("名簿の埋め: 名簿に値が既にあれば上書きしない")
def _():
    d = _fixture()
    bp.migrate(d, log=lambda *_: None)
    path = os.path.join(d, "spots.csv")
    head, rows = roster.load(path)
    for r in rows:
        if r["name"] == "東京ミッドタウン":
            r["parking"] = "no"           # 人が確かめた値
    roster.save(path, head, rows)
    fill, _c = _plan(d, "events")
    return "東京ミッドタウン" not in fill or f"{fill}"


@check("名簿の埋め: --apply で書き、下見では書かない")
def _():
    d = _fixture()
    bp.migrate(d, log=lambda *_: None)
    bp.fill("events", apply=False, data_dir=d, log=lambda *_: None)
    if any((r["parking"] or "") for r in _dicts(d, "spots.csv")):
        return "下見なのに書かれた"
    n = bp.fill("events", apply=True, data_dir=d, log=lambda *_: None)
    got = {r["name"]: r["parking"] for r in _dicts(d, "spots.csv")}
    return n == 3 and got["東京ミッドタウン"] == "yes" and got["東京ミッドタウン日比谷"] == "no" and got["東京国立博物館"] == "" \
        or f"{n} {got}"


@check("名簿の埋め: 列が無い名簿には何も書かず、案内を出す")
def _():
    d = _fixture()
    lines = []
    n = bp.fill("events", apply=True, data_dir=d, log=lines.append)
    return n == 0 and any("--migrate" in l for l in lines) or f"{n} {lines}"


@check("名簿の埋め: ライブは venues.csv に入る")
def _():
    d = _fixture()
    bp.migrate(d, log=lambda *_: None)
    bp.fill("lives", apply=True, data_dir=d, log=lambda *_: None)
    got = {r["venue"]: r["parking"] for r in _dicts(d, "venues.csv")}
    return got["日本武道館"] == "nearby" or f"{got}"


# ---------------------------------------------------------------- roster.py --parking

def _roster_rows():
    head = ["name", "url", "parking", "status"]
    return head, [{"name": "東京国立博物館", "parking": ""}, {"name": "山種美術館", "parking": "yes"}]


@check("roster --parking: yes / nearby / no を書き、空は未確認に戻す")
def _():
    head, rows = _roster_rows()
    done, missing = roster.do_set_parking(rows, head, "name", ["東京国立博物館=nearby", "山種美術館="])
    return rows[0]["parking"] == "nearby" and rows[1]["parking"] == "" and not missing and len(done) == 2 \
        or f"{rows} {done} {missing}"


@check("roster --parking: 決められた語以外・形の違う指定は止める")
def _():
    head, rows = _roster_rows()
    for spec in ("東京国立博物館=あり", "東京国立博物館=YES", "東京国立博物館", "=yes"):
        try:
            roster.do_set_parking(rows, head, "name", [spec])
        except SystemExit:
            continue
        return f"{spec!r} が通った"
    return True


@check("roster --parking: 名簿に無い名前は作らずに知らせる／列が無い名簿では止まる")
def _():
    head, rows = _roster_rows()
    done, missing = roster.do_set_parking(rows, head, "name", ["どこにも無い館=yes"])
    if done or missing != ["どこにも無い館"] or len(rows) != 2:
        return f"{done} {missing} {len(rows)}"
    try:
        roster.do_set_parking(rows, ["name", "url"], "name", ["東京国立博物館=yes"])
    except SystemExit:
        return True
    return "列が無いのに通った"


# ---------------------------------------------------------------- 検証

def _rep(name, rows):
    rep = vd.Report()
    enums = vd.load_enums()
    if name in ("spots.csv", "venues.csv", "theaters.csv"):
        vd.validate_master(name, rows, enums, rep)
    return rep


@check("検証: 名簿の parking は yes/nearby/no/空だけ")
def _():
    base = {c: "" for c in vd.EXPECTED_HEADERS["spots.csv"]}
    ok = [dict(base, name=f"館{i}", status="active", parking=v) for i, v in enumerate(("yes", "nearby", "no", ""))]
    if _rep("spots.csv", ok).errors:
        return f"正しい値が落ちた: {_rep('spots.csv', ok).errors}"
    bad = [dict(base, name="a", status="active", parking="あり")]
    errs = _rep("spots.csv", bad).errors
    return any("parking" in e for e in errs) or f"{errs}"


@check("検証: 催しの行の event_parking は temp/closed/temp_only/空だけ。バッジがあるのに文が空なら警告")
def _():
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "validate_data.py"), encoding="utf-8").read()
    return ('enums["event_parking"]' in src and "event_parking={ep} なのに parking が空です" in src) \
        or "検証の分岐が見つからない"


@check("検証: 列の定義（EXPECTED_HEADERS）に追加した列が入っている")
def _():
    h = vd.EXPECTED_HEADERS
    return (
        all("parking" in h[n] for n in ("spots.csv", "venues.csv", "theaters.csv"))
        and h["events.csv"][h["events.csv"].index("nearest_station") + 1] == "event_parking"
        and h["lives.csv"][h["lives.csv"].index("nearest_station") + 1] == "event_parking"
        and "event_parking" not in h["movies.csv"]
    ) or "列の定義が想定と違う"


@check("検証: config.js の PARKING_KINDS / EVENT_PARKING_KINDS から値の集合を読める")
def _():
    p, e = vd.load_parking_kinds()
    return (p == {"yes", "nearby", "no"} and e == {"temp", "closed", "temp_only"}) or f"{p} {e}"


@check("持ち越し: event_parking は前回値で補わない（CARRY_NEVER）")
def _():
    import append_rows as ar
    return ("event_parking" in ar.CARRY_NEVER and "event_parking" not in ar.CARRY_ALWAYS
            and "parking" in ar.VENUE_FACTS) or "持ち越しの分類が想定と違う"


@check("実データ: 追加した列が揃っていて、値がすべて許可集合に入っている")
def _():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    pk, ep = vd.load_parking_kinds()
    bad = []
    for n in ("spots.csv", "venues.csv", "theaters.csv"):
        with open(os.path.join(root, "data", n), newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        if "parking" not in rows[0]:
            bad.append(f"{n} に parking 列が無い")
        bad += [f"{n}: {r.get('parking')!r}" for r in rows if (r.get("parking") or "") not in pk | {""}]
    for n in ("events.csv", "lives.csv"):
        with open(os.path.join(root, "data", n), newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        if "event_parking" not in rows[0]:
            bad.append(f"{n} に event_parking 列が無い")
        bad += [f"{n}: {r.get('event_parking')!r}" for r in rows if (r.get("event_parking") or "") not in ep | {""}]
    return not bad or "\n    ".join(bad[:5])


def main():
    fails = 0
    for desc, fn in CHECKS:
        try:
            got = fn()
        except Exception as e:                                # noqa: BLE001
            got = f"{type(e).__name__}: {e}"
        if got is not True:
            print(f"✗ {desc}\n    {got}")
            fails += 1
    print(f"\n{len(CHECKS) - fails}/{len(CHECKS)} 件が期待どおり")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
