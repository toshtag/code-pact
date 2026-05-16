export const messages = {
  usage: [
    "code-pact - AI コーディング Agent のための制御層",
    "",
    "使い方:",
    "  code-pact <command> [options]",
    "  code-pact --version",
    "",
    "コマンド:",
    "  init       プロジェクトを初期化 (TTY なら対話、それ以外はフラグ)",
    "  phase      フェーズ契約を管理 (add | new | ls | show)",
    "  task       Agent 向けコマンド (context)",
    "  progress   baseline に対する重み付き進捗を表示",
    "  pack       .context/<agent>/ に context pack ファイルを書き出し",
    "  verify     決定論的な完了条件を検証",
    "  adapter    Agent 別の instruction ファイルを生成/更新",
    "  recommend  タスクに適したモデル tier を提案",
    "  doctor     プロジェクト構造の問題を報告",
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
  pack: {
    phaseNotFound: (id: string): string => `フェーズ "${id}" が roadmap.yaml に見つかりません。`,
    taskNotFound: (taskId: string, phaseId: string): string =>
      `タスク "${taskId}" がフェーズ "${phaseId}" に見つかりません。`,
    written: (path: string, chars: number): string =>
      `コンテキストパックを ${path} に書き込みました (${chars} 文字)`,
  },
  verify: {
    phaseNotFound: (id: string): string => `フェーズ "${id}" が roadmap.yaml に見つかりません。`,
    taskNotFound: (taskId: string, phaseId: string): string =>
      `タスク "${taskId}" がフェーズ "${phaseId}" に見つかりません。`,
  },
  adapter: {
    agentNotFound: (name: string): string =>
      `エージェント "${name}" が見つかりません。先に "code-pact init --agent ${name}" を実行してください。`,
    done: (name: string): string => `エージェント "${name}" のアダプターを生成しました。`,
  },
  doctor: {
    healthy: "問題は見つかりませんでした。プロジェクトは健全です。",
    issues: (errors: number, warnings: number): string =>
      `エラー ${errors} 件、警告 ${warnings} 件が見つかりました。`,
  },
  recommend: {
    phaseNotFound: (id: string): string => `フェーズ "${id}" が roadmap.yaml に見つかりません。`,
    taskNotFound: (taskId: string, phaseId: string): string =>
      `タスク "${taskId}" がフェーズ "${phaseId}" に見つかりません。`,
    agentNotFound: (name: string): string =>
      `エージェント "${name}" が見つかりません。先に "code-pact init --agent ${name}" を実行してください。`,
  },
  wizard: {
    init: {
      localePrompt: "Select language / 言語を選択してください",
      localeOptionEn: "English",
      localeOptionJa: "日本語",
      agentsPrompt: "サポートするエージェントを選択してください (カンマ区切り)",
      defaultAgentPrompt: "デフォルトのエージェントを選択してください",
      verifyCommandPrompt: "デフォルトの検証コマンド",
      verifyCommandHint: "そのままで良ければ Enter",
      createSamplePrompt: "サンプルフェーズを作成しますか?",
      generateAdaptersPrompt: "アダプターファイルをいま生成しますか?",
      summary: (agents: string[], defaultAgent: string): string =>
        `次の構成で初期化します: ${agents.join(", ")} (既定: ${defaultAgent})`,
      invalidChoice: "選択が不正です。もう一度入力してください。",
      noSelection: "1 つ以上選択してください。",
    },
    phase: {
      idPrompt: "フェーズ ID (例: P1)",
      namePrompt: "フェーズ名",
      weightPrompt: "重み (1-100)",
      objectivePrompt: "目的",
      confidencePrompt: "信頼度 (low | medium | high)",
      riskPrompt: "リスク (low | medium | high)",
      verifyCommandPrompt: "検証コマンド (カンマ区切り)",
      doneCriterionPrompt: "完了条件 (カンマ区切り)",
    },
  },
  task: {
    context: {
      taskNotFound: (taskId: string): string =>
        `タスク "${taskId}" がどのフェーズにも見つかりません。`,
      ambiguous: (taskId: string, phases: string[]): string =>
        `タスク "${taskId}" は複数のフェーズに存在します: ${phases.join(", ")}`,
      agentNotEnabled: (name: string): string =>
        `エージェント "${name}" は project.yaml で無効化されています (enabled: false)。`,
      agentNotFound: (name: string): string =>
        `エージェント "${name}" は project.yaml に設定されていません。`,
    },
  },
  cliContract: {
    nonInteractiveMissing: (flag: string): string =>
      `${flag} は非対話モードでは必須です。`,
    ciDetected:
      "CI 環境が検出されたため対話プロンプトは無効化されました。必要なフラグを明示するか、CI を解除してください。",
  },
} as const;
