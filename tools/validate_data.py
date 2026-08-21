#!/usr/bin/env python3
"""data/ のCSVを検証する。

このダッシュボードは毎週データだけを差し替える運用で、書き手は収集スキル
（＝生成AI）である。表示側は欠損や未知の値でも落ちない契約（設計書 第3.5節）に
なっているが、**落ちたことが誰にも伝わらない**のが問題だった。
未知のカテゴリキーは黙って「その他」になり、日付の書式ミスは黙って
「絞り込みに引っかからない行」になる。ここで先に気づけるようにする。

  ERROR   … 表示が壊れる/嘘になる。CIを落として前回のデプロイを残す。
            「古くて正しい」ほうが「新しくて壊れている」より良い。
  WARNING … 直したほうがよいが、表示は成立する。落とさずに一覧だけ出す。

使い方:  python3 tools/validate_data.py [--strict]
         --strict を付けると WARNING も終了コード1にする。
"""

import csv
import json
import os
import re
import sys
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CONFIG_JS = os.path.join(ROOT, "assets", "js", "config.js")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")
BOOL_OK = {"", "0", "1", "true", "false", "yes", "no"}

# date（自由記述）の中に月・季節を推測できる語があるか。
# 「会期は公式サイト参照」のような、本当に何も分からない行は拾わない。
MONTHLY_HINT = re.compile(r"\d{1,2}月|[春夏秋冬]")

# 関東＋近縁のゆるい外接矩形。ここを外れる座標は緯度経度の取り違えを疑う。
LAT_RANGE = (34.5, 37.5)
LNG_RANGE = (138.0, 141.5)

# pref="other"（関東以外）の行には関東の矩形を当てられない。名簿には静岡のライブ
# ハウスのような関東外の会場が実際に入っており、正しい座標が毎回18件の警告になる。
# ただし検査そのものは外さない——この検査の目的は「緯度と経度の取り違え」を捕まえる
# ことで、取り違えれば経度が35前後（＝日本の緯度帯）に落ちるので、日本全体の矩形でも
# 十分に捕まる。範囲を広げるのであって、素通しにするのではない。
JP_LAT_RANGE = (24.0, 46.0)
JP_LNG_RANGE = (122.0, 154.0)


def coord_ranges(pref):
    return (JP_LAT_RANGE, JP_LNG_RANGE) if pref == "other" else (LAT_RANGE, LNG_RANGE)

EXPECTED_HEADERS = {
    "events.csv": ["id","title","kana","cats","area","venue","venue_url","pref","start_date","end_date",
        "date","dates","open_time","start_time","end_time","date_note","backup_date","status","rank","series_id","announced_date","is_additional","onsale_label","onsale_start",
        "onsale_start_time","onsale_end","onsale_end_time","limited_sale","price","price_official",
        "price_best","discount_pct","best_source","coupon_note","price_checked","price_condition",
        "source","url","official_url","lat","lng","desc","note","parking","nearest_station"],
    "movies.csv": ["id","title","kana","genre","screening_type","area","theater","theater_url","pref",
        "release_date","end_date","date","dates","open_time","start_time","end_time","date_note",
        "backup_date","status","rank","series_id","announced_date","is_additional",
        "onsale_label","onsale_start","onsale_start_time","onsale_end","onsale_end_time","limited_sale",
        "price","price_official","price_best","discount_pct","best_source","coupon_note","price_checked",
        "price_condition","source","url","official_url","lat","lng","desc","note"],
    "lives.csv": ["id","tour_id","title","kana","artists","genre","live_type","area","venue","venue_url",
        "pref","start_date","end_date","date","dates","open_time","start_time","end_time","date_note",
        "backup_date","status","rank","announced_date","is_additional",
        "onsale_label","onsale_start","onsale_start_time","onsale_end","onsale_end_time","limited_sale",
        "price","source","url","official_url","lat","lng","desc","note",
        "parking","nearest_station","apple_music_url","lineup_id"],
    # --- フェスの日割りラインナップ（設計書 第12.12節）。lives.csv の lineup_id で引く ---
    "lineups.csv": ["lineup_id","date","stage","artist","is_headliner","apple_music_url","note"],
    # --- 収集の「定点観測リスト」。名簿は収集タスクが roster.py 経由で育てる ---
    # status / first_seen / last_hit / hit_count は名簿の保守用の列で、
    # ダッシュボードは列名で引くので、末尾に足しても表示側には影響しない。
    "theaters.csv": ["chain","name","pref","area","lat","lng","url",
        "status","first_seen","last_hit","hit_count","note"],
    "venues.csv": ["venue","kind","pref","area","capacity","lat","lng","url",
        "status","closed_until","first_seen","last_hit","hit_count","note"],
    "spots.csv": ["name","kind","pref","area","lat","lng","url",
        "status","closed_until","first_seen","last_hit","hit_count","note"],
    "festivals.csv": ["name","venue","pref","month_hint","url",
        "status","first_seen","last_hit","hit_count","note"],
}

# 開始日の列名はファイルごとに違う
START_COL = {"events.csv":"start_date", "movies.csv":"release_date", "lives.csv":"start_date"}
SERIES_COL = {"events.csv":"series_id", "movies.csv":"series_id", "lives.csv":"tour_id"}

# 名簿の「名前の列」。roster.py の ROSTERS と対応させる。
MASTER_KEY = {"theaters.csv":"name", "venues.csv":"venue",
              "spots.csv":"name", "festivals.csv":"name"}

# lineups.csv は本体でも名簿でもない第3の形（lives.csv への参照テーブル）なので、
# 検証も突き合わせも専用の関数で行う。
LINEUP_FILE = "lineups.csv"

ROSTER_STATUS = {"", "active", "candidate", "retired", "blocked"}

# spots.csv の施設種別。ダッシュボードは spots.csv を読まない（収集側だけで使う）ので、
# config.js には置かずここで定義する。
SPOT_KINDS = {"themepark","aquazoo","museum","science","hall","theater","mall","park","landmark"}

# --- 画像を持たない（設計書 第7.1節） ------------------------------------
#
# 3タブとも画像を扱わない。権利者が出しているのは「自社サイトに掲載する」許諾で
# あって第三者サイトへの再掲載・直リンクの許諾ではなく、複製せずURL参照するだけでも
# 利用規約違反と著作者人格権（氏名表示権）の問題は残るため、列そのものを持たない。
#
# 散文でのお願いは、安い経路の前では負ける——作品情報を読みに開いたページのOGP画像を
# 拾うのが常に最も安い経路なので、以前は許可した取得元を優先順位で書き分けていたが
# 実データは禁止したはずの経路が100%になっていた。だから列の不在を検証で固定する。
BANNED_COLUMNS = ("poster_url", "poster_source")


def load_prefs():
    """`assets/js/config.js` の PREFS から都県キーだけを読む。

    `roster.py` も名簿に入れる `pref` をこの集合で検証する。選択肢の正本は
    config.js ひとつに保ち、検証側で写しを持たない（load_enums と同じ方針）。
    こちらだけ分けてあるのは、名簿の検証に config.js の全テーブルを
    読ませたくないためである——無関係なテーブルの書式が変わっただけで
    `roster.py` が落ちるのは、依存として重すぎる。
    """
    src = open(CONFIG_JS, encoding="utf-8").read()
    # `{ key: "..." }` を全文から拾うと、PRESETS（today / weekend / month）や
    # タブ宣言（event / movie / live）まで都県キーとして混ざる。実際に混ざっており、
    # `pref` に `today` と書いても検証を素通りする状態だった。PREFS の配列だけを見る。
    block = re.search(r"export const PREFS = \[(.*?)\n\];", src, re.S)
    if not block:
        raise SystemExit("ERROR: config.js から PREFS を読めませんでした（定義の書式が変わった可能性があります）")
    keys = set(re.findall(r'key:\s*"([a-z]+)"', block.group(1)))
    if not keys:
        raise SystemExit("ERROR: config.js の PREFS からキーを1つも読めませんでした")
    return keys


def load_enums():
    """assets/js/config.js から選択肢のキーを読む。

    表示側と検証側で選択肢の一覧を二重管理すると、必ず片方だけ古くなる。
    定義の正本は config.js 側に置き、ここは読むだけにする。
    """
    src = open(CONFIG_JS, encoding="utf-8").read()

    def keys_of(name):
        m = re.search(r"export const %s = \{(.*?)\n\};" % name, src, re.S)
        if not m:
            raise SystemExit(f"ERROR: config.js から {name} を読めませんでした（定義の書式が変わった可能性があります）")
        return set(re.findall(r'^\s*"?([A-Za-z0-9_-]+)"?\s*:', m.group(1), re.M))

    def string_keys_of(name):
        # 日本語のキーは JS の識別子として妥当なので、prettier は引用符を外す
        # （`"開催中":` → `開催中:`）。どちらの書き方でも拾えるようにしておく。
        m = re.search(r"export const %s = \{(.*?)\n\};" % name, src, re.S)
        if not m:
            raise SystemExit(f"ERROR: config.js から {name} を読めませんでした")
        keys = set(re.findall(r'^\s*"([^"]+)"\s*:', m.group(1), re.M))
        keys |= set(re.findall(r"^\s*([^\s\"':,{}]+)\s*:", m.group(1), re.M))
        if not keys:
            raise SystemExit(f"ERROR: config.js の {name} からキーを1つも読めませんでした")
        return keys

    return {
        "cats": keys_of("CATS"),
        "movie_genre": keys_of("MOVIE_GENRES"),
        "screening_type": keys_of("SCREENING_TYPES"),
        "live_genre": keys_of("LIVE_GENRES"),
        "live_type": keys_of("LIVE_TYPES"),
        "venue_kind": keys_of("VENUE_KINDS"),
        "event_status": string_keys_of("EVENT_STATUS_STYLE"),
        "movie_status": string_keys_of("MOVIE_STATUS_STYLE"),
        "live_status": string_keys_of("LIVE_STATUS_STYLE"),
        # PREFS は `{key:"tokyo", ...}` とも `{ key: "tokyo", ... }` とも書かれうる（prettier）
        "pref": load_prefs(),
    }


class Report:
    """ERROR は1件ずつ、WARNING は「同じ種類が何十件も並ぶもの」だけ畳んで出す。

    畳む理由は見た目ではなく運用にある。この検証は週次の収集タスクが毎回実行し、
    その出力をモデルが読む。実データでは48件の警告のうち32件が
    「url が http:// です」——小規模なライブハウスや古い施設の**実際のURL**で、
    直しようがなく、来週も再来週も同じ32行が出る。行数が多いほど、その中に紛れた
    数件の直すべき警告が読まれなくなる。件数と場所は残したまま1行にまとめる。
    """

    def __init__(self):
        self.errors = []
        self.warnings = []          # (where, msg, group|None)

    def error(self, where, msg):
        self.errors.append(f"{where}: {msg}")

    def warn(self, where, msg):
        self.warnings.append((where, msg, None))

    def warn_many(self, where, group, msg):
        """同種が大量に出る警告。1件ずつではなく、件数と場所を1行にまとめて出す。"""
        self.warnings.append((where, msg, group))

    def warning_lines(self):
        """表示用の行を組み立てる。グループは3件までなら畳まずそのまま出す。"""
        groups, lines = {}, []
        for where, msg, group in self.warnings:
            if group:
                groups.setdefault(group, []).append((where, msg))
            else:
                lines.append(f"{where}: {msg}")
        for group, items in groups.items():
            if len(items) <= 3:
                lines.extend(f"{w}: {m}" for w, m in items)
            else:
                lines.append(f"{group}: {len(items)}件 — {', '.join(w for w, _ in items)}")
        return lines


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
        f.seek(0)
        header = next(csv.reader(f))
    return header, rows


def check_url(rep, where, col, value, required_https=True):
    if not value:
        return
    if not value.startswith(("http://", "https://")):
        rep.error(where, f"{col} がURLになっていません: {value[:60]}")
    elif required_https and value.startswith("http://"):
        # 小規模な会場・古い施設の公式サイトは実際に http:// のことが多く、
        # こちらでは直せない。件数と場所だけ残して1行に畳む（Report の説明を参照）。
        rep.warn_many(where, "http:// のURL（各サイトの実際のURL。こちらでは直せない）",
                      f"{col} が http:// です（https を推奨）: {value[:60]}")


def check_date(rep, where, col, value, hard=True):
    if not value:
        return None
    if not DATE_RE.match(value):
        rep.error(where, f"{col} の書式が YYYY-MM-DD ではありません: {value!r}")
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        rep.error(where, f"{col} が存在しない日付です: {value!r}")
        return None


def parse_date(value):
    """報告せずに日付を読む。すでに別の検査が見ている列を参照するときに使う。"""
    v = (value or "").strip()
    if not DATE_RE.match(v):
        return None
    try:
        return date.fromisoformat(v)
    except ValueError:
        return None


def check_enum(rep, where, col, raw, allowed, sep="|"):
    if not raw:
        return
    for v in [x.strip() for x in raw.split(sep) if x.strip()]:
        if v not in allowed:
            rep.error(where, f"{col} に未知の値 {v!r}（表示側では「その他」に落ちて、絞り込みからも漏れます）")


def check_num(rep, where, col, raw, lo=None, hi=None):
    if not raw:
        return None
    try:
        v = float(raw)
    except ValueError:
        rep.error(where, f"{col} が数値ではありません: {raw!r}")
        return None
    if lo is not None and not (lo <= v <= hi):
        rep.warn(where, f"{col} が想定範囲({lo}〜{hi})の外です: {v}（緯度経度の取り違えを確認してください）")
    return v


def check_schedule(rep, where, name, r, start_col, start, end):
    """日程の構造化列（dates / *_time / date_note / date）を見る。

    表示に出る日付文字列と開催ステータスは、この4組＋開始日・終了日から
    画面側が毎回組み立てる（assets/js/schedule.js）。ここが崩れると、
    「終わった催しがいつまでも開催中に見える」たぐいの、読み手には
    見破れない嘘になるので、書式のずれは黙って通さない。
    """
    days = []
    raw_days = (r.get("dates") or "").strip()
    if raw_days:
        for tok in [x.strip() for x in raw_days.split("|") if x.strip()]:
            d = check_date(rep, where, "dates", tok)
            if d:
                days.append(d)
        if len(days) < 2:
            rep.warn(where, "dates は飛び日程（連続していない複数日）のための列です。"
                            "1日だけなら空にして start/end で表してください")
        if days != sorted(days):
            rep.warn(where, "dates が日付順に並んでいません")
        if days and start and days[0] != start:
            rep.error(where, f"dates の最初の日({days[0]})が {start_col}({start}) と違います")
        if days and end and days[-1] != end:
            rep.error(where, f"dates の最後の日({days[-1]})が end_date({end}) と違います")

    for col in ("open_time", "start_time", "end_time"):
        v = (r.get(col) or "").strip()
        if v and not TIME_RE.match(v):
            rep.error(where, f"{col} の書式が H:MM ではありません: {v!r}")
    ot, st_, et = ((r.get(c) or "").strip() for c in ("open_time", "start_time", "end_time"))
    if et and not st_:
        rep.warn(where, "end_time だけがあり start_time がありません")
    if ot and st_ and ot > st_ and len(ot) == len(st_):
        rep.warn(where, f"open_time({ot}) が start_time({st_}) より後です（開場と開演の取り違えを確認してください）")

    # 予備日は会期には含めない。本開催で終われば使われない日なので、
    # start/end に混ぜると「まだやっている」と1日長く見せることになる。
    for tok in [x.strip() for x in (r.get("backup_date") or "").split("|") if x.strip()]:
        d = check_date(rep, where, "backup_date", tok)
        if d and start and end and start <= d <= end:
            rep.error(where, f"backup_date({d}) が会期({start}〜{end})の中にあります。"
                             "予備日は本開催が流れたときの日なので、会期には含めません")
        if d and start and d < start:
            rep.warn(where, f"backup_date({d}) が開始日({start})より前です")

    # date は「ISOの日付に落とせない日程」のための逃げ道で、常用する列ではない。
    # 埋まっている行は表記の統一から外れるので、残す判断をしたことが分かるよう毎回出す。
    free = (r.get("date") or "").strip()
    if free:
        rep.warn(where, f"date に自由記述が残っています（この行だけ日付表記が統一されません）: {free[:40]}")

        # 「10月中旬〜下旬」「2026年夏」のように月・季節が読み取れるのに
        # start_date/end_date が両方空だと、日程の絞り込みが「無期限」として
        # 素通りし、まったく無関係な日で絞っても表示されてしまう
        # （例: 8月で絞っているのに10月開催のコキアが出る）。
        # 完全に日付が読めない行（「会期は公式サイト参照」等）とは区別する。
        if not start and not end and MONTHLY_HINT.search(free):
            rep.warn(where, f"date に月・季節が書かれていますが start_date/end_date が空です: {free[:40]!r}"
                            "（日程の絞り込みで無関係な日にも表示されてしまいます。"
                            "少なくとも該当する月を start_date/end_date に設定してください）")

    # 単日公演の end_date 空欄は「終了日が未定」の意味になり、
    # 終わったあともいつまでも「開催中」と表示され続ける。
    if name == "lives.csv" and start and not end:
        rep.warn(where, "end_date が空です。単日公演なら start_date と同じ日を書いてください"
                        "（空欄は『終了日未定』の意味で、いつまでも開催中と表示されます）")


def check_status(rep, where, r, allowed, start, end):
    """status / rank は表示側が日付から毎回計算する（assets/js/schedule.js）。

    CSVのこの2列は、日付を1つも持たない行——「会期は公式サイト参照」のように
    ISOの日付に落とせない催し——のためだけに残してある予備で、日付がある行に
    書いても無視される。書いてあるのに画面に出ないのが一番たちが悪いので、
    「無視される値が入っている」ことをここで知らせる。
    """
    st = (r.get("status") or "").strip()
    rank = (r.get("rank") or "").strip()
    if st and st not in allowed:
        rep.warn(where, f"status に未知の値 {st!r}（バッジは灰色になります）")
    if (start or end) and (st or rank):
        rep.warn(where, "status / rank は日付から計算されるので、日付のある行では無視されます。"
                        "空欄にしてください")
    if not start and not end and not st:
        rep.warn(where, "日付が無く status も空です（開催状況のバッジも絞り込みも出ません）")


def validate_main(name, rows, enums, rep):
    start_col = START_COL[name]
    series_col = SERIES_COL[name]
    seen_ids = {}
    series_count = {}

    for i, r in enumerate(rows, start=2):     # 2 = ヘッダー行の次
        where = f"{name}:{i}"
        title = (r.get("title") or "").strip()
        if not title:
            rep.error(where, "title が空です")

        rid = (r.get("id") or "").strip()
        if rid:
            if rid in seen_ids:
                rep.warn(where, f"id {rid} が {seen_ids[rid]} 行目と重複しています")
            seen_ids[rid] = i

        # 日付
        start = check_date(rep, where, start_col, (r.get(start_col) or "").strip())
        end = check_date(rep, where, "end_date", (r.get("end_date") or "").strip())
        if start and end and end < start:
            rep.error(where, f"end_date({end}) が {start_col}({start}) より前です")
        if not start and not end:
            rep.warn(where, f"{start_col} も end_date も空です（日程での絞り込みに一切かかりません）")
        check_date(rep, where, "announced_date", (r.get("announced_date") or "").strip())
        check_schedule(rep, where, name, r, start_col, start, end)

        # 受付期間
        os_start = check_date(rep, where, "onsale_start", (r.get("onsale_start") or "").strip())
        os_end = check_date(rep, where, "onsale_end", (r.get("onsale_end") or "").strip())
        if os_start and os_end and os_end < os_start:
            rep.error(where, "onsale_end が onsale_start より前です")
        for col in ("onsale_start_time", "onsale_end_time"):
            v = (r.get(col) or "").strip()
            if v and not TIME_RE.match(v):
                rep.error(where, f"{col} の書式が HH:MM ではありません: {v!r}")
            if v and not (r.get(col.replace("_time", "")) or "").strip():
                rep.warn(where, f"{col} だけがあり日付がありません（時刻は無視されます）")

        if (r.get("is_additional") or "").strip().lower() not in BOOL_OK:
            rep.error(where, f"is_additional は空か 0/1/true/false: {r.get('is_additional')!r}")

        # 選択肢
        if name == "events.csv":
            check_enum(rep, where, "cats", (r.get("cats") or "").strip(), enums["cats"])
            if not (r.get("cats") or "").strip():
                rep.warn(where, "cats が空です（カテゴリで絞り込めません）")
            check_status(rep, where, r, enums["event_status"], start, end)
        elif name == "movies.csv":
            check_enum(rep, where, "genre", (r.get("genre") or "").strip(), enums["movie_genre"])
            check_enum(rep, where, "screening_type", (r.get("screening_type") or "").strip(), enums["screening_type"])
            check_status(rep, where, r, enums["movie_status"], start, end)
        else:
            check_enum(rep, where, "genre", (r.get("genre") or "").strip(), enums["live_genre"])
            check_enum(rep, where, "live_type", (r.get("live_type") or "").strip(), enums["live_type"])
            check_status(rep, where, r, enums["live_status"], start, end)

        pref = (r.get("pref") or "").strip()
        if pref and pref not in enums["pref"]:
            rep.error(where, f"pref に未知の値 {pref!r}（都県の絞り込みから漏れます）")
        # イベントの対象地域は1都4県（東京・神奈川・埼玉・千葉・茨城）に絞って
        # ある（映画・ライブは引き続き栃木・群馬が対象なので、PREFS 自体は
        # 変えていない）。ここは収集ルールの逸脱であって、表示が壊れるわけでは
        # ないので ERROR ではなく WARNING にする——ERROR にすると検証の対象を
        # データセットで分岐させる必要が生じ、この検証の構造が複雑になる。
        elif name == "events.csv" and pref in ("tochigi", "gunma"):
            rep.warn(where, f"pref={pref!r} はイベントの対象地域（1都4県）から外れています")

        # リンク
        for col in ("url", "official_url", "venue_url", "theater_url", "apple_music_url"):
            if col in r:
                check_url(rep, where, col, (r.get(col) or "").strip())
        if not (r.get("url") or "").strip() and not (r.get("official_url") or "").strip():
            rep.error(where, "url も official_url も空です（カードから行き先がありません）")

        # apple_music_url は「Apple Musicのアーティストページ」と明示して案内するリンクなので、
        # 別サービスやアーティスト以外のページ（アルバム・プレイリスト等）を誤って入れていないか確認する。
        amu = (r.get("apple_music_url") or "").strip()
        if amu:
            if not amu.startswith("https://music.apple.com/"):
                rep.error(where, f"apple_music_url が music.apple.com のURLになっていません: {amu[:60]}")
            elif "/artist/" not in amu:
                rep.error(where, f"apple_music_url がアーティストページのURLではないようです（/artist/ を含みません）: {amu[:60]}")

        # source 列にURLが入っていないか（ボタンラベルが壊れる）
        source_val = (r.get("source") or "").strip()
        if source_val and source_val.startswith(("http://", "https://")):
            rep.warn(where, "source がURLになっています。サイト名を書いてください"
                            "（ダッシュボードでは「{source}で予約する」のようなボタンラベルに使われます）")

        # 座標。関東以外（pref=other）には関東の矩形を当てない（coord_ranges 参照）
        lat_range, lng_range = coord_ranges(pref)
        lat = check_num(rep, where, "lat", (r.get("lat") or "").strip(), *lat_range)
        lng = check_num(rep, where, "lng", (r.get("lng") or "").strip(), *lng_range)
        if (lat is None) != (lng is None):
            rep.error(where, "lat と lng は両方そろえてください（片方だけでは地図に出せません）")

        # 価格レイヤー。条件付きの割引を無条件に見せると、出さないより有害になる。
        po = (r.get("price_official") or "").strip()
        pb = (r.get("price_best") or "").strip()
        dp = (r.get("discount_pct") or "").strip()
        cond = (r.get("price_condition") or "").strip()
        if pb and not po:
            rep.error(where, "price_best があるのに price_official がありません（比較になりません）")
        if pb and not (r.get("best_source") or "").strip():
            rep.error(where, "price_best があるのに best_source がありません（どこの価格か分かりません）")
        if po and pb:
            try:
                po_i, pb_i = int(po), int(pb)
                if pb_i > po_i:
                    rep.warn(where, f"price_best({pb_i}) が price_official({po_i}) より高いです")
                if dp:
                    calc = round((po_i - pb_i) / po_i * 100)
                    if abs(calc - int(dp)) > 2:
                        rep.error(where, f"discount_pct({dp}%) が実際の値引き({calc}%)と合いません")
            except (ValueError, ZeroDivisionError):
                rep.error(where, "price_official / price_best / discount_pct が整数ではありません")
        if (pb or dp) and not cond:
            rep.warn(where, "割引に price_condition（適用条件）がありません。"
                            "会員限定・曜日限定などの条件がある場合は必ず書いてください")
        if (po or pb) and not (r.get("price_checked") or "").strip():
            rep.warn(where, "価格があるのに price_checked（確認日）がありません")

        sid = (r.get(series_col) or "").strip()
        if sid:
            series_count[sid] = series_count.get(sid, 0) + 1

    for sid, n in series_count.items():
        if n < 2:
            rep.warn(f"{name}", f"{series_col}={sid!r} の行が1件しかありません（シリーズは2件以上で意味を持ちます）")


def validate_master(name, rows, enums, rep):
    key = MASTER_KEY[name]
    seen = {}
    active = 0
    for i, r in enumerate(rows, start=2):
        where = f"{name}:{i}"
        label = (r.get(key) or "").strip()
        if not label:
            rep.error(where, f"{key} が空です")
        elif label in seen:
            rep.error(where, f"{key}={label!r} が {seen[label]}行目と重複しています"
                             "（名簿の重複は同じ会場を二重に調べる原因になります）")
        else:
            seen[label] = i

        pref = (r.get("pref") or "").strip()
        if pref and pref not in enums["pref"]:
            rep.error(where, f"pref に未知の値 {pref!r}")
        if name == "venues.csv":
            kind = (r.get("kind") or "").strip()
            if kind and kind not in enums["venue_kind"]:
                rep.error(where, f"kind に未知の値 {kind!r}")
        if name == "spots.csv":
            kind = (r.get("kind") or "").strip()
            if kind and kind not in SPOT_KINDS:
                rep.error(where, f"kind に未知の値 {kind!r}（使えるのは {sorted(SPOT_KINDS)}）")
        check_url(rep, where, "url", (r.get("url") or "").strip())
        lat_range, lng_range = coord_ranges(pref)
        check_num(rep, where, "lat", (r.get("lat") or "").strip(), *lat_range)
        check_num(rep, where, "lng", (r.get("lng") or "").strip(), *lng_range)

        # --- 名簿の保守列 ---
        st = (r.get("status") or "").strip()
        if st not in ROSTER_STATUS:
            rep.error(where, f"status に未知の値 {st!r}（{sorted(ROSTER_STATUS - {''})} のいずれか）")
        if st in ("", "active"):
            active += 1
        for col in ("first_seen", "last_hit", "closed_until"):
            if col in r:
                check_date(rep, where, col, (r.get(col) or "").strip())
        hc = (r.get("hit_count") or "").strip()
        if hc and not hc.isdigit():
            rep.error(where, f"hit_count が整数ではありません: {hc!r}")

    if active == 0 and rows:
        rep.error(name, "active な行が1つもありません（定点観測の対象が空になっています）")


def validate_lineups(rows, live_rows, rep):
    """フェスの日割りラインナップ（設計書 第12.12節）を検証する。

    このファイルの価値は「どの日に誰が出るか」に尽きるので、壊れ方も
    そこに集中する——**日付が公演の会期の外を指している行**は、シートの中で
    存在しない日のタブを作り、利用者を実在しない日程へ案内する。
    参照先を失った行（lineup_id の綴り違い）は、収集は成功したのに
    ボタンが出ない、という気づきにくい壊れ方をする。
    """
    name = LINEUP_FILE
    # lives.csv 側の索引。会期の外の日付を捕まえるために開始日・終了日も持つ
    fests = {}
    for r in live_rows:
        lid = (r.get("lineup_id") or "").strip()
        if lid:
            fests.setdefault(lid, r)

    seen = set()
    used = set()
    for i, r in enumerate(rows, start=2):
        where = f"{name}:{i}"
        lid = (r.get("lineup_id") or "").strip()
        artist = (r.get("artist") or "").strip()
        if not lid:
            rep.error(where, "lineup_id が空です（どの公演のラインナップか分かりません）")
        if not artist:
            rep.error(where, "artist が空です")

        host = fests.get(lid)
        if lid and host is None:
            rep.error(where, f"lineup_id={lid!r} に対応する行が lives.csv にありません"
                             "（綴り違いか、公演行の側で lineup_id を埋め忘れています。"
                             "この行は表示されません）")
        else:
            used.add(lid)

        d = check_date(rep, where, "date", (r.get("date") or "").strip())
        if d and host is not None:
            # lives.csv 側の日付の書式は validate_main が見ている。ここで読めない
            # 値をもう一度エラーにすると、同じ1つの誤りが2件に増えるだけなので黙って諦める。
            start = parse_date(host.get("start_date"))
            end = parse_date(host.get("end_date")) or start
            if start and end and not (start <= d <= end):
                rep.error(where, f"date={d} が公演の会期（{start}〜{end}）の外です"
                                 "（開催しない日のタブができます）")

        hd = (r.get("is_headliner") or "").strip().lower()
        if hd not in BOOL_OK:
            rep.error(where, f"is_headliner が真偽値ではありません: {hd!r}")

        # 検索URLは表示側がその場で組み立てる。CSVに書いてよいのは、収集時に
        # 実在を確かめたアーティストページだけ（設計書 第12.11節・第12.12節）。
        amu = (r.get("apple_music_url") or "").strip()
        check_url(rep, where, "apple_music_url", amu)
        if amu:
            if "music.apple.com" not in amu:
                rep.error(where, f"apple_music_url が music.apple.com のURLになっていません: {amu[:60]}")
            elif "/artist/" not in amu:
                rep.error(where, "apple_music_url がアーティストページのURLではありません"
                                 f"（/artist/ を含みません。検索URLはここに書かず空欄にしてください）: {amu[:60]}")

        key = (lid, (r.get("date") or "").strip(), (r.get("stage") or "").strip(), artist)
        if artist and key in seen:
            rep.warn(where, f"同じ日・同じステージに {artist!r} が重複しています")
        seen.add(key)

    # 逆向き：公演側が lineup_id を持つのに1行も無い＝カードのボタンが出ない
    for lid, r in fests.items():
        if lid not in used:
            rep.error(f"lives.csv({r.get('title','')[:30]})",
                      f"lineup_id={lid!r} に対応する行が {name} に1件もありません"
                      "（カードの「全◯組の日程を見る」が出ません）")


def check_stray_csv(rep):
    """リポジトリのルートに `events.csv` 等が書かれていないか見る。

    ダッシュボードは `data/` 配下しか読まず、別パスへのフォールバックを意図的に
    持たない（設計書 第3.2節）。だからルート直下にCSVが書かれると、収集は
    成功したように見えるのに画面は先週のまま、という**最も気づきにくい壊れ方**をする。

    これは想像上の心配ではない。収集スキルの正本は `.claude/skills/` だが、
    `/kanto-*-collector` として呼び出すための複製が `~/.claude/skills/` にあり、
    **この同期は自動ではない**（第9.1節）。古い複製は書き出し先を
    `events.csv`（ルート直下）と書いていた版で、それが呼ばれると週次の成果が
    まるごと迷子になる。指示文で注意するだけでは防げないので、検証で落とす。

    週次ルーチン（`.claude/scripts/claude-routine.sh`）はこの検証が通らない回を
    コミットしないので、ここを ERROR にすれば「古いが正しい」状態が守られる。
    """
    for name in ("events.csv", "movies.csv", "lives.csv"):
        stray = os.path.join(ROOT, name)
        if os.path.exists(stray):
            rep.error(name, f"リポジトリのルートに {name} があります。"
                            f"書き出し先は data/{name} です"
                            "（ダッシュボードは data/ 配下しか読まないため、"
                            "ここに書いても表示は更新されません。"
                            "古い版の収集スキルが呼ばれていないか確認してください）")


def main():
    strict = "--strict" in sys.argv
    enums = load_enums()
    rep = Report()
    loaded = {}
    check_stray_csv(rep)

    for name, expected in EXPECTED_HEADERS.items():
        path = os.path.join(DATA, name)
        if not os.path.exists(path):
            rep.error(name, "ファイルがありません")
            continue
        header, rows = read_csv(path)
        # ヘッダー不一致でも捕まるが、それだと「余分な列がある」としか出ない。
        # 画像の列は理由があって持たないので、復活させたときは理由ごと知らせる。
        banned = [c for c in header if c in BANNED_COLUMNS]
        if banned:
            rep.error(name, f"画像の列 {banned} があります。3タブとも画像は扱いません"
                            "（権利者の許諾は自社サイトへの掲載に対するもので、"
                            "第三者サイトへの再掲載・直リンクの許諾ではないため。設計書 第7.1節）")
        if header != expected:
            missing = [c for c in expected if c not in header]
            extra = [c for c in header if c not in expected]
            rep.error(name, f"ヘッダーが想定と違います 不足={missing} 余分={extra}")
            continue          # 列がずれている状態で中身を見ても意味がない
        # ラインナップは付加的な層で、1件も無い週があってもダッシュボードは成立する
        # （フェスの出演者が未発表の時期は実際にある）。空でも落とさない。
        if not rows and name != LINEUP_FILE:
            rep.error(name, "データ行がありません")
            continue
        if name in START_COL:
            validate_main(name, rows, enums, rep)
        elif name != LINEUP_FILE:
            validate_master(name, rows, enums, rep)
        loaded[name] = rows
        print(f"  {name}: {len(rows)}行")

    # ラインナップは lives.csv との突き合わせが検証の本体なので、両方読めてから行う
    if LINEUP_FILE in loaded and "lives.csv" in loaded:
        validate_lineups(loaded[LINEUP_FILE], loaded["lives.csv"], rep)

    print()
    for w in rep.warning_lines():
        print(f"WARNING  {w}")
    for e in rep.errors:
        print(f"ERROR    {e}")
    print(f"\n合計: エラー {len(rep.errors)} / 警告 {len(rep.warnings)}")

    if rep.errors:
        print("\nエラーがあるためデプロイを止めます。"
              "壊れた新しいデータを出すより、前回の正しいデータを残すほうが害が小さいためです。")
        return 1
    if strict and rep.warnings:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
