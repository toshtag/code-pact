export const messages = {
  usage: [
    "code-pact - AI コーディング Agent のための Design Control Plane",
    "",
    "使い方:",
    "  code-pact <command> [options]",
    "  code-pact --version",
    "",
    "コマンド:",
    "  init       プロジェクトの制御構造を初期化",
    "  phase      フェーズ契約を管理 (add | ls | show)",
    "  progress   baseline に対する重み付き進捗を表示",
    "  pack       Agent 向けの context pack を生成",
    "  verify     決定論的な完了条件を検証",
    "",
    "グローバルオプション:",
    "  -v, --version    バージョンを表示",
    "  -h, --help       ヘルプを表示",
    "      --json       stdout に機械可読な JSON を出力",
    "      --locale     ja-JP | en-US (既定は LANG)",
  ].join("\n"),
  unknownCommand: (cmd: string): string => `未知のコマンド: ${cmd}`,
  init: {
    alreadyInitialized: (dir: string): string =>
      `"${dir}" に ".code-pact/" が既に存在します。上書きするには --force を使ってください。`,
    created: (n: number): string => `${n} 件のファイルを作成しました。`,
    done: "プロジェクトを初期化しました。",
  },
  phase: {
    added: (id: string, path: string): string => `フェーズ "${id}" を ${path} に追加しました`,
    duplicateId: (id: string): string =>
      `フェーズ "${id}" は既に存在します。別の ID を指定してください。`,
    notFound: (id: string): string => `フェーズ "${id}" が roadmap.yaml に見つかりません。`,
    noPhases: "フェーズがありません。",
  },
  progress: {
    baselineNotFound: (name: string): string =>
      `ベースライン "${name}" が .code-pact/state/baselines/ に見つかりません。`,
  },
} as const;
