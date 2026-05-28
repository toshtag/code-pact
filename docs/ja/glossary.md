# 用語集

このドキュメント群で使う用語を平易に定義します。他の場所で説明なく出てきた用語は、ここで定義されています。これらの用語が表すコマンドの流れは [タスク単位のループ](per-task-loop.md) を参照してください。

> 🌐 英語版: [glossary.md](../glossary.md)

## 中核となる考え方

| 用語 | 意味 |
| --- | --- |
| **agent（エージェント）** | あなたが使う AI コーディングツール — Claude Code、Codex、Cursor、Gemini CLI など。code-pact はエージェントを内蔵せず、あなたが既に使っているエージェントに共通のコマンド群を与えます。 |
| **control plane（コントロールプレーン）** | あなたのエージェントとプロジェクトの間に立つ薄い層。code-pact がそれで、エージェントが「このタスクの文脈は？」「終わったことを記録して」「検証は通った？」と尋ね、プロジェクトの状態を一貫させます。 |
| **design intent と operational fact（意図と事実）** | code-pact が意図的に分けて持つ2つの記録。**意図**は計画したこと（`design/`）。**事実**は実際に起きたこと（`.code-pact/state/progress.yaml`）。両者はずれてよく、コマンドがずれを教えてくれます。 |
| **roadmap（ロードマップ）** | プロジェクトのフェーズを順序づけた一覧。`design/roadmap.yaml` に保存。 |
| **phase（フェーズ）** | 1 つの目的と 1 つの検証コマンドを持つ、関連タスクのまとまり。`design/phases/<phase>.yaml`。 |
| **task（タスク）** | エージェントが着手する作業の単位。`P1-T1` の形で識別（下記）。 |
| **P1-T1（タスク / フェーズ ID）** | 作業項目の命名規則。`P1` = フェーズ1、`P1-T1` = フェーズ1のタスク1。数字は順序であって優先度ではありません。 |

## 状態とタスク単位のループ

| 用語 | 意味 |
| --- | --- |
| **progress.yaml** | 何が起きたかの追記専用ログ：`started` / `done` / `blocked` / `resumed` / `failed` イベント。過去のエントリは編集せず追記のみ。`.code-pact/state/progress.yaml`。 |
| **derived state（導出状態）** | タスクの最新の progress イベントから計算される現在の状態：`planned`（イベントなし）→ `started` → `done`、途中に `blocked` / `resumed` / `failed`。[ライフサイクル図](per-task-loop.md) を参照。 |
| **design status** | フェーズ YAML 内の `status` フィールド（`planned` / `in_progress` / `done`）。これは design の意図であり、`task complete` では変わりません。作業が実際に終わったら `task finalize` で揃えます。 |
| **context pack（コンテキストパック）** | code-pact が 1 タスク向けに作る Markdown ファイル。実装に必要なものだけ（タスクの説明、読むべきファイル、関連する決定、受け入れ基準）を含み、`.context/<agent>/<task-id>.md` に書かれます。 |
| **verification command（検証コマンド）** | フェーズが宣言する、タスクの動作を証明するシェルコマンド（例: `pnpm test`）。`task complete` はこれを実行し、通った場合だけ `done` を記録します。 |
| **finalize / reconcile** | `task finalize` は 1 タスクの design status を `done` に、`phase reconcile` はフェーズ全体を一度に揃えます。どちらも作業後に意図を事実へ同期します。 |
| **record-done** | ループの**外**で完了した作業（既にマージ済み、または作業ツリーから検証できない）に `done` イベントを記録します。検証コマンドは実行せず根拠は `--evidence`、イベントは `source: external` を持ちます。`task complete` の代替ではなく、decision gate は依然適用されます。 |
| **source（loop / external）** | `done` progress イベントのフィールド：`loop` = 通常の `task complete` 経由、`external` = `task record-done` で記録。ループ検証済みの完了と、外部主張による完了を後の診断で区別できます。 |

## 計画とスキーマ

| 用語 | 意味 |
| --- | --- |
| **brief / constitution** | プロジェクトの意図を捉える 2 つの短い文書。**brief** は何を誰のために作るか、**constitution** はあらゆる判断が尊重すべき原則。`design/` に保存。 |
| **plan adopt** | 既存の構造化プラン（`roadmap.md` / `TODO.md` / `tasks.md` や YAML 草案）を code-pact のフェーズとタスクへ変換するコマンド — AI 往復なし。 |
| **task readiness fields（タスクの readiness フィールド）** | タスクがコンテキストパックを形作りチェックを有効化するために宣言できる任意フィールド：`depends_on`、`reads`、`writes`、`decision_refs`、`acceptance_refs`。すべて任意で、無くても動きます。[task readiness fields](../concepts/task-readiness-fields.md)（英語）を参照。 |
| **write audit（書き込み監査）** | タスクを finalize すると、`writes` で宣言したファイルと実際に変更されたファイルを比較し、不一致を advisory として報告します。`--audit-strict` はその advisory を非ゼロ終了（CI 向け）に昇格します。 |
| **decision gate（決定ゲート）** | `requires_decision` タスクが完了する前に **accepted** な ADR の存在を強制するチェック。存在するまで `verify` / `task complete` / `task record-done` をブロックします。[the decision gate](../concepts/decision-gate.md)（英語）を参照。 |
| **ADR（決定記録）** | Architecture Decision Record：`design/decisions/` 配下の markdown で、その `**Status:**` 行（`accepted` / `proposed` / `draft` / `rejected` / `superseded`）を decision gate が読みます。`accepted` がゲートを通します。 |

## 出力と診断

| 用語 | 意味 |
| --- | --- |
| **envelope（エンベロープ）** | `--json` 応答の形：成功時は `{ "ok": true, "data": {…} }`、失敗時は `{ "ok": false, "error": { "code", "message" } }`。この一貫したラッパーが「envelope」です。 |
| **exit codes（終了コード）** | `0` 成功・`1` チェック失敗（例: 検証）・`2` 使い方/設定エラー・`3` 内部エラー。全表は [cli-contract.md](../cli-contract.md#exit-codes)（英語）。 |
| **advisory** | 知っておく価値はあるがコマンドを失敗させない警告コード（`affects_exit` が false）。`--strict` / `--audit-strict` のような strict フラグは advisory を失敗に昇格できます。 |
| **recommendation（recommend）** | code-pact がタスクに提案する実行プラン：モデル tier、effort、planning posture、context budget profile。`recommend` 単体で返るほか、`task prepare` に同梱されます。 |
| **dry-run** | プレビューモード — 変更内容を表示するが何も書きません。実際に適用するには `--write` を付けます。 |

## アダプタと統合

| 用語 | 意味 |
| --- | --- |
| **adapter（アダプタ）** | code-pact の契約からエージェント独自の指示ファイルを生成する部品 — 例: `claude-code` アダプタは `CLAUDE.md` と `.claude/skills/` を書きます。エージェントごとに 1 つ。 |
| **adapter conformance** | インストール済みアダプタの生成ファイルが、契約の要求をエージェントに正しく伝えているかを検査する読み取り専用チェック。`adapter conformance <agent>` を実行します。チェック自体を編集することはありません。 |
| **adapter doctor / drift** | 「drift」は、生成済みアダプタファイルが現在の code-pact の生成物と一致しなくなった状態。`adapter doctor` が検出し、`adapter upgrade --write` が修正します。 |
| **dogfooding** | code-pact 自身の開発で code-pact を使うこと。code-pact リポジトリは自らのロードマップを code-pact で管理しており、[dogfood.md](../dogfood.md)（英語）がその一連の流れです。 |
