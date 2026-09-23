/* 予備起動（.github/scripts/collect-fallback.cjs）の判定と、起動時刻を持つ3か所の整合の検証。

   予備は「Pi のタイマーが起動しなかった枠だけ」を起動しなければならない。
   起動しすぎれば収集が2回走り、起動しなさすぎればその日の収集が抜ける。どちらも
   深夜に無人で起き、その場では誰も気づかないので、判定を純粋関数として固定する。

   起動時刻は3か所が別々に持っている（Pi のタイマー・予備の cron・予備の判定の定数）。
   どれか1つだけ直すと「タイマーは起動したのに予備も起動する」ずれが生まれるため、
   その一致もここで見る。

   使い方（リポジトリのルートから。ネットワーク不要）:
     node tools/collect_fallback_test.mjs
*/

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const fb = require("../.github/scripts/collect-fallback.cjs");

const failures = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}${ok ? "" : `  — ${JSON.stringify(got)} (期待: ${JSON.stringify(want)})`}`,
  );
  if (!ok) failures.push(name);
};

const T = (s) => new Date(s);
const iso = (d) => d.toISOString();
const USER = { login: "yusuke-1105" };
const BOT = { login: "github-actions[bot]" };
const runAt = (created_at, actor = USER, event = "workflow_dispatch") => ({
  id: Date.parse(created_at),
  created_at,
  event,
  actor,
  triggering_actor: actor,
  html_url: `https://example.test/runs/${created_at}`,
});

console.log("\n--- 起動の枠（latestSlot） ---");
const slotCases = [
  [
    "火曜17:30ちょうどはその枠",
    "2026-09-22T17:30:00Z",
    "2026-09-22T17:30:00.000Z",
  ],
  [
    "火曜17:29:59は先週木曜の枠",
    "2026-09-22T17:29:59Z",
    "2026-09-17T17:30:00.000Z",
  ],
  [
    "2026-09-22 の実際の発火時刻（20:16）",
    "2026-09-22T20:16:04Z",
    "2026-09-22T17:30:00.000Z",
  ],
  [
    "UTC の日付をまたいでも前日の枠",
    "2026-09-23T00:30:00Z",
    "2026-09-22T17:30:00.000Z",
  ],
  [
    "木曜の枠のあと金曜は木曜の枠",
    "2026-09-25T10:00:00Z",
    "2026-09-24T17:30:00.000Z",
  ],
  ["土曜も木曜の枠", "2026-09-26T12:00:00Z", "2026-09-24T17:30:00.000Z"],
  ["月曜も先週木曜の枠", "2026-09-28T23:59:59Z", "2026-09-24T17:30:00.000Z"],
  [
    "月をまたぐ（10/1木 03:00 → 9/30水の枠）",
    "2026-10-01T03:00:00Z",
    "2026-09-30T17:30:00.000Z",
  ],
  [
    "年をまたぐ（2027/1/1金 → 12/31木の枠）",
    "2027-01-01T05:00:00Z",
    "2026-12-31T17:30:00.000Z",
  ],
];
for (const [name, now, want] of slotCases)
  check(name, iso(fb.latestSlot(T(now))), want);

console.log("\n--- 判定（decide） ---");
const SLOT = "2026-09-22T17:30:00Z";
const at = (min) => new Date(Date.parse(SLOT) + min * 60000);
const pick = (d) => ({
  action: d.action,
  by: d.byTimerOrHuman,
  run: d.run ? d.run.created_at : undefined,
});

check("何も起動されていなければ起動する", pick(fb.decide(at(20), [])), {
  action: "dispatch",
});
check(
  "タイマーの回があれば起動しない",
  pick(fb.decide(at(20), [runAt("2026-09-22T17:30:04Z")])),
  { action: "covered", by: true, run: "2026-09-22T17:30:04Z" },
);
check(
  "当日昼の手動実行は枠の起動に数えない（実際の 2026-09-22 の状況）",
  pick(fb.decide(T("2026-09-22T20:16:04Z"), [runAt("2026-09-22T07:33:59Z")]))
    .action,
  "dispatch",
);
check(
  "枠の10分前までの起動は数える（時計のずれ）",
  pick(fb.decide(at(20), [runAt("2026-09-22T17:20:00Z")])).action,
  "covered",
);
check(
  "枠の10分より前の起動は数えない",
  pick(fb.decide(at(20), [runAt("2026-09-22T17:19:59Z")])).action,
  "dispatch",
);
check(
  "予備自身が起動した回で埋まっていてもタイマーの回復とはみなさない",
  pick(fb.decide(at(140), [runAt("2026-09-22T17:52:00Z", BOT)])),
  { action: "covered", by: false, run: "2026-09-22T17:52:00Z" },
);
check(
  "複数あれば最も早い回で判断する",
  pick(
    fb.decide(at(140), [
      runAt("2026-09-22T19:51:00Z", BOT),
      runAt("2026-09-22T17:30:02Z"),
    ]),
  ),
  { action: "covered", by: true, run: "2026-09-22T17:30:02Z" },
);
check(
  "triggering_actor が無ければ actor で判断する",
  pick(
    fb.decide(at(30), [
      { ...runAt("2026-09-22T17:30:02Z"), triggering_actor: undefined },
    ]),
  ).by,
  true,
);
check(
  "枠から19時間59分なら起動する",
  fb.decide(at(19 * 60 + 59), []).action,
  "dispatch",
);
check(
  "枠から20時間を過ぎたら起動しない（JST の日付をまたぐ前に止める）",
  fb.decide(at(20 * 60 + 1), []).action,
  "too-late",
);
check(
  "20時間を過ぎていても起動済みなら covered",
  fb.decide(at(20 * 60 + 1), [runAt("2026-09-22T17:30:02Z")]).action,
  "covered",
);

console.log("\n--- 実行（run）: GitHub API への副作用 ---");
function fakeGitHub({ runs = [], openIssues = [], appearAfterPolls = 1 } = {}) {
  const calls = [];
  let dispatched = false;
  let polls = 0;
  const github = {
    rest: {
      actions: {
        listWorkflowRuns: async (p) => {
          calls.push(["listWorkflowRuns", p]);
          if (dispatched) polls++;
          const extra =
            dispatched && polls >= appearAfterPolls
              ? [runAt("2026-09-22T17:50:30Z", BOT)]
              : [];
          return { data: { workflow_runs: [...extra, ...runs] } };
        },
        createWorkflowDispatch: async (p) => {
          calls.push(["createWorkflowDispatch", p]);
          dispatched = true;
        },
      },
      issues: {
        listForRepo: async (p) => {
          calls.push(["listForRepo", p]);
          return { data: openIssues };
        },
        create: async (p) => calls.push(["create", p]),
        createComment: async (p) => calls.push(["createComment", p]),
        update: async (p) => calls.push(["update", p]),
      },
    },
  };
  return { github, calls };
}
const context = {
  repo: { owner: "the-ready", repo: "player-one" },
  serverUrl: "https://github.com",
};
const logs = [];
const core = {
  info: (m) => logs.push(["info", m]),
  warning: (m) => logs.push(["warning", m]),
};
const names = (calls) => calls.map((c) => c[0]);
let sleeps = 0;
const sleep = async () => {
  sleeps++;
};
const OPEN = [{ number: 42, html_url: "https://example.test/issues/42" }];

{
  const { github, calls } = fakeGitHub({ appearAfterPolls: 2 });
  sleeps = 0;
  const d = await fb.run({ github, context, core, now: at(20), sleep });
  check(
    "未起動: 起動し、実行が現れるまで待ち、Issue を起票する",
    names(calls),
    [
      "listWorkflowRuns",
      "createWorkflowDispatch",
      "listWorkflowRuns",
      "listWorkflowRuns",
      "listForRepo",
      "create",
    ],
  );
  check("未起動: 実行が現れるまで5秒ずつ待つ", sleeps, 2);
  check("未起動: 起動の引数", calls[1][1], {
    owner: "the-ready",
    repo: "player-one",
    workflow_id: "weekly-collect.yml",
    ref: "main",
  });
  check(
    "未起動: 一覧は枠の10分前から（ミリ秒なし）",
    calls[0][1].created,
    ">=2026-09-22T17:20:00Z",
  );
  const issue = calls.find((c) => c[0] === "create")[1];
  check("未起動: Issue のラベル", issue.labels, ["routine-timer"]);
  check(
    "未起動: Issue の題に JST の日付",
    issue.title.includes("2026-09-23"),
    true,
  );
  check(
    "未起動: Issue に serverUrl から組んだリンク",
    issue.body.includes(
      "https://github.com/the-ready/player-one/actions/workflows/weekly-collect.yml",
    ),
    true,
  );
  check(
    "未起動: 起動した実行を返す",
    d.created && d.created.created_at,
    "2026-09-22T17:50:30Z",
  );
}
{
  const { github, calls } = fakeGitHub({ openIssues: OPEN });
  await fb.run({ github, context, core, now: at(20), sleep });
  check(
    "未起動・Issue が既に開いている: 起票は重ねない",
    names(calls).includes("create"),
    false,
  );
  check(
    "未起動・Issue が既に開いている: 起動はする",
    names(calls).includes("createWorkflowDispatch"),
    true,
  );
}
{
  const { github, calls } = fakeGitHub({ appearAfterPolls: 99 });
  sleeps = 0;
  logs.length = 0;
  await fb.run({ github, context, core, now: at(20), sleep });
  check("未起動・実行が現れない: 60秒（12回）で待つのをやめる", sleeps, 12);
  check(
    "未起動・実行が現れない: 警告を出す",
    logs.some(([k, m]) => k === "warning" && m.includes("60秒")),
    true,
  );
}
{
  const { github, calls } = fakeGitHub({
    runs: [runAt("2026-09-22T17:30:04Z")],
    openIssues: OPEN,
  });
  await fb.run({ github, context, core, now: at(20), sleep });
  check(
    "タイマーが起動済み: 開いている Issue に一言添えて close する",
    names(calls),
    ["listWorkflowRuns", "listForRepo", "createComment", "update"],
  );
  check("タイマーが起動済み: close の引数", calls[3][1], {
    owner: "the-ready",
    repo: "player-one",
    issue_number: 42,
    state: "closed",
  });
}
{
  const { github, calls } = fakeGitHub({
    runs: [runAt("2026-09-22T17:30:04Z")],
  });
  await fb.run({ github, context, core, now: at(20), sleep });
  check("タイマーが起動済み・Issue 無し: 何も変えない", names(calls), [
    "listWorkflowRuns",
    "listForRepo",
  ]);
}
{
  const { github, calls } = fakeGitHub({
    runs: [runAt("2026-09-22T17:52:00Z", BOT)],
    openIssues: OPEN,
  });
  await fb.run({ github, context, core, now: at(140), sleep });
  check(
    "2本目の予備（1本目が起動済み）: 起動も Issue の変更もしない",
    names(calls),
    ["listWorkflowRuns"],
  );
}
{
  const { github, calls } = fakeGitHub();
  await fb.run({ github, context, core, now: at(20 * 60 + 1), sleep });
  check("20時間超過: 起動せず Issue だけ起票する", names(calls), [
    "listWorkflowRuns",
    "listForRepo",
    "create",
  ]);
  check(
    "20時間超過: Issue は起動していないと書く",
    calls[2][1].body.includes("起動していません"),
    true,
  );
}
{
  const { github, calls } = fakeGitHub();
  await fb.run({ github, context, core, now: at(20), dryRun: true, sleep });
  check("dry_run・未起動: 読むだけで何も変えない", names(calls), [
    "listWorkflowRuns",
    "listForRepo",
  ]);
}
{
  const { github, calls } = fakeGitHub({
    runs: [runAt("2026-09-22T17:30:04Z")],
    openIssues: OPEN,
  });
  await fb.run({ github, context, core, now: at(20), dryRun: true, sleep });
  check("dry_run・起動済み: Issue を close しない", names(calls), [
    "listWorkflowRuns",
    "listForRepo",
  ]);
}

console.log("\n--- 起動時刻を持つ3か所の整合 ---");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fallbackYml = read(".github/workflows/collect-fallback.yml");
const weeklyYml = read(".github/workflows/weekly-collect.yml");
const timer = read(".claude/systemd/player-one-dispatch.timer");
const service = read(".claude/systemd/player-one-dispatch.service");
const routineSkill = read(".claude/skills/weekly-routine/SKILL.md");

check(
  "weekly-collect.yml は schedule を持たない（タイマーと二重に起動しない）",
  /^\s*schedule:/m.test(weeklyYml),
  false,
);
check(
  "weekly-collect.yml は workflow_dispatch で起動できる",
  /^\s*workflow_dispatch:/m.test(weeklyYml),
  true,
);

// タイマー: JST の曜日・時刻を UTC に直すと、判定の定数と一致する
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const cal = timer.match(
  /^OnCalendar=(\w{3})\.\.(\w{3}) \*-\*-\* (\d{2}):(\d{2}):00 Asia\/Tokyo$/m,
);
check("タイマーは Asia/Tokyo の曜日範囲と時刻で書かれている", !!cal, true);
if (cal) {
  const jstDays = [];
  for (let d = DOW[cal[1]]; d <= DOW[cal[2]]; d++) jstDays.push(d);
  const jstMin = Number(cal[3]) * 60 + Number(cal[4]);
  const utcMin = jstMin - 9 * 60;
  const shift = utcMin < 0 ? -1 : 0;
  const utcDays = jstDays.map((d) => (d + shift + 7) % 7);
  check("タイマーの曜日（UTC）= 予備の枠の曜日", utcDays, fb.SLOT_UTC_DAYS);
  check(
    "タイマーの時刻（UTC）= 予備の枠の時刻",
    (utcMin + 1440) % 1440,
    fb.SLOT_UTC_HOUR * 60 + fb.SLOT_UTC_MINUTE,
  );
  // weekly-routine の対応表（date +%u: 月=1…日=7）の水木金の行と一致する
  const block = routineSkill.split("```schedule")[1].split("```")[0];
  const rows = block
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((c) => /^\d$/.test(c))
    .map(Number);
  check(
    "タイマーの曜日（JST）= weekly-routine の対応表の曜日",
    jstDays.map((d) => (d === 0 ? 7 : d)),
    rows,
  );
}
check(
  "タイマーは停止中に過ぎた回を取り戻さない",
  /^Persistent=false$/m.test(timer),
  true,
);

// 予備の cron: 曜日が枠と同じで、タイマーの再試行が終わってから、20時間以内に見る
const timeoutMin = Number(service.match(/^TimeoutStartSec=(\d+)min$/m)[1]);
const crons = [
  ...fallbackYml.matchAll(/cron:\s*"(\d+) (\d+) \* \* ([\d,]+)"/g),
];
check("予備の cron が2本ある", crons.length, 2);
for (const [, m, h, days] of crons) {
  const after =
    Number(h) * 60 + Number(m) - (fb.SLOT_UTC_HOUR * 60 + fb.SLOT_UTC_MINUTE);
  check(
    `予備 ${h}:${m} UTC の曜日 = 枠の曜日`,
    days.split(",").map(Number),
    fb.SLOT_UTC_DAYS,
  );
  check(
    `予備 ${h}:${m} UTC はタイマーの打ち切り（${timeoutMin}分）より後・20時間以内`,
    after > timeoutMin && after * 60000 < fb.MAX_LATE_MS,
    true,
  );
  check(`予備 ${h}:${m} UTC は毎時00分台を避ける`, Number(m) !== 0, true);
}
check(
  "予備のワークフローは判定モジュールを読む",
  fallbackYml.includes('require("./.github/scripts/collect-fallback.cjs")'),
  true,
);

// systemd があれば、タイマーの実際の発火時刻（UTC）を systemd 自身に計算させて突き合わせる
try {
  const out = execFileSync(
    "systemd-analyze",
    [
      "calendar",
      "--iterations=6",
      cal ? cal[0].replace("OnCalendar=", "") : "",
    ],
    { encoding: "utf8", env: { ...process.env, TZ: "UTC" } },
  );
  const elapses = [
    ...out.matchAll(/(?:Next elapse|Iteration #\d+): \w{3} (\S+ \S+) UTC/g),
  ].map((m) => new Date(`${m[1].replace(" ", "T")}Z`));
  check(
    "systemd が計算した6回がすべて枠と一致",
    elapses.length === 6 &&
      elapses.every((e) => iso(fb.latestSlot(e)) === iso(e)),
    true,
  );
} catch (e) {
  console.log(
    `  --  systemd-analyze が無いので、実際の発火時刻との突き合わせは省略（${e.code || e.message}）`,
  );
}

console.log(
  failures.length
    ? `\nNG ${failures.length}件: ${failures.join(", ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
