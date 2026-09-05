#!/usr/bin/env python3
"""前回の収集結果を、コンテキストを食わずに参照するためのツール。

## なぜ必要か

収集タスクは「前回のCSVを読んで、既存の行が更新・終了していないか確認する」
という工程を持つ。しかし前回CSVをそのまま読み込むと、events.csv だけで
約68,000文字（概算4〜5万トークン）あり、着手した時点でコンテキストの2〜3割を
失う。append_rows.py の冒頭に書いた「後半の調査品質が落ちる」問題が、
そのまま再発する。

そこでこのツールが、

  1. **一覧は圧縮して出す**（棚卸しに必要な列だけ・1行1軒）
  2. **詳細は uid 指定で引く**（必要になった行だけ全列を返す）

という2段構えを提供する。全部を読むのではなく、必要な分だけ引く。

## 前回データはどこにあるか

`append_rows.py <ds> --init` が、CSVを空にする**前に** `data/.prev/` へ
退避する。退避が無い場合（初回や、手作業で消した場合）は git の HEAD から
復元を試みる。どちらも無ければ「前回データなし」として扱う。

## 使い方

    # 棚卸し用の一覧（既定は全件。--tier A で要再確認だけに絞る）
    python3 tools/prev_rows.py events --worklist
    python3 tools/prev_rows.py events --worklist --tier A

    # 特定の行だけ全列を引く（複数指定可）
    python3 tools/prev_rows.py events --uid 3f2a1b9c --uid 8d7e6f50

    # 会場名で引く（その会場の前回分がまとめて出る）
    python3 tools/prev_rows.py events --venue 東京国立博物館

    # 打ち切られたときの後始末（終了工程。終了日を過ぎた行は expired、
    # 残りは前回値のまま書き戻す）
    python3 tools/prev_rows.py events --carry-rest            # 何が起きるか見るだけ
    python3 tools/prev_rows.py events --carry-rest --apply    # 実際に書き込む

    # 前回にあった行の「その後」を記録する（消滅行の説明。diff_data.py が要求する）
    python3 tools/prev_rows.py events --dispose <<'EOF'
    {"uid": "3f2a1b9c", "status": "ended", "note": "8/31で会期終了を公式で確認"}
    {"uid": "8d7e6f50", "status": "cancelled", "note": "台風のため中止"}
    EOF
"""

import argparse
import csv
import difflib
import json
import os
import subprocess
import sys
from collections import defaultdict
from datetime import date, timedelta

from rowkey import norm
from rowkey import uid as row_uid
from validate_data import EXPECTED_HEADERS, START_COL

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
PREV = os.path.join(DATA, ".prev")

NAME_MAP = {"events": "events.csv", "lives": "lives.csv", "movies": "movies.csv"}

# 前回にあった行が今回無い場合に付けられる説明。diff_data.py が対応表として使う。
#
# **`notfound` は「消滅」ではない。** 情報源を確認できなかった、というだけで
# 終了した根拠には一切ならない——実際、直近の実行では notfound 38件に対し
# 確認できた ended はわずか3件だった。だから `notfound` を付けた行は
# `cmd_dispose` が前回値のまま自動で書き戻す（受付欄は空にする）。消えるのは
# 「情報源で終了・中止を確認できた」「対象外と確定した」「別の行に実体が残る」
# の3種と、日付だけで機械的に確定する `expired` だけである。
DISPOSITIONS = {
    "ended":        "会期・上映・公演が終了したことを確認した",
    "cancelled":    "中止・延期になったことを確認した",
    "out-of-scope": "対象期間（3ヶ月）や対象地域から外れた",
    "merged":       "他の行に統合した（重複の解消）",
    "renamed":      "同じ催しだが表記が変わった（to に新しい uid を書くこと）",
    "notfound":     "今回は確認できなかった（行は削除しない。前回値のまま持ち越し、来週の最優先にする）",
    # モデルが情報源を確認して付ける "ended" とは違い、これは tools/purge_ended.py が
    # 終了日と今日の日付だけを比較して機械的に付けるもの。「確認した」を騙らないよう別枠にする。
    "expired":      "終了日を過ぎたことを purge_ended.py が機械的に検出した（未確認）",
}

# `ended` は「この行を個別に確認した」ことが前提の処分である。
# 2026-08-29 の無人実行では、これと `notfound` を1回の --dispose で35件まとめて
# 処分し（「確認できなかったものを統一処理します」の一言で）、うち3件は会期が
# まだ残っているのに ended と誤判定した。件数が多いこと自体が「個別に確認して
# いない」ことの兆候なので、上限を超えたら書き込ませない。
#
# `notfound` はこの上限から外してある——上の変更で `notfound` はもう削除では
# なく持ち越しになったので、「個別確認せずに大量削除する」事故がそもそも
# 起こりえない。まとめて何件記録しても、行は消えずに残る。
DISPOSE_RISKY_STATUSES = {"ended"}
DISPOSE_BATCH_LIMIT = 8

# 同じ理由文（定型文）が並んでいないかの目安の対象。件数の上限
# （DISPOSE_RISKY_STATUSES）とは別に持つ——`notfound` は削除しなくなったので
# 上限からは外したが、定型文の目安はそのまま効かせたい。
NOTE_SCRUTINY_STATUSES = {"ended", "notfound"}

# 同じ理由文（定型文）が並んでいないかの目安。ブロックはしない——同じ会場が
# 閉館した等、正当に理由が重なることもあるため、最終判断はモデルに委ねる。
NOTE_SIMILARITY_WARN = 0.5

# --- 再確認の優先度（tier）を決めるしきい値 ---------------------------------
# 「全行を毎週フルに調べ直す」のは高いだけでなく、後半の調査を浅くする。
# 列ごとに変わりやすさが違うので、変わりやすいものを持つ行から先に見る。
#
# ## しきい値は「多いほど安全」ではない
#
# 以前は 会期末・締切とも21日、価格の鮮度14日で、価格の鮮度だけで tier A に
# 上げていた。その結果 **events は125件中105件（84%）、lives は96件中70件（73%）が
# tier A** になった。各SKILL.mdは「予算が尽きたら tier A の再確認を最優先で守る」と
# 書いているが、105件を守れと言われて守れる工程の枠は存在しない。
# **全部が最優先なら、優先順位は無い。** 実際には恣意的な場所で止まる。
#
# そこで次の3点を分けた。
#
#   - **会期末・開始は10日**。延長・中止が告知されるのはこの辺りで、21日先の
#     終了日を毎週確認しても、ほとんどの週は何も変わっていない
#   - **受付の締切・発売は21日のまま**。これは利用者が行動を逃す期限であり、
#     3スキルの中でも最も落としたくない情報である（設計書 第12.2節）
#   - **価格の鮮度は tier B へ**。古い価格は「間違った値」ではなく
#     「いつ確認したかが分かる値」であり（`price_checked` がそれを示す）、
#     中止を伝え損ねることに比べれば実害が小さい。TTLも45日に伸ばした
#
# この変更で events 36% / lives 47% / movies 24% になる。lives が高いのは
# 受付未確定の行が多いためで、それは埋めるべき仕事が実在するという意味である。
SCHEDULE_NEAR_DAYS = 10   # 会期末・開始がこの日数以内なら要再確認
ONSALE_NEAR_DAYS = 21     # 受付の締切・発売日がこの日数以内なら要再確認
PRICE_TTL_DAYS = 45       # 価格の確認日がこれより古ければ洗い直す（tier B）
URGENT_STATUS = {
    "本日開催", "まもなく開催", "本日が最終上映", "まもなく公開",
}

# 受付が「決着している」ことを表す語。これらは締切を持たないのが正しい状態なので、
# `onsale_end` が空でも未確定ではない。
#
# これを分けないと、完売した公演が**永久に tier A に居座る**。SOLD OUT は
# 各SKILL.mdが「確定情報なので別経路を探すな」と明示している状態でありながら、
# 「onsale_label があるのに締切が空」という判定に引っかかっていた（lives の
# 未確定32件のうち14件がこれだった）。埋まりようのない欄を理由に最優先へ
# 上げ続けるのは、優先順位を薄めるだけである。
# `rowkey.norm()` を通した形で持つ（NFKC正規化・ひらがな化・casefold・空白/記号除去）。
# 素の文字列比較（`casefold()` だけ）だと全角英字（`ＳＯＬＤ　ＯＵＴ`）や全角空白を
# 吸収できず、そうした表記が来ると「決着済み」と判定できずに tier A へ上がり続ける。
SETTLED_ONSALE = {norm(s) for s in (
    "sold out", "soldout", "受付終了", "販売終了", "完売",
    "売り切れ", "ソールドアウト", "当日券あり", "入場無料",
)}


def resolve_dataset(arg):
    if arg in NAME_MAP:
        return NAME_MAP[arg]
    if arg in EXPECTED_HEADERS:
        return arg
    raise SystemExit(f"ERROR: 不明なデータセット名です: {arg!r}（events / lives / movies）")


# ---------------------------------------------------------------- 前回データ

def snapshot_path(name):
    return os.path.join(PREV, name)


def meta_path(name):
    return os.path.join(PREV, name.replace(".csv", ".meta.json"))


def _from_git(name):
    """`.prev` が無いときの保険。直前のコミットのCSVを読む。

    週次タスクは毎回コミットしてpushする運用なので、HEAD はほぼ前回の実行結果に
    あたる。ただし同じ日に2回実行した場合などはズレるため、あくまで保険。
    """
    try:
        out = subprocess.run(
            ["git", "show", f"HEAD:data/{name}"],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    return out.stdout


def load_prev(name):
    """(rows, source) を返す。前回データが無ければ ([], None)。"""
    path = snapshot_path(name)
    if os.path.exists(path):
        with open(path, newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f)), f"snapshot:{os.path.relpath(path, ROOT)}"
    text = _from_git(name)
    if text:
        return list(csv.DictReader(text.splitlines())), "git:HEAD"
    return [], None


def take_snapshot(name):
    """現在のCSVを `.prev/` に退避する。append_rows.py --init から呼ばれる。

    戻り値は「退避した行数」だが、**実際には退避しなかった**場合は負数で返す
    （呼び出し元がその旨を表示に使う）。

    ## なぜ「0行なら退避しない」のか

    `--init` を同じ日に2回実行すると（コンテキスト逼迫やツール失敗からの
    やり直しで実際に起こる）、1回目の `--init` で現在のCSVは既にヘッダーだけに
    なっている。ここで無条件に退避すると、**2回目の呼び出しが「前回0件」を
    `.prev/` に書き込み、1回目が正しく退避した本物の前回データを消してしまう。**
    `diff_data.py` はその状態を「前回データなし（初回実行）」と判定し、
    説明のない消滅の検査・noop検査・`_carry` の持ち越しがすべて素通りになる
    ——検証は通るが、何も検査していない。

    データ行が0のCSVを「前回の状態」として意味のある形で退避することはできない
    ので、その場合は既存のスナップショット（と、まだ引き継がれていない
    `carried.jsonl`）をそのまま残す。
    """
    src = os.path.join(DATA, name)
    if not os.path.exists(src):
        return None
    with open(src, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return -1
    os.makedirs(PREV, exist_ok=True)
    with open(src, encoding="utf-8") as f:
        raw = f.read()
    with open(snapshot_path(name), "w", encoding="utf-8") as f:
        f.write(raw)
    with open(meta_path(name), "w", encoding="utf-8") as f:
        json.dump({"taken_at": date.today().isoformat(), "rows": len(rows)},
                  f, ensure_ascii=False, indent=2)
    # 退避のたびに、その時点の処分記録は「今週の分」としての役目を終える。
    # 単純な世代交代（前の carried.jsonl を丸ごと捨てて disp で置き換える）は
    # しない——**まだCSVに戻っていない `expired` は、何週再確認を逃しても
    # 消さずに引き継ぐ**（`load_carried` / `carried_path` の説明を参照）。
    #
    # `notfound` はここで引き継がない。`cmd_dispose` が notfound を前回値の
    # まま書き戻すようになったため（行は削除されない）、notfound の uid は
    # 必ずこの時点の `rows`（＝退避される直前、今週まで使っていたCSV）に
    # 含まれる。「まだCSVに戻っていない」という条件が、この違いをそのまま
    # 反映する——expired だけが実際にCSVから消えている処分だからである。
    cur_uids = {row_uid(name, r) for r in rows}
    still_missing = {c["uid"]: c for c in load_carried(name) if c.get("uid") not in cur_uids}
    disp = disposition_path(name)
    if os.path.exists(disp):
        with open(disp, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("status") == "expired" and obj.get("uid") not in cur_uids:
                    still_missing[obj["uid"]] = obj
        os.remove(disp)
    if still_missing:
        with open(carried_path(name), "w", encoding="utf-8") as f:
            for obj in still_missing.values():
                f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    elif os.path.exists(carried_path(name)):
        os.remove(carried_path(name))
    return len(rows)


def prev_taken_at(name):
    try:
        with open(meta_path(name), encoding="utf-8") as f:
            return date.fromisoformat(json.load(f)["taken_at"])
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        return None


# ------------------------------------------------------------ 終了したか

def _d(value):
    try:
        return date.fromisoformat((value or "").strip())
    except ValueError:
        return None


def last_date(name, row):
    """判定に使う「終了日」を返す。飛び日程があればその最後の日を優先する。

    `schedulePhase`（assets/js/schedule.js）と同じ優先順位: `dates` があれば
    会期の端（`start_date`/`end_date`）ではなく実際の開催日の並びで見る。
    """
    days = [d.strip() for d in (row.get("dates") or "").split("|") if d.strip()]
    if days:
        return days[0], days[-1]
    return (row.get(START_COL[name]) or "").strip(), (row.get("end_date") or "").strip()


def is_ended(name, row, today):
    """`schedulePhase` の「終了」判定と同じ規則。

    ## なぜ purge_ended.py ではなくここにあるか

    この規則を使う側が3つに増えた——`purge_ended.py`（今回のCSVから消す）、
    `--worklist`（終わった行を棚卸しに出さない）、`--carry-rest`（書き戻す
    代わりに `expired` として処分する）。うち後の2つはこのファイルにある。

    `purge_ended.py` は `prev_rows` を import する側なので、規則をあちらに
    置いたままこちらから呼ぶと循環 import になる。**依存の向きに合わせて
    下位のこちらへ移し、`purge_ended.py` はここから import する。**
    判定が1か所にある限り、「表示では隠れているのにCSVには残っている」も
    「棚卸しには出るのに書き戻せない」も起きない。
    """
    start, end = last_date(name, row)
    if not start and not end:
        return False  # 日付を1つも持たない行は判定不能（自由記述の date に委ねる）

    backups = {b.strip() for b in (row.get("backup_date") or "").split("|") if b.strip()}
    if today.isoformat() in backups:
        return False  # 本日が予備日なら、表示側も「終了」より優先して出す

    end_date = _d(end)
    return bool(end_date and end_date < today)


# ---------------------------------------------------------------- tier 判定


def tier_of(name, row, today):
    """A=毎回必ず再確認 / B=会場調査のついでに確認 / C=低頻度でよい。

    tier は「手を抜いてよい行」を決めるためのものではなく、
    **限られた回数のページ取得を、変わりやすい行から先に使う**ための優先順位である。
    B の行も、その会場のページを開いた時点で同時に確認できる（会場単位で回るため）。
    """
    reasons = []
    start = _d(row.get(START_COL[name]))
    end = _d(row.get("end_date"))
    # status はもう日付から画面側が計算する列で、CSVでは日付を持たない行にしか入らない。
    # 「まもなく」「本日」の急ぎ判定は、下の start / end の比較がそのまま担っている。
    status = (row.get("status") or "").strip()
    sched_soon = today + timedelta(days=SCHEDULE_NEAR_DAYS)
    onsale_soon = today + timedelta(days=ONSALE_NEAR_DAYS)

    if status in URGENT_STATUS:
        reasons.append(f"status={status}")
    if end and end <= sched_soon:
        reasons.append(f"会期末{end}")
    if start and today <= start <= sched_soon:
        reasons.append(f"開始{start}")

    os_end = _d(row.get("onsale_end"))
    os_start = _d(row.get("onsale_start"))
    label = (row.get("onsale_label") or "").strip()
    if os_end and os_end <= onsale_soon:
        reasons.append(f"締切{os_end}")
    if os_start and os_start >= today:
        reasons.append(f"発売{os_start}")
    if label and not os_end and norm(label) not in SETTLED_ONSALE:
        reasons.append("受付状況が未確定")

    if (row.get("coupon_note") or "").strip():
        reasons.append("クーポン")           # 配布は不定期に終わる
    if (row.get("is_additional") or "").strip() in ("1", "true", "yes"):
        reasons.append("追加公演")

    if reasons:
        return "A", reasons

    # 価格の鮮度は B 止まりにする。古い価格は「間違い」ではなく「いつ確認した値かが
    # 分かる値」で（`price_checked` がそれを示す）、会場ページを開いたついでに
    # 直せば足りる。A に混ぜると、実害の桁が違う中止・締切と同じ列に並んでしまう。
    has_price = any((row.get(c) or "").strip()
                    for c in ("price_official", "price_best", "discount_pct"))
    checked = _d(row.get("price_checked"))
    if has_price and (not checked or (today - checked).days > PRICE_TTL_DAYS):
        return "B", ["価格の確認日が古い"]

    if status == "通年予約可" or (not start and not end):
        return "C", ["日程が動かない/日程を持たない"]
    return "B", []


# ---------------------------------------------------------------- 出力

def _clip(value, width):
    """一覧表示用に切り詰める。**この出力をそのまま書き戻さないこと。**

    末尾には `…`（U+2026）ではなく U+FFFD（REPLACEMENT CHARACTER）を置く。
    `…` は実在のタイトル・副題の末尾に正当に現れうる記号なので、それを
    切り詰めの目印にすると「本物の `…` で終わるタイトル」と区別が付かない。
    U+FFFD はデコード事故を示すための予約済み文字で、人が書いた本物のタイトル
    に紛れ込むことは実質ありえない——2026-08-29 の事故（`--worklist` の34字
    省略をそのまま書き戻し、同じ催しが旧uid/新uidの二重掲載になった）を機械的
    に検知できるようにする（`append_rows.py` がこの文字を含む行を拒否する）。
    """
    s = (value or "").strip().replace("\t", " ").replace("\n", " ")
    return s if len(s) <= width else s[: width - 1] + "�"


def print_carried(name):
    """まだCSVに戻っていない `expired` 行を先に出す。

    棚卸しの先頭に置くのは、これが**今週いちばん最初に確かめるべき行**だから
    である。終了日を過ぎたという機械的な理由だけで消えており、会期延長を
    見落としていた可能性がある。CSVに戻らない限り、この一覧に出さないと
    二度と視界に入らない（`load_carried` は何週でも引き継ぐ）。

    `notfound`（確認できなかった行）はここに出さない。行は削除されずに
    前回値のまま持ち越されるので、下の tier 分類（`--worklist` 本体）に
    tier A として出る——`unverified.jsonl` を参照。
    """
    ex = load_carried(name)
    if not ex:
        return
    print(f"# ---- 終了日を過ぎたまま未確認の行（{len(ex)}件・今週の最優先）----")
    print("# 会期が延長されていた可能性があるので、その施設を開くついでに確かめること")
    for c in ex[:15]:
        print(f"#   {c.get('uid', '')}\t{_clip(c.get('title'), 40)}")
    if len(ex) > 15:
        print(f"#   …ほか{len(ex) - 15}件")
    print("#")


def cmd_worklist(name, rows, args):
    today = args.today if args.today else date.today()
    taken = prev_taken_at(name)
    # 手で組んだ Args から呼ばれることがある（検証・他ツール）ので、
    # 属性が無くても既定（＝従来どおり全行を出す）で動くようにしておく。
    summary = getattr(args, "summary", False)

    print_carried(name)
    print(f"# {name} 前回分の棚卸しリスト（{len(rows)}件）")
    if taken:
        print(f"# 前回の取得日: {taken}（{(today - taken).days}日前）")
    print("# tier A=今回必ず再確認 / B=会場ページを開いたついでに確認 / C=低頻度でよい")
    print("# 全列が要るときは: python3 tools/prev_rows.py <ds> --uid <uid>")
    if not summary:
        print("uid\ttier\tpref\ttitle\tvenue\t期間\t締切\t理由")

    counts = {"A": 0, "B": 0, "C": 0}
    by_pref = {}
    place_col = "theater" if name == "movies.csv" else "venue"
    wanted_prefs = set(args.pref or [])
    unverified = load_unverified(name)
    ended = 0
    for r in rows:
        # 終了日を過ぎた行は棚卸しに出さない。
        #
        # 調査の枠も文脈も、**これから消す行に使う理由が無い**。実測では
        # 2026-08-26 の events で256件中26件（約10%）がこれに当たっていた。
        # 終了日と今日を比べるだけで確定するのに、一覧に載ればモデルの目を通り、
        # tier A なら再確認の対象にもなる。
        #
        # ここでは処分を記録しない（記録は `--carry-rest` の仕事）。棚卸しは
        # `--pref` で担当分だけを切り出す使い方をするので、ここで書き込むと
        # **サブエージェントへ配る回数だけ、担当外の行が処分され残る。**
        # 問い合わせは問い合わせのままにしておく。
        if is_ended(name, r, today):
            ended += 1
            continue
        tier, reasons = tier_of(name, r, today)
        # 前回 `--carry-rest` または `--dispose notfound` が未確認のまま
        # 書き戻した行は、無条件に最優先へ。受付欄を空にした副作用で tier が
        # 下がるのを、ここで打ち消している（`unverified_path` の説明）。
        if row_uid(name, r) in unverified:
            tier = "A"
            reasons = ["前回は未確認のまま持ち越し"] + reasons
        counts[tier] += 1
        if args.tier and tier not in args.tier:
            continue
        if wanted_prefs and (r.get("pref") or "") not in wanted_prefs:
            continue
        by_pref.setdefault((r.get("pref") or "-"), {"A": 0, "B": 0, "C": 0})[tier] += 1
        # `--summary` は「同じ一覧を、行の代わりに数で出す」。親は担当の割り振りと
        # 最優先の行（上の print_carried）さえ分かればよく、**443行の一覧を親の文脈に
        # 置くと、それが毎ターン再送される**（events で28,922字）。担当分の全行は
        # `--pref <都県> > temp/worklist-<ds>-<都県>.md` でファイルに書き、子に Read させる。
        if summary:
            continue
        span = f"{(r.get(START_COL[name]) or '')[5:]}〜{(r.get('end_date') or '')[5:]}".strip("〜")
        print("\t".join([
            row_uid(name, r), tier, (r.get("pref") or ""),
            _clip(r.get("title"), 34), _clip(r.get(place_col), 16),
            span or "-", (r.get("onsale_end") or "")[5:] or "-",
            ",".join(reasons)[:48],
        ]))
    if summary:
        print("\n# 都県ごとの内訳（この一覧に出る行）")
        for pref, c in sorted(by_pref.items(), key=lambda kv: -sum(kv[1].values())):
            print(f"#   {pref}\tA={c['A']} B={c['B']} C={c['C']}\t計{sum(c.values())}")
        print("# 行そのものは出していません（--summary）。担当分を子に渡すときは")
        print(f"#   python3 tools/prev_rows.py {name.replace('.csv', '')} --worklist "
              "--pref <都県> > temp/worklist-<ds>-<都県>.md")
        print("# でファイルに書き、指示にはそのパスを Read させる1文だけを書くこと")

    print(f"\n# 内訳: A={counts['A']} B={counts['B']} C={counts['C']}")
    if ended:
        print(f"# 終了日を過ぎた{ended}件は一覧から除いてあります"
              "（終了工程の tools/prev_rows.py <ds> --carry-rest --apply が "
              "expired として処分します。調査の対象にしないこと）")


def _venue_matches(cell, wanted):
    """会場名の照合。**完全一致では引けない。**

    名簿（spots.csv 等）の施設名と、本体CSVの `venue` の書き方は一致しない。
    実データでは events.csv の会場118種のうち39種（約1/3）が名簿の名前と
    完全一致しない——`東京国立博物館` に対して `東京国立博物館 平成館`、
    `上野恩賜公園（袴腰広場）` のように、館内の会場や区画まで書かれるためである。

    完全一致で引くと、この文書自身が例に挙げている
    `prev_rows.py events --venue 東京国立博物館` が「該当なし」を返す。
    そしてこのコマンドは、**前回の official_url を引いて検索を1回節約する**
    ための入口なので（COLLECTION-PROTOCOL 第8.2節 原則1）、空振りすると
    節約するはずだった検索がそのまま消費される。

    そこで rowkey と同じ正規化（全角/半角・かな・記号・空白を吸収）をかけたうえで、
    どちらかがどちらかを含んでいれば一致とみなす。
    """
    c = norm(cell)
    if not c:
        return False
    return any(w and (w in c or c in w) for w in wanted)


def cmd_show(name, rows, args):
    wanted = set(args.uid or [])
    venues = [norm(v) for v in (args.venue or [])]
    place_col = "theater" if name == "movies.csv" else "venue"
    hits = [r for r in rows
            if (row_uid(name, r) in wanted)
            or (venues and _venue_matches(r.get(place_col), venues))]
    if not hits:
        print("# 該当なし", file=sys.stderr)
        return 1
    for r in hits:
        out = {k: v for k, v in r.items() if (v or "").strip()}
        out["_uid"] = row_uid(name, r)
        print(json.dumps(out, ensure_ascii=False))
    return 0


# ------------------------------------------------------ 残りを機械的に片付ける
#
# 受付の事実だけは書き戻さない。`price_*` を残して `onsale_*` を消すのは、
# 価格が「いつ確認した値か」を `price_checked` で示せるのに対し、受付の締切は
# 過ぎた瞬間に**間違った案内**になるためである（設計書 第7.2.3節）。
# `limited_sale` も同じ性質を持つので一緒に空にする。
CARRY_REST_CLEAR = (
    "onsale_label", "onsale_start", "onsale_start_time",
    "onsale_end", "onsale_end_time", "limited_sale",
)

# 持ち越した目印を行に書かないのは、`note` が**画面に出る列**だからである
# （カードに「注意」バッジとして描画され、検索の対象にもなる）。ここに内部事情を
# 書けば、利用者には無意味な文言が持ち越した行数だけ並ぶ。何件を持ち越したかは
# 下の要約行が stderr に出し、claude-routine.sh のログに残る。
CARRY_REST_EXPIRED_NOTE_FMT = "終了日（{end}）を過ぎたため carry-rest が機械的に処分（未確認）"


def unverified_path(name):
    """未確認のまま持ち越した行の uid を置く場所。

    ## なぜ要るのか

    `--carry-rest` は受付（`onsale_*`）を空にして書き戻す。過ぎた締切を
    そのまま載せるのは誤った案内になるからで、これ自体は正しい。

    **だがその副作用で、翌週の再確認の優先度が落ちる。** `tier_of()` は
    「締切が21日以内」「受付状況が未確定」を tier A の根拠にしており、
    受付を空にするとその根拠ごと消える。実測すると、持ち越す前は
    `tier=A（締切2026-09-10）` だった行が、持ち越したあとは `tier=B（理由なし）`
    になる。**確認できなかった行が、確認しなくてよい行に見える。**
    これはこのプロジェクトが最も避けている「静かな欠落」の作られ方そのものである。

    そこで、持ち越した uid をここに残す。`--worklist` はこれを読んで、
    該当する行を無条件に tier A へ上げる。受付欄を空にしたまま、
    「今週こそ確かめる」という情報だけを別に持ち越す形にしてある。

    書き手は2つある——`--carry-rest`（まとめて片付けた残り）と
    `--dispose notfound`（個別に確認できなかった行）。どちらも同じ「今週、
    確認できずに前回値のまま持ち越した」という事実を記す。だから片方が
    書いたあとにもう片方が呼ばれても、互いの記録を消してはいけない。

    2026-08-29 に見つかった事故を踏まえ、書き込みは `_record_unverified()`
    に一本化してある——**空で上書きしない・既存分と合流する**。以前は
    `"w"` で無条件に開き直しており、対象0件の呼び出し（`claude-routine.sh`
    が終了時に3データセットへ保険で打つ再実行がこれに当たる）が、
    セッション中に正しく書けていた記録ごと0バイトへ切り詰めていた。

    週をまたいだ蓄積は起きない——`take_snapshot()`（`--init`）はこのファイルに
    触れないので、`--worklist` が読むのは常に「前回このファイルへ書かれた、
    まだ解決していない行」だけである。ある uid がその後（今回）ちゃんと
    書き直されれば、その uid はもう `carried`/`notfound` の計算対象に出て
    こないので、次にこの関数が呼ばれたときに自然に引き継がれなくなる。
    """
    return os.path.join(PREV, name.replace(".csv", ".unverified.jsonl"))


def _record_unverified(name, pairs):
    """`(uid, title)` の一覧を、既存の unverified.jsonl に合流させる（追記ではなく合流）。

    合流にする理由は上の `unverified_path` の docstring を参照。空なら書かない
    ——対象0件の呼び出しで既存の記録を消さないため。
    """
    if not pairs:
        return
    path = unverified_path(name)
    existing = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("uid"):
                    existing[obj["uid"]] = obj
    except OSError:
        pass
    for u, title in pairs:
        existing[u] = {"uid": u, "title": title}
    try:
        os.makedirs(PREV, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for obj in existing.values():
                f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        os.replace(tmp, path)
    except OSError as e:
        print(f"WARNING: 持ち越しの記録に失敗しました（書き戻し自体は続けます）: {e}",
              file=sys.stderr)


def load_unverified(name):
    path = unverified_path(name)
    out = set()
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("uid"):
                    out.add(obj["uid"])
    except OSError:
        pass
    return out


def _current_uids(name):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return set()
    with open(path, newline="", encoding="utf-8") as f:
        return {row_uid(name, r) for r in csv.DictReader(f)}


def _live_lineup_ids():
    """いま lineups.csv に日割りが1行でもある lineup_id。

    書き戻す行が持つ `lineup_id` の参照先が無いと `validate_data.py` が
    「対応する行が lineups.csv に1件もありません」でERRORにする。打ち切られた
    実行では、公演行だけ前回分・日割りは未収集という組み合わせが普通に起きる。
    **持ち越しが検証を落とすなら、持ち越す意味が無い**ので、参照先を失った
    `lineup_id` は落として書き戻す（日割りは翌週あらためて集め直せばよい）。
    """
    path = os.path.join(DATA, "lineups.csv")
    if not os.path.exists(path):
        return set()
    with open(path, newline="", encoding="utf-8") as f:
        return {(r.get("lineup_id") or "").strip() for r in csv.DictReader(f)} - {""}


def _build_carry_obj(row, lineups):
    """前回値の行を、そのまま書き戻せる形に整える（受付欄は空にする）。

    `--carry-rest` と `--dispose notfound` の両方が使う共通処理。**この2つは
    「確認できないまま前回値を残す」という同じ操作**であり、規則を2箇所に
    分けて書くと片方だけ直し忘れる壊れ方をする。
    """
    obj = {k: v for k, v in row.items() if (v or "").strip()}
    for col in CARRY_REST_CLEAR:
        obj.pop(col, None)
    if (obj.get("lineup_id") or "").strip() not in lineups:
        # 空にするだけでは足りない。`lineup_id` は append_rows.py の
        # CARRY_ALWAYS にあり、空欄は前回値で埋め直される（綴りの揺れを
        # 防ぐための正しい既定である）。ここは「もう日割りは書かれない」と
        # 分かっている経路なので、`_no_carry` で明示的に打ち消す。
        obj.pop("lineup_id", None)
        obj["_no_carry"] = "lineup_id"
    return obj


def cmd_carry_rest(name, rows, args):
    """前回あって今回まだ書かれていない行を、機械的に片付ける。

    ## なぜモデルではなくツールがやるのか

    各SKILL.mdの「撤退の手順」は、この後始末をモデルの仕事として書いていた。
    だが撤退の手順は**生きているセッションにしか実行できない。** 2026-08-26 の
    lives 収集はアカウントの利用上限で予告なく強制終了され、その時点で書けていた
    94行と日割り217行は、前回78行のうち41行が未処分だったせいで
    「説明のない消滅」と判定され、`claude-routine.sh` に丸ごと巻き戻された。

    **未処理の行の既定値が「消滅」であることが、打ち切りを全損に変えている。**
    `append_rows.py --init` がCSVをヘッダーだけに切り詰める以上、前回行は
    能動的に書き直されない限り消える。ならば既定値のほうを変える——最後に
    残ったものを機械的に拾い、終了日を過ぎていれば `expired` として処分し、
    そうでなければ前回値のまま書き戻す。どちらも日付の比較だけで決まるので、
    モデルの判断も検索も要らない（設計書 第9.1.5節と同じ考え方）。

    これで打ち切りは全損ではなく「新規の収穫が少ない週」に縮む。空回りを
    成功と誤認する穴は開かない——`diff_data.py` の「収穫が0件なら落ちる」検査は
    そのまま残るので、**何も調べずに前回分を書き戻しただけの回は依然として落ちる。**
    """
    today = args.today if args.today else date.today()

    # **今回 `--init` していないデータセットには手を出さない。**
    #
    # claude-routine.sh は3データセットとも回すが、収集するのは曜日ごとに1つである。
    # 触っていないCSVに対してこれを走らせると、前回の実行が正当に落とした行
    # （処分記録が別の世代に回った後の行など）を掘り返して、その日の収集とは
    # 無関係な差分をコミットに混ぜうる。`diff_data.py` の noop 検査が
    # 「`--init` を今日実行したデータセット」だけを見るのと同じ理由で、
    # 対象をその日の収集に閉じる。
    #
    # 前日も許すのは diff_data.py と同じ理由（実行の上限は6時間で、日をまたぐ）。
    taken = prev_taken_at(name)
    if not args.force and taken not in (today, today - timedelta(days=1)):
        print(f"# {name}: 今回の実行で --init していないので何もしません"
              f"（前回スナップショットの取得日 {taken or '不明'}）。"
              "意図して動かすなら --force", file=sys.stderr)
        return 0

    current = _current_uids(name)
    disposed = load_dispositions(name)
    lineups = _live_lineup_ids()

    carried, expired = [], []
    for r in rows:
        u = row_uid(name, r)
        if u in current or u in disposed:
            continue           # 今回書き直された／既に理由が記録されている
        (expired if is_ended(name, r, today) else carried).append((u, r))

    if expired:
        os.makedirs(PREV, exist_ok=True)
        with open(disposition_path(name), "a", encoding="utf-8") as f:
            for u, r in expired:
                _, end = last_date(name, r)
                f.write(json.dumps({
                    "uid": u, "status": "expired", "title": r.get("title", ""),
                    "note": CARRY_REST_EXPIRED_NOTE_FMT.format(end=end or "不明"),
                }, ensure_ascii=False) + "\n")

    records = [_build_carry_obj(r, lineups) for u, r in carried]

    # 書き戻した uid を残す。翌週の `--worklist` がこれを読んで tier A に上げる。
    # `--apply` を付けない下見でも書くのは、下見と本番で記録がずれないようにするため
    # （どちらも「今回どれが未確認で残ったか」という同じ事実を表している）。
    # 空で上書きしない・既存分（`--dispose notfound` が書いた分を含む）と
    # 合流させる理由は `unverified_path` の docstring を参照。
    _record_unverified(name, [(u, r.get("title", "")) for u, r in carried])

    print(f"# {name}: 書き戻し {len(records)}件 / 終了済み {len(expired)}件を expired で処分",
          file=sys.stderr)

    if not args.apply:
        for obj in records:
            print(json.dumps(obj, ensure_ascii=False))
        return 0

    if not records:
        return 0
    # 追記は append_rows.py に通す。id の採番・固定列の持ち越し・列挙値の検証・
    # 名簿の収穫記録は、あちらに1か所だけ置いてある規則である。ここで書き込みを
    # 真似ると、その規則が2か所に分かれる。
    payload = "".join(json.dumps(o, ensure_ascii=False) + "\n" for o in records)
    proc = subprocess.run(
        [sys.executable, os.path.join(ROOT, "tools", "append_rows.py"), args.dataset],
        input=payload, text=True, cwd=ROOT,
    )
    return proc.returncode


# ---------------------------------------------------------------- 処分の記録

def disposition_path(name):
    return os.path.join(PREV, name.replace(".csv", ".dispositions.jsonl"))


def carried_path(name):
    """CSVから消えたままになっている `expired` 行の置き場。

    ## なぜ「消えている間ずっと」残すのか

    `expired` は「終了日を過ぎたことを `purge_ended.py` が機械的に検出した
    （未確認）」という印であり、**会期延長を見落とした行**を含みうる——延長に
    気づかなければ古い終了日が残り、その日を過ぎた時点で機械的に消えるので、
    まだ開催中の催しが「終了日を過ぎた」という理由だけで一覧から落ちる。

    以前はここを1世代（先週分）だけ残していたが、2週続けて再確認が間に合わ
    なかった行は3週目の一覧から消えてしまい、確認できないまま忘れられていた。
    いまは `take_snapshot()` が、**その uid がまだ今回のCSVに戻っていない限り**
    世代をまたいで引き継ぐ——何週かかっても、実際に確認できて `ended`/
    `cancelled` として個別処分されるか、会期延長が確認されて行がCSVに
    戻るまで、この一覧に出続ける。

    `notfound` はここに含めない。`cmd_dispose` が notfound を前回値のまま
    自動で書き戻すようになったため（行は削除されない）、notfound の uid は
    常に今回のCSVに存在し、`take_snapshot()` の引き継ぎ条件（まだ戻って
    いない）を満たさない。

    ## 呼び出し順序に依存する

    このファイルへの反映は `take_snapshot()`（＝ `append_rows.py --init`）の
    中で行う。`--worklist`（`print_carried()`）を**先に**呼ぶと、まだ今回の
    `--init` が起きていないので、ここにあるのは「前回の実行時点」のままになる
    ——各SKILL.mdの実行手順は、この理由で `--init` を `--worklist` より先に置いている。
    """
    return os.path.join(PREV, name.replace(".csv", ".carried.jsonl"))


def load_carried(name):
    """まだCSVに戻っていない `expired` 行を返す（何世代でも引き継がれる）。"""
    path = carried_path(name)
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("status") == "expired":
                out.append(obj)
    return out


def _reject_premature_ended(name, uid_, row, today, i):
    """`ended` は `is_ended()` が真になる行（＝ end_date が実行日より前の行）にしか使えない。

    会期の途中（今日を含む・本日が予備日）や未来の行を ended にするのは、
    情報源を確認したのではなく日付を見誤った可能性が高い（2026-08-29 の
    事故そのもの）。日付を1つも持たない行（自由記述の date だけの行）は
    機械的に判定できないので、ここでは拒否しない——`is_ended()` の判定規則を
    そのまま使うことで、`purge_ended.py`・`--worklist`・`--carry-rest` と
    「終了とは何か」の定義がずれない。
    """
    _, end = last_date(name, row)
    if not end:
        return
    if is_ended(name, row, today):
        return
    raise SystemExit(
        f"ERROR: {i}行目 uid={uid_!r} を ended にできません。"
        f"end_date（またはdatesの最終日、あるいは本日がbackup_dateであること）から見て、"
        f"実行日 {today.isoformat()} 時点でまだ終了していません（end_date={end!r}）。"
        "会期中・開催前・予備日当日の行を ended にしないこと——本当に終了を確認できたなら"
        "日付側の登録ミスを疑い、確認できないなら notfound を使ってください。"
    )


def _warn_similar_notes(records):
    """同じ status の理由文が定型文で埋まっていないかの目安を出す（ブロックしない）。

    `DISPOSE_RISKY_STATUSES`（件数の上限）とは別の対象範囲を持つ。`notfound` は
    行を削除しなくなったので件数の上限からは外したが、「個別確認せず定型文で
    済ませていないか」という目安としての価値はそのまま残る——むしろ `notfound`
    こそ「調べたが分からなかった」を装った手抜きが起きやすい。
    """
    by_status = defaultdict(list)
    for r in records:
        if r.get("status") in NOTE_SCRUTINY_STATUSES:
            by_status[r["status"]].append((r.get("note") or "").strip())
    for st, notes in by_status.items():
        notes = [n for n in notes if n]
        pairs = [(a, b) for i, a in enumerate(notes) for b in notes[i + 1:]]
        if len(notes) < 3 or not pairs:
            continue
        similar = sum(1 for a, b in pairs if difflib.SequenceMatcher(None, a, b).ratio() >= NOTE_SIMILARITY_WARN)
        if similar / len(pairs) >= 0.5:
            print(f"WARNING: status={st!r} の理由文が{len(notes)}件中で似たものが多いです"
                  f"（{similar}/{len(pairs)}組）。定型文で済ませず、行ごとに個別確認したか見直してください。",
                  file=sys.stderr)


def cmd_dispose(name, rows, args):
    known = {row_uid(name, r): r for r in rows}
    today = args.today if args.today else date.today()
    # 追記は append-only、読み出しは「同じ uid なら最後の行が勝つ」実装なので
    # （load_dispositions）、重複追記そのものはエラーにしない——訂正は
    # 正当な操作である。ただし今回の実行で3回書き換えた実例（renamed →
    # notfound → renamed）のように、無警告だと矛盾した履歴が黙って積み上がる。
    # 気づけるように、上書きだけは知らせる。
    existing = load_dispositions(name)
    raw = sys.stdin.read()
    recs, seen_in_batch = [], {}
    for i, line in enumerate((l for l in raw.splitlines() if l.strip()), start=1):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            raise SystemExit(f"ERROR: {i}行目のJSONを解析できません: {e}")
        uid_ = (obj.get("uid") or "").strip()
        st = (obj.get("status") or "").strip()
        if uid_ not in known:
            raise SystemExit(f"ERROR: {i}行目の uid {uid_!r} は前回データにありません")
        if st not in DISPOSITIONS:
            raise SystemExit(
                f"ERROR: {i}行目の status {st!r} は未定義です。"
                f"使えるのは: {', '.join(DISPOSITIONS)}"
            )
        if st == "renamed" and not (obj.get("to") or "").strip():
            raise SystemExit(f"ERROR: {i}行目 renamed には to（新しいuid）が要ります")
        if st == "ended":
            _reject_premature_ended(name, uid_, known[uid_], today, i)
        prior = seen_in_batch.get(uid_) or existing.get(uid_)
        if prior and prior.get("status") != st:
            print(f"WARNING: uid {uid_!r} は既に {prior['status']!r} として処分済みでした"
                  f"（→ {st!r} で上書き）", file=sys.stderr)
        obj["title"] = known[uid_].get("title", "")
        seen_in_batch[uid_] = obj
        recs.append(obj)

    risky = [r for r in recs if r.get("status") in DISPOSE_RISKY_STATUSES]
    if len(risky) > DISPOSE_BATCH_LIMIT:
        raise SystemExit(
            f"ERROR: 1回の --dispose で ended を{len(risky)}件まとめて処分しようとしています"
            f"（上限{DISPOSE_BATCH_LIMIT}件）。ended は行ごとに個別確認したことが前提の処分です。"
            f"{DISPOSE_BATCH_LIMIT}件を超える塊は、複数回に分けて個別に確認してください。"
            "確認できていない行は notfound を使ってください"
            "（行は削除されず前回値のまま持ち越されるので、件数の上限はありません）。"
        )
    _warn_similar_notes(recs)

    os.makedirs(PREV, exist_ok=True)
    with open(disposition_path(name), "a", encoding="utf-8") as f:
        for obj in recs:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    print(f"{len(recs)}件の処分を記録しました → {os.path.relpath(disposition_path(name), ROOT)}")

    # notfound は「消滅」ではない。前回値のまま自動で書き戻す
    # （DISPOSITIONS["notfound"] の説明・`docs/COLLECTION-PROTOCOL.md` 第5節参照）。
    notfound = [r for r in recs if r.get("status") == "notfound"]
    if notfound:
        lineups = _live_lineup_ids()
        carry_objs = [_build_carry_obj(known[r["uid"]], lineups) for r in notfound]
        payload = "".join(json.dumps(o, ensure_ascii=False) + "\n" for o in carry_objs)
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "tools", "append_rows.py"), args.dataset],
            input=payload, text=True, cwd=ROOT,
        )
        if proc.returncode != 0:
            raise SystemExit(
                f"ERROR: notfound {len(notfound)}件の書き戻しに失敗しました"
                f"（append_rows.py が exit {proc.returncode}）。上の出力を確認してください。"
            )
        _record_unverified(name, [(r["uid"], known[r["uid"]].get("title", "")) for r in notfound])
        print(f"  うち notfound {len(notfound)}件は前回値のまま書き戻しました"
              "（受付欄は空。来週 tier A で再確認）", file=sys.stderr)
    return 0


def load_dispositions(name):
    path = disposition_path(name)
    if not os.path.exists(path):
        return {}
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                obj = json.loads(line)
                out[obj["uid"]] = obj
    return out


# ---------------------------------------------------------------- entry


def _parse_today(s):
    """`--today` の検証。argparse の `type=` に渡すと、壊れた値は
    トレースバックではなく argparse 自身の使用法メッセージで弾かれる。"""
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"YYYY-MM-DD 形式で指定してください: {s!r}")

def main():
    p = argparse.ArgumentParser(description="前回の収集結果を圧縮して参照する")
    p.add_argument("dataset", help="events / lives / movies")
    p.add_argument("--worklist", action="store_true", help="棚卸し用の圧縮一覧を出す")
    p.add_argument("--summary", action="store_true",
                   help="worklist を、行の代わりに都県ごとの件数で出す"
                        "（親が担当を割り振るときに使う。最優先の行は従来どおり出る）")
    p.add_argument("--tier", help="worklist を tier で絞る（例: A / AB）")
    p.add_argument("--pref", action="append",
                   help="worklist をこの pref に絞る（複数可）。都県ごとにサブエージェントへ"
                        "渡す担当分だけを切り出すのに使う")
    # `action="extend"` + `nargs="+"` で、`--uid a --uid b` と `--uid a b` の
    # **両方**を受ける。以前は前者だけだったため、2026-08-27 の実行では
    # `--uid a b c` が7回弾かれ、そのたびに usage が出力され、`--help` を
    # 3回読み直している。数十件の uid をまとめて引くのはこの道具の主用途なので、
    # 素直に書ける形を通らなくしておく理由が無い。
    p.add_argument("--uid", action="extend", nargs="+",
                   help="この uid の行を全列で出す（複数可。空白区切りでも --uid の繰り返しでも可）")
    p.add_argument("--venue", action="extend", nargs="+",
                   help="この会場の行を全列で出す（複数可。部分一致・表記ゆれを吸収する）")
    p.add_argument("--dispose", action="store_true", help="消えた行の理由を標準入力(JSONL)から記録する")
    p.add_argument("--carry-rest", action="store_true", dest="carry_rest",
                   help="前回あって今回まだ書かれていない行を機械的に片付ける"
                        "（終了日を過ぎていれば expired で処分、そうでなければ前回値で書き戻す）")
    p.add_argument("--force", action="store_true",
                   help="--carry-rest を、今回 --init していないデータセットにも適用する")
    p.add_argument("--apply", action="store_true",
                   help="--carry-rest の結果を append_rows.py に通して実際に書き込む"
                        "（既定は JSONL を標準出力に出すだけ）")
    p.add_argument("--stats", action="store_true", help="件数だけ出す")
    p.add_argument("--today", type=_parse_today, help="基準日 YYYY-MM-DD（試験用。既定は今日）")
    args = p.parse_args()

    name = resolve_dataset(args.dataset)
    rows, source = load_prev(name)
    if not rows:
        print(f"# 前回データがありません（{name}）。初回実行として扱ってください。")
        return 0
    print(f"# 出典: {source}", file=sys.stderr)

    if args.dispose:
        return cmd_dispose(name, rows, args)
    if args.carry_rest:
        return cmd_carry_rest(name, rows, args)
    if args.uid or args.venue:
        return cmd_show(name, rows, args)
    if args.stats:
        print(f"{name}: {len(rows)}行")
        return 0
    cmd_worklist(name, rows, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
