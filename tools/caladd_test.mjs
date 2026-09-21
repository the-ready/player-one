/* カレンダーに追加する日付の初期値（設計書 第5.10節）の回帰テスト。

   分岐が「飛び日程／会期中／これから／終了済み」の4つあり、どれも
   「今日」ではなく「明日」を起点にする。画面を開かないと分からない値だと
   直したつもりの回帰に気づけないので、純粋関数としてここで固定する。
   DOMもデータファイルも要らない（schedule.js は util.js と config.js しか見ない）。

   使い方（リポジトリのルートから）:
     node tools/caladd_test.mjs
*/

import { suggestedVisitDate } from "../assets/js/schedule.js";

const failures = [];
const check = (name, got, want) => {
  const ok = got === want;
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}  — ${got}${ok ? "" : ` (期待: ${want})`}`,
  );
  if (!ok) failures.push(name);
};

// 「本日」は引数で渡せるようにしてあるので、実行日に左右されない
const TODAY = "2026-09-21";

console.log("\n--- 飛び日程（dates） ---");
check(
  "明日以降でいちばん近い開催日を選ぶ",
  suggestedVisitDate(
    { dates: ["2026-09-19", "2026-09-22", "2026-09-27"] },
    TODAY,
  ),
  "2026-09-22",
);
check(
  "今日の開催日は飛ばして次の日を選ぶ",
  suggestedVisitDate({ dates: ["2026-09-21", "2026-09-28"] }, TODAY),
  "2026-09-28",
);
check(
  "すべて過去なら最後の開催日",
  suggestedVisitDate({ dates: ["2026-09-05", "2026-09-12"] }, TODAY),
  "2026-09-12",
);

console.log("\n--- 会期（start_date〜end_date） ---");
check(
  "過去に始まり未来まで続く会期は明日",
  suggestedVisitDate({ startDate: "2026-06-10", endDate: "2026-12-01" }, TODAY),
  "2026-09-22",
);
check(
  "今日で終わる会期は末日（明日は会期外）",
  suggestedVisitDate({ startDate: "2026-06-10", endDate: "2026-09-21" }, TODAY),
  "2026-09-21",
);
check(
  "明日で終わる会期は明日",
  suggestedVisitDate({ startDate: "2026-06-10", endDate: "2026-09-22" }, TODAY),
  "2026-09-22",
);
check(
  "これから始まる会期は初日",
  suggestedVisitDate({ startDate: "2026-10-01", endDate: "2026-10-31" }, TODAY),
  "2026-10-01",
);
check(
  "終わった会期は末日",
  suggestedVisitDate({ startDate: "2026-07-01", endDate: "2026-08-31" }, TODAY),
  "2026-08-31",
);
check(
  "終了日が未登録で始まっている行は明日",
  suggestedVisitDate({ startDate: "2026-06-10" }, TODAY),
  "2026-09-22",
);

console.log("\n--- 単日・欠損 ---");
check(
  "未来の単日はその日",
  suggestedVisitDate({ startDate: "2026-11-03", endDate: "2026-11-03" }, TODAY),
  "2026-11-03",
);
check(
  "開始が無く終了だけの行は終了日を使う",
  suggestedVisitDate({ endDate: "2026-12-24" }, TODAY),
  "2026-12-24",
);
check("日付をまったく持たない行は空", suggestedVisitDate({}, TODAY), "");

console.log(
  failures.length
    ? `\nNG ${failures.length}件: ${failures.join(", ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
