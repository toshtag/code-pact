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
    "  tutorial   使い捨てサンドボックスでタスクの進め方を通しで実演",
    "  plan       プロジェクト計画ツール (brief | prompt | constitution)",
    "  phase      フェーズ契約を管理 (add | new | ls | show | import)",
    "  task       タスクの管理 (add) と Agent 向けコマンド (context | complete)",
    "  progress   baseline に対する重み付き進捗を表示",
    "  pack       agent profile の context_dir に context pack ファイルを書き出し",
    "  verify     決定論的な完了条件を検証",
    "  evidence   参照から検証 evidence キャッシュを表示",
    "  context    参照から deferred context を確認・取得",
    "  memory     bounded local loop-memory episode を確認・prune",
    "  adapter    Agent 別のルールファイルを生成/更新",
    "  recommend  タスクに適したモデル tier を提案",
    "  doctor     プロジェクト構造の問題を報告 (人間向け)",
    "  validate   CI 向けプロジェクト検証 (エラー時 exit 1、--strict で警告も対象)",
    "  status     チームの活動概観: 進行中 / blocked / 着手可能 / 待機",
    "  decision   決定記録のライフサイクル (prune — 出荷済み決定の退役を dry-run でプレビュー)",
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
  tutorial: {
    header: "code-pact tutorial — タスクの進め方を通しで体験します",
    sandboxNote: (dir: string): string =>
      `使い捨てのサンドボックスで実行します（最後に削除します）: ${dir}`,
    step: {
      init: "使い捨てのプロジェクトを用意します（`code-pact init --sample-phase` が書き出すものと同じです）。",
      prepareT1:
        "次に何をすべきかを code-pact に尋ねます。現在の状態と、実行すべきコマンドが返ります。",
      start: "タスクを着手中にして、進捗を記録できるようにします。",
      prepareT2Blocked:
        "TUTORIAL-T2 は TUTORIAL-T1 に依存するため、prepare はブロック中と報告します — 順序を飛ばして着手できません。",
      complete: "検証を実行し、成功したら `done` イベントを記録します。",
      finalize: "実際に起きたことに合わせて design の状態を同期します。",
      prepareT2Ready:
        "TUTORIAL-T1 が完了したので、TUTORIAL-T2 のブロックが解け、着手できる状態になりました。",
    },
    result: {
      init: (n: number): string =>
        `${n} 個のファイルを作成（project.yaml, roadmap.yaml, TUTORIAL フェーズ）`,
      prepare: (state: string, next: string): string =>
        `状態: ${state} · 次: ${next}`,
      started: "着手しました",
      blocked: (deps: string): string => `ブロック中 · 待機対象: ${deps}`,
      completed: (n: number): string =>
        `検証成功（${n} チェック）· done イベントを記録`,
      finalized: "同期完了",
    },
    done: "完了。サンドボックスは削除しました — あなたのプロジェクトには何も書き込んでいません。",
    keptNote: (dir: string): string =>
      `完了。サンドボックスを残しました: ${dir}`,
    realNextSteps:
      "準備ができたら、自分のプロジェクトで `code-pact init` を実行してください。",
  },
  phase: {
    added: (id: string, path: string): string =>
      `フェーズ "${id}" を ${path} に追加しました`,
    duplicateId: (id: string): string =>
      `フェーズ "${id}" は既に存在します。別の ID を指定してください。`,
    notFound: (id: string): string =>
      `フェーズ "${id}" が roadmap.yaml に見つかりません。`,
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
    reconcile: {
      phaseNotFound: (id: string): string =>
        `フェーズ "${id}" が roadmap.yaml に見つかりません。`,
      noEligible: (id: string): string =>
        `フェーズ "${id}": finalize 対象の task はありません。`,
      wouldReconcile: (id: string, count: number): string =>
        `Dry run: フェーズ "${id}" の task ${count} 件を finalize する想定です。--write で適用してください。`,
      reconciled: (id: string, applied: number, skipped: number): string => {
        const parts = [
          `フェーズ "${id}" を reconcile しました: ${applied} 件を flip`,
        ];
        if (skipped > 0) parts.push(`、${skipped} 件をスキップ`);
        parts.push("。");
        return parts.join("");
      },
      writeRefused: (id: string): string =>
        `フェーズ "${id}" の reconcile を拒否しました: 適用候補すべてが安全上の理由で拒否されました。data.skipped_writes を確認してください。`,
    },
    archive: {
      wouldArchive: (id: string): string =>
        `Dry run: フェーズ "${id}" を archive する想定です(snapshot を書き、YAML を削除)。--write で適用してください。`,
      archived: (id: string): string =>
        `フェーズ "${id}" を archive しました: snapshot を書き、design/phases の YAML を削除しました。`,
      wouldAlreadyArchived: (id: string): string =>
        `フェーズ "${id}" は既に archive 済みです(YAML が無く、有効な snapshot が解決します)。何もすることはありません。`,
      alreadyArchived: (id: string): string =>
        `フェーズ "${id}" は既に archive 済みです。何もすることはありません。`,
    },
    runbook: {
      header: (phaseId: string): string => `フェーズ ${phaseId} の runbook:`,
      phaseSummary: (summary: {
        task_histogram: {
          planned: number;
          started: number;
          blocked: number;
          resumed: number;
          done: number;
          failed: number;
        };
        phase_status_candidate: string;
      }): string => {
        const h = summary.task_histogram;
        return `  tasks: planned=${h.planned}, started=${h.started}, blocked=${h.blocked}, resumed=${h.resumed}, done=${h.done}, failed=${h.failed} | phase_status_candidate=${summary.phase_status_candidate}`;
      },
      noSteps: "  (次の step はありません — フェーズは安定状態です)",
      step: (
        index: number,
        step: {
          command: string | null;
          manual_action: string | null;
          reason: string;
          blocking: boolean;
          safety_note: string | null;
          expected_result: string | null;
        },
      ): string => {
        const action = step.command ?? `手動: ${step.manual_action}`;
        const prefix = step.blocking ? "[blocking] " : "";
        const safety = step.safety_note
          ? `\n      安全注意: ${step.safety_note}`
          : "";
        const expected = step.expected_result
          ? `\n      期待結果: ${step.expected_result}`
          : "";
        return `  ${index}. ${prefix}${action}\n      理由: ${step.reason}${safety}${expected}`;
      },
    },
  },
  progress: {
    baselineNotFound: (name: string): string =>
      `ベースライン "${name}" が .code-pact/state/baselines/ に見つかりません。`,
  },
  pack: {
    phaseNotFound: (id: string): string =>
      `フェーズ "${id}" が roadmap.yaml に見つかりません。`,
    taskNotFound: (taskId: string, phaseId: string): string =>
      `タスク "${taskId}" がフェーズ "${phaseId}" に見つかりません。`,
    written: (path: string, chars: number): string =>
      `コンテキストパックを ${path} に書き込みました (${chars} 文字)`,
  },
  verify: {
    aborted: "検証はキャンセルされました。",
    phaseNotFound: (id: string): string =>
      `フェーズ "${id}" が roadmap.yaml に見つかりません。`,
    taskNotFound: (taskId: string, phaseId: string): string =>
      `タスク "${taskId}" がフェーズ "${phaseId}" に見つかりません。`,
  },
  adapter: {
    agentNotFound: (name: string): string =>
      `エージェント "${name}" が見つかりません。先に "code-pact init --agent ${name}" を実行してください。`,
    done: (name: string): string =>
      `エージェント "${name}" のアダプターを生成しました。`,
  },
  doctor: {
    healthy: "問題は見つかりませんでした。プロジェクトは健全です。",
    issues: (errors: number, warnings: number): string =>
      `エラー ${errors} 件、警告 ${warnings} 件が見つかりました。`,
  },
  recommend: {
    phaseNotFound: (id: string): string =>
      `フェーズ "${id}" が roadmap.yaml に見つかりません。`,
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
      agentsPrompt: "サポートするエージェントを選択してください",
      defaultAgentPrompt: "デフォルトのエージェントを選択してください",
      verifyCommandPrompt: "デフォルトの検証コマンド",
      verifyCommandHint: "そのままで良ければ Enter",
      verifyCustomOption: "カスタムコマンド…",
      generateAdaptersPrompt:
        "AI エージェント用のルールファイルを生成しますか? (CLAUDE.md / AGENTS.md など)",
      summary: (agents: string[], defaultAgent: string): string =>
        `次の構成で初期化します: ${agents.join(", ")} (既定: ${defaultAgent})`,
      invalidChoice: "選択が不正です。もう一度入力してください。",
      noSelection: "1 つ以上選択してください。",
      nextStepsHeader: "次のステップ:",
      nextStep1: "1. フェーズを作成する:        code-pact phase add",
      nextStep2: "2. タスクを追加する:          code-pact task add <phase-id>",
      nextStep3:
        "3. Agent ワークフローを開始:  code-pact task context <task-id>",
      tutorialHint:
        "タスクの進め方を一度通しで見たいなら `code-pact tutorial` を実行してください（プロジェクトには何も書き込みません）。",
      samplePhaseHint:
        "design/ に起点フェーズを作りたい場合は `code-pact init --sample-phase` を実行してください。",
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
      whatPrompt: "何を作りますか？ (1〜3 文で)",
      whoPrompt: "誰のためですか？ (主なユーザーや関係者)",
      differentiatorPrompt:
        "特徴的なところは何ですか？ (任意 — スキップするなら Enter)",
    },
    constitution: {
      descriptionPrompt:
        "このプロジェクトの判断を導く原則を一言で教えてください (1〜2 文 — デフォルトを使う場合は Enter)",
      principlesPrompt:
        "基本原則をカンマ区切りで入力してください (デフォルトを使う場合は Enter)",
    },
  },
  plan: {
    briefDone: (path: string): string =>
      `プロジェクト概要を ${path} に書き出しました`,
    briefSkipped: (path: string): string =>
      `${path} は既に存在します。上書きするには --force を使ってください。`,
    constitutionDone: (path: string): string =>
      `プロジェクト方針を ${path} に書き出しました`,
    constitutionSkipped: (path: string): string =>
      `${path} は既に存在します。上書きするには --force を使ってください。`,
    promptClipboardCopied: "プロンプトをクリップボードにコピーしました。",
    promptClipboardFailed:
      "クリップボードへのコピーに失敗しました (pbcopy/xclip コマンドが使えません)。",
    promptNoBrief:
      "ヒント: 先に `code-pact plan brief` を実行してプロジェクト説明を追加してください。",
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
    execute: {
      missingTaskId: "task execute にはタスク ID が必要です。",
      missingExecutorFile:
        "task execute には --executor-file <path> が必要です。",
      done: (taskId: string, changed_file: string): string =>
        `タスク ${taskId} 完了: ${changed_file}`,
      ineligible: (taskId: string, reasons: string[]): string =>
        `タスク ${taskId} は one-shot 実行の対象外です:` +
        reasons.map(r => `\n  - ${r}`).join(""),
      worktreeNotClean: (summary: {
        changed_path_count: number;
        changed_paths: string[];
        paths_truncated: boolean;
      }): string =>
        `実行前に working tree がクリーンではありません (${summary.changed_path_count} 件の変更${summary.paths_truncated ? "、一覧は打ち切り" : ""})。`,
      executorMutatedWorktree: (
        summary: {
          changed_path_count: number;
          changed_paths: string[];
          paths_truncated: boolean;
        },
        rollback: string,
        head_changed: boolean,
        index_changed: boolean,
      ): string =>
        `executor が source ファイルを含む working tree に ${summary.changed_path_count} 件の変更を加えました${summary.paths_truncated ? " (一覧は打ち切り)" : ""}; rollback=${rollback}, head_changed=${head_changed}, index_changed=${index_changed}。手動で確認・復元してください。`,
      gitStateUnavailable: (reason: string, source_rollback: string): string =>
        `edit 後に Git 状態を取得できません: ${reason}; source_rollback=${source_rollback}。リポジトリがクリーンであることは保証されません。`,
      executionScopeViolation: (
        summary: {
          changed_path_count: number;
          changed_paths: string[];
          paths_truncated: boolean;
        },
        rollback: string,
        head_changed: boolean,
        index_changed: boolean,
      ): string =>
        `実行スコープ違反: source ファイル外に ${summary.changed_path_count} 件の変更があります${summary.paths_truncated ? " (一覧は打ち切り)" : ""}; rollback=${rollback}, head_changed=${head_changed}, index_changed=${index_changed}。`,
      blocked: (taskId: string, reason: string): string =>
        `タスク ${taskId} はブロックされました: ${reason}`,
      editRejected: (taskId: string, reason: string): string =>
        `タスク ${taskId} の edit が拒否されました: ${reason}`,
      executorFailed: (taskId: string, reason: string): string =>
        `タスク ${taskId} の executor が失敗しました: ${reason}`,
      verificationFailed: (taskId: string): string =>
        `タスク ${taskId} の verify が失敗しました; ファイルを復元しました。`,
      rollbackFailed: (taskId: string, reason: string): string =>
        `タスク ${taskId} の rollback に失敗しました: ${reason}`,
      rollbackStaleFile: (taskId: string, reason: string): string =>
        `タスク ${taskId} の rollback が stale file により拒否されました: ${reason}`,
      rollbackIncomplete: (summary: {
        changed_path_count: number;
        changed_paths: string[];
        paths_truncated: boolean;
      }): string =>
        `rollback は不完全です: ${summary.changed_path_count} 件の追加変更が残っています${summary.paths_truncated ? " (一覧は打ち切り)" : ""}。`,
      unknownResult: (result: string): string =>
        `未知の execute 結果 kind です: ${result}`,
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
        `タスク "${taskId}" の verify が失敗しました。progress イベントは記録されていません。`,
      causeDecision: (taskId: string, reason: string): string =>
        reason
          ? `${taskId} は完了前に accepted な ADR が必要です: ${reason}。progress イベントは記録されていません。`
          : `${taskId} は完了前に accepted な ADR が必要です。progress イベントは記録されていません。`,
      causeCommands: (taskId: string, reason: string): string =>
        reason
          ? `${taskId}: 検証コマンドが失敗しました: ${reason}。progress イベントは記録されていません。`
          : `${taskId}: 検証コマンドが失敗しました。progress イベントは記録されていません。`,
      aborted: (taskId: string): string =>
        `タスク "${taskId}" の完了処理はキャンセルされました。progress イベントは記録されていません。`,
      alreadyDone: (taskId: string): string =>
        `タスク "${taskId}" には既に done イベントが存在します。再 verify をスキップしました (idempotent)。`,
      success: (taskId: string, agent: string): string =>
        `タスク "${taskId}" の done イベントを記録しました (agent: ${agent})。`,
      dryRun: (taskId: string): string =>
        `Dry run: タスク "${taskId}" の done イベントを追記する想定です。progress イベントは記録されていません。`,
      invalidTransition: (taskId: string, current: string): string =>
        `タスク "${taskId}" は ${current} 状態です。先に \`code-pact task resume ${taskId}\` を実行してください。`,
      dependencyIncomplete: (taskId: string, deps: string[]): string =>
        `タスク "${taskId}" は完了できません: 依存タスクが未完了です: ${deps.join(", ")}。`,
    },
    failure: {
      cause: (name: string, reason: string): string =>
        `  原因: ${name} — ${reason}`,
      otherChecks: (names: string[]): string =>
        `  他に失敗: ${names.join(", ")}`,
      rerunAfterFixing: (cmd: string): string => `  修正後に再実行: ${cmd}`,
    },
    recordDone: {
      evidenceRequired:
        'task record-done には、完了の根拠（PR、CI 結果、または実行した検証）を示す --evidence "<text>" が必要です。',
      decisionRequired: (taskId: string): string =>
        `タスク "${taskId}" を done にするには decision ADR が必要です。`,
      alreadyDone: (taskId: string): string =>
        `タスク "${taskId}" には既に done イベントが存在します。progress イベントは記録されていません (idempotent)。`,
      success: (taskId: string, agent: string): string =>
        `タスク "${taskId}" の external done イベントを記録しました (agent: ${agent})。`,
      dryRun: (taskId: string): string =>
        `Dry run: タスク "${taskId}" の external done イベントを追記する想定です。progress イベントは記録されていません。`,
      invalidTransition: (taskId: string, current: string): string =>
        `タスク "${taskId}" は ${current} 状態です。先に \`code-pact task resume ${taskId}\` を実行してください。`,
      dependencyIncomplete: (taskId: string, deps: string[]): string =>
        `タスク "${taskId}" を done に記録できません: 依存タスクが未完了です: ${deps.join(", ")}。`,
    },
    finalize: {
      taskNotFound: (taskId: string): string =>
        `タスク "${taskId}" がどのフェーズにも見つかりません。`,
      ambiguous: (taskId: string, phases: string[]): string =>
        `タスク "${taskId}" は複数のフェーズに存在します: ${phases.join(", ")}`,
      notEligible: (taskId: string, current: string): string =>
        `タスク "${taskId}" は finalize できません: derived 状態が "${current}" で、"done" が必要です。先に \`code-pact task complete ${taskId}\` を実行してください。`,
      writeRefused: (taskId: string, reason: string): string =>
        `タスク "${taskId}" の finalize は拒否されました: ${reason}`,
      alreadyFinalized: (taskId: string): string =>
        `タスク "${taskId}" の design status は既に "done" です。書き込みは行いませんでした。`,
      success: (taskId: string, file: string): string =>
        `タスク "${taskId}" を ${file} 上で finalize しました。`,
      wouldFinalize: (taskId: string, file: string): string =>
        `Dry run: ${file} 上でタスク "${taskId}" の status を "done" に書き換える想定です。--write で適用してください。`,
    },
    runbook: {
      header: (taskId: string, phaseId: string): string =>
        `${taskId} の runbook (phase ${phaseId}):`,
      stateSummary: (summary: {
        design_status: string;
        derived_state: string;
        drift_kind: string | null;
      }): string =>
        `  state: design=${summary.design_status}, derived=${summary.derived_state}${summary.drift_kind ? `, drift=${summary.drift_kind}` : ""}`,
      noSteps: "  (次の step はありません — タスクは整合しています)",
      step: (
        index: number,
        step: {
          command: string | null;
          manual_action: string | null;
          reason: string;
          blocking: boolean;
          safety_note: string | null;
          expected_result: string | null;
        },
      ): string => {
        const action = step.command ?? `手動: ${step.manual_action}`;
        const prefix = step.blocking ? "[blocking] " : "";
        const safety = step.safety_note
          ? `\n      安全注意: ${step.safety_note}`
          : "";
        const expected = step.expected_result
          ? `\n      期待結果: ${step.expected_result}`
          : "";
        return `  ${index}. ${prefix}${action}\n      理由: ${step.reason}${safety}${expected}`;
      },
    },
    start: {
      success: (taskId: string, agent: string): string =>
        `タスク "${taskId}" の started イベントを記録しました (agent: ${agent})。`,
      alreadyStarted: (taskId: string): string =>
        `タスク "${taskId}" は既に started 状態です。progress イベントは記録されていません。`,
      invalidTransition: (taskId: string, current: string): string =>
        `状態 "${current}" からタスク "${taskId}" を start できません。`,
    },
    block: {
      success: (taskId: string, reason: string): string =>
        `タスク "${taskId}" の blocked イベントを記録しました (reason: ${reason})。`,
      reasonRequired:
        'task block には --reason "<text>" でブロック理由を指定する必要があります。',
      invalidTransition: (taskId: string, current: string): string =>
        `状態 "${current}" からタスク "${taskId}" を block できません。block は started / resumed からのみ可能です。`,
    },
    resume: {
      success: (taskId: string): string =>
        `タスク "${taskId}" の resumed イベントを記録しました。`,
      invalidTransition: (taskId: string, current: string): string =>
        `状態 "${current}" からタスク "${taskId}" を resume できません。resume は blocked からのみ可能です。`,
    },
    status: {
      headline: (taskId: string, current: string): string =>
        `タスク "${taskId}" — 現在の状態: ${current}`,
      noEvents: (taskId: string): string =>
        `タスク "${taskId}" の進捗イベントはまだ記録されていません。`,
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
      editHint:
        "このファイルを編集して、プロジェクト固有の原則を反映させてください。",
    },
    codingStyle: {
      header: "コーディングスタイルルール",
      rules: [
        "暗黙より明示を優先する。",
        "コミットにコメントアウトしたコードを含めない。",
        "ファイルレベルのエクスポートのみ使用し、内部ヘルパーのバレル再エクスポートは避ける。",
      ],
      editHint:
        "このファイルを編集または削除して、プロジェクトの規約に合わせてください。",
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
        "verify_commands は実際に実行できるシェルコマンドにする（例: pnpm test）。",
        "各タスクに ambiguity / risk / context_size / write_surface / verification_strength を必ず付け、後段の recommend・lint が判断できるようにする。",
        "推測で 'medium' に逃げない。設計が本当に不確実な箇所や前提を置いた箇所は、中間値で体裁を整えず、フェーズの confidence: low とタスクの requires_decision: true で明示する。",
        "フェーズは 基盤 → 能力 → 安定化 の順に並べる。最初に基盤フェーズ（type: architecture 中心）、次に外部から観測できる能力ごとに 1 フェーズ（type: feature 中心）、最後にリリース前の安定化フェーズ（type: test / type: docs 中心）。",
        "各タスクは 1 つの PR に収まる粒度にする（1 タスク = 1 PR）。フェーズの weight は予算ではなく見積もりで、1 フェーズあたり 5〜30 が目安。",
        "readiness フィールド（depends_on / reads / writes / decision_refs / acceptance_refs）は任意。分かるものだけ入れ、不明なものは省略する（空配列は出さない）。`writes` は declared-writes 監査の入力になるので、タスクの出力パスが分かる場合は設定する。",
        "出力は YAML のみとし、前後に説明文を含めない。",
      ],
      schemaOnly: {
        intro:
          "以下の形式どおりに code-pact ロードマップを YAML で出力してください。プロジェクトの文脈はこのセッションに既にあります。このプロンプトは出力形式だけを固定するものなので、新たに考え直さず手元の計画をそのまま使ってください。",
        rulesHeader: "出力ルール",
        rules: [
          "出力は YAML ドキュメントのみ。前後の説明文も Markdown のコードフェンスも付けない。",
          "トップレベルのキーは `phases:`（フェーズオブジェクトの配列）にする。",
          "ネストした `verification:` ブロックではなく `verify_commands`（実行可能なシェルコマンドのフラットな配列、例: pnpm test）を使う。",
          "各タスクに ambiguity / risk / context_size / write_surface / verification_strength を必ず付ける。",
          "設計が本当に不確実な箇所は中間値で逃げず、フェーズの confidence: low とタスクの requires_decision: true で明示する。",
          "readiness フィールド（depends_on / reads / writes / decision_refs / acceptance_refs）は任意。分かるものだけ入れ、不明なものは省略する（空配列は出さない）。`writes` は declared-writes 監査の入力になるので、タスクの出力パスが分かる場合は設定する。",
        ],
      },
    },
    adapterCommon: {
      managedNotice:
        "このファイルは [code-pact](https://github.com/toshtag/code-pact) によって管理されています。",
      editNotice:
        "「プロジェクト固有」とマークされたセクションを編集して、プロジェクトの規約を反映させてください。",
      workflowHeader: "タスクの進め方",
      step0:
        "タスクを prepare する — タスク単位の単一の入口。デフォルト (minimal) では現在の状態、goal、宣言された読み書きスコープ、完了条件、検証コマンド、`next` アクション、そして full envelope を取得するための `more` コマンドを含むコンパクトな作業指示を返す。`--detail full` またはいずれかの budget flag を使うと、実行推奨 (モデル階層、エフォート、計画姿勢、バジェット)、コンテキストパックのメタデータ、構造化された `next_action`、そして次に実行すべき正確なコマンドの `commands` 辞書も返る:",
      step0Detail:
        "minimal モードではコンテキストパックを書き込まず、重い取得処理も行わない。`next.type` が `inspect_decision` の場合、推奨情報が必要な場合、またはコンテキストパックの具体化が指示された場合に限り full detail を取得する。full モードでは返された `commands` 辞書をそのまま使ってライフサイクルを進める。",
      step1:
        "`task prepare` の外でコンテキストパックが必要な場合のみ、直接取得する (診断用 — `task prepare` は既にそのメタデータを返している):",
      step2: "タスクを実装する。",
      step3:
        "タスクを完了としてマークする。verify を実行し、成功すれば `done` イベントを `.code-pact/state/events/` に記録する:",
      step3FailDetail:
        "verify が失敗した場合、このコマンドは exit 1 を返し progress イベントは記録されません。",
      step3IdempotentDetail:
        "`done` イベントが既に存在する場合は no-op (`already_done: true`) となります。",
      step4: "結果をユーザーに報告する。",
      verifyNote:
        "低レベルコマンド `code-pact verify --phase <p> --task <t>` は、進捗イベントを記録せずに verify 出力を確認したい場合に利用できます。",
      validateNote:
        "非自明なタスク開始前に `code-pact validate --json` でプロジェクト全体の整合性 (schema / manifest / plan) を確認する。",
      packNote:
        "**低レベルコマンド:** `code-pact pack` は安定していますが、エージェント向けの入口としては `code-pact task context <task-id>` を推奨します。",
      projectConventionsHeader: "プロジェクト固有の規約",
      projectConventionsHint:
        "このセクションを編集して、実際のプロジェクト規約を記述してください。",
      projectConventionsSource:
        "`design/constitution.md` と `design/rules/` が規約の source of truth です。",
      projectConventionsDefault:
        "`design/rules/coding-style.md` のコーディングスタイルに従う。",
      agentContract: {
        // 見出し文字列は design/decisions/agent-contract-rfc.md により
        // ロケール横断で英語固定 (P16-T4 conformance regex が anchor として使う)。
        sectionHeader: "Agent contract",
        whenHeader: "When to invoke code-pact",
        verifyHeader: "What to verify first",
        failHeader: "How to handle failures",
        intro:
          "code-pact の正規ワークフローには 3 つの軸があります。準拠するエージェントは 3 軸すべてを尊重します。完全な envelope 仕様は [`docs/cli-contract.md`](https://github.com/toshtag/code-pact/blob/main/docs/cli-contract.md) を参照してください。",
        contextCommandBody:
          "`data.commands.context` は `task prepare` を `--detail full` または full detail を強制する明示的な budget flag で実行した場合にのみ存在します。存在する場合は返されたまま使ってください。解決済み context budget を再構築したり、広げたり、置き換えたりしないでください。budget 付き context には決定論的な構造 projection が含まれる場合があります。まず projected form を使用してください。minimal モードで context が必要な場合は `data.more.command` で full envelope を取得してください。具体的な不足が作業を妨げ、かつ `data.deferred_context.retrieve_command` が non-null の場合だけ正確な原文 section を取得してください。`null` の場合は manifest reference から取得 command を組み立てないでください。",
        whenBody: [
          "プロジェクト初期化（CI / 非対話可）:",
          "",
          "```sh",
          "code-pact init --non-interactive --agent claude-code --locale ja-JP --json",
          "",
          "# plan brief: 3 つの相互排他的モード",
          "code-pact plan brief --from-file brief.yaml --json",
          "# または: cat brief.yaml | code-pact plan brief --stdin --json",
          '# または: code-pact plan brief --what "..." --who "..." --differentiator "..." --json',
          "",
          "# plan constitution: 同じ 3 モード構造",
          "code-pact plan constitution --from-file constitution.yaml --json",
          '# または: code-pact plan constitution --description "..." --principle "..." --principle "..." --json',
          "```",
          "",
          "タスクごと (推奨入口: `task prepare`):",
          "",
          "```sh",
          "# デフォルト minimal — context pack の build/取得なしのコンパクトな作業指示",
          "code-pact task prepare <task-id> --agent claude-code --json",
          "",
          "# Full detail — 推薦、context pack メタデータ、next_action、commands",
          "code-pact task prepare <task-id> --agent claude-code --detail full --json",
          "",
          "# 明示的な budget flag は full detail を強制する（context pack をサイジングする用途）",
          "code-pact task prepare <task-id> --agent claude-code --budget-bytes 100000 --json",
          "",
          "# prepare の応答に応じてエージェントが呼び出す lifecycle verb:",
          "code-pact task start    <task-id> --agent claude-code",
          "# ... 実装 ...",
          "code-pact verify --phase <p> --task <task-id>",
          "code-pact task complete <task-id> --agent claude-code",
          "code-pact task finalize <task-id> --write --json",
          "",
          "# 補助 diagnostic:",
          "code-pact task context <task-id> --agent claude-code",
          "code-pact recommend --phase <p> --task <task-id> --agent claude-code --json",
          "code-pact validate --json",
          "",
          "# CI: --audit-strict は --base-ref <default-branch> と --json を併用（working tree が clean な CI では merge-base 起点で audit）",
          "```",
          "",
          "順序ガイダンスには `code-pact task runbook <id> --json` と `code-pact phase runbook <id> --json` が read-only で使えます。",
          "",
          "起動ルール (エージェントの振る舞い):",
          "",
          "- ユーザーがタスクを指定して実装を依頼したら (例: 「P1-T1 をやって」)、まずデフォルト minimal の `task prepare` から始める。",
          "- デフォルトの minimal 出力は bounded な作業指示である: `data.task`、`data.next`、`data.more.command`。context pack を構築せず、重い取得も行わない。",
          "- 明示的な budget flag (`--budget-bytes`, `--context-budget`, `--recommended-context-budget`) は `--detail minimal` を無視して `--detail full` を強制する。",
          "- `next.type` (minimal) または `next_action.type` (full) を読む。可能な値は `start_task`, `continue_implementation`, `wait_for_dependencies`, `resolve_block`, `inspect_decision`, `noop_already_done`, `investigate_failure` である。",
          "- next action が `wait_for_dependencies` の場合は実装しない — ブロックしている依存タスクを解消してから `task prepare` を再実行する。",
          "- next action が `resolve_block` (manual block) の場合は `block.summary` (512 UTF-8 bytes 以内に bounded) の理由を解消してから `task prepare` を再実行する。",
          "- next action が `inspect_decision` (`planned` 状態の `requires_decision` タスク) の場合、開始前に `next.command` の full-detail `task prepare` を実行して decision commitments を取得する。",
          "- next action が `investigate_failure` の場合、`failure.summary` (512 UTF-8 bytes 以内に bounded) から原因を調査し、修正後に `task start` (または `task prepare`) を再実行する。",
          "- `CONTEXT_OVER_BUDGET` のときは勝手にコンテキストを広げず、バジェット・タスク分割・達成可能な最小バイト数を報告する。",
          "- `task finalize --write` は `task complete` が `done` イベントを記録した後にのみ実行する。",
        ].join("\n"),
        verifyBody: [
          "実装前:",
          "",
          "- `data.recommendation` は `task prepare` を `--detail full` または full detail を強制する明示的な budget flag で実行した場合にのみ存在します。実行プロファイルが必要な場合は `task prepare --detail full --json` または `recommend --json` から読みます。",
          "- `recommend --json` の後は `data` を読みます。",
          "- その recommendation object を、レポートではなく実行プロファイルとして扱ってください:",
          "  - `tier` / `modelId` → 継続 / モデル切替 / runtime が **cannot switch model**（モデルを切り替えられない）場合は無視せず限界として報告する。",
          "  - `effort` → 推論の深さ。`planningRequired` が true なら編集前に plan を書く。",
          "  - `lifecycleMode` → ループを選ぶ: `full_loop`（prepare→start→complete→finalize）/ `decision_loop`（先に decision ADR を解決）/ `record_only`。",
          '- `record_only` は**ループを軽くするだけで、検証を省くものではない**: プロジェクトの検証コマンドを省略せず実行し、その後 `task record-done --evidence "..."` で正直に記録する（evidence 必須・decision gate も honor）。',
          "- タスクの `writes` field を読み、実際の意図を正確に反映させます。これにより `write_audit` advisory が有効な signal を出せます。",
          "",
          "`task finalize --write` の前:",
          "",
          "- 先に同じコマンドを `--json` のみ（`--write` なし）で実行し、`data.write_audit` を確認します。`outside_declared` や `declared_unused` が非空なら declared writes を先に修正します。",
          "- ブランチレベルの audit には `--base-ref main` を渡します（`--json` 必須）。",
          "- CI（working tree が clean / commit 済み）では、`--audit-strict` に `--base-ref <default-branch>` を併用してください。merge-base 起点で audit が走ります。`--base-ref` 無しだと未 commit の差分しか見えず、宣言された writes が working tree に現れていない task では `TASK_WRITES_AUDIT_DECLARED_UNUSED` で fail します: `task finalize <id> --audit-strict --write --json --base-ref origin/main`",
          "- ローカルの pre-commit レビュー（未 commit の working tree を audit する用途）では `--base-ref` 不要: `task finalize <id> --audit-strict --write --json`",
          "",
          "PR 境界:",
          "",
          "- `code-pact validate --json` でプロジェクト整合性を確認。",
          "- `code-pact plan lint --json` は advisory; `--strict` で warning が exit-relevant に昇格します（`--audit-strict` とは別 flag）。",
        ].join("\n"),
        failBody: [
          "- **dependency block** (`task prepare` から) — `next.type` (full detail では `next_action.type`) が `wait_for_dependencies` で、`blocked_by` に未完の上流タスク id が並びます。依存タスクを先に解消してから `task prepare` を再実行してください。",
          "- **manual block** (`task prepare` から) — `next.type` が `resolve_block` で、`blocked_by` は省略されます。`block.summary` の理由 (512 UTF-8 bytes 以内に bounded) を解消してから `task prepare` を再実行してください。手動 `task block` の理由が解消されていれば、`code-pact task resume <task-id>` してから `task prepare` を再実行することもできます。",
          "- **decision-required planned task** (`task prepare` から) — `next.type` が `inspect_decision` です。開始前に `next.command` の full-detail `task prepare` を実行して decision commitments を取得してください。",
          "- **failed task prepare** (`task prepare` から) — `next.type` が `investigate_failure` です。`failure.summary` (512 UTF-8 bytes 以内に bounded) にある最後の verify/finalize 失敗の理由を調査し、修正後に `task start` (または `task prepare`) を再実行してください。",
          "- **task complete の verification failure** (`task complete --json --detail agent` から) — `error.code` は `VERIFICATION_FAILED`（exit 1）。まず `error.cause_code` を確認: `COMMANDS_FAILED` → 失敗した検証コマンドを修正; `DECISION_REQUIRED` → `requires_decision` タスクに accepted な ADR が必要（作成・accept する）; `ABORTED` → 中断要因を解消してから retry。",
          "- **standalone verify failure** (`verify --json --detail agent` から) — `error.cause_code` が保証されるのは cancellation (`ABORTED`) のみです。通常の失敗は `data.failure.kind` で分岐します: `command_failed` → 失敗したコマンドを修正; `timed_out` → timeout または hang したコマンドを調査; `decision_required` → required ADR を解決; `invalid_state` → `data.failure.check` と `data.failure.reason` を読む。",
          "- `invalid_state` の代表的な check は `progress_event`（done event がない、または ledger consistency を確認すべき状態。通常は正規の `task complete` 経路を確認）と `task_status`（progress 上は完了しているが design task status が `done` ではない状態。`task finalize` 経路を確認）です。行動を選ぶ前に必ず `data.failure.reason` を読んでください。",
          "- Agent detail の verification failure では `error.message` は意図的に短い固定文です。診断はこの順で行います: `data.failure.kind`, `data.failure.check`, `data.failure.reason`, `data.failure.fingerprint`（存在する場合）, `data.failure.stderr_excerpt`（存在する場合）, `data.failure.stdout_excerpt`（存在する場合）, `data.failure.evidence_available`, `data.failure.evidence_error`, `data.failure.retrieve_command`。",
          "- `data.prior_local_signal` は、同じ failure fingerprint が bounded local store に保持されていることだけを示します（`exact_match_count`, `last_observed_at`）。過去の repair や仮説の内容は示さないため、推測しないでください。現在の会話または diff から同じ変更をそのまま再実行していると確認できる場合だけ、その再実行を避けます。`stopOnRepeatedFingerprint` が true なら、その停止 contract を先に優先してください。",
          "- `fingerprint`、excerpt、Evidence field は optional で、通常は command-output failure にのみ存在します。`invalid_state`、decision、preflight、configuration failure で存在しないことを新しいエラー扱いしないでください。",
          "- full evidence はデフォルトで取得しないでください。command-output failure で、excerpt だけでは修正判断に不足する場合に限り、`data.failure.retrieve_command` を使います。",
          "- **missing context pack** — デフォルト minimal の `task prepare` は pack を生成・書き込みしません。pack を materialize する場合は、minimal 出力の `data.more.command` を使うか、`code-pact task prepare <task-id> --agent <name> --detail full --json` を実行してください。pack 本文だけ必要な場合は `code-pact task context <task-id> --agent <name>` を使ってください。",
          "- **adapter drift** (`code-pact adapter doctor` / `code-pact adapter conformance <agent>` から) — インストール済み adapter ファイルが manifest と乖離している、または agent contract surface が不完全。`code-pact adapter upgrade <agent> --write` で再適用してください（手動編集を残したい場合は `--accept-modified`）。",
          "- **`LOCK_HELD`** — 別の code-pact mutation が同プロジェクトで進行中。待って retry。`data.lock_holder` で保持者を確認できます。",
          "- **`TASK_FINALIZE_NOT_ELIGIBLE`** — 先に `code-pact task complete <task-id>` を経由してください。derived state が進めば finalize 可能になります。",
          "- **`WRITES_AUDIT_STRICT_FAILED`** — `--audit-strict` + 1 つ以上の `TASK_WRITES_AUDIT_*` warning。(a) declared writes を修正して audit が clean になるようにする、または (b) `--audit-strict` を外して deviation を記録する、のいずれか。この失敗パスでは design YAML は **mutate されません** (`applied: false`)。",
          "- **`CONFIG_ERROR`** — 構造的な引数エラー（mutex flag、必須 positional の欠落、`--audit-strict` / `--base-ref` を `--json` なしで渡した、`--from-file` と `--stdin` 同時指定など）。コマンド surface を再確認してください。",
        ].join("\n"),
        repairBody: [
          "- failure 後は既存の repair policy を読みます。既に `task prepare --detail full`（または full detail を強制する明示的な budget flag）の結果を持っている場合は `data.recommendation.repairPolicy` を使います。それ以外は `code-pact recommend --phase <p> --task <t> --agent <a> --json` を実行し、`data.repairPolicy` を読みます。",
          "- `mode` が `disabled` なら自動 repair はしません。",
          "- `mode` が `bounded` でも repair 対象は `command_failed` のみで、`maxRepairAttempts` が許す 1 回だけです。",
          "- 最初の repair では `same_model_same_effort_same_context` を守り、model / effort / context を変更しません。",
          "- `failure_delta` を使います: Failure Capsule と現在の差分だけです。context 拡張目的で `task prepare`、`task context`、repository-wide discovery を再実行しません。",
          "- bounded repair で非対象の kind は terminal です: `timed_out`, `aborted`, `decision_required`, `unsafe_write`, `invalid_state`, `unknown`。",
          "- full evidence は excerpt が不足する場合だけ取得し、デフォルト取得しません。",
          "- `stopOnRepeatedFingerprint` が true で同一 fingerprint が再発したら停止します。",
          "- `afterExhaustion` が `use_allowed_escalation` の場合、既存の `task prepare --detail full` 結果があれば `data.recommendation.allowedEscalation` を参照します。それ以外は `recommend --json` の `data.allowedEscalation` を参照します。",
        ].join("\n"),
      },
    },
  },
} as const;
