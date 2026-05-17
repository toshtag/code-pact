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
    "  plan       プロジェクト計画ツール (brief | prompt)",
    "  phase      フェーズ契約を管理 (add | new | ls | show | import)",
    "  task       タスクの管理 (add) と Agent 向けコマンド (context | complete)",
    "  progress   baseline に対する重み付き進捗を表示",
    "  pack       .context/<agent>/ に context pack ファイルを書き出し",
    "  verify     決定論的な完了条件を検証",
    "  adapter    Agent 別の instruction ファイルを生成/更新",
    "  recommend  タスクに適したモデル tier を提案",
    "  doctor     プロジェクト構造の問題を報告 (人間向け)",
    "  validate   CI 向けプロジェクト検証 (エラー時 exit 1、--strict で警告も対象)",
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
    importDone: (
      phaseCount: number,
      taskCount: number,
      skippedCount: number,
    ): string => {
      const parts = [`${phaseCount} 件のフェーズを取り込みました`];
      if (taskCount > 0) parts.push(`(タスク ${taskCount} 件)`);
      if (skippedCount > 0) parts.push(`(既存 ${skippedCount} 件はスキップ)`);
      return `${parts.join(" ")}。`;
    },
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
      localePrompt: "Select language",
      localeOptionEn: "English",
      localeOptionJa: "日本語",
      agentsPrompt: "サポートするエージェントを選択してください (カンマ区切り)",
      defaultAgentPrompt: "デフォルトのエージェントを選択してください",
      verifyCommandPrompt: "デフォルトの検証コマンド",
      verifyCommandHint: "そのままで良ければ Enter",
      createSamplePrompt: "プロジェクト構造を理解するためのサンプルフェーズファイルを作成しますか?",
      generateAdaptersPrompt:
        "AI エージェント用の instruction ファイルをいま生成しますか? (CLAUDE.md / AGENTS.md など)",
      summary: (agents: string[], defaultAgent: string): string =>
        `次の構成で初期化します: ${agents.join(", ")} (既定: ${defaultAgent})`,
      invalidChoice: "選択が不正です。もう一度入力してください。",
      noSelection: "1 つ以上選択してください。",
      nextStepsHeader: "次のステップ:",
      nextStep1: "1. フェーズを作成する:        code-pact phase add",
      nextStep2: "2. タスクを追加する:          code-pact task add <phase-id>",
      nextStep3: "3. Agent ワークフローを開始:  code-pact task context <task-id>",
    },
    phase: {
      idPrompt: "フェーズ ID (例: P1)",
      namePrompt: "フェーズ名",
      weightPrompt: "重み (1-100)",
      weightHint: "  (相対的な重み。迷ったらそのままEnter)",
      objectivePrompt: "目的",
      confidencePrompt: "信頼度",
      confidenceHint: "  (設計の確度: low / medium / high)",
      riskPrompt: "リスク",
      riskHint: "  (実装リスク: low / medium / high)",
      verifyCommandPrompt: "検証コマンド (カンマ区切り)",
      doneCriterionPrompt: "完了条件 (カンマ区切り)",
    },
    task: {
      descriptionPrompt: "タスクの説明",
      typePrompt: "タスクの種類",
    },
    brief: {
      collectBriefPrompt: "プロジェクト概要を収集しますか？ (design/brief.md を作成)",
      whatPrompt: "何を作りますか？ (1〜3 文で)",
      whoPrompt: "誰のためですか？ (主なユーザーや関係者)",
      differentiatorPrompt: "特徴的なところは何ですか？ (任意 — スキップするなら Enter)",
    },
  },
  plan: {
    briefDone: (path: string): string => `プロジェクト概要を ${path} に書き出しました`,
    briefSkipped: (path: string): string =>
      `${path} は既に存在します。上書きするには --force を使ってください。`,
    promptClipboardCopied: "プロンプトをクリップボードにコピーしました。",
    promptClipboardFailed: "クリップボードへのコピーに失敗しました (pbcopy/xclip コマンドが使えません)。",
    promptNoBrief: "ヒント: 先に `code-pact plan brief` を実行してプロジェクト説明を追加してください。",
  },
  task: {
    added: (taskId: string, phaseId: string, path: string): string =>
      `タスク "${taskId}" をフェーズ "${phaseId}" に追加しました (${path})`,
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
    complete: {
      taskNotFound: (taskId: string): string =>
        `タスク "${taskId}" がどのフェーズにも見つかりません。`,
      ambiguous: (taskId: string, phases: string[]): string =>
        `タスク "${taskId}" は複数のフェーズに存在します: ${phases.join(", ")}`,
      agentNotEnabled: (name: string): string =>
        `エージェント "${name}" は project.yaml で無効化されています (enabled: false)。`,
      agentNotFound: (name: string): string =>
        `エージェント "${name}" は project.yaml に設定されていません。`,
      verificationFailed: (taskId: string): string =>
        `タスク "${taskId}" の verify が失敗しました。progress.yaml は変更されていません。`,
      alreadyDone: (taskId: string): string =>
        `タスク "${taskId}" には既に done イベントが存在します。再 verify をスキップしました (idempotent)。`,
      success: (taskId: string, agent: string): string =>
        `タスク "${taskId}" の done イベントを記録しました (agent: ${agent})。`,
      dryRun: (taskId: string): string =>
        `Dry run: タスク "${taskId}" の done イベントを追記する想定です。progress.yaml は変更されていません。`,
    },
  },
  cliContract: {
    nonInteractiveMissing: (flag: string): string =>
      `${flag} は非対話モードでは必須です。`,
    ciDetected:
      "CI 環境が検出されたため対話プロンプトは無効化されました。必要なフラグを明示するか、CI を解除してください。",
  },
  templates: {
    constitution: {
      description:
        "このファイルは、プロジェクトのすべての計画・実装上の判断を導く原則を記述します。",
      corePrinciplesHeader: "基本原則",
      principles: [
        "次のテストのためではなく、次に読む人のために書く。",
        "計画上の判断は `design/decisions/` に記録する。",
        "完了条件は決定論的に検証できるものにする。",
      ],
      editHint: "このファイルを編集して、プロジェクト固有の原則を反映させてください。",
    },
    codingStyle: {
      header: "コーディングスタイルルール",
      rules: [
        "暗黙より明示を優先する。",
        "コミットにコメントアウトしたコードを含めない。",
        "ファイルレベルのエクスポートのみ使用し、内部ヘルパーのバレル再エクスポートは避ける。",
      ],
      editHint: "このファイルを編集または削除して、プロジェクトの規約に合わせてください。",
    },
    brief: {
      header: "プロジェクト概要",
      whatHeader: "何を作るか",
      whoHeader: "誰のためか",
      differentiatorHeader: "特徴的なところ",
      differentiatorPlaceholder: "(未記入)",
      footer:
        "このファイルは `code-pact plan brief` で再生成できます。\nAI 向けの計画プロンプトを生成するには `code-pact plan prompt` を実行してください。",
    },
    planPrompt: {
      intro:
        "以下のプロジェクト情報を読んで、code-pact 形式のロードマップ YAML を作成してください。",
      briefHeader: "プロジェクト概要",
      noBriefNotice:
        "design/brief.md が見つかりません。このセクションの上にプロジェクト説明を手動で追加してください。",
      constitutionHeader: "プロジェクト方針",
      formatHeader: "出力形式（YAML）",
      guidelinesHeader: "出力の指針",
      guidelines: [
        "プロジェクト全体をカバーする 3〜7 個のフェーズを作成する。",
        "各フェーズに 3〜8 個のタスクを割り当てる。",
        "全フェーズの weight 合計は目安として 100 前後にする。",
        "confidence は設計の確度、risk は実装難易度を反映する。",
        "verification.commands は実際に実行できるシェルコマンドにする（例: pnpm test）。",
        "出力は YAML のみとし、前後に説明文を含めない。",
      ],
    },
    adapterCommon: {
      managedNotice:
        "このファイルは [code-pact](https://github.com/toshtag/code-pact) によって管理されています。",
      editNotice:
        "「プロジェクト固有」とマークされたセクションを編集して、プロジェクトの規約を反映させてください。",
      workflowHeader: "タスクの進め方",
      step1: "コンテキストパックを取得する:",
      step2: "タスクを実装する。",
      step3: "タスクを完了としてマークする。verify を実行し、成功すれば `done` イベントを `.code-pact/state/progress.yaml` に追記する:",
      step3FailDetail:
        "verify が失敗した場合、このコマンドは exit 1 を返し progress.yaml は変更されません。",
      step3IdempotentDetail:
        "`done` イベントが既に存在する場合は no-op (`already_done: true`) となります。",
      step4: "結果をユーザーに報告する。",
      verifyNote:
        "低レベルコマンド `code-pact verify --phase <p> --task <t>` は、進捗イベントを記録せずに verify 出力を確認したい場合に利用できます。",
      packNote:
        "**内部コマンド:** `code-pact pack` は `task context` が内部的に呼び出すコマンドです。`pack` を直接呼び出さず、`code-pact task context <task-id>` を使用してください。",
      projectConventionsHeader: "プロジェクト固有の規約",
      projectConventionsHint:
        "このセクションを編集して、実際のプロジェクト規約を記述してください。",
      projectConventionsSource:
        "`design/constitution.md` と `design/rules/` が規約の source of truth です。",
      projectConventionsDefault: "`design/rules/coding-style.md` のコーディングスタイルに従う。",
    },
  },
} as const;
