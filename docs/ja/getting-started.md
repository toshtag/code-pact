# はじめに

このドキュメントは、空のプロジェクトから最初の `task complete` を成功させるまでを約30分でたどるためのガイドです。ロードマップを立ち上げる方法は3つあり、それぞれを並べて説明します。自分のやり方に合うものを選んでください。

> このリポジトリで日本語ドキュメントが用意されているのは現在この `getting-started.md` のみです。それ以外（README、`docs/cli-contract.md`、`docs/migration.md`、`docs/dogfood.md` など）はすべて英語が一次資料です。
>
> 60秒で `code-pact` の概要だけ知りたい場合は、まず英語の [README](../../README.md) を読むことをおすすめします。

## 前提

- Node.js **22 以上**（LTS または current）
- `npm install -g code-pact`（または `npx code-pact …`）を実行できるターミナル
- サポートされているエージェントのいずれか：`claude-code`、`codex`、`generic`（いずれも Stable）。`cursor` と `gemini-cli` も動作しますが Experimental です。

## インストール

```sh
# グローバルインストール
npm install -g code-pact
code-pact --version

# インストールせずに使う
npx code-pact --version
```

v1.0 より前の挙動に固定したプロジェクトでは `npm install -g code-pact@alpha` も引き続き使えます。新規プロジェクトはデフォルトの `latest` タグを使ってください。

## どの経路を選ぶか

ロードマップの作り方に合わせて経路を選びます。3つの経路はいずれも最終的に同じタスク単位のループ（ドキュメント末尾で説明）に合流するので、後から経路を切り替えるのも難しくありません。

| 経路 | 向いている場面 | 最初の `task complete` までの目安 |
| --- | --- | --- |
| **チュートリアル** | エンドツーエンドの動作確認をいちばん速く済ませたい | 約5分 |
| **手動** | 作るものの形がすでに見えていて、ロードマップを自分で書きたい | 約15分 |
| **AI 支援** | プロジェクトのブリーフから AI エージェントにフェーズとタスクを起こさせたい | 約20分 |

---

## 経路 1 — チュートリアル

`init` ウィザードが用意するサンプルフェーズを使い、ループ全体が通ることを確認する経路です。**計画用の成果物は不要**で、インストールが健全であることの確認専用です。

```sh
# 1. 初期化。ウィザードは順に次を尋ねます:
#    言語 → エージェント → デフォルトエージェント →
#    アダプタファイルをいま生成するか (yes) → 検証コマンド (pnpm test) →
#    サンプルフェーズを作るか (yes) → ブリーフを集めるか (ここではスキップ)
code-pact init

# 2. サンプルフェーズ P1 ("Welcome") が作成されていますが、タスクはまだありません。
#    対話的にひとつ追加します。
code-pact task add P1

# 3. Markdown のコンテキストパックを取得して、エージェントが実装します。
code-pact task context P1-T1 --agent claude-code

# 4. 実装が終わったら完了をマークします。フェーズの verify コマンドが走り、
#    通れば `done` イベントが追記されます。
code-pact task complete P1-T1 --agent claude-code
```

`pnpm test` がこのリポジトリにふさわしくない場合は、ウィザード（手順1）で別のコマンドを指定してください。スモークテスト目的なら `node --version` のようなコマンドも安全な選択肢です。

> サンプルフェーズの名前は `P1 — Welcome` で、プロジェクト構造と検証パイプラインの確認のためだけに存在します。本物のフェーズができたら、残すか、改名するか、削除するかを判断してください。サンプルフェーズの概念は別ドキュメント（[`docs/concepts/sample-phase.md`](../concepts/sample-phase.md)）で詳しく扱っています。

---

## 経路 2 — 手動

ロードマップの形がすでに見えているときの経路です。各フェーズとタスクを自分で書き、対話的なコマンドとフラグベースのコマンドを混ぜて使います。

```sh
# 1. 初期化。対話で進めても、ウィザードを完全にスキップしても構いません。
#    どちらでも動きますが、ここではフラグサーフェスを示すために非対話形式で示します。
code-pact init --non-interactive --agent claude-code --locale en-US

# 2. プロジェクトの意図を記録します。これらのウィザードは
#    design/brief.md と design/constitution.md をそれぞれ書き出します。
code-pact plan brief
code-pact plan constitution

# 3. フラグでフェーズを追加します（ウィザードをスキップ）。
code-pact phase add \
  --id P1 \
  --name "Foundation" \
  --weight 20 \
  --objective "Establish the project foundation" \
  --verify-command "pnpm test"

# 4. フェーズにタスクを追加します（対話）。
code-pact task add P1

# 5. エージェント別の指示ファイルを生成します。手順1のウィザードでも
#    生成できます。これは後でエージェントを変えたときに使う単体コマンドです。
code-pact adapter install claude-code

# 6. タスク単位のループ（後述）に入ります。
code-pact task context P1-T1 --agent claude-code
code-pact task complete P1-T1 --agent claude-code
```

複数語からなる検証コマンドはクオートで囲んでください。囲まないと末尾のトークンが `CONFIG_ERROR` を引き起こします。

```sh
# 正しい
code-pact phase add ... --verify-command "node --version"

# 拒否される — 末尾のトークンが黙って失われる
code-pact phase add ... --verify-command node --version
```

---

## 経路 3 — AI 支援

プロジェクトのブリーフをもとに、AI エージェントにフェーズとタスクを起こさせたいときの経路です。`code-pact` 自身が LLM を呼ぶことはありません。`plan prompt` はあなたが自分のエージェント（Claude、Codex、Gemini など）に貼り付けるためのプロンプト文字列を組み立て、`phase import` はエージェントが返してきた YAML を読み込みます。

```sh
# 1. 初期化。
code-pact init

# 2. プロジェクトの意図を記録し、計画用プロンプトに地盤を与えます。
code-pact plan brief
code-pact plan constitution

# 3. 計画用プロンプトを生成し、自分のエージェントに渡します。
code-pact plan prompt > planning-prompt.txt
#    planning-prompt.txt をエージェントで開き、YAML 形式のロードマップを
#    出力するよう指示します。返答を draft-roadmap.yaml として保存します。

# 4. エージェントが生成したロードマップを一括インポートします。
#    lenient モードは task の optional フィールドをデフォルトで埋め、
#    何を埋めたかを結果に報告します。
code-pact phase import draft-roadmap.yaml
#    すべてのフィールドを明示させたい場合は --strict を付けます。
code-pact phase import draft-roadmap.yaml --strict

# 5. 実装を担当するエージェント向けのアダプタをインストールします。
code-pact adapter install claude-code

# 6. タスク単位のループ（後述）に入ります。
code-pact task context P1-T1 --agent claude-code
code-pact task complete P1-T1 --agent claude-code
```

`phase import` の lenient モードは意図的な設計です。AI には `id` を正しく出すことに集中させ、残りは `code-pact` が埋めるという分担にできます。埋められたデフォルトは JSON レスポンス、または `code-pact plan lint --json` で監査できます。

---

## タスク単位のエージェントループ

タスクがひとつでもできれば、3つの経路はすべて同じ決定論的なループに合流します。エージェント（または人）がタスクごとに走らせる流れは次のとおりです。

```sh
# A. タスクの実行計画を取得します — モデル tier・effort、context profile、
#    planning が必要かどうか、preflight コマンド、budget profile が返ります。
#    厳密に additive なので、必要のないフィールドは無視して構いません。
code-pact recommend --phase P1 --task P1-T1 --json

# B. Markdown のコンテキストパックを取得します（stdout、副作用なし）。
#    内容は task の属性（context_size、ambiguity、write_surface）で
#    自動的に変わります。
code-pact task context P1-T1 --agent claude-code

# C. ハンドオフやステータス表示に「誰が手をつけているか」を残すため、
#    タスクの開始を記録します。
code-pact task start P1-T1 --agent claude-code

# D. タスクがブロックされた場合は、理由を明示的に記録します。
code-pact task block P1-T1 --reason "Waiting for review on PR #42"
code-pact task resume P1-T1 --agent claude-code

# E. 派生状態と全イベント履歴はいつでも参照できます。
code-pact task status P1-T1 --json

# F. 実装が終わったら完了をマークします。フェーズの verify コマンドが走り、
#    通れば `done` イベントが .code-pact/state/progress.yaml に追記されます。
code-pact task complete P1-T1 --agent claude-code
```

知っておくと役立つ不変条件がいくつかあります。

- `task start` と `task complete` は **冪等** です。すでに started / done のタスクに再実行すると `already_started: true` / `already_done: true` が返ります。
- `blocked` 状態のタスクは直接 complete できません。`task complete` は `INVALID_TASK_TRANSITION` を返し、`resume` してから初めて completable になります。これにより `resume` イベントがブロック解除の判断を記録します。
- `task complete` は progress を記録しますが、**`design/` を変更しません**。design YAML が「意図」、`progress.yaml` が「実際に起きたこと」です。両者がずれたときは `code-pact plan analyze` が `STATUS_DRIFT` 警告を出します。

## フェーズや PR の境界でのチェックポイント

```sh
code-pact plan lint --json          # スキーマ・命名・参照チェック
code-pact plan normalize --check    # 空白・改行の drift（--write で適用）
code-pact plan analyze --json       # design status と progress ログの drift
code-pact doctor --json             # 人間が読むためのプロジェクトヘルスチェック
code-pact validate                  # CI 向け、エラーで exit 1
```

`plan lint` と `plan analyze` はいずれも `--strict` で warning を error に昇格できます。`plan normalize --write` は YAML コメントと Markdown のハードラインブレークを保ちます。

## アダプタの運用

`init` ウィザード（または手動 / AI 支援の手順5）でアダプタは一度だけ設定すれば、たいていのプロジェクトはそれ以降アダプタを意識する必要はありません。あとは次のような upgrade パスになります。

```sh
code-pact adapter list --json                          # 登録済みアダプタの一覧
code-pact adapter upgrade claude-code --check --json   # drift だけ確認（書き込みなし）
code-pact adapter upgrade claude-code --write          # 安全な更新を適用
code-pact adapter doctor --json                        # アダプタ単位のヘルスチェック
```

`--force` は **unmanaged-adoption 専用** です。`managed-modified` ファイルを上書きすることはありません。ローカルで編集された managed ファイルを破壊的に上書きするには `adapter upgrade --write --accept-modified` が必須で、これは CI スクリプトの `--force` の付け忘れでローカルの編集が吹き飛ばないようにするための意図的な分離です。

## 次に読むもの

- [`docs/getting-started.md`](../getting-started.md) — このドキュメントの英語版。一次資料です。
- [`README.md`](../../README.md) — `code-pact` 全体の紹介とリファレンスへのリンクハブ（英語）。
- [`docs/cli-contract.md`](../cli-contract.md) — フラグ / 終了コード / JSON envelope / エラーコードの完全リファレンスと Stability taxonomy（英語）。
- [`docs/migration.md`](../migration.md) — alpha（v0.6–v0.9）から v1.0 へのアップグレードガイド（英語）。
- [`docs/dogfood.md`](../dogfood.md) — 実プロジェクトでのウォークスルーと、よく出るエラーコードのトラブルシュート（英語）。
