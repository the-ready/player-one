#!/usr/bin/env python3
"""`data/sources.json` に載っている調査元サイトの robots.txt を確認する。

## なぜこのスクリプトがあるのか

収集は生成AIのエージェントが週次で自動実行する（`.claude/scripts/claude-routine.sh`）。
「手作業だから robots.txt は関係ない」とは言えない——機械的なアクセスである。

robots.txt を尊重することには、礼儀とは別に根拠が2つある。

  1. **著作権法47条の5の政令基準**（著作権法施行令第7条の5）は、所在検索サービス等が
     権利制限を受けるための基準のひとつとして、**収集を禁止する措置がとられた情報を
     収集しないこと**、および**収集後にその措置がとられたと判明したときに記録を
     消去すること**を挙げている。robots.txt はその代表的な「措置」である。
  2. **著作権法30条の4**（情報解析等）は取得・解析の段階を広く適法化するが、
     **契約（各サイトの利用規約）を上書きしない**。規約で自動収集を禁じている
     サイトからの取得は、著作権法上適法でも規約違反として残る。

判断の材料をモデルに毎回ゼロから集めさせると、コンテキストを食ううえに結果が
週ごとにぶれる。**突き合わせは機械の仕事**（`docs/COLLECTION-PROTOCOL.md` の
差分収集と同じ考え方）なので、機械が読めるものはここで読む。

## このスクリプトと `tools/fetch_gate.py` の分担

| | 見るもの | いつ |
| --- | --- | --- |
| `check_robots.py`（これ） | `sources.json` の各サイトの**トップ** | 着手前に1回 |
| `fetch_gate.py` | **これから開くURLそのもの** | 取得のたび（フックで自動） |

**このスクリプトだけでは足りない。** サイトはトップを開放したまま `/reserve/`
`/api/` `/search/*experienceDate` のような特定のパスだけを閉じている（実例として
asoview! がそう書いている）。「トップがOKだったから以下すべてOK」にはならないので、
**実際に開くURLの判定は `fetch_gate.py` が取得の直前に行う**。ここが受け持つのは、
着手前に「今週そもそも使えないサイトはどれか」を一望することである。

判定規則そのもの（Allow/Disallow の最長一致、`*` と `$`、UA群の選び方）は
`tools/robots_rules.py` に置いて両者で共有している。2つのツールが同じ robots.txt に
違う答えを出す状態を作らないためである。

## このスクリプトが判断しないこと

robots.txt に書いていない**利用規約上の禁止**は、ここでは分からない。規約の
読み取りは人間が行う。このスクリプトは robots.txt という機械可読な部分だけを見る。

## AI系UAを名指ししているサイトでの Claude-User / Claude-SearchBot 個別判定

このコレクタ自身は `DEFAULT_AGENT`（`EventBoardCollector/1.0`）を名乗っており、
`allowed`/`blocked` の主判定はそのUAに対するものである。それとは別に、
robots.txt が `GPTBot` `ClaudeBot` などAI系UAを名指ししているサイトでは、
**Anthropicが実際に運用している3種のクローラのうち、`Claude-User` と
`Claude-SearchBot` に何が許可されているか**も `claude_detail` として出す
（許可/拒否だけでなく、一致した段が個別指定かワイルドカード`*`か、
crawl-delay、該当する Allow/Disallow のルール本文まで）。

**`ClaudeBot` はここでは見ない。** 3種の役割は次のように異なる
（出典: https://support.claude.com/en/articles/8896518 ）。

  - `ClaudeBot` —— モデルの**学習データ収集**用クローラ。ユーザ操作を伴わない
    バッチ収集で、このタスクのような実行時のエージェント動作とは無関係
  - `Claude-User` —— **ユーザの指示に応じてリアルタイムに取得する**クローラ。
    このコレクタがWebFetchで行っている取得は、性質としてはこちらに近い
  - `Claude-SearchBot` —— 検索結果の質を上げるために巡回するクローラ

サイト運営者が「AIエージェントによる自動アクセスを止めたい」と考えたとき、
実際に robots.txt へ書くのは `Claude-User` と `Claude-SearchBot` の側であり、
`ClaudeBot`（学習用）を拒否していても、それは今回の収集の可否とは別の話である。
このコレクタが `Claude-User` を名乗っているわけではないが、Anthropicのモデルを
使って実行時に収集している以上、規約確認の材料として関連性が高いため出している。

## 使い方

    python3 tools/check_robots.py                 # 一覧を表示
    python3 tools/check_robots.py --json          # 機械可読な出力
    python3 tools/check_robots.py --agent MyBot   # 判定に使うUAを変える

終了コードは、取得できなかったサイトがあっても 0 のまま（ネットワークの都合で
週次ルーチンを落とさない）。**明示的に拒否されているサイトが見つかったときだけ 1** を返す。
"""

import argparse
import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import robots_rules as rr                                    # noqa: E402

ROOT = rr.ROOT
SOURCES = os.path.join(ROOT, "data", "sources.json")

DEFAULT_AGENT = rr.DEFAULT_AGENT
AGENTS_TO_CHECK = rr.AGENTS


def agent_permissions(groups, site_url, agent):
    """robots.txt が指定エージェントに何を許可しているかを、ルール本文つきで返す。"""
    info = rr.match(groups, agent, site_url)
    group, _ = rr.select_group(groups, agent)
    rate = info["request_rate"]
    return {
        "allowed": info["allowed"],
        "matched_section": info["matched_section"] or "該当する段なし",
        "matched_rule": info["matched_rule"],
        "crawl_delay": info["crawl_delay"],
        "request_rate": f"{rate[0]}/{rate[1]}秒" if rate else None,
        "rules": [f"{'Allow' if a else 'Disallow'}: {p}" for a, p in group.rules]
        if group else [],
    }


def check(site_url, agent):
    """1サイト分の判定を返す。

    status は次のいずれか。
      allowed   … robots.txt があり、このUAでのトップ取得を妨げていない
      blocked   … robots.txt が明示的に拒否している（要対応）
      none      … robots.txt が無い（4xx）。拒否の意思表示は無いものとして扱う
      unknown   … 取得できなかった（ネットワーク・タイムアウト等）
    """
    ru = rr.robots_url(site_url)
    state, text = rr.fetch_robots(site_url, agent=agent)

    if state == "none":
        return {"robots_url": ru, "status": "none", "detail": "robots.txt なし (4xx)"}
    if state == "forbidden":
        return {"robots_url": ru, "status": "blocked",
                "detail": "robots.txt が 5xx で読めない（RFC 9309 は全面拒否とみなす）"}
    if state == "unknown":
        return {"robots_url": ru, "status": "unknown", "detail": text}

    groups = rr.parse(text)
    info = rr.match(groups, agent, site_url)

    # 生成AI・LLM向けのUAを名指しで拒否しているサイトが増えている。判定には使わない
    # （こちらは名乗りが違う）が、**意思表示としては読む**。人間が規約を確認する
    # きっかけになるので、見つけたら必ず出す。
    ai_agents = [
        "GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-User",
        "Claude-SearchBot", "anthropic-ai", "CCBot", "Google-Extended",
        "PerplexityBot", "Applebot-Extended", "Bytespider", "meta-externalagent",
    ]
    named = [a for a in ai_agents if a.lower() in text.lower()]

    result = {
        "robots_url": ru,
        "status": "allowed" if info["allowed"] else "blocked",
        "detail": ("取得可" if info["allowed"]
                   else f"robots.txt がこのUAでの取得を拒否（{info['matched_rule']}）"),
        "crawl_delay": info["crawl_delay"],
        "ai_agents_named": named,
    }
    if named:
        result["claude_detail"] = {
            a: agent_permissions(groups, site_url, a) for a in AGENTS_TO_CHECK
        }
    return result


def load_sites():
    with open(SOURCES, encoding="utf-8") as f:
        data = json.load(f)
    seen, out = set(), []
    for tab, entries in data.items():
        if tab.startswith("_"):
            continue
        for e in entries:
            host = urllib.parse.urlparse(e["url"]).netloc
            if host in seen:                    # 同じサイトが複数タブに出る
                continue
            seen.add(host)
            out.append({"tab": tab, "name": e["name"], "url": e["url"], "host": host})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--agent", default=DEFAULT_AGENT, help="判定に使う User-Agent")
    ap.add_argument("--json", action="store_true", dest="as_json", help="JSONで出す")
    args = ap.parse_args()

    sites = load_sites()
    results = []
    for s in sites:
        r = check(s["url"], args.agent)
        results.append({**s, **r})
        if not args.as_json:
            mark = {"allowed": "OK  ", "blocked": "拒否", "none": "--  ", "unknown": "?   "}[r["status"]]
            extra = ""
            if r.get("crawl_delay"):
                extra += f"  crawl-delay={r['crawl_delay']}"
            if r.get("ai_agents_named"):
                extra += f"  ※AI系UAを名指し: {', '.join(r['ai_agents_named'])}"
            print(f"{mark}  {s['name']:<28} {s['host']:<32}{extra}")
            cd = r.get("claude_detail")
            if cd:
                for agent, info in cd.items():
                    cd_mark = "許可" if info["allowed"] else "拒否"
                    cd_extra = f"（{info['matched_section']}）"
                    if info["crawl_delay"]:
                        cd_extra += f" crawl-delay={info['crawl_delay']}"
                    if info["request_rate"]:
                        cd_extra += f" request-rate={info['request_rate']}"
                    print(f"        ↳ {agent}: {cd_mark}{cd_extra}")
                    for rule in info["rules"]:
                        print(f"           {rule}")

    blocked = [r for r in results if r["status"] == "blocked"]
    unknown = [r for r in results if r["status"] == "unknown"]
    flagged = [r for r in results if r.get("ai_agents_named")]

    if args.as_json:
        json.dump(results, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        print(f"\n合計 {len(results)}サイト / 拒否 {len(blocked)} / 未取得 {len(unknown)}"
              f" / AI系UAを名指し {len(flagged)}")
        if blocked:
            print("\n拒否されているサイトは、収集対象から外し data/sources.json からも削除すること。")
            for r in blocked:
                print(f"  - {r['name']}  {r['robots_url']}")
        if flagged:
            print("\nAI系UAを名指ししているサイトは、利用規約の自動収集条項を人間が確認すること。")
            for r in flagged:
                cd = r.get("claude_detail") or {}
                statuses = ", ".join(
                    f"{a}:{'許可' if info['allowed'] else '拒否'}" for a, info in cd.items()
                )
                print(f"  - {r['name']}  名指し: {', '.join(r['ai_agents_named'])}  / {statuses}")
        print("\n個々のページを開いてよいかは、これでは分からない（トップの判定である）。"
              "\n取得の直前に tools/fetch_gate.py が URL ごとに判定する（WebFetch のフックで自動）。")

    return 1 if blocked else 0


if __name__ == "__main__":
    sys.exit(main())
