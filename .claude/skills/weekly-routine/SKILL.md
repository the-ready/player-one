---
name: weekly-routine
description: 週次データ収集ルーチンの実行手順。cron から claude -p の引数として起動される。収集スキルを1つ選んで最後まで回し、終了工程を通し切る。
disable-model-invocation: true
argument-hint: "[kanto-event-collector|kanto-movie-collector|kanto-live-collector]"
allowed-tools:
  - Bash(date *)
  - Bash(echo *)
  - Bash(python3 tools/budget.py *)
arguments: skill
---

# 週次データ収集ルーチン

## 今回の実行

- **今日**: !`date '+%Y-%m-%d（%a） 曜日番号=%u'`
- **実行するスキル**: `$skill`（引数で渡されていなければ、下の対応表の該当行を使う）
- **同時実行数の上限**: !`echo "${CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS:-（未設定）}"`（超えた起動は失敗する。孫エージェントは `settings.json` で禁止）
- **サブエージェントのモデル**: !`echo "${CLAUDE_CODE_SUBAGENT_MODEL:-（親と同じ）}"`（環境変数が Agent ツールの `model` 引数より優先される。自分で指定しない）
- **起動時の予算**: !`python3 tools/budget.py --report 2>&1 | head -3`

**日付と曜日を自分の暗算で決めない。** 上の行はシェルの `date` が出したもので、この文章が届いた時点で既に確定している。
（2026-08-29 の無人実行は、モデルが当日を「金曜日」と暗算し間違え、本来 `other` 行が適用されるべき土曜日に
`kanto-live-collector` を実行してしまい、会期を残したフェスを `ended` として消す事故につながった。
`docs/routine-postmortems.md`）

## 曜日 → スキル・モデル・同時実行数の対応表

```schedule
# 曜日(date +%u: 1=月 2=火 3=水 4=木 5=金 6=土 7=日) スキル 親モデル 同時実行数 子モデル
3      kanto-event-collector sonnet 3 haiku
4      kanto-movie-collector sonnet 2 inherit
5      kanto-live-collector  sonnet 3 inherit
other  kanto-event-collector sonnet 3 haiku
```

**この表が唯一の正本である。** `claude-routine.sh` はこのブロックをそのまま読んで `ROUTINE_SKILL`・`--model`・
`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`・`CLAUDE_CODE_SUBAGENT_MODEL` を決めており、独自の対応表は持たない。
曜日を増やす・組み合わせを変えるときは、この表の行を編集するだけでよい（シェルスクリプト側の変更は不要）。

**親と子でモデルを分ける。** 5列目が子（サブエージェント）のモデルで、`inherit` は親と同じという意味である。
親の仕事は「棚卸し・分割・起動・追記・検証」——**規則を落とさずに指示を組み立てること**が成果を決めるので、
ここを弱いモデルにすると被害が全工程に及ぶ。2026-09-02 の events は親も子も Haiku で走り、親が
`skill_brief.py` の抜粋を貼らずに自作の1〜2KBの指示に要約した結果、**価格の列が指示から丸ごと落ちて
新規90件の `price_official` が0件**になった（`docs/routine-postmortems.md`）。子の仕事は
「渡された名簿のURLを開いて行を書く」で範囲が狭く、抜粋という手順書も付くので、Haiku で足りる。

無人実行では、この表からスクリプトが決めた値が既に `--model` と環境変数で渡されている。**自分で選び直さない。**
特定のスキルを試したいときは、crontab 側で `ROUTINE_SKILL=kanto-live-collector` のように環境変数を渡す
（表より優先する。表に無いスキル名を渡すと起動時にエラーで止まる）。

対話セッションで手動実行するときは `--model` も `ROUTINE_SKILL` も渡らないので、実行するスキルは対話の指示に従い、
指示が無ければ上の表の該当行（無ければ `other` 行）を使う。判断には冒頭に注入された曜日番号を使う。

## 前提 —— git はスクリプトの責任

git の書き込みは行わない（`.claude/routines/invariants.md` の規則。`PreToolUse` フックが実際に拒否する）。

- 実行前: スクリプトが `git fetch` と fast-forward マージで最新を取り込んでから、あなたを起動している
- 実行後: スクリプトが `validate_data.py` と `diff_data.py` を回し、**どちらも終了コード0のときだけ** コミットして push する
- 検証に通らなかった回は、生成物を `.claude/logs/failed/` に退避したうえで `data/` と `docs/` を実行前の状態に戻す。
  つまり**途中で終えた週は、その週の収集がまるごと失われる**

したがってあなたの仕事は、**「検証を通る状態のCSVを作り、終了工程まで通し切ること」** に尽きる。

## 手順

### 1. 手順書を読む

`.claude/skills/<スキル名>/SKILL.md` を Read で**パス指定して**読む。正本はリポジトリ内のここ1箇所だけである。

### 2. 「実行手順まとめ」の最後の項目まで実行する

- 調査（探索・深掘り）は、予算切れ・コンテキスト逼迫・情報源への到達失敗などを理由に**打ち切ってよい**
- ただし「完走条件」にある**終了工程は、どんな理由で打ち切っても必ず全部通す**
- 打ち切る場合は「撤退の手順」に従い、未処理の前回行を持ち越しまたは `notfound` として片付けてから終了工程に入る

**残りは `python3 tools/budget.py --report` で見る。ただし時間で判断しない。**
枠は6時間あるが、実行を止めているのは一度も時間ではなく、アカウントの利用上限（トークン）だった。
見るのは**文脈再送**で、2段階の線がある。

- **25M**「新しい波を投げないでください」→ 動いている波を受け取って書き切り、終了工程へ
- **40M**「撤退の手順に入ってください」→ 新しい調査はやめ、終了工程だけを通す

**波を投げる前に必ず見ること。** 投げてしまうと、動いている子に割り込む手段が無い。
25M を越えた状態で `Agent` を起動しようとすると、`agent-guard.sh` が拒否する。
逆に線に届いていないうちは、時間が余っているかどうかに関わらず畳まないこと。

### 3. 波の分け方

サブエージェントの起動規則そのもの（前景起動・書き切り・親は取得しない）は
`.claude/routines/invariants.md` にある。ここではその上で、**1回に背負わせる範囲**を決める。

- **1回の呼び出しに、調査軸1つの全体を背負わせない。** 名簿の一部・対象期間の一部などに区切り、
  **波**（同時に起動して同時に受け取る1組）に分けて呼ぶ
- **子に SKILL.md を読ませない。抜粋をファイルで渡す。** 波を投げる前に1回だけ実行する。

  ```bash
  python3 tools/skill_brief.py <events|lives|movies> --out temp/brief-<events|lives|movies>.md
  ```

  指示に**貼らない**。「まず `temp/brief-<ds>.md` を Read し、そこの規則に従うこと」という1文だけを書く。
  貼る形は親に「抜粋ぶんの出力トークン × 体数」を払わせ、払えないと判断した親は自作の要約に逃げる
  ——2026-09-02 の events はそれで価格の列が指示から丸ごと落ちた。
  **抜粋のパスへの参照が無い波は `agent-guard.sh` が拒否する。**

- **1体が回るターン数を60以下に収める。** 1つの文脈でN回呼ぶと入力はNの2乗で増えるので、
  担当範囲を小さく割るだけでトークンが減る（`budget.py --report` が「最長の子◯ターン」を出す）
- worktree 隔離は使わない（書き込まないので隔離する対象が無く、名簿の更新まで破棄される）

前景で起動していても、**1回の呼び出しが長時間に及ぶ設計**なら同じように全損する
（`docs/routine-postmortems.md` の 2026-08-20、`docs/COLLECTION-PROTOCOL.md` 第11.3節）。
区切るのは起動の形だけでなく、1回に背負う範囲でもある。

### 4. CSVが更新されたことを確認する

`data/` 配下の該当CSVを見る。**ヘッダーだけの状態（`--init` した直後の状態）で終わらせない。**

### 5. 検証を通す

`python3 tools/diff_data.py` と `python3 tools/validate_data.py` を実行し、どちらも終了コード0であることを確認する。
落ちた場合はその原因を解消してから終える。ここが通らないと、今回の成果は保存されない。

**`diff_data.py` の出力を `head`/`tail`/`grep` で切らない。** `[表記が変わった可能性]` は `[新規]` の一覧の直後に出る。
該当ペアがあれば `carry-rest` の前に、次の形で `renamed` として処理する
（`--status` / `--to` という個別フラグは無い。JSONL を標準入力で渡す）。

```bash
python3 tools/prev_rows.py events --dispose <<'EOF'
{"uid": "<旧uid>", "status": "renamed", "to": "<新uid>", "note": "表記が変わった"}
EOF
```

なお `--worklist` の一覧に出るタイトル・会場名は表示用に切り詰めてあり（末尾が `…`）、そのまま新しい行として
書き戻すと `append_rows.py` が拒否する。正しい表記は `tools/prev_rows.py <ds> --uid <uid>` で引き直すこと。

- **説明のない消滅**があると落ちる → `tools/prev_rows.py <events|lives|movies> --dispose` で理由を記録する
- **収穫が0件**（新規・変更・消滅がすべて0）でも落ちる → 調査結果を `append_rows.py` で書き切っていないか、
  前回のCSVをそのまま復元して終えようとしている

### 6. 報告して終える

`python3 tools/report_stats.py` で充足率と分布を出したうえで、SKILL.md が求める報告を出力する。次の3つは必ず含める。

- `python3 tools/report_stats.py` の出力（件数・**中核列の充足率と前回比**）
- `python3 tools/budget.py --report --verbose` の出力（工程別の消費・残り時間）
- 打ち切った工程がある場合は、**どの工程をどの理由で打ち切ったか**
