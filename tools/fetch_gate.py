#!/usr/bin/env python3
"""ページを取得してよいかを**URLごとに**判定し、必要なだけ待ってから通す門。

## なぜサイト単位の確認では足りないのか

`tools/check_robots.py` は `data/sources.json` の名簿サイトについて、
**トップページ（`/`）**が取得可能かを見る。着手前の全体確認としては要るが、
これだけでは2つの穴が残る。

  1. **実際に開くのは深いページである。** `Disallow: /search`、`Disallow: /api/`、
     `Disallow: /*?sort=` のように、サイトはトップを開放したまま特定のパスだけを
     閉じている。トップが「OK」でも、そのページが Allow されているとは限らない
  2. **名簿のURLが対象外だった。** 収集が直接開くのは `spots.csv` /
     `theaters.csv` / `venues.csv` / `festivals.csv` に入っている
     会場・劇場の公式サイトで、これらは `sources.json` に載っていない。
     つまり**実際の取得先の大半が、これまで一度も robots.txt を見られていなかった**

このスクリプトは、**取得する直前にそのURLそのものを判定する**。

## なぜ「待つ」のがここにあるのか

`crawl-delay` は、これまで表示するだけで守られていなかった。表示された数字を
モデルが数えて自分で待つ、という運用は成立しない——待ったかどうかを誰も確認できず、
急いでいるときに最初に省かれる。**待つ処理をコードの中に置けば、通った時点で
待ち終わっている。**

間隔は次の3つの大きいほうを採る。

  - robots.txt の `Crawl-delay`（`Claude-User` / `Claude-SearchBot` の長いほう）
  - robots.txt の `Request-rate` から出した1回あたりの秒数
  - `MIN_INTERVAL`（既定3秒）—— robots.txt が何も言っていないサイトへの下限。
    週次バッチが同じホストへ連続で当たるときに、間を空けずに叩かないためのもの

## 使い方

    python3 tools/fetch_gate.py <URL>            # 判定して、待って、通す（取得の直前）
    python3 tools/fetch_gate.py --check <URL>... # 判定だけ（待たない・記録しない）
    python3 tools/fetch_gate.py --roster spots   # 名簿のURLを一括で事前判定
    python3 tools/fetch_gate.py --hook           # PreToolUse フック用（stdin から受ける）

終了コードは 0（取得してよい）/ 1（取得してはいけない）。`--hook` のときだけ、
Claude Code のフックの約束に合わせて**ブロックを 2** で返す。

## フックとして自動で挟まる

`.claude/settings.json` の `PreToolUse` に登録してあるので、収集タスクが
`WebFetch` を呼ぶたびに、このスクリプトが先に走る。拒否されているURLは
モデルの判断を待たずにブロックされ、許可されているURLは待ち時間を消化してから通る。

**散文のお願いは、安い経路の前では負ける**（`docs/DESIGN.md` 第7.1節が画像の件で
実証している）。だから守らせたい規則は仕組みに置く、というのがこのリポジトリの
一貫した方針で、これはその適用である。
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import robots_rules as rr                                    # noqa: E402

ROOT = rr.ROOT
STATE = os.path.join(rr.CACHE_DIR, "_access.json")

# robots.txt が何も言っていないホストへの最低間隔（秒）。
MIN_INTERVAL = float(os.environ.get("FETCH_GATE_MIN_INTERVAL", "3"))

# 1回のゲートで待つ上限（秒）。
#
# **この値は、`.claude/settings.json` の PreToolUse フックの `timeout`（180秒）より
# 必ず小さく保つこと。** フックが時間切れで打ち切られると、それは「ブロック」
# （終了コード2）ではなく単なるエラー扱いになり、**待たないまま WebFetch が通る**。
# 守るための仕組みが、守らない方向に壊れる。上限を上げるときは両方を上げる。
#
# 150秒にしてあるのは、実在する最も長い部類の指定（rockin'on.com の
# `Crawl-delay: 120`）を**実際に待ちきる**ため。相手が2分空けろと言うなら2分空ける、
# というのがこの仕組みの筋であって、待てないから諦めるのでは本末転倒になる。
# これを超える指定（150秒より長い間隔）のホストだけは、待って居座るより
# 後回しにするほうが筋が通るのでブロックする。
MAX_WAIT = float(os.environ.get("FETCH_GATE_MAX_WAIT", "150"))

ROSTERS = {
    "spots": "data/spots.csv",
    "venues": "data/venues.csv",
    "theaters": "data/theaters.csv",
    "festivals": "data/festivals.csv",
}

# ============================================================
# 文書化された公開APIの例外（`docs/COLLECTION-PROTOCOL.md` 6.5.7）
# ============================================================
#
# APIのパスに `Disallow` を置くのは、クローラをAPI面に迷い込ませないための定型で
# あって、「このAPIを使うな」という意思表示ではない。根拠は3つあり、詳細と出典は
# `docs/COLLECTION-PROTOCOL.md` 6.5.7 にある。
#
#   1. RFC 9309 がクローラを「リンクを再帰的に辿ってインデックスする自動クライアント」
#      と定義し、"These rules are not a form of access authorization" と明記している
#   2. Google の解説も、主な用途を「リクエストの過剰を避けること」としている
#   3. MusicBrainz（`Disallow: /ws`）とウィキペディア（`Disallow: /w/`）は、
#      同じAPIの利用方法を公式に案内しながらそのパスを除外している
#
# 名前を1つ渡して1件引く呼び出しは、1の定義のクローリングに当たらない。
#
# 例外は**ホスト全体ではなくエンドポイント単位**で持つ。APIが開いていることは、
# 同じホストの通常ページを開いてよい理由にならないため。
#
# ここを通っても間隔（`MIN_INTERVAL` 以上）は消化される。iTunes Search API の
# 公称上限は約20回/分で、既定の3秒間隔はこれを下回る。
API_EXCEPTIONS = {
    "itunes.apple.com": ("/search",),
}


def documented_api(url):
    """文書化された公開APIのエンドポイントなら True。

    パスは**区切りまで見て**一致を取る。`startswith` だけだと `/searchanything` の
    ような別のパスまで巻き込み、「エンドポイント単位」と言いながらそうなっていない。
    """
    parts = urllib.parse.urlsplit(url)
    prefixes = API_EXCEPTIONS.get(parts.netloc.lower())
    if not prefixes:
        return False
    path = parts.path.rstrip("/")
    return any(path == p or path.startswith(p + "/") for p in prefixes)


# ============================================================
# 最終アクセス時刻の記録
# ============================================================


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    os.makedirs(rr.CACHE_DIR, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE)                      # 書き込み途中の状態を残さない


def wait_needed(host, crawl_delay, state):
    """このホストへ次に当たってよくなるまでの残り秒数を返す。"""
    interval = max(MIN_INTERVAL, crawl_delay or 0)
    last = state.get(host)
    if last is None:
        return 0.0, interval
    return max(0.0, interval - (time.time() - last)), interval


# ============================================================
# ゲート本体
# ============================================================


def gate(url, wait=True, use_cache=True):
    """1URLを判定し、必要なら待つ。戻り値は判定の辞書（`ok` が可否）。"""
    d = rr.decide(url, use_cache=use_cache)

    # 例外が覆すのは「`Disallow` に書いてある」という判定だけである。
    #
    #   - **取下げ申請（`no-crawl.json`）は覆さない**——申請は相手が明示した
    #     意思表示で、APIかどうかとは関係がない
    #   - **robots.txt が読めない（5xx）場合も覆さない**——6.5.7 の理屈は
    #     「`Disallow` の意図の読み方」であって、相手の意思が確認できない場面には
    #     何も言っていない。RFC 9309 の全面拒否の扱いをそのまま残す
    if (not d["allowed"]
            and d["robots_state"] not in ("optout", "forbidden")
            and documented_api(url)):
        d["allowed"] = True
        d["reason"] = "文書化された公開API（6.5.7の例外）"

    state = load_state()
    remain, interval = wait_needed(d["host"], d["crawl_delay"], state)

    d["interval"] = interval
    d["waited"] = 0.0
    d["ok"] = d["allowed"]

    if not d["allowed"]:
        return d

    if remain > MAX_WAIT:
        # 待ちすぎるくらいなら、そのホストは今回まわさない。
        d["ok"] = False
        d["reason"] = (
            f"このホストは次の取得まで {remain:.0f} 秒必要（上限 {MAX_WAIT:.0f} 秒）。"
            "先に別のホストを回ること"
        )
        return d

    if wait:
        if remain > 0:
            time.sleep(remain)
            d["waited"] = remain
        state[d["host"]] = time.time()
        save_state(state)
    return d


# ============================================================
# 出力
# ============================================================


def line(d, verbose=True):
    mark = "OK  " if d["ok"] else "拒否"
    s = f"{mark}  {d['url']}"
    if not d["ok"]:
        return s + f"\n      理由: {d['reason']}"
    if not verbose:
        return s
    extra = []
    if d.get("waited"):
        extra.append(f"{d['waited']:.1f}秒待機")
    if d.get("interval"):
        extra.append(f"間隔{d['interval']:.0f}秒")
    if d["robots_state"] != "ok":
        extra.append(d["reason"])
    for a, info in d.get("agents", {}).items():
        if info.get("matched_rule"):
            extra.append(f"{a}: {info['matched_rule']}")
    return s + (f"  [{' / '.join(extra)}]" if extra else "")


def roster_urls(name):
    path = os.path.join(ROOT, ROSTERS[name])
    out = []
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            url = (row.get("url") or "").strip()
            # 閉館・撤退した先は今後開かないので、判定しても意味がない。
            if url and row.get("status") != "retired":
                out.append(url)
    return out


def source_urls():
    with open(os.path.join(ROOT, "data", "sources.json"), encoding="utf-8") as f:
        data = json.load(f)
    return [e["url"] for tab, entries in data.items()
            if not tab.startswith("_") for e in entries]


# ============================================================
# フックモード
# ============================================================


def run_hook():
    """`PreToolUse` から呼ばれる。ブロックは終了コード2（Claude Code の約束）。"""
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0                                 # 読めない入力で収集を止めない
    url = (payload.get("tool_input") or {}).get("url")
    if not url or not urllib.parse.urlsplit(url).netloc:
        return 0

    d = gate(url)
    if d["ok"]:
        # 許可のときは黙って通す（待ちはこの中で消化済み）。
        return 0

    print(
        f"robots.txt により取得できません: {url}\n"
        f"  {d['reason']}\n"
        "  このURLは開かず、別の情報源を当たること。"
        "（判定は Claude-User / Claude-SearchBot の厳しいほう）",
        file=sys.stderr,
    )
    return 2


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("urls", nargs="*", help="判定するURL")
    ap.add_argument("--check", action="store_true",
                    help="判定だけ行う（待たない・記録しない）")
    ap.add_argument("--roster", choices=sorted(ROSTERS),
                    help="名簿のURLを一括で事前判定する")
    ap.add_argument("--sources", action="store_true",
                    help="data/sources.json のURLを一括で事前判定する")
    ap.add_argument("--hook", action="store_true", help="PreToolUse フック用")
    ap.add_argument("--json", action="store_true", dest="as_json", help="JSONで出す")
    ap.add_argument("--no-cache", action="store_true",
                    help="robots.txt のキャッシュを使わず取り直す")
    args = ap.parse_args()

    if args.hook:
        return run_hook()

    urls = list(args.urls)
    if args.roster:
        urls += roster_urls(args.roster)
    if args.sources:
        urls += source_urls()
    if not urls:
        ap.error("URL を指定するか --roster / --sources を使うこと")

    # 一括の事前判定は「開いてよいURLの一覧を作る」ためのもので、
    # ここでページを取得するわけではないから待つ必要がない。
    check_only = args.check or args.roster or args.sources

    results = []
    for u in urls:
        d = gate(u, wait=not check_only, use_cache=not args.no_cache)
        results.append(d)
        if not args.as_json:
            print(line(d, verbose=not check_only))

    if args.as_json:
        json.dump(results, sys.stdout, ensure_ascii=False, indent=2, default=str)
        print()
    elif len(results) > 1:
        ng = [r for r in results if not r["ok"]]
        print(f"\n合計 {len(results)}件 / 取得不可 {len(ng)}件")
        if ng:
            print("取得不可のURLは開かないこと。名簿のものは roster.py で retire するか、"
                  "会場の別ページ（Allow されているパス）を使う。")

    return 0 if all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
