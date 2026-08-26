# CLAUDE.md

関東のイベント・映画・ライブを1画面で探す静的ダッシュボード（GitHub Pages）。
**ビルドなし。** `index.html` + ESモジュール（`assets/js/`）+ 素のCSS。依存はLeafletのみで、これも同梱。

データは毎週、`.claude/skills/` の収集スキル（＝生成AI）が `data/*.csv` を丸ごと書き直す。
コードは人が触り、データは機械が書く。この非対称が設計のほぼすべての理由になっている。

## ドキュメントの役割

| ファイル                        | 何が書いてあるか                                  | いつ読む・書く                |
| ------------------------------- | ------------------------------------------------- | ----------------------------- |
| `docs/DESIGN.md`                | **なぜそうなっているか**（節番号つき）            | 設計判断を変える／したとき    |
| `README.md`                     | 構成とCSVスキーマの一覧                           | 列や構成を変えたとき          |
| `docs/COLLECTION-PROTOCOL.md`   | 収集の仕組み（uid・持ち越し・予算）               | `tools/` を変えたとき         |
| `.claude/skills/*/SKILL.md`     | 収集タスクの指示（**正本はここ**）                | CSVの列・収集規則を変えたとき |
| `.claude/skills/source-optout/` | 調査対象外・掲載停止の申請への対応手順            | 申請が来たとき                |
| `docs/skill-feedback.md`        | 収集を実行して分かったこと                        | スキルの改善を提案するとき    |
| `.claude/routines/event.txt`    | 無人実行の手順（曜日→スキル・並行調査・終了工程） | ルーチンの流れを変えたとき    |

コードのコメントは**「なぜ」を書く**。この方針は既存コードを読めば分かる密度で徹底されている。合わせること。

## 変更したときに最低限やること

### 共通（毎回）

```bash
python3 tools/validate_data.py     # ERROR 0 であること。週次ルーチンと Stop フックのゲートでもある
```

`tools/` を変えた回は、その道具の検証も回す（どれもネットワーク不要・1秒未満）。

```bash
python3 tools/robots_test.py       # robots.txt の判定規則
python3 tools/purge_ended_test.py  # 終了日の判定と書き換え
python3 tools/fetch_page_test.py   # JSON-LD / sitemap / ICS / 日程行の抽出規則
python3 tools/prev_rows_test.py    # 打ち切られた回の後始末（--carry-rest）と棚卸し
```

Prettier は保存時にフックで自動実行される（`.claude/hooks/format-file.sh`）。手で整形しない。
CSV・Python・シェルは対象外（prettier に parser が無い）。

`data/` に手を入れた回は、**ターンを終える前に `Stop` フックが `purge_ended.py`・`validate_data.py`・`diff_data.py` を自動で回す**（`.claude/hooks/verify-data.sh`）。
落ちていると終われないので、コマンドを打ち忘れて終わることは無い。理由は `docs/DESIGN.md` 第9.1.5節。

### CSVの列を足す・変える・消す

**9か所を必ず揃える。** 1つ漏れると「収集は成功したのに画面に出ない」という最も気づきにくい壊れ方をする。

1. `tools/validate_data.py` の `EXPECTED_HEADERS`（ここが唯一の正。他ツールはここから読む）
2. `assets/js/config.js` の `*_COLUMNS`（表示に使う列だけ）
3. `tools/append_rows.py` の `CARRY_ALWAYS` / `CARRY_NEVER`（週をまたいで持ち越してよいか）
4. 該当する `.claude/skills/*/SKILL.md`（ヘッダー行・列の表・品質チェック）
5. `README.md` のスキーマ節
6. `docs/DESIGN.md` 第3.4節の列の表（＋判断を変えたなら理由も）
7. `tools/diff_data.py` の `WATCH` / `QUIET`（**変動する列をここに入れ忘れると、変化が差分報告に一切出ない**）
8. `tools/report_stats.py` の `CORE` / `BALANCE`（充足率と分布の計算対象）
9. `docs/DESIGN.md` 第10章の列数と `docs/COLLECTION-PROTOCOL.md` 第4章の持ち越し表

> **`~/.claude/skills/` への複製は、この機械には存在しない**（2026-08-19 時点。`ls ~/.claude/skills` が無い）。
> 収集スキルはリポジトリ内の `.claude/skills/` からプロジェクトスキルとして直接読まれている。
> 複製を運用に戻すなら、ここに「複製の手動同期」を10番目として足すこと
> ——古い複製が呼ばれると、列の規則だけが先週のままになる。

### `assets/js/` にモジュールを足す

`sw.js` の `SHELL` 配列に追加し、**`VERSION` を上げる**。上げないと既存の閲覧者に新しいJSが届かない。

### 表示を変える

```bash
node tools/lineup_test.mjs                  # データの繋ぎ・検索・シート（DOM不要）
python3 -m http.server 8000 &
node tools/smoke_test.mjs                   # 画面全体（要 playwright）
```

## 破ってはいけない規則

理由はすべて `docs/DESIGN.md` にある。◎は検証が機械的に落とすので、破ると週次ルーチンがコミットせず、ターンも終われない
（`.github/workflows/pages.yml` はデプロイだけで、検証は回していない）。

- ◎ **画像を持たない。** `poster_url` 等の列を復活させない（第7.1節）
- ◎ **CSVは `data/` 配下だけ。** ルート直下に書いても画面は更新されない
- ◎ **受付・日付・料金を前回値から持ち越さない**（`append_rows.py` が拒否する。第9.3節）
- **二次流通・転売サイトへリンクしない**（第12.8節）
- **推測で日付・時刻・料金を書かない。** 確認できないものは空欄（第7.2.3節）
- **欠損に耐える。** 空欄や未知の値で表示が壊れてはいけない（第3.5節）
- `docs/DESIGN.md` に追記・修正する際は、「以前〜だったから、〜した」と言う書き方ではなく、「[判断理由]のため[判断結果]としている（する）」といった記載の仕方を採用する。

## 一時ファイル

検証用のスクリプトをリポジトリのルートに置かない。残す価値があるものは `tools/`（`*_test.py` / `*_test.mjs`）へ、
使い捨ては `temp/` フォルダへ（無ければ作成すること）。
