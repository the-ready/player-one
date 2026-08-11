#!/usr/bin/env python3
"""robots.txt を読み、**URLごと**に取得の可否を判定する共有モジュール。

`tools/check_robots.py`（名簿サイトの一括確認）と `tools/fetch_gate.py`
（1URLごとの取得ゲート）の両方がここを使う。判定の実装を1か所に置くのは、
2つのツールが同じ robots.txt について違う答えを出す状態を作らないためである。

## なぜ標準ライブラリ（urllib.robotparser）に判定を任せないのか

**`urllib.robotparser` の判定規則は Python のバージョンによって変わるため。**
新しい実装は RFC 9309（2022年に標準化された robots.txt の仕様）どおり
**一致した中で最も長いパターン**を採り、`*`（任意の並び）と `$`（末尾の固定）も
解釈する。古い実装は**書かれた順に最初に一致したルール**を採り、`*` や `$` を
ただの文字として扱う。同じ robots.txt で答えが割れる。

    Disallow: /
    Allow: /event/

サイトが「ここだけは開放する」という意図で書いた Allow を、古い実装は読み落として
`/event/1` を拒否と判定する。逆に、

    Disallow: /*.pdf$

は古い実装では「`/*.pdf$` という名前のパスで始まるもの」になり、**何にも一致しない**
（＝素通ししてしまう）。

週次の収集は cron から動き、どの Python で走るかはこのリポジトリが決めていない。
**取得してよいかの判断が実行環境で変わるのは、robots.txt を守る仕組みとして成立
しない**ので、規則をここに固定する。実装が正しいことは `tools/robots_test.py` が
検証し、あわせて実行中の標準ライブラリとの一致も確認する（割れたらそれが、
この環境の標準ライブラリが古いという印になる）。

**「Allow されている範囲だけを見る」という運用は、Allow を正しく解釈できることが
前提**になる。だからここは、外部の挙動に委ねずに持っておく。

## 判定に使うUA —— なぜ Claude-User と Claude-SearchBot なのか

Anthropic が運用するクローラは役割が3つに分かれている（[出典][1]）。

  - `ClaudeBot` —— モデルの**学習データ収集**用。ユーザ操作を伴わないバッチ収集で、
    このタスクのような実行時のアクセスとは無関係
  - `Claude-User` —— **ユーザの指示に応じてリアルタイムに取得する**クローラ
  - `Claude-SearchBot` —— 検索結果の質を上げるための巡回

収集タスクが行っているのは後ろの2つに当たる性質のアクセスなので、この2つで判定し、
**どちらか一方でも拒否していれば取得しない**（`decide()`）。厳しい側に寄せるのは、
どちらの性質に当たるかをページ単位で言い分けられないためである。サイトが
`ClaudeBot` だけを拒否している場合は、それは学習利用の拒否であって、
このタスクの可否とは別の話になる。

[1]: https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
"""

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# robots.txt の取得結果を置く場所。robots.txt を毎回取りに行くこと自体が
# サイトへのアクセスなので、同じセッション中は使い回す。gitignore 済み。
CACHE_DIR = os.path.join(ROOT, "data", ".robots")

# 調査対象外の申請を受けたサイトの登録簿（人間が編集する。コミットする）。
NO_CRAWL = os.path.join(ROOT, "data", "no-crawl.json")

# キャッシュの寿命。週次バッチの1回の実行（数時間）を通して同じ内容を使い、
# 翌週は取り直す。24時間にしてあるのはその中間で、robots.txt の更新に
# 1日以上気づかないことがない範囲で、取得回数を最小にする値である。
CACHE_TTL_SEC = 24 * 60 * 60

# 収集は検索エンジンのクローラではないが、robots.txt を取りにいくときも
# 名乗る。連絡先を含めるのは OSM のタイル利用ポリシー等でも求められる作法。
DEFAULT_AGENT = (
    "EventBoardCollector/1.0 "
    "(+https://github.com/the-ready/player-one; weekly; respects robots.txt)"
)

# 実行時アクセスに対応する2つのUA（詳細はモジュール冒頭）。
AGENTS = ["Claude-User", "Claude-SearchBot"]

TIMEOUT = 15


# ============================================================
# パース
# ============================================================


class Group:
    """1つの User-agent 群（同じUAに適用される Allow/Disallow の集まり）。"""

    def __init__(self):
        self.agents = []
        self.rules = []          # [(allow: bool, pattern: str)]
        self.crawl_delay = None
        self.request_rate = None  # (requests, seconds)

    def __repr__(self):                                     # デバッグ用
        return f"<Group {self.agents} rules={len(self.rules)}>"


def parse(text):
    """robots.txt の本文を Group のリストにする。

    RFC 9309 の構造に従う。連続する User-agent 行は同じ群の見出しになり、
    Allow/Disallow が1行でも現れた後の User-agent 行は、次の群の始まりになる。
    """
    groups, current, expecting_agent = [], None, False

    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        field, _, value = line.partition(":")
        field, value = field.strip().lower(), value.strip()

        if field == "user-agent":
            # 直前も User-agent 行なら同じ群に相乗り（複数UAへの同一ルール）。
            if current is None or not expecting_agent:
                current = Group()
                groups.append(current)
            current.agents.append(value.lower())
            expecting_agent = True
            continue

        if current is None:
            # User-agent 行より前に書かれたルールは、どの群にも属さない。
            continue
        expecting_agent = False

        if field in ("allow", "disallow"):
            # 空の Disallow は「何も禁止しない」の意味なので、ルールにしない。
            if field == "disallow" and value == "":
                continue
            current.rules.append((field == "allow", value))
        elif field == "crawl-delay":
            try:
                current.crawl_delay = float(value)
            except ValueError:
                pass
        elif field == "request-rate":
            # 例: "1/10s"（10秒あたり1回）
            m = re.match(r"^\s*(\d+)\s*/\s*(\d+)\s*([smhd])?\s*$", value)
            if m:
                n, per = int(m.group(1)), int(m.group(2))
                per *= {"s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(3) or "s"]
                if n > 0:
                    current.request_rate = (n, per)

    return groups


def agent_token(agent):
    """UA 文字列から、robots.txt の照合に使う製品トークンを取り出す。

    robots.txt が書くのは `Claude-User` のような製品トークンであって、
    `EventBoardCollector/1.0 (+https://...)` のような完全なUA文字列ではない。
    バージョンや連絡先が付いたまま突き合わせると、名指しされていても一致しない。
    """
    return agent.split("/")[0].split()[0].strip().lower() if agent.strip() else ""


def select_group(groups, agent):
    """`agent` に適用される群を返す。個別指定があればそれ、無ければ `*`。

    戻り値は `(group, is_wildcard)`。どちらも無ければ `(None, False)`。
    """
    agent = agent_token(agent)
    for g in groups:
        if agent in g.agents:
            return g, False
    for g in groups:
        if "*" in g.agents:
            return g, True
    return None, False


def _to_regex(pattern):
    """robots.txt のパスパターンを正規表現にする（`*` と `$` に対応）。"""
    anchored = pattern.endswith("$")
    if anchored:
        pattern = pattern[:-1]
    out = "".join(".*" if ch == "*" else re.escape(ch) for ch in pattern)
    return re.compile("^" + out + ("$" if anchored else ""))


def _path_of(url):
    """判定に使うパス（クエリを含む）を取り出す。"""
    p = urllib.parse.urlsplit(url)
    path = p.path or "/"
    return path + (("?" + p.query) if p.query else "")


def match(groups, agent, url):
    """`agent` が `url` を取得してよいかを RFC 9309 の規則で判定する。

    一致した中で**最も長いパターン**を採用し、同じ長さなら Allow を優先する。
    どのルールにも一致しなければ許可（robots.txt は「禁止を書く」ものなので、
    書かれていないものは許可が既定である）。
    """
    group, is_wildcard = select_group(groups, agent)
    result = {
        "allowed": True,
        "matched_rule": None,
        "matched_section": None,
        "crawl_delay": None,
        "request_rate": None,
    }
    if group is None:
        return result

    result["matched_section"] = "ワイルドカード(*)" if is_wildcard else f"{agent} 個別指定"
    result["crawl_delay"] = group.crawl_delay
    result["request_rate"] = group.request_rate

    path = _path_of(url)
    best = None                                  # (長さ, allowか, ルール本文)
    for allow, pattern in group.rules:
        if not pattern.startswith("/") and not pattern.startswith("*"):
            continue                             # 相対パスは仕様外なので読まない
        if not _to_regex(pattern).match(path):
            continue
        # 長い方が勝ち。同点なら Allow を優先（RFC 9309）。
        key = (len(pattern), 1 if allow else 0)
        if best is None or key > best[0]:
            best = (key, allow, f"{'Allow' if allow else 'Disallow'}: {pattern}")

    if best is not None:
        result["allowed"] = best[1]
        result["matched_rule"] = best[2]
    return result


# ============================================================
# 取得（キャッシュつき）
# ============================================================


def robots_url(url):
    p = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((p.scheme or "https", p.netloc, "/robots.txt", "", ""))


def _cache_path(host):
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", host)
    return os.path.join(CACHE_DIR, safe + ".txt")


def fetch_robots(url, agent=DEFAULT_AGENT, use_cache=True):
    """robots.txt を取得する。結果は `(state, text)`。

    state は次のいずれか。

      ok        … 取得できた（text が本文）
      none      … robots.txt が無い（4xx）。拒否の意思表示は無いものとして扱う
      forbidden … 5xx で読めない。RFC 9309 は「全面的に拒否とみなす」と定めるので、
                  こちらもそう扱う（読めないものを都合よく解釈しない）
      unknown   … ネットワークの都合で取得できなかった
    """
    host = urllib.parse.urlsplit(url).netloc
    cache = _cache_path(host)

    if use_cache and os.path.exists(cache):
        age = time.time() - os.path.getmtime(cache)
        if age < CACHE_TTL_SEC:
            with open(cache, encoding="utf-8") as f:
                head, _, body = f.read().partition("\n")
            return head.strip(), body

    ru = robots_url(url)
    try:
        req = urllib.request.Request(ru, headers={"User-Agent": agent})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            charset = res.headers.get_content_charset() or "utf-8"
            state, text = "ok", res.read().decode(charset, errors="replace")
    except urllib.error.HTTPError as e:
        state, text = ("none", "") if 400 <= e.code < 500 else ("forbidden", "")
    except Exception as e:                       # noqa: BLE001 — 何で落ちても続行する
        return "unknown", f"{type(e).__name__}: {e}"

    if use_cache:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(cache, "w", encoding="utf-8") as f:
            f.write(state + "\n" + text)
    return state, text


# ============================================================
# 判定（2つのUAをまとめて見る）
# ============================================================


def _host_matches(host, entry):
    target = (entry.get("host") or "").lower().lstrip(".")
    host = host.lower().split(":")[0]
    for h in (host, host[4:] if host.startswith("www.") else host):
        if h == target:
            return True
        if entry.get("include_subdomains") and h.endswith("." + target):
            return True
    return False


def optout_match(url):
    """`data/no-crawl.json` に登録された調査対象外の申請に当たるかを返す。

    **robots.txt より先に見る。** robots.txt は機械可読な意思表示だが、
    それが唯一の意思表示ではない——「robots.txt には書いていないが、メールで
    やめてほしいと言われた」場合、こちらのほうが強い拒否である。`terms.html`
    第6節で受け付けると書いている申請は、実体としてはこのファイルに載る。
    """
    try:
        with open(NO_CRAWL, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None                              # 登録簿が無くても収集は止めない

    p = urllib.parse.urlsplit(url)
    path = p.path or "/"
    for e in data.get("entries", []):
        if not _host_matches(p.netloc, e):
            continue
        paths = e.get("paths") or ["/"]
        if any(path.startswith(pp) for pp in paths):
            return e
    return None


def decide(url, agent=DEFAULT_AGENT, use_cache=True):
    """URL 1本について、取得してよいかを判定する。

    まず `data/no-crawl.json`（申請による対象外）を見て、次に robots.txt を見る。
    robots.txt は `Claude-User` と `Claude-SearchBot` の**両方が許可している
    ときだけ** allowed。間隔の計算に使う `crawl_delay` は、2つのうち**長いほう**を採る。
    """
    out = {
        "url": url,
        "host": urllib.parse.urlsplit(url).netloc,
        "robots_state": "",
        "allowed": True,
        "reason": "",
        "agents": {},
        "crawl_delay": None,
        "optout": None,
    }

    # 申請による対象外は、robots.txt を取りに行くより前に断る
    # （断ると決まっている相手のサーバへ、確認のためのアクセスもしない）。
    hit = optout_match(url)
    if hit:
        out["allowed"] = False
        out["optout"] = hit
        out["robots_state"] = "optout"
        out["reason"] = (
            f"調査対象外の申請（{hit.get('requested_on', '日付不明')} / "
            f"{hit.get('via', '経路不明')}）: {hit.get('note', '')}".strip()
        )
        return out

    state, text = fetch_robots(url, agent=agent, use_cache=use_cache)
    out["robots_state"] = state

    if state == "none":
        out["reason"] = "robots.txt なし（拒否の意思表示なし）"
        return out
    if state == "forbidden":
        out["allowed"] = False
        out["reason"] = "robots.txt が 5xx で読めない（RFC 9309 は全面拒否とみなす）"
        return out
    if state == "unknown":
        out["reason"] = f"robots.txt を取得できず（{text}）"
        return out

    groups = parse(text)
    delays = []
    for a in AGENTS:
        info = match(groups, a, url)
        out["agents"][a] = info
        if not info["allowed"]:
            out["allowed"] = False
        if info["crawl_delay"]:
            delays.append(info["crawl_delay"])
        if info["request_rate"]:
            n, per = info["request_rate"]
            delays.append(per / n)

    if not out["allowed"]:
        blocked = [a for a, i in out["agents"].items() if not i["allowed"]]
        rules = {i["matched_rule"] for a, i in out["agents"].items() if not i["allowed"]}
        out["reason"] = f"{'／'.join(blocked)} に対して {'／'.join(sorted(filter(None, rules)))}"
    else:
        out["reason"] = "Allow"

    out["crawl_delay"] = max(delays) if delays else None
    return out
