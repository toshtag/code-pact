# code-pact ドキュメント（日本語）

> 🌐 The full English documentation index is at [docs/](../README.md).

このページは日本語で読めるドキュメントの入口です。日本語版が用意されていないものは英語の一次資料へのリンクに「(英語)」と付けています。

まずは [はじめに](getting-started.md) — 空のプロジェクトから最初の `task complete` 成功までを約30分でたどれます。作るものの形が見えているなら、状況に合うワークフローガイド（ゼロから / 既存リポジトリへ導入）に直接進んでも構いません。

## まず読む

| ドキュメント | 内容 |
| --- | --- |
| [はじめに](getting-started.md) | 30分ガイド — 導入アプローチ（スモークテスト / エージェント先行 / plan adopt / code-pact 先行 / 手動）とタスク単位のループ。 |
| [タスク単位のループ](per-task-loop.md) | タスクのライフサイクルの正典 — 状態遷移図、各コマンド、実例。 |
| [用語集](glossary.md) | このドキュメント群で使う code-pact 用語の平易な定義。 |
| [positioning.md](../positioning.md) (英語) | code-pact が何であり、何を意図的にやらないか。中核となる CLI と、プロジェクトが自らを測る成功指標。 |

## ワークフロー

どこから始めるかで選んでください。どちらも具体的なコマンド列は「はじめに」に委ね、**何を書くか**と**作業をどうスコープするか**に焦点を当てています。

| ガイド | こんなとき |
| --- | --- |
| [ゼロから (greenfield)](workflows/greenfield.md) | **空のリポジトリから始める。** brief と constitution に何を書くか、最初のフェーズの形、最小で意味のある初回 PR。 |
| [既存に導入 (brownfield)](workflows/brownfield-feature.md) | **既存コードベースに code-pact を導入する。** 1機能にスコープを絞る、既存の `CLAUDE.md` / `AGENTS.md` との共存、verify コマンドの選び方。 |

## リファレンス

| ドキュメント | 内容 |
| --- | --- |
| [cli-contract.md](../cli-contract.md) (英語) | フラグ / 終了コード / JSON エンベロープ / エラーコードの全リファレンスと安定性区分。 |
| [agent-contract.md](../agent-contract.md) (英語) | v1.11+ のエージェント契約と、各エージェント統合に `adapter conformance` が要求する内容。 |
| [spec-kit-bridge.md](../spec-kit-bridge.md) (英語) | 既存の Spec Kit `tasks.md` / `spec.md` を code-pact のロードマップに取り込む。 |
| [upgrading.md](../upgrading.md) (英語) | アップグレード方法 — v1.x 内は追加のみ。pre-v1.0 alpha からの移行ポインタ。 |

## 概念

| ドキュメント | 内容 |
| --- | --- |
| [task-readiness-fields.md](../concepts/task-readiness-fields.md) (英語) | 任意のタスクスキーマフィールド（`depends_on` / `reads` / `writes` など）と `plan lint` への影響。 |
| [runbook.md](../concepts/runbook.md) (英語) | `task runbook` / `phase runbook` — 依存関係のゲートと finalize 候補の提示。 |
| [finalization-reconciliation.md](../concepts/finalization-reconciliation.md) (英語) | `task finalize` / `phase reconcile` — design の状態を進捗ログに同期する。 |
| [governance.md](../concepts/governance.md) (英語) | ガバナンス層 — write lock、予約 ID、保護パス。 |
| [sample-phase.md](../concepts/sample-phase.md) (英語) | `TUTORIAL` サンプルフェーズ — 残す / 改名 / 削除の判断。 |
| [evidence-harness.md](../concepts/evidence-harness.md) (英語) | メンテナ向けツール（プロダクト機能ではない） — 設計判断を支える決定論的メトリクスのハーネス。 |

## プロジェクト

| ドキュメント | 内容 |
| --- | --- |
| [troubleshooting.md](../troubleshooting.md) (英語) | 診断コードごとの復旧アクション（よく出るエラーコード）。 |
| [dogfood.md](../dogfood.md) (英語) | 実プロジェクトでの一連の流れ — code-pact で code-pact 自身を回す。 |
| [community.md](../community.md) (英語) | issue / discussion / PR の出し方と、Non-goals リストに関するスコープ規律。 |
