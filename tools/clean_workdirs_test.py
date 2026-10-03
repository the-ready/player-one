#!/usr/bin/env python3
"""`tools/clean_workdirs.py` の判定と削除を検証する（ネットワーク不要・一時ディレクトリの中だけで動く）。

    python3 tools/clean_workdirs_test.py

**削除の道具は、消しすぎると取り返しがつかない。** 守りたいのは「古いものだけを消す」ことより、
「消してはいけないものを消さない」ことなので、後者（`data/.prev/`・ロック・実行中の状態・
リンクの先・リポジトリの外）を先に固定している。
"""

import io
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clean_workdirs as cw                                   # noqa: E402

DAY = cw.DAY
NOW = 2_000_000_000.0     # 基準時刻（固定）
# failed/ のディレクトリ名は日時なので、基準時刻から逆算して作る
STAMP_OLD = datetime.fromtimestamp(NOW - 60 * 86400).strftime("%Y%m%d-%H%M%S")
STAMP_NEW = datetime.fromtimestamp(NOW - 3 * 86400).strftime("%Y%m%d-%H%M%S")

failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok    {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        failures.append(name)


def touch(path, age_days, content="x"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)
    t = NOW - age_days * DAY
    os.utime(path, (t, t))


def age_dir(path, age_days):
    t = NOW - age_days * DAY
    os.utime(path, (t, t))


def run(root, *args):
    out, err = io.StringIO(), io.StringIO()
    rc = cw.main(list(args), root=root, now=NOW, out=out, err=err)
    return rc, out.getvalue(), err.getvalue()


def exists(root, rel):
    return os.path.lexists(os.path.join(root, rel))


def build(root):
    # temp/
    touch(f"{root}/temp/old.jsonl", 10)
    touch(f"{root}/temp/new.jsonl", 0.5)
    touch(f"{root}/temp/edge-just-under.md", 2.9)
    touch(f"{root}/temp/edge-exactly.md", 3.0)
    touch(f"{root}/temp/.gitkeep", 100)
    touch(f"{root}/temp/olddir/a.txt", 20)
    age_dir(f"{root}/temp/olddir", 20)
    touch(f"{root}/temp/activedir/old.txt", 20)       # 中身が最近書かれたディレクトリ
    touch(f"{root}/temp/activedir/fresh.txt", 0.1)
    age_dir(f"{root}/temp/activedir", 20)
    # logs
    for n in ("routine", "investigate", "repair"):
        touch(f"{root}/.claude/logs/{n}_2026-01-01.log", 60)
        touch(f"{root}/.claude/logs/{n}_2026-09-30.log", 3)
    touch(f"{root}/.claude/logs/notes.txt", 400)                  # 名前の形が違う：触らない
    touch(f"{root}/.claude/logs/routine_2026-01-01.log.bak", 400)  # 同上
    touch(f"{root}/.claude/logs/.run.ABC123/state.json", 400)      # 実行中の状態：触らない
    # failed
    touch(f"{root}/.claude/logs/failed/{STAMP_OLD}/data.csv", 1)   # 中身は新しいが、名前の日時が古い
    touch(f"{root}/.claude/logs/failed/{STAMP_NEW}/data.csv", 400)  # 中身は古いが、名前の日時が新しい
    touch(f"{root}/.claude/logs/failed/odd-name/x", 90)
    age_dir(f"{root}/.claude/logs/failed/odd-name", 90)
    # robots
    touch(f"{root}/data/.robots/old.example.txt", 30)
    touch(f"{root}/data/.robots/new.example.txt", 1)
    touch(f"{root}/data/.robots/_access.json", 1)
    # 触ってはいけないもの
    touch(f"{root}/data/.prev/events.csv", 400)
    touch(f"{root}/data/.run/budget.json", 400)
    touch(f"{root}/data/events.csv", 400)
    touch(f"{root}/tools/some.py", 400)


NEVER = [
    "data/.prev/events.csv", "data/.run/budget.json", "data/events.csv", "tools/some.py",
    "temp/.gitkeep", ".claude/logs/notes.txt", ".claude/logs/routine_2026-01-01.log.bak",
    ".claude/logs/.run.ABC123/state.json",
]


def test_dry_run_deletes_nothing():
    print("既定（--apply なし）は何も消さない")
    with tempfile.TemporaryDirectory() as root:
        build(root)
        before = sorted(os.path.join(dp, f) for dp, _, fs in os.walk(root) for f in fs)
        rc, out, _ = run(root)
        after = sorted(os.path.join(dp, f) for dp, _, fs in os.walk(root) for f in fs)
        check("終了コード0", rc == 0)
        check("ファイルの集合が変わらない", before == after)
        check("候補が一覧に出る", "temp/old.jsonl" in out and "候補" in out)


def test_apply_removes_only_old():
    print("--apply は古いものだけを消す")
    with tempfile.TemporaryDirectory() as root:
        build(root)
        rc, out, err = run(root, "--apply")
        check("終了コード0", rc == 0, err)
        # 消える
        for rel in ("temp/old.jsonl", "temp/edge-exactly.md", "temp/olddir",
                    ".claude/logs/routine_2026-01-01.log",
                    ".claude/logs/investigate_2026-01-01.log",
                    ".claude/logs/repair_2026-01-01.log",
                    f".claude/logs/failed/{STAMP_OLD}", ".claude/logs/failed/odd-name",
                    "data/.robots/old.example.txt"):
            check(f"消える: {rel}", not exists(root, rel))
        # 残る
        for rel in ("temp/new.jsonl", "temp/edge-just-under.md", "temp/activedir/old.txt",
                    "temp/activedir/fresh.txt",
                    ".claude/logs/routine_2026-09-30.log",
                    ".claude/logs/investigate_2026-09-30.log",
                    ".claude/logs/repair_2026-09-30.log",
                    f".claude/logs/failed/{STAMP_NEW}",
                    "data/.robots/new.example.txt", "data/.robots/_access.json"):
            check(f"残る: {rel}", exists(root, rel))


def test_never_touch():
    print("消してはいけないものは、どれだけ古くても残る")
    with tempfile.TemporaryDirectory() as root:
        build(root)
        run(root, "--apply")
        for rel in NEVER:
            check(f"残る: {rel}", exists(root, rel))
        check("temp/ 自体が残る", os.path.isdir(os.path.join(root, "temp")))
        check("data/.robots/ 自体が残る", os.path.isdir(os.path.join(root, "data/.robots")))
        check(".claude/logs/failed/ 自体が残る", os.path.isdir(os.path.join(root, ".claude/logs/failed")))


def test_missing_dirs():
    print("対象のディレクトリが無くても落ちない")
    with tempfile.TemporaryDirectory() as root:
        rc, out, err = run(root, "--apply")
        check("終了コード0", rc == 0, err)
        check("0件と出る", "0件" in out)


def test_symlinks():
    print("リンクは辿らない（先を消さない）")
    with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
        touch(f"{outside}/precious.csv", 400)
        os.makedirs(f"{root}/temp")
        os.symlink(f"{outside}/precious.csv", f"{root}/temp/link.csv")
        os.symlink(outside, f"{root}/temp/linkdir")
        for n in ("link.csv", "linkdir"):
            t = NOW - 30 * DAY
            os.utime(f"{root}/temp/{n}", (t, t), follow_symlinks=False)
        rc, _, err = run(root, "--apply")
        check("リンク自体は消える", not exists(root, "temp/link.csv") and not exists(root, "temp/linkdir"), err)
        check("リンク先のファイルは残る", os.path.exists(f"{outside}/precious.csv"))
        check("リンク先のディレクトリは残る", os.path.isdir(outside))


def test_base_symlink_escape():
    print("対象ディレクトリ自体が外を指すなら何もしない")
    with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
        touch(f"{outside}/old.txt", 400)
        os.symlink(outside, f"{root}/temp")
        rc, out, err = run(root, "--apply")
        check("外のファイルは残る", os.path.exists(f"{outside}/old.txt"))
        check("警告が出る", "外を指している" in err)


def test_lock():
    print("実行中の週次ルーチンがあれば断る")
    with tempfile.TemporaryDirectory() as root:
        build(root)
        lock = os.path.join(root, cw.LOCK_REL)
        os.makedirs(lock)
        with open(os.path.join(lock, "pid"), "w") as f:
            f.write(str(os.getpid()))             # このテスト自身＝生きているプロセス
        rc, _, err = run(root, "--apply")
        check("終了コード2", rc == 2, err)
        check("何も消えていない", exists(root, "temp/old.jsonl"))
        rc, out, _ = run(root)
        check("一覧だけならロック中でも見られる", rc == 0 and "temp/old.jsonl" in out)
        rc, _, err = run(root, "--apply", "--from-routine")
        check("--from-routine なら進む", rc == 0 and not exists(root, "temp/old.jsonl"), err)


def test_stale_lock():
    print("持ち主が居ない残存ロックは断る理由にしない")
    with tempfile.TemporaryDirectory() as root:
        build(root)
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()                                  # 終了済みの pid を得る
        lock = os.path.join(root, cw.LOCK_REL)
        os.makedirs(lock)
        with open(os.path.join(lock, "pid"), "w") as f:
            f.write(str(p.pid))
        rc, _, err = run(root, "--apply")
        check("消せる", rc == 0 and not exists(root, "temp/old.jsonl"), err)


def test_unreadable_lock():
    print("pid が読めないロックは、実行中かもしれないので断る")
    with tempfile.TemporaryDirectory() as root:
        build(root)
        os.makedirs(os.path.join(root, cw.LOCK_REL))      # pid ファイル無し
        rc, _, _ = run(root, "--apply")
        check("終了コード2", rc == 2)
        check("何も消えていない", exists(root, "temp/old.jsonl"))


def test_real_repo_not_touched_by_tests():
    print("このテスト自体はリポジトリの実体に触れていない")
    check("ROOT は一時ディレクトリではない", not cw.ROOT.startswith(tempfile.gettempdir()))


def _routine_block():
    """claude-routine.sh の掃除の呼び出し部分（コメントの見出し行から最初の `fi` まで）を取り出す。"""
    path = os.path.join(cw.ROOT, ".claude", "scripts", "claude-routine.sh")
    lines, grab = [], False
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("# temp/・ログ・robots キャッシュの古い残骸を片付ける"):
                grab = True
            if grab:
                lines.append(line)
                if line.rstrip("\n") == "fi":
                    break
    return "".join(lines)


def test_routine_wiring():
    print("claude-routine.sh からの呼び出し（結線）")
    block = _routine_block()
    check("呼び出しのブロックが見つかる", "clean_workdirs.py" in block and block.rstrip().endswith("fi"))
    with tempfile.TemporaryDirectory() as sb:
        os.makedirs(f"{sb}/tools")
        with open(os.path.join(cw.ROOT, "tools", "clean_workdirs.py"), encoding="utf-8") as src, \
                open(f"{sb}/tools/clean_workdirs.py", "w", encoding="utf-8") as dst:
            dst.write(src.read())
        touch(f"{sb}/temp/old.txt", 10)
        touch(f"{sb}/temp/new.txt", 0)
        # 実時間で判定されるので、古さは現在時刻から作り直す
        t = time.time() - 10 * DAY
        os.utime(f"{sb}/temp/old.txt", (t, t))
        os.utime(f"{sb}/temp/new.txt", (time.time(), time.time()))
        lock = f"{sb}/.claude/logs/.routine.lock"
        os.makedirs(lock)
        with open(f"{lock}/pid", "w") as f:
            f.write(str(os.getpid()))               # 呼び出し側が自分のロックを持っている状況
        harness = (
            "set -u; set -o pipefail\n"
            f"REPO_DIR={sb}\n"
            'log(){ echo "LOG: $*"; }\n'
            'log_output(){ echo "LOGOUT: $1"; }\n'
            f"{block}\n"
            'echo reached-end\n'
        )

        def go():
            r = subprocess.run(["bash", "-c", harness], capture_output=True, text=True)
            return r.returncode, r.stdout, r.stderr

        rc, out, err = go()
        check("最後まで進む", rc == 0 and "reached-end" in out, err)
        check("自分のロックを理由に断られず、古いものが消える", not os.path.exists(f"{sb}/temp/old.txt"), out)
        check("新しいものは残る", os.path.exists(f"{sb}/temp/new.txt"))
        check("ログに件数の行が1行出る", out.count("LOG: 作業ディレクトリの古い残骸を片付けました") == 1, out)
        check("一覧はログに流さない", "temp/old.txt" not in out)

        rc, out, err = go()
        check("消すものが無い回はログを出さない", rc == 0 and "LOG:" not in out, out)

        with open(f"{sb}/tools/clean_workdirs.py", "w", encoding="utf-8") as f:
            f.write("import sys\nprint('boom')\nsys.exit(7)\n")
        rc, out, err = go()
        check("道具が壊れていても収集は止まらない", rc == 0 and "reached-end" in out, err)
        check("WARNING を残す", "WARNING: 作業ディレクトリの掃除が終了コード 7" in out, out)

        os.remove(f"{sb}/tools/clean_workdirs.py")
        rc, out, err = go()
        check("道具が無くても進む", rc == 0 and "reached-end" in out and "LOG:" not in out, out)


if __name__ == "__main__":
    test_dry_run_deletes_nothing()
    test_apply_removes_only_old()
    test_never_touch()
    test_missing_dirs()
    test_symlinks()
    test_base_symlink_escape()
    test_lock()
    test_stale_lock()
    test_unreadable_lock()
    test_real_repo_not_touched_by_tests()
    test_routine_wiring()
    if failures:
        print(f"\nFAILED: {len(failures)}件")
        sys.exit(1)
    print("\nOK")
