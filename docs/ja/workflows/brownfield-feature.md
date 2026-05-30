# 既存に導入する（brownfield）ワークフロー — 既存プロジェクトへの code-pact 導入

> 🌐 English version: [Brownfield workflow](../../workflows/brownfield-feature.md)

このガイドは、**既存のプロダクションコード・既存のドキュメント・おそらく既存の `CLAUDE.md` / `AGENTS.md` / エージェントルールファイルがある**プロジェクト向けです。リポジトリの歴史全体を後から埋め直すのではなく、**特定の機能やリファクタリング**を `code-pact` で進めたい場合に読んでください。

空のリポジトリから始める場合は、代わりに [ゼロから (greenfield)](greenfield.md) を読んでください。コマンド列そのものは [はじめに](../getting-started.md) にあります。このドキュメントが扱うのは、**スコープ**、**既存のエージェントファイルとの共存**、**最小で妥当な導入範囲**です。

## スコープ: リポジトリ全体ではなく1機能

避けるべき間違いは、過去のすべての機能を後からフェーズとして表現しようとすることです。`code-pact` は前向き（forward-looking）なツールです。その強みは、**次の作業を**決定論的な CLI ループで進めることであり、すでに起きたことを監査することではありません。

brownfield リポジトリで最小かつ実用的な導入範囲は次のとおりです:

- 次に作る機能を objective に名指しした1フェーズ。
- その下に2〜6個のタスク。各タスク=1PR。
- 実際に使うエージェント1つ分の adapter。

それ以外はすべて手をつけません。`code-pact` が書き込むのは `design/`、`.code-pact/`、adapter の指示ファイル（`CLAUDE.md` / `AGENTS.md` など）、そしてエージェントのタスク単位パック出力用の `.context/` ディレクトリだけです。既存のビルド・テスト・デプロイ・ドキュメントはそのままの場所に残ります。

## どの導入経路を選ぶか

| こんなとき | 使うアプローチ |
| --- | --- |
| エージェントにコードベースを読ませて作業計画を既に作らせた | 既存プランの取り込み（`plan adopt`） |
| いまエージェントに分解を起案させ YAML を出させたい | エージェント先行 |
| フェーズ+タスクを自分で書きたい | 経路2 — 手動 |
| このリポジトリでインストールの動作確認をしたいだけ | スモークテスト（チュートリアル）（`code-pact tutorial` はこのリポジトリに何も書き込みません） |

各アプローチの詳細は [はじめに](../getting-started.md) を参照してください。brownfield で最も自然なのは **エージェント駆動** です。コーディングエージェントを既存コードに向け、次の機能のフェーズ+タスク分解を作らせてから、それを決定論的に取り込みます — 構造化された markdown/計画なら `plan adopt`、YAML なら `phase import`。brief / constitution ウィザードはここでは省略できることが多いです。brownfield プロジェクトの意図と原則は既存ドキュメントや `CLAUDE.md` に既にあり、エージェントはそれらを読むので、再入力するより既存に地盤づける方が勝ります。分解を自分の手で精密に制御したいときは **手動** を選んでください。

## 既存の `CLAUDE.md` / `AGENTS.md` との共存

リポジトリに手書きの `CLAUDE.md`（や `AGENTS.md`、`.cursor/rules/` など）が既にある場合、`adapter install` はそれを上書きしません。解決方法は3つあります。

### オプション A — 既存ファイルを manifest に取り込む

既存の指示ファイルが今のままで問題なく、`code-pact` には*追跡*だけさせたい（将来のアップグレードが認識できるように）場合は、v0.9 の `--force` セマンティクスを使います。`--force` は**未管理ファイルの取り込み専用**で、管理下で変更されたファイルを上書きすることは決してなく、ディスク上の既存ファイルを manifest に取り込むだけです。

```sh
code-pact adapter install claude-code --force --json
```

取り込み後、そのファイルは `managed` になります。以降の `adapter upgrade --check` は、`code-pact` のテンプレートがあなたのファイルに対してドリフトしていれば報告します。

### オプション B — 必要な内容を抜き出してから code-pact に任せる

既存の `CLAUDE.md` の内容を、プロジェクト内の適切な場所（プロジェクト全体の原則は `design/constitution.md`、タグ付きルールは `design/rules/*.md`）へ移し、手書きの `CLAUDE.md` を削除してから `adapter install` をクリーンに実行します。

これが長期的に最もきれいな構成です。`code-pact` は `design/` + adapter テンプレートから `CLAUDE.md` を再生成するので、原則が1か所にまとまります。

### オプション C — 別々のまま保つ

既存の `CLAUDE.md` が `code-pact` にはできないこと（例: プロジェクト固有の MCP サーバー設定）をしている場合は、*別の* adapter をインストールします:

```sh
code-pact adapter install generic
```

`generic` adapter は `docs/code-pact/agent-instructions.md` を書き出します。これは `CLAUDE.md` とは別ファイルです。手書きの `CLAUDE.md` と `code-pact` の `agent-instructions.md` が共存し、エージェントには両方を読むよう伝えます。やや優雅さに欠けますが、曖昧さがありません。

## その機能のための verify コマンド

brownfield フェーズを作るときは、**今作っている機能だけ**を回す verify コマンドを選んでください — テストスイート全体ではありません。フェーズの `verify.commands` は `task complete` のたびに走るので、10分かかる全スイートの呼び出しは、ループを回さない癖をつけてしまいます。

良い brownfield の verify コマンド:

- `pnpm test -- path/to/new-feature.test.ts`
- `pnpm exec vitest run src/new-feature/`
- `node --check src/new-feature/index.ts`

verify コマンドは後からでも `design/phases/<phase>.yaml` を直接編集して切り替えられます — YAML が source of truth です。

## やってはいけないこと

- **古いフェーズを後追いで埋めない。** P1 は*新しい*機能であって、過去の再構成ではありません。
- **5分前に手で書いた `CLAUDE.md` を上書きするために `adapter install` を `--force` しない。** v0.9 の `--force` は未管理ファイルの取り込み専用で実際には上書きしませんが、その意図自体が間違っています — 上のオプション B か C を選んでください。
- **`.code-pact/` は自動 gitignore されない、と理解する。** `init` が `.gitignore` に足すのは `/.local/`（機密の計画メモ — `LOCAL_NOT_GITIGNORED` 警告が見ているのは*これ*）と `/.context/`（再生成可能な context pack）だけです。`.code-pact/` は ignore **しません**。何を追跡するかは利用者が決めます。一般的な慣習は、**プロジェクト設定**（`.code-pact/project.yaml`、`agent-profiles/`、`model-profiles/`）をコミットしてチームと CI で共有し、`.code-pact/state/`（append-only の `progress.yaml`、locks、baselines）や `.code-pact/adapters/*.manifest.yaml` は履歴用にコミットするか各開発者ローカルにするかをチーム方針で決める、というものです。`design/` は常にコミットされる source of truth です。状態ファイルの書き込み契約の全体は [cli-contract.md](../../cli-contract.md)（英語）を参照してください。
  - **CI 注記（v1.26+）。** `validate` / `recommend` / `task prepare` は上記のプロジェクト設定を読むので、CI のチェックアウトに存在する必要があります。さらに P34 の `CONTROL_PLANE_BRANCH_NOT_DRIVEN` ゲート（`validate --strict --base-ref`）を使う場合、ゲートが読むのは**コミット済み**の `.code-pact/state/progress.yaml` です — これも自動 ignore されないのでコミットするか、`.code-pact/` を意図的に ignore しているなら `git add -f .code-pact/state/progress.yaml`。設定ごと ignore しているなら `progress.yaml` だけ force-add しても不十分です。

## 次に読む

- [はじめに](../getting-started.md) — すべての導入アプローチのコマンド列。
- [cli-contract.md](../../cli-contract.md)（英語） — `adapter install --force` のセマンティクス、`task complete` 契約、エラーコードの全リファレンス。
- [upgrading.md](../../upgrading.md)（英語） — 新規導入ではなく既存の `code-pact` プロジェクトをアップグレードする場合は、アップグレードガイドが正しい入口です。
