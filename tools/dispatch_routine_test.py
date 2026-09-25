#!/usr/bin/env python3
"""Pi のタイマーが呼ぶ `.claude/scripts/dispatch-routine.sh` と、その導入スクリプト
`.claude/scripts/install-dispatch-timer.sh` を、偽の GitHub API に向けて検証する（ネットワーク不要）。

    python3 tools/dispatch_routine_test.py

## なぜ念入りにやるか

このスクリプトは週3回、深夜に無人で1度だけ走る。**起動しそこねても、二重に起動しても、
その場では誰も気づかない**（前者はその枠のデータが翌週まで古いまま、後者は収集が2回走る）。
固定したいのは次の倒し方である。

  - 一時的な失敗（通信断・5xx・429）だけを再試行し、設定の問題（401/403/404/422）では粘らない
  - 再試行の前に「実は届いていた」かを確かめ、二重に起動しない
  - トークンを出力にも curl の引数（/proc/<pid>/cmdline）にも出さない
  - 導入スクリプトは何度実行しても壊れず、トークンを空で上書きしない
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, ".claude", "scripts", "dispatch-routine.sh")
INSTALLER = os.path.join(ROOT, ".claude", "scripts", "install-dispatch-timer.sh")
TOKEN = "github_pat_TESTtoken0123456789abcdef"
WF_PATH = "/repos/the-ready/player-one/actions/workflows/weekly-collect.yml"


class FakeGitHub:
    """種類ごとに応答の列を持ち、先頭から1つずつ返す。尽きたら既定の応答を返す。"""

    def __init__(self):
        self.plan = {"dispatch": [], "runs": [], "workflow": []}
        self.default = {
            "dispatch": (204, None, 0),
            "runs": (200, {"total_count": 0, "workflow_runs": []}, 0),
            "workflow": (200, {"name": "週次データ収集", "state": "active"}, 0),
        }
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _serve(self):
                u = urlsplit(self.path)
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n).decode() if n else ""
                if self.command == "POST" and u.path == WF_PATH + "/dispatches":
                    kind = "dispatch"
                elif self.command == "GET" and u.path == WF_PATH + "/runs":
                    kind = "runs"
                elif self.command == "GET" and u.path == WF_PATH:
                    kind = "workflow"
                else:
                    kind = "unknown"
                outer.requests.append(
                    {"kind": kind, "method": self.command, "path": u.path,
                     "query": parse_qs(u.query), "headers": dict(self.headers), "body": body})
                q = outer.plan.get(kind)
                status, payload, delay = (q.pop(0) if q else outer.default.get(kind, (404, {"message": "Not Found"}, 0)))
                if delay:
                    time.sleep(delay)
                data = b"" if payload is None else json.dumps(payload).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            do_GET = do_POST = _serve

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def kinds(self):
        return [r["kind"] for r in self.requests]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Sandbox:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="dispatch_test_")
        self.token_file = os.path.join(self.dir, "token")
        with open(self.token_file, "w") as f:
            f.write(TOKEN + "\n")
        # curl の引数を記録してから本物に渡す（トークンが引数に載らないことを見る）
        self.bin = os.path.join(self.dir, "bin")
        os.mkdir(self.bin)
        self.argv_log = os.path.join(self.dir, "curl-argv.log")
        real_curl = shutil.which("curl")
        with open(os.path.join(self.bin, "curl"), "w") as f:
            f.write(f'#!/bin/bash\nprintf "%s\\n" "$*" >> "{self.argv_log}"\nexec "{real_curl}" "$@"\n')
        os.chmod(os.path.join(self.bin, "curl"), 0o755)
        self.gh = FakeGitHub()

    def env(self, **extra):
        e = {k: v for k, v in os.environ.items() if not k.startswith("DISPATCH_") and k != "CREDENTIALS_DIRECTORY"}
        e.update({
            "PATH": self.bin + os.pathsep + e.get("PATH", ""),
            "GITHUB_API_URL": self.gh.url,
            "DISPATCH_TOKEN_FILE": self.token_file,
            "DISPATCH_RETRY_DELAYS": "0 0 0 0",
            "DISPATCH_CURL_MAX_TIME": "2",
        })
        e.update(extra)
        return {k: v for k, v in e.items() if v is not None}

    def run(self, *args, stdin="", cmd=SCRIPT, **env):
        p = subprocess.run([cmd, *args], input=stdin, capture_output=True, text=True,
                           env=self.env(**env), timeout=60)
        return p.returncode, p.stdout + p.stderr

    def argv_text(self):
        return open(self.argv_log).read() if os.path.exists(self.argv_log) else ""

    def close(self):
        self.gh.close()
        shutil.rmtree(self.dir, ignore_errors=True)


def expect(cond, msg):
    if not cond:
        raise AssertionError(msg)


# ---------------------------------------------------------------- 起動

def check_dispatch_ok(sb):
    code, out = sb.run()
    expect(code == 0, f"exit {code}: {out}")
    expect(sb.gh.kinds() == ["dispatch"], sb.gh.kinds())
    r = sb.gh.requests[0]
    expect(json.loads(r["body"]) == {"ref": "main"}, r["body"])
    h = {k.lower(): v for k, v in r["headers"].items()}
    expect(h.get("authorization") == f"Bearer {TOKEN}", "Authorization ヘッダが違う")
    expect(h.get("accept") == "application/vnd.github+json", h.get("accept"))
    expect(h.get("x-github-api-version") == "2022-11-28", h.get("x-github-api-version"))
    return True


def check_retry_5xx_then_ok(sb):
    sb.gh.plan["dispatch"] = [(502, {"message": "Bad Gateway"}, 0), (500, {"message": "x"}, 0)]
    code, out = sb.run()
    expect(code == 0, f"exit {code}: {out}")
    expect(sb.gh.kinds() == ["dispatch", "runs", "dispatch", "runs", "dispatch"], sb.gh.kinds())
    return True


def check_retry_429(sb):
    sb.gh.plan["dispatch"] = [(429, {"message": "rate"}, 0)]
    code, out = sb.run()
    expect(code == 0 and sb.gh.kinds() == ["dispatch", "runs", "dispatch"], (code, sb.gh.kinds(), out))
    return True


def check_timeout_but_delivered_no_resend(sb):
    # 依頼は GitHub に届いたが応答が返らなかった → 再送せずに成功で終える
    sb.gh.plan["dispatch"] = [(204, None, 4)]
    sb.gh.plan["runs"] = [(200, {"total_count": 1, "workflow_runs": [{"id": 1}]}, 0)]
    code, out = sb.run(DISPATCH_CURL_MAX_TIME="1")
    expect(code == 0, f"exit {code}: {out}")
    expect(sb.gh.kinds() == ["dispatch", "runs"], f"再送してはいけない: {sb.gh.kinds()}")
    expect("再送はしません" in out, out)
    return True


def check_runs_query_shape(sb):
    sb.gh.plan["dispatch"] = [(503, {}, 0)]
    before = datetime.now(timezone.utc)
    sb.run()
    runs = [r for r in sb.gh.requests if r["kind"] == "runs"][0]
    q = runs["query"]
    expect(q.get("event") == ["workflow_dispatch"], q)
    created = q.get("created", [""])[0]
    expect(created.startswith(">="), created)
    since = datetime.strptime(created[2:], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    lag = before - since
    expect(timedelta(seconds=50) <= lag <= timedelta(seconds=75), f"開始の約1分前から数えること: {lag}")
    return True


def check_runs_check_failure_still_retries(sb):
    # 「届いていたか」の確認自体が失敗しても、再試行は続ける（確認できない＝届いていない扱い）
    sb.gh.plan["dispatch"] = [(503, {}, 0)]
    sb.gh.plan["runs"] = [(500, {}, 0)]
    code, out = sb.run()
    expect(code == 0 and sb.gh.kinds() == ["dispatch", "runs", "dispatch"], (code, sb.gh.kinds()))
    return True


def _reject(status, message):
    def fn(sb):
        sb.gh.plan["dispatch"] = [(status, {"message": message}, 0)]
        code, out = sb.run()
        expect(code == 2, f"exit {code}: {out}")
        expect(sb.gh.kinds() == ["dispatch"], f"設定の問題では再試行しない: {sb.gh.kinds()}")
        expect(message in out, f"GitHub の理由を出すこと: {out}")
        return True
    return fn


def check_all_503_gives_up(sb):
    sb.gh.default["dispatch"] = (503, {"message": "unavailable"}, 0)
    code, out = sb.run()
    expect(code == 3, f"exit {code}: {out}")
    expect(sb.gh.kinds().count("dispatch") == 5, sb.gh.kinds())
    expect("手動で weekly-collect.yml を起動" in out, out)
    return True


def check_connection_refused(sb):
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    code, out = sb.run(GITHUB_API_URL=f"http://127.0.0.1:{port}")
    expect(code == 3, f"exit {code}: {out}")
    expect(out.count("HTTP 000") == 5, out)
    return True


def check_no_retries_when_delays_empty(sb):
    sb.gh.default["dispatch"] = (503, {}, 0)
    code, _ = sb.run(DISPATCH_RETRY_DELAYS="")
    expect(code == 3 and sb.gh.kinds() == ["dispatch"], (code, sb.gh.kinds()))
    return True


def check_default_retry_budget(sb):
    # 既定の待ち時間と上限の合計が TimeoutStartSec（15分）に収まること。
    # 超えると systemd が先にサービスを殺し、再試行の途中で枠が落ちる。
    src = open(SCRIPT).read()
    delays = src.split('DISPATCH_RETRY_DELAYS-', 1)[1].split('}', 1)[0]
    max_time = int(src.split('DISPATCH_CURL_MAX_TIME:-', 1)[1].split('}', 1)[0])
    waits = [int(x) for x in delays.split()]
    worst = sum(waits) + (len(waits) + 1) * max_time + len(waits) * max_time
    unit = open(os.path.join(ROOT, ".claude", "systemd", "player-one-dispatch.service")).read()
    limit = int(unit.split("TimeoutStartSec=", 1)[1].split("min", 1)[0]) * 60
    expect(worst < limit, f"最悪 {worst}秒・TimeoutStartSec {limit}秒")
    return True


# ---------------------------------------------------------------- トークン

def check_token_never_leaks(sb):
    sb.gh.plan["dispatch"] = [(503, {"message": "x"}, 0), (401, {"message": "Bad credentials"}, 0)]
    code, out = sb.run()
    sb.run("--check")
    expect(code == 2, out)
    expect(TOKEN not in out, "トークンが出力に出ている")
    argv = sb.argv_text()
    expect(argv and TOKEN not in argv, f"トークンが curl の引数に載っている: {argv[:200]}")
    return True


def check_missing_token_file(sb):
    code, out = sb.run(DISPATCH_TOKEN_FILE=os.path.join(sb.dir, "nope"))
    expect(code == 1 and sb.gh.requests == [], (code, out))
    return True


def check_empty_token_file(sb):
    with open(sb.token_file, "w") as f:
        f.write("  \n\n")
    code, out = sb.run()
    expect(code == 1 and sb.gh.requests == [], (code, out))
    return True


def check_credentials_directory(sb):
    cred = os.path.join(sb.dir, "cred")
    os.mkdir(cred)
    with open(os.path.join(cred, "dispatch-token"), "w") as f:
        f.write("  " + TOKEN + "\r\n")
    code, out = sb.run(DISPATCH_TOKEN_FILE=None, CREDENTIALS_DIRECTORY=cred)
    expect(code == 0, out)
    h = {k.lower(): v for k, v in sb.gh.requests[0]["headers"].items()}
    expect(h["authorization"] == f"Bearer {TOKEN}", "LoadCredential の場所から読み、空白を落とすこと")
    return True


# ---------------------------------------------------------------- --check

def check_check_ok(sb):
    code, out = sb.run("--check")
    expect(code == 0 and sb.gh.kinds() == ["workflow"], (code, sb.gh.kinds(), out))
    return True


def check_check_disabled(sb):
    sb.gh.plan["workflow"] = [(200, {"state": "disabled_manually"}, 0)]
    code, out = sb.run("--check")
    expect(code == 2 and "disabled_manually" in out and "dispatch" not in sb.gh.kinds(), (code, out))
    return True


def check_check_unauthorized(sb):
    sb.gh.plan["workflow"] = [(401, {"message": "Bad credentials"}, 0)]
    code, out = sb.run("--check")
    expect(code == 2 and "Bad credentials" in out, (code, out))
    return True


def check_bad_argument(sb):
    code, _ = sb.run("--now")
    expect(code == 64 and sb.gh.requests == [], code)
    return True


# ---------------------------------------------------------------- 導入スクリプト

def _fake_systemctl(sb, version="252"):
    path = os.path.join(sb.bin, "systemctl")
    log = os.path.join(sb.dir, "systemctl.log")
    with open(path, "w") as f:
        f.write(f'#!/bin/bash\nprintf "%s\\n" "$*" >> "{log}"\n'
                f'[ "$1" = --version ] && echo "systemd {version} (test)"\nexit 0\n')
    os.chmod(path, 0o755)
    return path, log


def _install(sb, *args, stdin="", version="252"):
    root = os.path.join(sb.dir, "root")
    systemctl, log = _fake_systemctl(sb, version)
    code, out = sb.run(*args, stdin=stdin, cmd=INSTALLER, INSTALL_ROOT=root, SYSTEMCTL=systemctl,
                       DISPATCH_TOKEN_FILE=None)
    calls = open(log).read().splitlines() if os.path.exists(log) else []
    return root, code, out, calls


def _mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)


def check_install_fresh(sb):
    root, code, out, calls = _install(sb, stdin=TOKEN + "\n")
    expect(code == 0, out)
    tok = os.path.join(root, "etc/player-one/dispatch-token")
    expect(open(tok).read() == TOKEN + "\n", "トークンの保存内容")
    expect(_mode(tok) == 0o600 and _mode(os.path.dirname(tok)) == 0o700, "トークンは root のみ")
    lib = os.path.join(root, "usr/local/lib/player-one/dispatch-routine.sh")
    expect(_mode(lib) == 0o755 and open(lib).read() == open(SCRIPT).read(), "スクリプトの配置")
    for u in ("player-one-dispatch.service", "player-one-dispatch.timer"):
        expect(_mode(os.path.join(root, "etc/systemd/system", u)) == 0o644, u)
    expect(calls[:3] == ["--version", "daemon-reload", "enable --now player-one-dispatch.timer"], calls)
    expect(sb.gh.kinds() == ["workflow"], f"導入の最後に --check だけを行い、起動はしない: {sb.gh.kinds()}")
    expect(TOKEN not in out, "トークンを画面に出さない")
    return True


def check_install_rerun_keeps_token(sb):
    root, code, _, _ = _install(sb, stdin=TOKEN + "\n")
    root, code, out, _ = _install(sb, stdin="")
    expect(code == 0 and "既存のトークン" in out, out)
    expect(open(os.path.join(root, "etc/player-one/dispatch-token")).read() == TOKEN + "\n", "上書きした")
    return True


def check_install_rotate(sb):
    root, _, _, _ = _install(sb, stdin=TOKEN + "\n")
    _, code, out, _ = _install(sb, "--rotate-token", stdin="github_pat_NEW\n")
    expect(code == 0 and open(os.path.join(root, "etc/player-one/dispatch-token")).read() == "github_pat_NEW\n", out)
    return True


def check_install_rotate_empty_keeps_old(sb):
    root, _, _, _ = _install(sb, stdin=TOKEN + "\n")
    _, code, out, _ = _install(sb, "--rotate-token", stdin="\n")
    expect(code == 1, out)
    expect(open(os.path.join(root, "etc/player-one/dispatch-token")).read() == TOKEN + "\n", "空で上書きした")
    return True


def check_install_old_systemd(sb):
    root, code, out, calls = _install(sb, stdin=TOKEN + "\n", version="245")
    expect(code == 1 and "247" in out, out)
    expect(not os.path.exists(os.path.join(root, "etc/systemd/system")), "古い systemd では何も置かない")
    return True


def check_install_check_fails(sb):
    sb.gh.plan["workflow"] = [(401, {"message": "Bad credentials"}, 0)]
    _, code, out, _ = _install(sb, stdin=TOKEN + "\n")
    expect(code == 1 and "--rotate-token" in out, out)
    return True


CHECKS = [
    ("起動: 204 で成功し、ref=main とヘッダを正しく送る", check_dispatch_ok),
    ("起動: 5xx は再試行して通る", check_retry_5xx_then_ok),
    ("起動: 429 は再試行して通る", check_retry_429),
    ("起動: 応答が失われても届いていれば再送しない（二重起動の防止）", check_timeout_but_delivered_no_resend),
    ("起動: 届いたかの確認は workflow_dispatch・開始の約1分前から", check_runs_query_shape),
    ("起動: 届いたかの確認が失敗しても再試行は続ける", check_runs_check_failure_still_retries),
    ("起動: 401 では粘らない", _reject(401, "Bad credentials")),
    ("起動: 403 では粘らない", _reject(403, "Resource not accessible by personal access token")),
    ("起動: 404 では粘らない", _reject(404, "Not Found")),
    ("起動: 422（無効化されたワークフロー）では粘らない", _reject(422, "Workflow does not have 'workflow_dispatch' trigger")),
    ("起動: 503 が続けば5回で諦めて予備に委ねる", check_all_503_gives_up),
    ("起動: 通信できなければ5回で諦める", check_connection_refused),
    ("起動: 待ち時間が空なら再試行しない", check_no_retries_when_delays_empty),
    ("起動: 既定の再試行は TimeoutStartSec と予備起動の前に終わる", check_default_retry_budget),
    ("トークン: 出力にも curl の引数にも出さない", check_token_never_leaks),
    ("トークン: ファイルが無ければ通信せずに止まる", check_missing_token_file),
    ("トークン: 空なら通信せずに止まる", check_empty_token_file),
    ("トークン: LoadCredential の場所から読む", check_credentials_directory),
    ("--check: 読めれば成功し、起動はしない", check_check_ok),
    ("--check: 無効化されたワークフローを検出する", check_check_disabled),
    ("--check: 認証の失敗を検出する", check_check_unauthorized),
    ("引数の誤りは通信せずに止まる", check_bad_argument),
    ("導入: 初回は配置・権限・有効化・確認まで行う", check_install_fresh),
    ("導入: 再実行してもトークンを保つ", check_install_rerun_keeps_token),
    ("導入: --rotate-token で差し替える", check_install_rotate),
    ("導入: --rotate-token に空を渡しても旧トークンを保つ", check_install_rotate_empty_keeps_old),
    ("導入: systemd 247 未満なら何も置かない", check_install_old_systemd),
    ("導入: 確認に失敗したら失敗で終え、直し方を示す", check_install_check_fails),
]


def main():
    fails = 0
    for name, fn in CHECKS:
        sb = Sandbox()
        try:
            got = fn(sb)
        except Exception as e:                                # noqa: BLE001
            got = f"{type(e).__name__}: {e}"
        finally:
            sb.close()
        if got is not True:
            print(f"✗ {name}\n    {got}")
            fails += 1
    print(f"\n{len(CHECKS) - fails}/{len(CHECKS)} 件が期待どおり")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
