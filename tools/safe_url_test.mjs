/* href に入れてよいURLの判定（util.js の safeUrl）の回帰テスト。DOM不要。

   CSVは収集タスク（生成AI）が毎週書き直すので、リンクの列に何が入るかは画面側では選べない。
   1行でも `javascript:` や別サイトを指す相対URLが混ざると、クリックがそのまま実行や
   遷移になる。判定は正規表現の組み合わせで、見た目では抜けに気づけないので、
   通すもの・落とすものを数字ではなく実例で固定する。

   使い方（リポジトリのルートから）:
     node tools/safe_url_test.mjs
*/

import { safeUrl } from "../assets/js/util.js";

const failures = [];
const check = (name, got, want) => {
  const ok = got === want;
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${name}  — ${JSON.stringify(got)}${ok ? "" : ` (期待: ${JSON.stringify(want)})`}`,
  );
  if (!ok) failures.push(name);
};

console.log("\n--- 通すもの ---");
check(
  "https",
  safeUrl("https://example.com/a?b=1"),
  "https://example.com/a?b=1",
);
check("http", safeUrl("http://example.com/"), "http://example.com/");
check(
  "大文字のスキーム",
  safeUrl("HTTPS://example.com/"),
  "HTTPS://example.com/",
);
check("mailto", safeUrl("mailto:a@example.com"), "mailto:a@example.com");
check("tel", safeUrl("tel:0312345678"), "tel:0312345678");
check("ルート相対", safeUrl("/terms.html"), "/terms.html");
check("相対（./）", safeUrl("./privacy.html"), "./privacy.html");
check("ページ内", safeUrl("#rights"), "#rights");
check(
  "前後の空白は落とす",
  safeUrl("  https://example.com/  "),
  "https://example.com/",
);

console.log("\n--- 落とすもの：危険なスキーム ---");
check("javascript", safeUrl("javascript:alert(1)"), null);
check("大文字の javascript", safeUrl("JavaScript:alert(1)"), null);
check("data", safeUrl("data:text/html,<script>alert(1)</script>"), null);
check("vbscript", safeUrl("vbscript:msgbox(1)"), null);
// ブラウザはタブ・改行を読み飛ばしてから解釈するので、これは javascript: になる
check("タブを挟んだ javascript", safeUrl("java\tscript:alert(1)"), null);
check("改行を挟んだ javascript", safeUrl("java\nscript:alert(1)"), null);

console.log("\n--- 落とすもの：別のサイトを指す相対URL ---");
check("プロトコル相対（//）", safeUrl("//evil.example/"), null);
// `\` は `/` と同じに扱われるので、どちらも //evil.example と同じ意味になる
check("/\\ で始まる", safeUrl("/\\evil.example/"), null);
check("\\\\ で始まる", safeUrl("\\\\evil.example/"), null);
check("/ と / のあいだにタブ", safeUrl("/\t/evil.example/"), null);

console.log("\n--- 落とすもの：判断できない値 ---");
check("空", safeUrl(""), null);
check("null", safeUrl(null), null);
check("undefined", safeUrl(undefined), null);
check("スキームの無い文字列", safeUrl("example.com/page"), null);

console.log(
  failures.length
    ? `\nNG ${failures.length}件: ${failures.join(", ")}`
    : "\nすべて通過",
);
process.exit(failures.length ? 1 : 0);
