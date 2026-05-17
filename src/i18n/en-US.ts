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
    "  phase      manage phase contracts (add | new | ls | show | import)",
    "  task       manage tasks (add) and agent-facing commands (context | complete)",
    "  progress   show weighted progress against a baseline snapshot",
    "  pack       write a context pack file under .context/<agent>/",
    "  verify     run deterministic completion criteria",
    "  adapter    generate or refresh per-agent instruction files",
    "  recommend  suggest a model tier for a task",
    "  doctor     report project structure issues",
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
    },
  },
  cliContract: {
    nonInteractiveMissing: (flag: string): string =>
      `${flag} is required in non-interactive mode.`,
    ciDetected:
      "CI environment detected; interactive prompts are disabled. Pass required flags explicitly or unset CI.",
  },
} as const;
