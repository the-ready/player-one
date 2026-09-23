// collect-fallback.yml から actions/github-script 経由で呼ばれる（docs/DESIGN.md 第13.3節）。
//
// 収集の起動は Pi の systemd タイマーが 02:30 JST に workflow_dispatch で行う。ここは
// その回が起動されなかったときだけ、代わりに起動を依頼する予備である。判定を純粋関数
// （latestSlot / decide）に切り出しているのは、tools/collect_fallback_test.mjs で
// ネットワーク無しに検証するため。

const WORKFLOW = "weekly-collect.yml";
const REF = "main";
const TIMER_LABEL = "routine-timer";
const BOT_LOGIN = "github-actions[bot]";

// 起動の枠: UTC 火水木 17:30 = JST 水木金 02:30。
// Pi のタイマー（.claude/systemd/player-one-dispatch.timer）と揃えること。
const SLOT_UTC_DAYS = [2, 3, 4];
const SLOT_UTC_HOUR = 17;
const SLOT_UTC_MINUTE = 30;

// 枠の少し前に作られた実行も、その枠の実行として数える（Pi の時計のずれ・手動の前倒し）
const GRACE_BEFORE_MS = 10 * 60 * 1000;
// これより遅れたら起動しない。Pi 側は起動時点の曜日でスキルを選ぶ（claude-routine.sh の
// `date +%u`）ので、JST の日付をまたいで起動すると別の曜日のスキルが走ってしまう。
// 枠（02:30 JST）から日付が変わる 24:00 JST までは21.5時間あり、余裕を見て20時間で切る。
const MAX_LATE_MS = 20 * 60 * 60 * 1000;

// now 以前で最も新しい起動の枠
function latestSlot(now) {
  for (let back = 0; back <= 7; back++) {
    const d = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - back,
        SLOT_UTC_HOUR,
        SLOT_UTC_MINUTE,
      ),
    );
    if (SLOT_UTC_DAYS.includes(d.getUTCDay()) && d.getTime() <= now.getTime())
      return d;
  }
  throw new Error("起動の枠が見つかりません（SLOT_UTC_DAYS が空？）");
}

// runs: weekly-collect.yml の実行（GitHub API の workflow_runs の要素）
function decide(now, runs) {
  const slot = latestSlot(now);
  const windowStart = new Date(slot.getTime() - GRACE_BEFORE_MS);
  const covering = runs
    .filter((r) => Date.parse(r.created_at) >= windowStart.getTime())
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (covering.length > 0) {
    const run = covering[0];
    const login = (run.triggering_actor || run.actor || {}).login;
    // この予備自身が起動した回（github-actions[bot]）で埋まっているなら、タイマーが
    // 動いた証拠にはならない
    return {
      action: "covered",
      slot,
      windowStart,
      run,
      byTimerOrHuman: login !== BOT_LOGIN,
    };
  }
  if (now.getTime() - slot.getTime() > MAX_LATE_MS) {
    return { action: "too-late", slot, windowStart };
  }
  return { action: "dispatch", slot, windowStart };
}

const jst = (d) =>
  new Date(d.getTime() + 9 * 3600 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 16) + " JST";

async function listRunsSince(github, repo, since) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: WORKFLOW,
    // 検索の日時指定はミリ秒を含まない形（YYYY-MM-DDTHH:MM:SSZ）で渡す
    created: `>=${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    per_page: 20,
  });
  return data.workflow_runs;
}

async function openTimerIssues(github, repo) {
  const { data } = await github.rest.issues.listForRepo({
    ...repo,
    state: "open",
    labels: TIMER_LABEL,
  });
  return data;
}

async function run({
  github,
  context,
  core,
  now = new Date(),
  dryRun = false,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const repoUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}`;
  const slot = latestSlot(now);
  const runs = await listRunsSince(
    github,
    repo,
    new Date(slot.getTime() - GRACE_BEFORE_MS),
  );
  const d = decide(now, runs);
  core.info(
    `起動の枠: ${jst(d.slot)}（${d.slot.toISOString()}）／判定: ${d.action}`,
  );

  if (d.action === "covered") {
    core.info(
      `この枠は既に起動されています: ${d.run.html_url}（${d.run.event}・${jst(new Date(d.run.created_at))}）`,
    );
    if (!d.byTimerOrHuman) return d;
    const open = await openTimerIssues(github, repo);
    for (const issue of open) {
      core.info(
        `タイマーの回復を確認したので Issue #${issue.number} を close します`,
      );
      if (dryRun) continue;
      await github.rest.issues.createComment({
        ...repo,
        issue_number: issue.number,
        body: `${jst(d.slot)} の枠は予備を待たずに起動されました（${d.run.html_url}）。自動で close します。`,
      });
      await github.rest.issues.update({
        ...repo,
        issue_number: issue.number,
        state: "closed",
      });
    }
    return d;
  }

  if (d.action === "dispatch") {
    core.warning(
      `${jst(d.slot)} の枠が起動されていません。予備として起動を依頼します`,
    );
    if (!dryRun) {
      await github.rest.actions.createWorkflowDispatch({
        ...repo,
        workflow_id: WORKFLOW,
        ref: REF,
      });
      // 実行が一覧に現れるまで待つ。すぐに終えると、続けて走る予備（2本目の cron）が
      // まだ一覧に無い実行を見落として二重に起動しうるため。
      let created = null;
      for (let i = 0; i < 12 && !created; i++) {
        await sleep(5000);
        created = (await listRunsSince(github, repo, d.windowStart))[0] || null;
      }
      if (created) core.info(`起動しました: ${created.html_url}`);
      else
        core.warning(
          "起動を依頼しましたが、60秒待っても実行が一覧に現れません",
        );
      d.created = created;
    }
  } else {
    core.warning(
      `${jst(d.slot)} の枠から20時間以上過ぎています。日付をまたいで別の曜日のスキルが走るのを避けるため、起動しません`,
    );
  }

  const open = await openTimerIssues(github, repo);
  if (open.length > 0) {
    core.info(
      `タイマーの Issue は既に開いています: ${open[0].html_url}（追加の起票はしません）`,
    );
    return d;
  }
  const what =
    d.action === "dispatch"
      ? "予備の collect-fallback.yml が代わりに起動を依頼しました（時刻どおりには始まっていません）。"
      : "予備の起動も枠から20時間以上遅れたため、この回は起動していません。";
  const body = [
    `${jst(d.slot)} の週次収集が、Raspberry Pi のタイマーから起動されませんでした。${what}`,
    "",
    "考えられる原因:",
    "- Pi が停止している・ネットワークに出られない",
    "- タイマーが入っていない・止まっている（`systemctl list-timers player-one-dispatch.timer`）",
    "- トークンの失効・権限不足（`sudo /usr/local/lib/player-one/dispatch-routine.sh --check` で確かめられる）",
    "",
    "Pi 上で `journalctl -u player-one-dispatch.service --since yesterday` を確認してください。",
    "トークンの差し替えは `sudo .claude/scripts/install-dispatch-timer.sh --rotate-token`（docs/DESIGN.md 第13.7節）。",
    "",
    `[weekly-collect.yml の実行一覧](${repoUrl}/actions/workflows/${WORKFLOW})`,
    "",
    "次にタイマーが時刻どおり起動した枠で、このIssueは自動で close されます。",
  ].join("\n");
  core.info("タイマーの不調を知らせる Issue を起票します");
  if (!dryRun) {
    await github.rest.issues.create({
      ...repo,
      title: `週次収集が Pi のタイマーから起動されませんでした（${jst(d.slot).slice(0, 10)}）`,
      labels: [TIMER_LABEL],
      body,
    });
  }
  return d;
}

module.exports = {
  WORKFLOW,
  REF,
  TIMER_LABEL,
  SLOT_UTC_DAYS,
  SLOT_UTC_HOUR,
  SLOT_UTC_MINUTE,
  GRACE_BEFORE_MS,
  MAX_LATE_MS,
  latestSlot,
  decide,
  run,
};
