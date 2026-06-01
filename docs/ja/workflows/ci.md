# CI で code-pact を動かす

> 🌐 English version: [Running code-pact in CI](../../workflows/ci.md)

このページは code-pact を CI に組み込むための単一の入口です。各要素を**並べてリンクする**だけで、内容を再掲はしません。依存する検出器はすでに存在します（`CONTROL_PLANE_*`、branch-drift。[`cli-contract.md`](../../cli-contract.md#error-codes) を参照）。

コマンドやフラグ、JSON エンベロープ、branch-drift の `--base-ref` の仕組みといったリファレンスは [`cli-contract.md`](../../cli-contract.md)（英語）を、インストールと pin の理由は [`getting-started.md`](../getting-started.md) を参照してください。このページが扱うのは **どのチェックを、いつ走らせ、何が前提として満たされている必要があるか** です。

## ループは1つではなく2つ

code-pact のチェックは「毎コミットで全部走らせる」儀式ではありません。分けて考えます。

- **コントリビューターのループ — PR を開く前。** 変更に関係するチェックだけ走らせます。ドキュメントのみの変更にプラン整合の一括チェックは不要ですが、フェーズやタスクの変更には必要です。毎コミットで全スイートを走らせる必要はありません。
- **メンテナ / リリースのループ。** マージやリリースの前にフルゲートを走らせます。下記の strict 昇格はここで使います。

## 最小の PR チェック（GitHub Actions）

ゲートを走らせる単一の `pull_request` ワークフローです。code-pact を **正確なバージョンで project devDependency に pin** している前提（[`getting-started.md`](../getting-started.md) を参照）なので、プロジェクトローカルのバイナリを使い、`@latest` に追従しません。

```yaml
# .github/workflows/code-pact.yml
name: code-pact
on:
  pull_request:
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # full history — merge-base for --base-ref
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile     # installs the pinned code-pact
      - run: pnpm exec code-pact validate --strict --base-ref origin/${{ github.base_ref }} --json
      - run: pnpm exec code-pact plan lint --include-quality --strict --json
      - run: pnpm exec code-pact plan analyze --strict --json
```

これが最小ゲートの全体です。ビルドマトリクス、上記を超えるキャッシュ、リリース/publish の自動化といった重い構成は、ここでは意図的に対象外です。プロジェクトの慣習に応じて追加してください。

> GitHub Actions 以外でも要件は同じです（プロバイダ非依存）。**完全な git 履歴**を取得し（merge-base のため）、**base ref** をコマンドに渡し、**pin した**バイナリを走らせる。上記のステップを各プロバイダの構文に置き換えてください。

## 各チェックが守るもの

- **`validate --strict --base-ref <default-branch>`** — プロジェクト整合に加え、P34 の branch-drift ゲート（`CONTROL_PLANE_BRANCH_NOT_DRIVEN`）。ブランチでコードが変わったのにループを駆動していない状態を検出します。`--strict` は warning を exit 1 に昇格します。仕組み: [`cli-contract.md`](../../cli-contract.md#--base-ref-and-ci-branch-drift-gating-v126-p34)。
- **`plan lint --include-quality --strict`** — プラン/スキーマ整合。リリースブランチでは **green** を目標にします。ただし `--include-quality` の一部の診断は **advisory**（`affects_exit: false`）で、hard blocker ではなくレビューの指針です。プロジェクトの方針が別途定めない限り、すべてを解消しなくても clean に exit します。
- **`plan analyze --strict`** — プラン分析の warning を exit 1 に昇格します（ステータスドリフト、依存関係の問題）。
- **`task finalize <id> --audit-strict --base-ref <default-branch>`** *(タスクごとに任意)* — 宣言した writes の監査。`--audit-strict` と `--base-ref` を併用し、クリーンな作業ツリーで `DECLARED_UNUSED` が誤発火しないようにします。[`task-readiness-fields.md`](../../concepts/task-readiness-fields.md)（英語）を参照。

## 前提チェックリスト

CI で最もよくある不意打ちは、ゲートが黙ってスキップする/誤発火することです。上記ワークフローが意味を持つために、事前に:

- [ ] **`.code-pact/` をコミットする** — プロジェクト設定 **と** `state/progress.yaml`。`init` はこれを gitignore しません。branch-drift ゲートは*コミット済みの* `progress.yaml` を読むため、ledger が未追跡だとチェックは**黙ってスキップ**します。リポジトリで意図的に `.code-pact/` を無視している場合は ledger を force-add してください: `git add -f .code-pact/state/progress.yaml`。詳細: [`cli-contract.md`](../../cli-contract.md#--base-ref-and-ci-branch-drift-gating-v126-p34)。
- [ ] **`fetch-depth: 0`** — `--base-ref` は merge-base と比較するため完全な履歴が必要です。shallow checkout では壊れます。
- [ ] **正確なバージョンを pin する** — code-pact を `devDependency` に `--save-exact` で pin し、lockfile をコミットして、毎回同じ CLI が解決されるようにします。[`getting-started.md`](../getting-started.md) を参照。
- [ ] **`--audit-strict` と `--base-ref` を併用する** — これがないと、クリーンな CI チェックアウトで writes を宣言した全タスクに対し `DECLARED_UNUSED` が報告されます。

## 関連

- [`cli-contract.md`](../../cli-contract.md)（英語） — コマンド/フラグ/エンベロープのリファレンスと branch-drift ゲートの仕組み。
- [`getting-started.md`](../getting-started.md) — インストールと正確なバージョンの pin。
- [`maintainers/operations.md`](../../maintainers/operations.md)（英語） — メンテナのプラン整合・リリース準備の姿勢。
