#!/usr/bin/env python3
"""`.claude/scripts/investigate-routine.sh` の関門を検証する（ネットワーク不要）。

    python3 tools/investigate_routine_test.py

## なぜ念入りにやるか

調査ルーチンは、深夜に無人で走って **main へ直接 push する**。人のレビューは入らない。
`.claude/routines/investigate-invariants.md` は守ってほしいことを散文で伝えているが、
散文は守られないことがある——守らせたい規則は仕組みに置く、という方針をここでも採る。

固定したいのは「push してよい」と答えてよい条件のほうである。関門が緩む壊れ方は、
厳しすぎる壊れ方よりはるかに高くつく（前者は未検証のコードが公開まで進み、後者は
診断だけが残る）。とくに次を見る。

  - 自分の拘束具（フック・規則・ワークフロー・ゲート本体）に触れた回を通さない
  - 収集の領分（data/）に触れた回を通さない
  - 規模の上限を超えた回を通さない
  - 検査を消す・黙らせる変更を通さない
  - **起動前から汚れていたパスを、調査の成果と取り違えない**（収集の書きかけを
    巻き込んで push すると、検証を通っていないデータがそのまま公開される）

後半は通し（E2E）で、偽の GitHub API とスタブの claude を相手に次を見る。

  - Claude が起動できない回は、調査を諦めて通知だけ残し、push しない
  - 関門を全部通った回だけが実際に origin へ届く
  - push しなかった回も必ず Issue が残る（沈黙で終えない）
  - 報告に混ざったトークンが Issue に出ない
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, ".claude", "scripts", "investigate-routine.sh")


def _git(cwd, *args):
    return subprocess.run(["git", "-C", cwd] + list(args),
                          capture_output=True, text=True, check=False)


def _repo(files=None):
    """初期コミット済みの一時リポジトリを作り、スクリプトを置いて返す。"""
    tmp = tempfile.mkdtemp(prefix="investigate_routine_test_")
    _git(tmp, "init", "-q", "-b", "main")
    _git(tmp, "config", "user.email", "t@example.com")
    _git(tmp, "config", "user.name", "t")

    base = {
        "tools/sample.py": "print(1)\n",
        "tools/sample_test.py": "print(1)\n",
        ".claude/hooks/some-hook.sh": "echo hi\n",
        ".github/workflows/some.yml": "name: x\n",
        "tools/run_all_tests.py": "print(1)\n",
        "data/events.csv": "a,b\n1,2\n",
        "README.md": "hi\n",
    }
    base.update(files or {})
    for rel, body in base.items():
        path = os.path.join(tmp, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)

    os.makedirs(os.path.join(tmp, ".claude", "scripts"), exist_ok=True)
    with open(SCRIPT, "r", encoding="utf-8") as src:
        body = src.read()
    dst = os.path.join(tmp, ".claude", "scripts", "investigate-routine.sh")
    with open(dst, "w", encoding="utf-8") as f:
        f.write(body)
    os.chmod(dst, 0o755)

    _git(tmp, "add", "-A")
    _git(tmp, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init")
    return tmp


def _write(tmp, rel, body):
    path = os.path.join(tmp, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)


def _check_diff(tmp, baseline_lines=None):
    """--check-diff を走らせて (通ったか, 出力) を返す。

    基準線ファイルはリポジトリの**外**に置く。中に置くと、それ自身が未追跡
    ファイルとして候補に数えられ、判定がずれる（本番の投入元は mktemp なので
    常にリポジトリ外にある）。
    """
    fd, baseline = tempfile.mkstemp(prefix="baseline_", suffix=".txt")
    os.close(fd)
    with open(baseline, "w", encoding="utf-8") as f:
        for line in (baseline_lines or []):
            f.write(line + "\n")
    p = subprocess.run(
        [os.path.join(tmp, ".claude", "scripts", "investigate-routine.sh"),
         "--check-diff", baseline],
        cwd=tmp, capture_output=True, text=True, check=False,
    )
    return p.returncode == 0, p.stdout + p.stderr


CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


@check("変更が無ければ通す（診断のみの回を妨げない）")
def _():
    tmp = _repo()
    ok, out = _check_diff(tmp)
    return ok or f"clean なのに止めた: {out}"


@check("小さな普通の修正は通す")
def _():
    tmp = _repo()
    _write(tmp, "tools/sample.py", "print(2)\n")
    ok, out = _check_diff(tmp)
    return ok or f"通すべき差分を止めた: {out}"


@check("フックに触れた回は止める")
def _():
    tmp = _repo()
    _write(tmp, ".claude/hooks/some-hook.sh", "echo changed\n")
    ok, out = _check_diff(tmp)
    if ok:
        return "フックの変更を通した"
    return "安全装置に触れています" in out or f"理由が違う: {out}"


@check("不変規則そのものに触れた回は止める")
def _():
    tmp = _repo()
    _write(tmp, ".claude/routines/investigate-invariants.md", "緩めました\n")
    ok, out = _check_diff(tmp)
    if ok:
        return "規則の変更を通した"
    return "安全装置に触れています" in out or f"理由が違う: {out}"


@check("ワークフローに触れた回は止める")
def _():
    tmp = _repo()
    _write(tmp, ".github/workflows/some.yml", "name: y\n")
    ok, out = _check_diff(tmp)
    return (not ok) or "ワークフローの変更を通した"


@check("ゲート本体に触れた回は止める")
def _():
    tmp = _repo()
    _write(tmp, "tools/run_all_tests.py", "print(2)\n")
    ok, out = _check_diff(tmp)
    return (not ok) or "ゲート本体の変更を通した"


@check("data/ に触れた回は止める")
def _():
    tmp = _repo()
    _write(tmp, "data/events.csv", "a,b\n9,9\n")
    ok, out = _check_diff(tmp)
    if ok:
        return "data/ の変更を通した"
    return "data/ を書き換えています" in out or f"理由が違う: {out}"


@check("ファイル数の上限を超えた回は止める")
def _():
    tmp = _repo()
    for i in range(4):
        _write(tmp, f"tools/new{i}.py", "print(1)\n")
    ok, out = _check_diff(tmp)
    if ok:
        return "4ファイルを通した"
    return "上限の3を超えています" in out or f"理由が違う: {out}"


@check("行数の上限を超えた回は止める")
def _():
    tmp = _repo()
    _write(tmp, "tools/big.py", "".join(f"x = {i}\n" for i in range(100)))
    ok, out = _check_diff(tmp)
    if ok:
        return "100行を通した"
    return "上限の80を超えています" in out or f"理由が違う: {out}"


@check("テストを削除した回は止める")
def _():
    tmp = _repo()
    os.remove(os.path.join(tmp, "tools/sample_test.py"))
    ok, out = _check_diff(tmp)
    if ok:
        return "テストの削除を通した"
    return "テストを削除しています" in out or f"理由が違う: {out}"


@check("continue-on-error を足した回は止める")
def _():
    tmp = _repo()
    _write(tmp, "tools/sample.py", "print(1)\n# continue-on-error: true\n")
    ok, out = _check_diff(tmp)
    if ok:
        return "continue-on-error を通した"
    return "検査を弱める変更" in out or f"理由が違う: {out}"


@check("|| true を足した回は止める")
def _():
    tmp = _repo()
    _write(tmp, "tools/sample.py", "print(1)\n# run tests || true\n")
    ok, out = _check_diff(tmp)
    if ok:
        return "|| true を通した"
    return "検査を弱める変更" in out or f"理由が違う: {out}"


@check("--no-verify を足した回は止める")
def _():
    tmp = _repo()
    _write(tmp, "tools/sample.py", "print(1)\n# git commit --no-verify\n")
    ok, out = _check_diff(tmp)
    return (not ok) or "--no-verify を通した"


@check("起動前から汚れていたパスは調査の成果に数えない")
def _():
    # 収集が失敗して data/ を書きかけのまま残した作業ツリーを模す。
    # 調査が触ったのは tools/sample.py だけなので、通ってよい。
    tmp = _repo()
    _write(tmp, "data/events.csv", "a,b\n7,7\n")      # 起動前からの汚れ
    _write(tmp, "tools/sample.py", "print(2)\n")      # 調査による変更
    ok, out = _check_diff(tmp, baseline_lines=["data/events.csv"])
    if not ok:
        return f"基準線のパスを成果に数えて止めた: {out}"
    return "1ファイル" in out or f"候補の数え方がおかしい: {out}"


@check("新しいディレクトリに置かれたファイルも1件ずつ数える")
def _():
    # 既定の `git status --porcelain` は未追跡ファイルをディレクトリ1件に畳むため、
    # そのまま数えると「1ファイル・0行」になって規模の関門を素通りする。
    # 素通しは関門が緩む壊れ方そのものなので、ここで固定する。
    tmp = _repo()
    for i in range(5):
        _write(tmp, f"tools/newdir/f{i}.py", "".join(f"x = {j}\n" for j in range(40)))
    ok, out = _check_diff(tmp)
    if ok:
        return f"新規ディレクトリ5ファイル200行を通した: {out}"
    return ("上限の3を超えています" in out and "上限の80を超えています" in out) \
        or f"ファイル数・行数の両方で止まっていない: {out}"


@check("基準線を渡さなければ、収集の書きかけも候補に入って止まる")
def _():
    # 基準線の受け渡しが壊れたときに素通しにならないことを確かめる。
    tmp = _repo()
    _write(tmp, "data/events.csv", "a,b\n7,7\n")
    ok, out = _check_diff(tmp, baseline_lines=[])
    return (not ok) or f"基準線なしで data/ を通した: {out}"


# ============================================================
# ここから通し（E2E）
# ============================================================

class FakeIssues:
    """POST /repos/<repo>/issues を受けて控えるだけの偽 API。"""

    def __init__(self):
        self.posted = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):                                # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                outer.posted.append(body)
                payload = json.dumps({"html_url": "https://example.invalid/issues/1"})
                self.send_response(201)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload.encode())

            def log_message(self, *a):                        # noqa: A003
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self):
        self.server.shutdown()


def _e2e(check_env_rc=0, claude_body="", report="（報告）", push="1"):
    """origin 付きのサンドボックスで investigate-routine.sh を通しで走らせる。

    claude_body はスタブの claude がリポジトリへ書き込むシェル片。
    戻り値は (終了コード, 標準出力, origin に届いたか, 起票された Issue の一覧)。
    """
    tmp = _repo()

    # origin を用意して、初期コミットを送っておく
    origin = tempfile.mkdtemp(prefix="investigate_origin_")
    _git(origin, "init", "-q", "--bare", "-b", "main")
    _git(tmp, "remote", "add", "origin", origin)
    _git(tmp, "push", "-q", "-u", "origin", "main")

    # ゲートは通ったことにする（本物のランナーはサンドボックスにテストが無く落ちる）
    _write(tmp, "tools/run_all_tests.py", "import sys\nsys.exit(0)\n")
    _git(tmp, "add", "-A")
    _git(tmp, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "gate")
    _git(tmp, "push", "-q", "origin", "main")

    # 規則と手順（中身は問わない。存在の確認だけがスクリプトの要件）
    _write(tmp, ".claude/routines/investigate-invariants.md", "規則\n")
    _write(tmp, ".claude/skills/routine-investigate/SKILL.md", "手順\n")
    _git(tmp, "add", "-A")
    _git(tmp, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "docs")
    _git(tmp, "push", "-q", "origin", "main")

    # claude-routine.sh のスタブ（--check-env の可否だけを決める）
    _write(tmp, ".claude/scripts/claude-routine.sh",
           f"#!/bin/bash\necho 'check-env stub'\nexit {check_env_rc}\n")
    os.chmod(os.path.join(tmp, ".claude/scripts/claude-routine.sh"), 0o755)

    # claude 本体のスタブ
    stub = os.path.join(tmp, "fake-claude.sh")
    with open(stub, "w", encoding="utf-8") as f:
        f.write("#!/bin/bash\ncd \"$(git rev-parse --show-toplevel)\"\n"
                + claude_body + "\n"
                + f"cat <<'EOF'\n{report}\nEOF\n")
    os.chmod(stub, 0o755)

    api = FakeIssues()
    try:
        env = dict(os.environ)
        env.update({
            "GITHUB_API_URL": api.url,
            "GITHUB_TOKEN": "ghp_faketoken0123456789abcdefghij",
            "GITHUB_REPOSITORY": "the-ready/player-one",
            "INVESTIGATE_CLAUDE_BIN": stub,
            "INVESTIGATE_PUSH": push,
            "FAILED_RUN_URL": "https://example.invalid/runs/1",
            "FAILED_RUN_CONCLUSION": "failure",
        })
        p = subprocess.run(
            [os.path.join(tmp, ".claude", "scripts", "investigate-routine.sh")],
            cwd=tmp, capture_output=True, text=True, check=False, env=env, timeout=180,
        )
        head = _git(origin, "log", "--oneline", "-1", "main").stdout
        return p.returncode, p.stdout + p.stderr, head, api.posted
    finally:
        api.stop()


@check("E2E: Claude が起動できない回は、調査せず通知だけ残す")
def _():
    rc, out, head, posted = _e2e(check_env_rc=1,
                                 claude_body="echo 'ここは呼ばれてはいけない' > tools/bad.py")
    if rc != 0:
        return f"正常終了していない: rc={rc}\n{out}"
    if "gate" not in head and "docs" not in head:
        return f"origin が動いた: {head}"
    if len(posted) != 1:
        return f"Issue が1件でない: {posted}"
    title = posted[0].get("title", "")
    return "調査も起動できません" in title or f"通知の題が違う: {title}"


@check("E2E: 関門を全部通った小さな修正は origin に届く")
def _():
    rc, out, head, posted = _e2e(
        claude_body="printf 'print(2)\\n' > tools/sample.py")
    if rc != 0:
        return f"正常終了していない: rc={rc}\n{out}"
    if "自動調査して修正" not in head:
        return f"origin に届いていない: {head}"
    return len(posted) == 1 or f"Issue が1件でない: {posted}"


@check("E2E: 規模の上限を超えた修正は push されないが、Issue は残る")
def _():
    big = "; ".join([f"echo 'x{i}' >> tools/big.py" for i in range(120)])
    rc, out, head, posted = _e2e(claude_body=big)
    if rc != 0:
        return f"正常終了していない: rc={rc}\n{out}"
    if "自動調査して修正" in head:
        return f"上限超過なのに push された: {head}"
    if len(posted) != 1:
        return f"Issue が1件でない: {posted}"
    body = posted[0].get("body", "")
    return "上限" in body or f"理由が Issue に出ていない: {body[:300]}"


@check("E2E: 安全装置に触れた修正は push されない")
def _():
    rc, out, head, posted = _e2e(
        claude_body="printf 'echo x\\n' > .claude/hooks/some-hook.sh")
    if rc != 0:
        return f"正常終了していない: rc={rc}\n{out}"
    if "自動調査して修正" in head:
        return f"安全装置に触れたのに push された: {head}"
    body = posted[0].get("body", "") if posted else ""
    return "安全装置" in body or f"理由が Issue に出ていない: {body[:300]}"


@check("E2E: 変更が無くても Issue は残る（沈黙で終えない）")
def _():
    rc, out, head, posted = _e2e(claude_body="true", report="原因は特定できませんでした")
    if rc != 0:
        return f"正常終了していない: rc={rc}\n{out}"
    if len(posted) != 1:
        return f"Issue が1件でない: {posted}"
    return "原因は特定できませんでした" in posted[0].get("body", "") \
        or "報告が載っていない"


@check("E2E: 報告に混ざったトークンは Issue に出さない")
def _():
    leaked = "ghp_abcdefghijklmnopqrstuvwxyz012345"
    rc, out, head, posted = _e2e(claude_body="true",
                                 report=f"ログに {leaked} が出ていました")
    if rc != 0:
        return f"正常終了していない: rc={rc}\n{out}"
    body = posted[0].get("body", "") if posted else ""
    if leaked in body:
        return "トークンがそのまま Issue に載った"
    return "***REDACTED***" in body or f"伏字になっていない: {body[-300:]}"


@check("E2E: INVESTIGATE_PUSH=0 なら関門を通っても push しない")
def _():
    rc, out, head, posted = _e2e(
        claude_body="printf 'print(2)\\n' > tools/sample.py", push="0")
    if rc != 0:
        return f"正常終了していない: rc={rc}\n{out}"
    return "自動調査して修正" not in head or f"push=0 なのに push された: {head}"


# ============================================================
# ワークフローの結線
#
# 2026-09-25、routine-investigate.yml に actions/checkout が無く、runner の作業ツリーが
# 直前の収集が checkout した時点のまま（＝このスクリプトがまだ存在しない）だったため、
# 手動実行が exit 127（command not found）で落ちた。**ワークフローの結線そのものは
# 動かしてみるまで誰も検査していなかった**ので、ここで機械的に固定する。
# YAML ライブラリには依存せず、collect_fallback_test.mjs と同じく本文を読んで見る。
# ============================================================

def _wf(name):
    with open(os.path.join(ROOT, ".github", "workflows", name), encoding="utf-8") as f:
        return f.read()


@check("結線: routine-investigate.yml が参照するスクリプトが実在する")
def _():
    # exit 127 の直接の再発防止。パスを書き換えたまま置き忘れたら、ここで落ちる。
    s = _wf("routine-investigate.yml")
    refs = re.findall(r"run:\s*(\.claude/scripts/[\w.-]+\.sh)", s)
    if not refs:
        return "スクリプトを実行するステップが見つからない"
    missing = [r for r in refs if not os.path.exists(os.path.join(ROOT, r))]
    return not missing or f"実在しないパスを実行しようとしている: {missing}"


@check("結線: routine-investigate.yml は checkout する（clean:false で）")
def _():
    s = _wf("routine-investigate.yml")
    if "actions/checkout" not in s:
        return "checkout が無い（作業ツリーが古いまま走り、スクリプトの更新が反映されない）"
    return "clean: false" in s or "clean:false" in s \
        or "clean: true 相当になっている（.claude/logs/ が消え、調査が読むものを失う）"


@check("結線: routine-investigate.yml は weekly-routine の concurrency group に入る")
def _():
    # 別グループにすると収集と同時に走り、checkout --force が収集中の data/ を壊す。
    s = _wf("routine-investigate.yml")
    m = re.search(r"concurrency:\s*\n\s*group:\s*(\S+)", s)
    if not m:
        return "concurrency group の指定が無い"
    return m.group(1) == "weekly-routine" or f"group が weekly-routine でない: {m.group(1)}"


@check("結線: 起動元は routine-repair.yml で、weekly-collect.yml ではない")
def _():
    # investigate は checkout --force を伴うため、repair が書きかけの data/ を
    # 救い出した後でなければ走ってはいけない。weekly-collect から直接起動すると
    # 順序が保証されず、pending のキャンセル競合も起きる。
    collect = _wf("weekly-collect.yml")
    repair = _wf("routine-repair.yml")
    target = "routine-investigate.yml/dispatches"
    if target in collect:
        return "weekly-collect.yml が investigate を直接起動している（順序が保証されない）"
    return target in repair or "routine-repair.yml が investigate を起動していない"


def main():
    if not os.path.exists(SCRIPT):
        print(f"✗ スクリプトが見つかりません: {SCRIPT}")
        return 1
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
