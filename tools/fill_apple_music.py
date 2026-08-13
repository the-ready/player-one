#!/usr/bin/env python3
"""`data/lineups.csv` の `apple_music_url` を iTunes Search API から一括で埋める。

## なぜモデルではなく機械がやるのか

「アーティスト名 → Apple Music のアーティストページURL」は**判断を要さない写像**で、
名前を渡してAPIの答えを受け取るだけの決定論的な処理である。これをモデルの任意工程に
すると、検索予算の都合で真っ先に省かれる——実際、日割り側は「時間の許す範囲でよい」と
書かれていたために全行が空欄のまま定着した。**機械にできることを人の裁量に残さない**
というのが、このリポジトリで名簿・差分・robots判定に一貫して採ってきた方針で、
これはその適用である（`docs/COLLECTION-PROTOCOL.md` 1.3節、`docs/DESIGN.md` 第12.11節）。

空欄でも表示は壊れない（表示側が名前から検索URLを組み立てる）。ただし**その検索URLは
iOSのApple Musicアプリでは検索が実行されない**（アプリに `/search` のルートが無い。
第12.11節）ので、埋まっている行が多いほど、iPhoneでの体験が素直になる。

## 埋めない、という判断を必ず残す

このAPIは名前の曖昧一致で候補を返す。`HANA` や `yama` のように**実在の別アーティストが
同名で複数いる**ケースがあり、ここで1件を選ぶと「出演しないアーティストのページ」に
リンクすることになる。したがって**候補が1件に絞れないときは空欄のままにする。**
リンクが無いことより、間違ったリンクがあることのほうが悪い（第7.2.3節と同じ判断）。

## 日本語名の照合

APIは `artistName` を**ローマ字に変換して返す**ことがある（`大森靖子` → `Seiko Oomori`）。
一方で `artistLinkUrl` のスラッグは原名を保つ（`/artist/%E5%A4%A7%E6%A3%AE%E9%9D%96%E5%AD%90/`）。
そこで**名前とスラッグの両方**で照合する。これをしないと日本語名の大半を取りこぼす。

## キャッシュ

`lineups.csv` は毎週 `--init` で空にされ、`append_lineup.py` に持ち越しの仕組みが無い。
キャッシュが無いと毎週数百件を引き直すことになるので、結果を `data/apple-music.json` に
残して**コミットする**。2週目以降にAPIを叩くのは、新しく出てきた名前だけになる。

引けなかった名前も記録する（理由つき）。ただし**アーティストは後から配信を始める**ので、
`--retry-misses` で空欄だったものだけを引き直せるようにしてある。

## 使い方

    python3 tools/fill_apple_music.py              # 未取得の名前だけ引いて書き込む
    python3 tools/fill_apple_music.py --dry-run    # 書き込まずに結果だけ見る
    python3 tools/fill_apple_music.py --retry-misses   # 空欄だった名前を引き直す
    python3 tools/fill_apple_music.py --limit 50   # 途中で切り上げる（予算の都合）

終了コードは常に0（引けない名前があることは失敗ではない）。ネットワークに届かない
場合だけ、その旨を出して0で終わる——**空欄は正常な状態**であり、収集全体を止める
理由にはならない。
"""

import argparse
import csv
import datetime
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_gate                                             # noqa: E402
from validate_data import EXPECTED_HEADERS                    # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
LINEUPS = os.path.join(DATA, "lineups.csv")
CACHE = os.path.join(DATA, "apple-music.json")

ENDPOINT = "https://itunes.apple.com/search"

# 連絡先を名乗る。相手が問い合わせ先を辿れない自動アクセスはしない。
UA = "player-one/1.0 (+https://github.com/the-ready/player-one)"

TIMEOUT = 20


# ============================================================
# 名前の正規化と照合
# ============================================================

# 「(Acoustic set)」「（弾き語り）」のような**公演の形態を示す補足**。
# アーティスト名の一部ではないので、APIに渡す前に落とす。
PAREN = re.compile(r"[（(][^（()）]*[)）]\s*$")


def clean(name):
    return PAREN.sub("", name).strip()


def nfkc(s):
    """全角/半角と合成文字の揺れを吸収する（`ＴＵＢＥ` と `TUBE` を同じに見る）。"""
    return unicodedata.normalize("NFKC", s).strip()


def fold(s):
    """大小文字だけを無視した形。空白と記号は残す。

    収集は公式サイトの見出しをそのまま写すため、原名が小文字でも**大文字で
    記録されることがある**（`keshi` → `KESHI`）。そこだけを吸収したいので、
    空白と記号は残す——`BIGMAMA` と `Big mama` は別のアーティストで、
    ここまで潰すと取り違える。
    """
    return nfkc(s).casefold()


def loose(s):
    """記号だけを落とした形。**語の切れ目（空白）は残す。**

    `Chilli Beans.` と `Chilli Beans`、`ano` と `ano.` を同じに見たいだけなので、
    落とすのは記号に限る。空白まで潰すと `BIGMAMA` と `Big mama` が一致してしまい、
    **別のアーティストを1件だけ返された場面で、それを確定として書き込む**ことになる。
    """
    kept = "".join(c if c.isalnum() else " " for c in nfkc(s).casefold())
    return " ".join(kept.split())


def slug_name(url):
    """`artistLinkUrl` のスラッグを名前として読む（APIがローマ字化しても原名が残る）。"""
    m = re.search(r"/artist/([^/]+)/", url or "")
    if not m:
        return ""
    return urllib.parse.unquote(m.group(1)).replace("-", " ")


def pick(name, results):
    """候補を1件に絞る。絞れなければ (None, 理由) を返す。

    厳密（大小文字を区別）→ 大小文字だけ無視 → 記号も無視、の順に試し、
    **1件に絞れた最初の段で確定する**。いきなり最後の段まで緩めると、
    `TUBE` と `Tube`、`BIGMAMA` と `Big mama` のような別アーティストを取り違える。
    """
    for norm, why_many in (
        (nfkc, "同名の候補が{}件（別アーティストの可能性）"),
        (fold, "大小文字を無視すると候補が{}件"),
        (loose, "表記ゆれを吸収しても候補が{}件"),
    ):
        target = norm(name)
        if not target:
            continue
        cand = [r for r in results
                if norm(r.get("artistName", "")) == target
                or norm(slug_name(r.get("artistLinkUrl", ""))) == target]
        if len(cand) == 1:
            return cand[0], ""
        if len(cand) > 1:
            return None, why_many.format(len(cand))
    return None, "候補なし（Apple Music に登録が無い可能性）"


def artist_url(result):
    """書き込んでよい形のURLだけを返す。形が違えば空文字。"""
    url = (result.get("artistLinkUrl") or "").split("?")[0]     # `?uo=4` 等を落とす
    if url.startswith("https://music.apple.com/") and "/artist/" in url:
        return url
    return ""


# ============================================================
# API
# ============================================================


def lookup(name):
    """1件引く。戻り値は (URL, 理由)。URLが空なら理由が入る。"""
    q = urllib.parse.urlencode(
        {"term": clean(name), "entity": "musicArtist", "country": "jp", "limit": 8})
    url = f"{ENDPOINT}?{q}"

    # 可否の判定と間隔の消化を、収集本体と同じ門に通す。
    # ここが拒否に転じたら（例外の取り消し・取下げ申請）このツールは黙って止まる。
    d = fetch_gate.gate(url)
    if not d["ok"]:
        raise PermissionError(d["reason"])

    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        payload = json.load(r)

    hit, why = pick(clean(name), payload.get("results", []))
    if not hit:
        return "", why
    got = artist_url(hit)
    return (got, "") if got else ("", "URLの形が想定と違う")


# ============================================================
# キャッシュ
# ============================================================


def load_cache():
    try:
        with open(CACHE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"_comment": "", "artists": {}}


def save_cache(cache):
    cache["_comment"] = (
        "アーティスト名 → Apple Music アーティストページURL。"
        "tools/fill_apple_music.py が iTunes Search API から作る。"
        "lineups.csv は毎週作り直されるため、ここに残して引き直しを避ける。"
        "url が空の行は「引けなかった」記録で、--retry-misses で引き直せる。"
    )
    tmp = CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, CACHE)


# ============================================================
# 本体
# ============================================================


def read_rows():
    with open(LINEUPS, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_rows(rows):
    headers = EXPECTED_HEADERS["lineups.csv"]
    tmp = LINEUPS + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        # 改行は `csv` の既定（CRLF）のまま。`append_lineup.py` と揃えないと、
        # **1行も内容が変わっていない行まで差分に出て**、週次の差分レビューが潰れる。
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for r in rows:
            w.writerow({h: r.get(h, "") for h in headers})
    os.replace(tmp, LINEUPS)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="書き込まない")
    ap.add_argument("--retry-misses", action="store_true",
                    help="前回引けなかった名前も引き直す")
    ap.add_argument("--limit", type=int, default=0,
                    help="APIを叩く回数の上限（0で無制限）")
    args = ap.parse_args()

    if not os.path.exists(LINEUPS):
        print("data/lineups.csv がありません。先に append_lineup.py で書き出すこと。")
        return 0

    rows = read_rows()
    cache = load_cache()
    known = cache.setdefault("artists", {})
    today = datetime.date.today().isoformat()

    # 埋める必要のある名前だけを、CSVの出現順に並べる（並び順は公式の序列なので、
    # 予算で打ち切るときも「上から」が自然に主要アーティスト優先になる）。
    todo, seen = [], set()
    for r in rows:
        name = (r.get("artist") or "").strip()
        if not name or name in seen or (r.get("apple_music_url") or "").strip():
            continue
        seen.add(name)
        hit = known.get(name)
        if hit and (hit.get("url") or not args.retry_misses):
            continue
        todo.append(name)

    if args.limit:
        todo = todo[:args.limit]

    print(f"対象 {len(todo)} 名（キャッシュ済み {len(known)} 名）")

    added = 0
    for i, name in enumerate(todo, 1):
        try:
            url, why = lookup(name)
        except PermissionError as e:
            print(f"\n取得が許可されていません: {e}")
            print("6.5.7 の例外か no-crawl.json を確認すること。ここで中断します。")
            break
        except KeyboardInterrupt:
            print("\n中断しました。ここまでの結果は保存されます。")
            break
        except (urllib.error.URLError, OSError, ValueError) as e:
            print(f"\nAPIに届きません（{e}）。ここまでの結果を保存して終了します。")
            print("**空欄は正常な状態**なので、収集全体を止める必要はありません。")
            break
        known[name] = {"url": url, "checked": today}
        if not url:
            known[name]["why"] = why
        else:
            added += 1
        print(f"  [{i}/{len(todo)}] {'OK' if url else '--'} {name}"
              f"{'' if url else '  ← ' + why}", flush=True)
        # 数百件を3秒間隔で回すと十数分かかる。**途中で止まっても引き直しに
        # ならない**よう、こまめに書き出す（キャッシュの目的がまさにそれである）。
        # `--dry-run` でも保存する——叩いてしまったAPIの結果を捨てるほうが無駄で、
        # かつ破壊的なのはCSVへの書き込みのほうだけである。
        if i % 10 == 0:
            save_cache(cache)

    # CSVへ反映する。キャッシュに載っている名前はすべて対象（今回引いた分に限らない）。
    filled = 0
    for r in rows:
        if (r.get("apple_music_url") or "").strip():
            continue
        hit = known.get((r.get("artist") or "").strip())
        if hit and hit.get("url"):
            r["apple_music_url"] = hit["url"]
            filled += 1

    save_cache(cache)                       # dry-run でも引けた結果は捨てない

    if args.dry_run:
        print(f"\n[dry-run] {filled} 行が埋まります（新規に引けた名前 {added}）")
        print("CSVは書き換えていません（キャッシュには保存済み）。")
        return 0

    if filled:
        write_rows(rows)
    total = sum(1 for r in rows if (r.get("apple_music_url") or "").strip())
    print(f"\n{filled} 行を追加 → {total}/{len(rows)} 行が埋まりました"
          f"（新規に引けた名前 {added}）")
    print("空欄の行は表示側が検索URLを組み立てるので、表示は壊れません。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
