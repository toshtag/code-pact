export const messages = {
  usage: [
    "code-pact - Design Control Plane for AI Coding Agents",
    "",
    "Usage:",
    "  code-pact <command> [options]",
    "  code-pact --version",
    "",
    "Commands:",
    "  init       initialize a project control structure",
    "  phase      manage phase contracts (add | ls | show)",
    "  progress   show weighted progress against baseline",
    "  pack       generate context pack for an agent",
    "  verify     verify deterministic completion criteria",
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
      localePrompt: "Select language / 言語を選択してください",
      localeOptionEn: "English",
      localeOptionJa: "日本語",
      agentsPrompt: "Which agents do you want to support? (comma separated)",
      defaultAgentPrompt: "Which agent should be the default?",
      verifyCommandPrompt: "Default verification command",
      verifyCommandHint: "Press Enter to keep the default",
      createSamplePrompt: "Create a sample phase to get started?",
      generateAdaptersPrompt: "Generate adapter files now?",
      summary: (agents: string[], defaultAgent: string): string =>
        `Will initialize with agents: ${agents.join(", ")} (default: ${defaultAgent}).`,
      invalidChoice: "Invalid choice. Please try again.",
      noSelection: "At least one selection is required.",
    },
    phase: {
      idPrompt: "Phase ID (e.g. P1)",
      namePrompt: "Phase name",
      weightPrompt: "Weight (1-100)",
      objectivePrompt: "Objective",
      confidencePrompt: "Confidence (low | medium | high)",
      riskPrompt: "Risk (low | medium | high)",
      verifyCommandPrompt: "Verification commands (comma separated)",
      doneCriterionPrompt: "Done criteria (comma separated)",
    },
  },
  task: {
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
  },
  cliContract: {
    nonInteractiveMissing: (flag: string): string =>
      `${flag} is required in non-interactive mode.`,
    ciDetected:
      "CI environment detected; interactive prompts are disabled. Pass required flags explicitly or unset CI.",
  },
} as const;
