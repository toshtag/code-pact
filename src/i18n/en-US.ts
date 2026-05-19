export const messages = {
  usage: [
    "code-pact - Control plane for AI coding agents",
    "",
    "Usage:",
    "  code-pact <command> [options]",
    "  code-pact --version",
    "",
    "Commands:",
    "  init       initialize a project (interactive in a TTY, flag-based otherwise)",
    "  plan       project planning tools (brief | prompt | constitution)",
    "  phase      manage phase contracts (add | new | ls | show | import)",
    "  task       manage tasks (add) and agent-facing commands (context | complete)",
    "  progress   show weighted progress against a baseline snapshot",
    "  pack       write a context pack file under .context/<agent>/",
    "  verify     run deterministic completion criteria",
    "  adapter    generate or refresh per-agent instruction files",
    "  recommend  suggest a model tier for a task",
    "  doctor     report project structure issues (human-friendly)",
    "  validate   check project validity for CI (exit 1 on errors, --strict for warnings)",
    "",
    "Global options:",
    "  -v, --version    print version",
    "  -h, --help       print this help",
    "      --json       emit machine-readable JSON to stdout",
    "      --locale     ja-JP | en-US (defaults to LANG)",
  ].join("\n"),
  unknownCommand: (cmd: string): string => `Unknown command: ${cmd}`,
  init: {
    alreadyInitialized: (dir: string): string =>
      `".code-pact/" already exists in ${dir}. Use --force to overwrite.`,
    created: (n: number): string => `Created ${n} file(s).`,
    done: "Project initialized successfully.",
  },
  phase: {
    added: (id: string, path: string): string => `Phase "${id}" added at ${path}`,
    duplicateId: (id: string): string =>
      `Phase "${id}" already exists. Choose a different ID.`,
    notFound: (id: string): string => `Phase "${id}" not found in roadmap.yaml.`,
    noPhases: "No phases found.",
    importDone: (
      phaseCount: number,
      taskCount: number,
      skippedCount: number,
    ): string => {
      const parts = [
        `Imported ${phaseCount} phase${phaseCount === 1 ? "" : "s"}`,
      ];
      if (taskCount > 0) parts.push(`and ${taskCount} task${taskCount === 1 ? "" : "s"}`);
      if (skippedCount > 0) parts.push(`(skipped ${skippedCount} existing)`);
      return `${parts.join(" ")}.`;
    },
  },
  progress: {
    baselineNotFound: (name: string): string =>
      `Baseline "${name}" not found in .code-pact/state/baselines/.`,
  },
  pack: {
    phaseNotFound: (id: string): string => `Phase "${id}" not found in roadmap.yaml.`,
    taskNotFound: (taskId: string, phaseId: string): string =>
      `Task "${taskId}" not found in phase "${phaseId}".`,
    written: (path: string, chars: number): string =>
      `Context pack written to ${path} (${chars} chars)`,
  },
  verify: {
    phaseNotFound: (id: string): string => `Phase "${id}" not found in roadmap.yaml.`,
    taskNotFound: (taskId: string, phaseId: string): string =>
      `Task "${taskId}" not found in phase "${phaseId}".`,
  },
  adapter: {
    agentNotFound: (name: string): string =>
      `Agent "${name}" not found. Run "code-pact init --agent ${name}" first.`,
    done: (name: string): string => `Agent adapter for "${name}" generated successfully.`,
  },
  doctor: {
    healthy: "No issues found. Project is healthy.",
    issues: (errors: number, warnings: number): string =>
      `Found ${errors} error(s) and ${warnings} warning(s).`,
  },
  recommend: {
    phaseNotFound: (id: string): string => `Phase "${id}" not found in roadmap.yaml.`,
    taskNotFound: (taskId: string, phaseId: string): string =>
      `Task "${taskId}" not found in phase "${phaseId}".`,
    agentNotFound: (name: string): string =>
      `Agent "${name}" not found. Run "code-pact init --agent ${name}" first.`,
  },
  wizard: {
    init: {
      localePrompt: "Select language",
      localeOptionEn: "English",
      localeOptionJa: "日本語",
      agentsPrompt: "Which agents do you want to support? (comma separated)",
      defaultAgentPrompt: "Which agent should be the default?",
      verifyCommandPrompt: "Default verification command",
      verifyCommandHint: "Press Enter to keep the default",
      createSamplePrompt: "Create an example phase file to understand the project structure?",
      generateAdaptersPrompt:
        "Generate AI agent instruction files now? (CLAUDE.md / AGENTS.md etc.)",
      summary: (agents: string[], defaultAgent: string): string =>
        `Will initialize with agents: ${agents.join(", ")} (default: ${defaultAgent}).`,
      invalidChoice: "Invalid choice. Please try again.",
      noSelection: "At least one selection is required.",
      nextStepsHeader: "Next steps:",
      nextStep1: "1. Create a phase:        code-pact phase add",
      nextStep2: "2. Add tasks to a phase:  code-pact task add <phase-id>",
      nextStep3: "3. Start agent workflow:  code-pact task context <task-id>",
    },
    phase: {
      idPrompt: "Phase ID (e.g. P1)",
      namePrompt: "Phase name",
      weightPrompt: "Weight (1-100)",
      weightHint: "  (relative weight; press Enter for default)",
      objectivePrompt: "Objective",
      confidencePrompt: "Confidence",
      confidenceHint: "  (how certain is this design: low / medium / high)",
      riskPrompt: "Risk",
      riskHint: "  (implementation risk: low / medium / high)",
      verifyCommandPrompt: "Verification commands (comma separated)",
      doneCriterionPrompt: "Done criteria (comma separated)",
    },
    task: {
      descriptionPrompt: "Task description",
      typePrompt: "Task type",
    },
    brief: {
      collectBriefPrompt: "Collect a project brief? (creates design/brief.md)",
      whatPrompt: "What are you building? (1–3 sentences)",
      whoPrompt: "Who is it for? (primary users or stakeholders)",
      differentiatorPrompt: "What makes it different? (optional — press Enter to skip)",
    },
    constitution: {
      descriptionPrompt:
        "What principles guide decisions in this project? (1-2 sentences — press Enter to use default)",
      principlesPrompt:
        "Core principles, comma separated (press Enter to use defaults)",
    },
  },
  plan: {
    briefDone: (path: string): string => `Project brief written to ${path}`,
    briefSkipped: (path: string): string =>
      `${path} already exists. Use --force to overwrite.`,
    constitutionDone: (path: string): string => `Project constitution written to ${path}`,
    constitutionSkipped: (path: string): string =>
      `${path} already exists. Use --force to overwrite.`,
    promptClipboardCopied: "Prompt copied to clipboard.",
    promptClipboardFailed: "Could not copy to clipboard — piped pbcopy/xclip command failed.",
    promptNoBrief: "Tip: run `code-pact plan brief` first to add a project description.",
  },
  task: {
    added: (taskId: string, phaseId: string, path: string): string =>
      `Task "${taskId}" added to phase "${phaseId}" at ${path}`,
    context: {
      taskNotFound: (taskId: string): string =>
        `Task "${taskId}" not found in any phase.`,
      ambiguous: (taskId: string, phases: string[]): string =>
        `Task "${taskId}" exists in multiple phases: ${phases.join(", ")}.`,
      agentNotEnabled: (name: string): string =>
        `Agent "${name}" is disabled in project.yaml (enabled: false).`,
      agentNotFound: (name: string): string =>
        `Agent "${name}" is not configured in project.yaml.`,
    },
    complete: {
      taskNotFound: (taskId: string): string =>
        `Task "${taskId}" not found in any phase.`,
      ambiguous: (taskId: string, phases: string[]): string =>
        `Task "${taskId}" exists in multiple phases: ${phases.join(", ")}.`,
      agentNotEnabled: (name: string): string =>
        `Agent "${name}" is disabled in project.yaml (enabled: false).`,
      agentNotFound: (name: string): string =>
        `Agent "${name}" is not configured in project.yaml.`,
      verificationFailed: (taskId: string): string =>
        `Verification failed for "${taskId}". progress.yaml was not modified.`,
      alreadyDone: (taskId: string): string =>
        `Task "${taskId}" already has a done event. Skipped re-verification (idempotent).`,
      success: (taskId: string, agent: string): string =>
        `Recorded done event for "${taskId}" (agent: ${agent}).`,
      dryRun: (taskId: string): string =>
        `Dry run: would append done event for "${taskId}". progress.yaml was not modified.`,
      invalidTransition: (taskId: string, current: string): string =>
        `Task "${taskId}" is ${current}. Run \`code-pact task resume ${taskId}\` before completing.`,
    },
    start: {
      success: (taskId: string, agent: string): string =>
        `Recorded started event for "${taskId}" (agent: ${agent}).`,
      alreadyStarted: (taskId: string): string =>
        `Task "${taskId}" is already started. progress.yaml was not modified.`,
      invalidTransition: (taskId: string, current: string): string =>
        `Cannot start task "${taskId}" from state "${current}".`,
    },
    block: {
      success: (taskId: string, reason: string): string =>
        `Recorded blocked event for "${taskId}" (reason: ${reason}).`,
      reasonRequired:
        "task block requires --reason \"<text>\" describing why the task is blocked.",
      invalidTransition: (taskId: string, current: string): string =>
        `Cannot block task "${taskId}" from state "${current}". Block is allowed from started or resumed.`,
    },
    resume: {
      success: (taskId: string): string =>
        `Recorded resumed event for "${taskId}".`,
      invalidTransition: (taskId: string, current: string): string =>
        `Cannot resume task "${taskId}" from state "${current}". Resume is only valid from blocked.`,
    },
    status: {
      headline: (taskId: string, current: string): string =>
        `Task "${taskId}" — current: ${current}`,
      noEvents: (taskId: string): string =>
        `Task "${taskId}" has no progress events yet.`,
    },
  },
  cliContract: {
    nonInteractiveMissing: (flag: string): string =>
      `${flag} is required in non-interactive mode.`,
    ciDetected:
      "CI environment detected; interactive prompts are disabled. Pass required flags explicitly or unset CI.",
  },
  templates: {
    constitution: {
      description:
        "This file captures the principles that guide every planning and implementation decision in this project.",
      corePrinciplesHeader: "Core principles",
      principles: [
        "Write for the next reader, not just the next test.",
        "Planning decisions must be captured in `design/decisions/`.",
        "Completion criteria must be deterministically verifiable.",
      ],
      editHint: "Edit this file to reflect the actual principles of your project.",
    },
    codingStyle: {
      header: "Coding style rules",
      rules: [
        "Prefer explicit over implicit.",
        "No commented-out code in commits.",
        "File-level exports only; avoid barrel re-exports of internal helpers.",
      ],
      editHint: "Edit or delete this file to match your project conventions.",
    },
    brief: {
      header: "Project Brief",
      whatHeader: "What we're building",
      whoHeader: "Who it's for",
      differentiatorHeader: "What makes it different",
      differentiatorPlaceholder: "(not specified)",
      footer:
        "Regenerate this file with `code-pact plan brief`.\nTo create a planning prompt for AI, run `code-pact plan prompt`.",
    },
    planPrompt: {
      intro:
        "Please read the following project information and create a code-pact roadmap YAML.",
      briefHeader: "Project Brief",
      noBriefNotice:
        "No design/brief.md found. Add a project description above this section manually.",
      constitutionHeader: "Project Constitution",
      formatHeader: "Output Format (YAML)",
      guidelinesHeader: "Guidelines",
      guidelines: [
        "Create 3–7 phases that cover the full scope of the project.",
        "Assign 3–8 tasks per phase.",
        "Total weight across all phases should be approximately 100.",
        "confidence reflects design certainty; risk reflects implementation difficulty.",
        "verification.commands must be real, runnable shell commands (e.g. pnpm test).",
        "Output ONLY the YAML — no explanation text before or after.",
      ],
    },
    adapterCommon: {
      managedNotice:
        "This file is managed by [code-pact](https://github.com/toshtag/code-pact).",
      editNotice:
        'Edit the sections marked "Project-specific" to reflect your project\'s conventions.',
      workflowHeader: "How to work on a task",
      step0: "Get an execution recommendation (model tier, effort, planning posture, budget):",
      step0Detail:
        "The JSON drives model selection, context budget, and whether to plan or proceed directly.",
      step1: "Fetch the context pack:",
      step2: "Implement the task.",
      step3: "Mark the task complete. This runs verify and, on pass, appends a `done` event to `.code-pact/state/progress.yaml`:",
      step3FailDetail:
        "If verify fails, this command exits 1 and progress.yaml is left unchanged.",
      step3IdempotentDetail:
        "If a `done` event already exists, it is a no-op (`already_done: true`).",
      step4: "Report the result to the user.",
      verifyNote:
        "The low-level `code-pact verify --phase <p> --task <t>` is still available if you need to inspect verify output without recording a progress event.",
      validateNote:
        "Run `code-pact validate --json` to check overall project state (schema, manifest, plan integrity) before starting a non-trivial task.",
      packNote:
        "**Internal command:** `code-pact pack` is used internally by `task context`. Do not call `pack` directly — use `code-pact task context <task-id>` instead.",
      projectConventionsHeader: "Project-specific conventions",
      projectConventionsHint:
        "Replace this section with your project's actual conventions.",
      projectConventionsSource:
        "See `design/constitution.md` and `design/rules/` for the source of truth.",
      projectConventionsDefault: "Follow `design/rules/coding-style.md` for code style.",
    },
  },
} as const;
