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
    "  tutorial   watch the task workflow run end to end in a throwaway sandbox",
    "  plan       project planning tools (brief | prompt | constitution)",
    "  phase      manage phase contracts (add | new | ls | show | import)",
    "  task       manage tasks (add) and agent-facing commands (context | complete)",
    "  progress   show weighted progress against a baseline snapshot",
    "  pack       write a context pack file to the agent profile's context_dir",
    "  verify     run deterministic completion criteria",
    "  evidence   show cached verification evidence by reference",
    "  context    inspect or retrieve deferred context by reference",
    "  memory     inspect and prune bounded local loop-memory episodes",
    "  adapter    generate or refresh per-agent rule files",
    "  recommend  suggest a model tier for a task",
    "  doctor     report project structure issues (human-friendly)",
    "  validate   check project validity for CI (exit 1 on errors, --strict for warnings)",
    "  status     team activity overview: in flight / blocked / available / waiting",
    "  decision   decision-record lifecycle (prune — dry-run preview of retiring a shipped decision)",
    "",
    "Global options:",
    "  -v, --version    print version",
    "  -h, --help       print this help",
    "      --json       emit machine-readable JSON to stdout",
    "      --locale     ja-JP | en-US (defaults to LANG)",
  ].join("\n"),
  unknownCommand: (cmd: string): string => `Unknown command: ${cmd}`,
  reviewBundle: {
    missingTaskId: "review-bundle requires a task id.",
    written: (taskId: string, phaseId: string, path: string): string =>
      `Review bundle written for "${taskId}" (phase ${phaseId}) at ${path}.`,
    stateMismatch: (taskId: string): string =>
      `Review bundle refused: task/phase state mismatch for "${taskId}".`,
    verificationMissing: (taskId: string): string =>
      `Review bundle refused: task verification evidence missing for "${taskId}".`,
    scopeImprecise: (declaredUnused: string[]): string =>
      `Review bundle refused: declared writes were not used: ${declaredUnused.join(", ")}.`,
  },
  ciParity: {
    missingTaskId: "ci-parity requires a task id.",
    ok: (taskId: string): string =>
      `ci-parity: review evidence for "${taskId}" matches current HEAD and local verification passed.`,
  },
  init: {
    alreadyInitialized: (dir: string): string =>
      `".code-pact/" already exists in ${dir}. Use --force to overwrite.`,
    created: (n: number): string => `Created ${n} file(s).`,
    done: "Project initialized successfully.",
  },
  tutorial: {
    header: "code-pact tutorial — a short tour of the task workflow",
    sandboxNote: (dir: string): string =>
      `Running in a throwaway sandbox (deleted at the end): ${dir}`,
    step: {
      init: "Scaffold a throwaway project — this is what `code-pact init --sample-phase` writes.",
      prepareT1:
        "Ask code-pact what to do next; it returns the current state and the exact commands to run.",
      start: "Mark the task in-progress so progress is tracked.",
      prepareT2Blocked:
        "TUTORIAL-T2 depends on TUTORIAL-T1, so prepare reports it blocked — work can't start out of order.",
      complete: "Run verification; on pass, a `done` event is recorded.",
      finalize: "Reconcile the design state to match what actually happened.",
      prepareT2Ready:
        "TUTORIAL-T1 is done, so TUTORIAL-T2 is now unblocked and ready to start.",
    },
    result: {
      init: (n: number): string =>
        `created ${n} files (project.yaml, roadmap.yaml, TUTORIAL phase)`,
      prepare: (state: string, next: string): string =>
        `state: ${state} · next: ${next}`,
      started: "started",
      blocked: (deps: string): string => `blocked · waiting on: ${deps}`,
      completed: (n: number): string =>
        `verify passed (${n} checks) · done event recorded`,
      finalized: "finalized",
    },
    done: "Done. The sandbox was deleted — nothing was written to your project.",
    keptNote: (dir: string): string => `Done. Sandbox kept at: ${dir}`,
    realNextSteps:
      "When you're ready, run `code-pact init` in your own project.",
  },
  phase: {
    added: (id: string, path: string): string =>
      `Phase "${id}" added at ${path}`,
    duplicateId: (id: string): string =>
      `Phase "${id}" already exists. Choose a different ID.`,
    notFound: (id: string): string =>
      `Phase "${id}" not found in roadmap.yaml.`,
    noPhases: "No phases found.",
    importDone: (
      phaseCount: number,
      taskCount: number,
      skippedCount: number,
    ): string => {
      const parts = [
        `Imported ${phaseCount} phase${phaseCount === 1 ? "" : "s"}`,
      ];
      if (taskCount > 0)
        parts.push(`and ${taskCount} task${taskCount === 1 ? "" : "s"}`);
      if (skippedCount > 0) parts.push(`(skipped ${skippedCount} existing)`);
      return `${parts.join(" ")}.`;
    },
    reconcile: {
      phaseNotFound: (id: string): string =>
        `Phase "${id}" not found in roadmap.yaml.`,
      noEligible: (id: string): string =>
        `Phase "${id}": no tasks are eligible for finalize (nothing to do).`,
      wouldReconcile: (id: string, count: number): string =>
        `Dry run: would finalize ${count} task${count === 1 ? "" : "s"} in phase "${id}". Run with --write to apply.`,
      reconciled: (id: string, applied: number, skipped: number): string => {
        const parts = [`Reconciled phase "${id}": ${applied} flipped`];
        if (skipped > 0) parts.push(`, ${skipped} skipped`);
        parts.push(".");
        return parts.join("");
      },
      writeRefused: (id: string): string =>
        `Refused to reconcile phase "${id}": every eligible write was refused for safety reasons. Inspect data.skipped_writes for the per-task reason.`,
    },
    archive: {
      wouldArchive: (id: string): string =>
        `Dry run: would archive phase "${id}" (write its snapshot, then delete its YAML). Run with --write to apply.`,
      archived: (id: string): string =>
        `Archived phase "${id}": snapshot written, design/phases YAML deleted.`,
      wouldAlreadyArchived: (id: string): string =>
        `Phase "${id}" is already archived (its YAML is gone and a valid snapshot resolves it). Nothing to do.`,
      alreadyArchived: (id: string): string =>
        `Phase "${id}" is already archived. Nothing to do.`,
    },
    runbook: {
      header: (phaseId: string): string => `Runbook for phase ${phaseId}:`,
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
      noSteps: "  (no next steps — phase is at rest)",
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
        const action = step.command ?? `MANUAL: ${step.manual_action}`;
        const prefix = step.blocking ? "[blocking] " : "";
        const safety = step.safety_note
          ? `\n      safety: ${step.safety_note}`
          : "";
        const expected = step.expected_result
          ? `\n      expected: ${step.expected_result}`
          : "";
        return `  ${index}. ${prefix}${action}\n      reason: ${step.reason}${safety}${expected}`;
      },
    },
  },
  progress: {
    baselineNotFound: (name: string): string =>
      `Baseline "${name}" not found in .code-pact/state/baselines/.`,
  },
  pack: {
    phaseNotFound: (id: string): string =>
      `Phase "${id}" not found in roadmap.yaml.`,
    taskNotFound: (taskId: string, phaseId: string): string =>
      `Task "${taskId}" not found in phase "${phaseId}".`,
    written: (path: string, chars: number): string =>
      `Context pack written to ${path} (${chars} chars)`,
  },
  verify: {
    aborted: "Verification was aborted.",
    phaseNotFound: (id: string): string =>
      `Phase "${id}" not found in roadmap.yaml.`,
    taskNotFound: (taskId: string, phaseId: string): string =>
      `Task "${taskId}" not found in phase "${phaseId}".`,
  },
  adapter: {
    agentNotFound: (name: string): string =>
      `Agent "${name}" not found. Run "code-pact init --agent ${name}" first.`,
    done: (name: string): string =>
      `Agent adapter for "${name}" generated successfully.`,
  },
  doctor: {
    healthy: "No issues found. Project is healthy.",
    issues: (errors: number, warnings: number): string =>
      `Found ${errors} error(s) and ${warnings} warning(s).`,
  },
  recommend: {
    phaseNotFound: (id: string): string =>
      `Phase "${id}" not found in roadmap.yaml.`,
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
      agentsPrompt: "Which agents do you want to support?",
      defaultAgentPrompt: "Which agent should be the default?",
      verifyCommandPrompt: "Default verification command",
      verifyCommandHint: "Press Enter to keep the default",
      verifyCustomOption: "Custom command…",
      generateAdaptersPrompt:
        "Generate AI agent rule files now? (CLAUDE.md / AGENTS.md etc.)",
      summary: (agents: string[], defaultAgent: string): string =>
        `Will initialize with agents: ${agents.join(", ")} (default: ${defaultAgent}).`,
      invalidChoice: "Invalid choice. Please try again.",
      noSelection: "At least one selection is required.",
      nextStepsHeader: "Next steps:",
      nextStep1: "1. Create a phase:        code-pact phase add",
      nextStep2: "2. Add tasks to a phase:  code-pact task add <phase-id>",
      nextStep3: "3. Start agent workflow:  code-pact task context <task-id>",
      tutorialHint:
        "New to the task workflow? Run `code-pact tutorial` to watch it run end to end — nothing is written to your project.",
      samplePhaseHint:
        "Want a starter phase scaffolded into design/? Re-run `code-pact init --sample-phase`.",
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
      whatPrompt: "What are you building? (1–3 sentences)",
      whoPrompt: "Who is it for? (primary users or stakeholders)",
      differentiatorPrompt:
        "What makes it different? (optional — press Enter to skip)",
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
    constitutionDone: (path: string): string =>
      `Project constitution written to ${path}`,
    constitutionSkipped: (path: string): string =>
      `${path} already exists. Use --force to overwrite.`,
    promptClipboardCopied: "Prompt copied to clipboard.",
    promptClipboardFailed:
      "Could not copy to clipboard — piped pbcopy/xclip command failed.",
    promptNoBrief:
      "Tip: run `code-pact plan brief` first to add a project description.",
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
    lock: {
      missingTaskId: "task lock requires a task id.",
      locked: (taskId: string, phaseId: string, path: string): string =>
        `Locked contract for task "${taskId}" in phase "${phaseId}" at ${path}.`,
      contractDrift: (taskId: string, reasons: string[]): string =>
        `TASK_CONTRACT_DRIFT for "${taskId}": ${reasons.join("; ")}`,
    },
    execute: {
      missingTaskId: "task execute requires a task id.",
      missingExecutorFile: "task execute requires --executor-file <path>.",
      done: (taskId: string, changed_file: string): string =>
        `Task ${taskId} done: ${changed_file}`,
      ineligible: (taskId: string, reasons: string[]): string =>
        `Task ${taskId} is not eligible for one-shot execution:` +
        reasons.map(r => `\n  - ${r}`).join(""),
      worktreeNotClean: (summary: {
        changed_path_count: number;
        changed_paths: string[];
        paths_truncated: boolean;
      }): string =>
        `Working tree is not clean before execution (${summary.changed_path_count} path${summary.changed_path_count === 1 ? "" : "s"} changed${summary.paths_truncated ? ", list truncated" : ""}).`,
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
        `Executor modified the working tree before returning (${summary.changed_path_count} file${summary.changed_path_count === 1 ? "" : "s"}${summary.paths_truncated ? ", list truncated" : ""}); rollback=${rollback}, head_changed=${head_changed}, index_changed=${index_changed}. Review and restore the repository manually.`,
      gitStateUnavailable: (reason: string, source_rollback: string): string =>
        `Git state is unavailable after edit: ${reason}; source_rollback=${source_rollback}. The repository may not be clean.`,
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
        `Execution scope violation: ${summary.changed_path_count} file${summary.changed_path_count === 1 ? "" : "s"} changed outside the target source file${summary.paths_truncated ? " (list truncated)" : ""}; rollback=${rollback}, head_changed=${head_changed}, index_changed=${index_changed}.`,
      blocked: (taskId: string, reason: string): string =>
        `Task ${taskId} blocked: ${reason}`,
      editRejected: (taskId: string, reason: string): string =>
        `Edit rejected for ${taskId}: ${reason}`,
      executorFailed: (taskId: string, reason: string): string =>
        `Executor failed for ${taskId}: ${reason}`,
      verificationFailed: (taskId: string): string =>
        `Verification failed for ${taskId}; file rolled back.`,
      rollbackFailed: (taskId: string, reason: string): string =>
        `Rollback failed for ${taskId}: ${reason}`,
      rollbackStaleFile: (taskId: string, reason: string): string =>
        `Rollback stale file for ${taskId}: ${reason}`,
      rollbackIncomplete: (summary: {
        changed_path_count: number;
        changed_paths: string[];
        paths_truncated: boolean;
      }): string =>
        `Rollback incomplete: ${summary.changed_path_count} extra change${summary.changed_path_count === 1 ? "" : "s"} remain${summary.paths_truncated ? " (list truncated)" : ""}.`,
      unknownResult: (result: string): string =>
        `Unknown execute result kind: ${result}`,
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
        `Verification failed for "${taskId}". no progress event was recorded.`,
      causeDecision: (taskId: string, reason: string): string =>
        reason
          ? `${taskId} requires an accepted ADR before completion: ${reason}. no progress event was recorded.`
          : `${taskId} requires an accepted ADR before completion. no progress event was recorded.`,
      causeCommands: (taskId: string, reason: string): string =>
        reason
          ? `${taskId}: a verification command failed: ${reason}. no progress event was recorded.`
          : `${taskId}: a verification command failed. no progress event was recorded.`,
      aborted: (taskId: string): string =>
        `Task completion for "${taskId}" was aborted. No progress event was recorded.`,
      alreadyDone: (taskId: string): string =>
        `Task "${taskId}" already has a done event. Skipped re-verification (idempotent).`,
      success: (taskId: string, agent: string): string =>
        `Recorded done event for "${taskId}" (agent: ${agent}).`,
      dryRun: (taskId: string): string =>
        `Dry run: would append done event for "${taskId}". no progress event was recorded.`,
      invalidTransition: (taskId: string, current: string): string =>
        `Task "${taskId}" is ${current}. Run \`code-pact task resume ${taskId}\` before completing.`,
      dependencyIncomplete: (taskId: string, deps: string[]): string =>
        `Task "${taskId}" cannot be completed: dependencies are not done: ${deps.join(", ")}.`,
    },
    failure: {
      cause: (name: string, reason: string): string =>
        `  cause: ${name} — ${reason}`,
      otherChecks: (names: string[]): string =>
        `  also failed: ${names.join(", ")}`,
      rerunAfterFixing: (cmd: string): string => `  rerun after fixing: ${cmd}`,
    },
    recordDone: {
      evidenceRequired:
        'task record-done requires --evidence "<text>" — the proof of completion (a PR, a CI result, or the verification you ran).',
      decisionRequired: (taskId: string): string =>
        `Task "${taskId}" requires a decision ADR before it can be marked done.`,
      alreadyDone: (taskId: string): string =>
        `Task "${taskId}" already has a done event. no progress event was recorded (idempotent).`,
      success: (taskId: string, agent: string): string =>
        `Recorded external done event for "${taskId}" (agent: ${agent}).`,
      dryRun: (taskId: string): string =>
        `Dry run: would append external done event for "${taskId}". no progress event was recorded.`,
      invalidTransition: (taskId: string, current: string): string =>
        `Task "${taskId}" is ${current}. Run \`code-pact task resume ${taskId}\` before recording done.`,
      dependencyIncomplete: (taskId: string, deps: string[]): string =>
        `Task "${taskId}" cannot be recorded as done: dependencies are not done: ${deps.join(", ")}.`,
    },
    finalize: {
      taskNotFound: (taskId: string): string =>
        `Task "${taskId}" not found in any phase.`,
      ambiguous: (taskId: string, phases: string[]): string =>
        `Task "${taskId}" exists in multiple phases: ${phases.join(", ")}.`,
      notEligible: (taskId: string, current: string): string =>
        `Task "${taskId}" is not finalize-eligible: derived state is "${current}", expected "done". Run \`code-pact task complete ${taskId}\` first.`,
      writeRefused: (taskId: string, reason: string): string =>
        `Refused to finalize "${taskId}": ${reason}.`,
      contractDrift: (taskId: string, reasons: string[]): string =>
        `TASK_CONTRACT_DRIFT for "${taskId}": ${reasons.join("; ")}`,
      alreadyFinalized: (taskId: string): string =>
        `Task "${taskId}" design status is already "done". No change written.`,
      success: (taskId: string, file: string): string =>
        `Finalized "${taskId}" in ${file}.`,
      wouldFinalize: (taskId: string, file: string): string =>
        `Dry run: would flip "${taskId}" status to "done" in ${file}. Run with --write to apply.`,
    },
    runbook: {
      header: (taskId: string, phaseId: string): string =>
        `Runbook for ${taskId} (phase ${phaseId}):`,
      stateSummary: (summary: {
        design_status: string;
        derived_state: string;
        drift_kind: string | null;
      }): string =>
        `  state: design=${summary.design_status}, derived=${summary.derived_state}${summary.drift_kind ? `, drift=${summary.drift_kind}` : ""}`,
      noSteps: "  (no next steps — task is consistent)",
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
        const action = step.command ?? `MANUAL: ${step.manual_action}`;
        const prefix = step.blocking ? "[blocking] " : "";
        const safety = step.safety_note
          ? `\n      safety: ${step.safety_note}`
          : "";
        const expected = step.expected_result
          ? `\n      expected: ${step.expected_result}`
          : "";
        return `  ${index}. ${prefix}${action}\n      reason: ${step.reason}${safety}${expected}`;
      },
    },
    start: {
      success: (taskId: string, agent: string): string =>
        `Recorded started event for "${taskId}" (agent: ${agent}).`,
      alreadyStarted: (taskId: string): string =>
        `Task "${taskId}" is already started. no progress event was recorded.`,
      invalidTransition: (taskId: string, current: string): string =>
        `Cannot start task "${taskId}" from state "${current}".`,
    },
    block: {
      success: (taskId: string, reason: string): string =>
        `Recorded blocked event for "${taskId}" (reason: ${reason}).`,
      reasonRequired:
        'task block requires --reason "<text>" describing why the task is blocked.',
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
      editHint:
        "Edit this file to reflect the actual principles of your project.",
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
        "verify_commands must be real, runnable shell commands (e.g. pnpm test).",
        "Annotate every task with ambiguity, risk, context_size, write_surface, and verification_strength so downstream recommend/lint can reason about it.",
        "Do NOT guess your way to 'medium'. Where the design is genuinely uncertain or you assumed something, mark it explicitly: set the phase's confidence: low and the task's requires_decision: true rather than picking a middle value to look complete.",
        "Order phases foundations → capabilities → stabilization: a foundations phase first (heavy on type: architecture), then one phase per externally-observable capability (type: feature dominates), then a stabilization phase before any release (type: test / type: docs dominate).",
        "Scope each task so it maps to a single PR (one task = one PR). Phase weights are estimates, not budgets — 5–30 is the typical band per phase.",
        "The readiness fields (depends_on, reads, writes, decision_refs, acceptance_refs) are optional: fill the ones you can determine and omit any you cannot — do not emit empty arrays. `writes` is what powers the declared-writes audit, so set it where you know the task's output paths.",
        "Output ONLY the YAML — no explanation text before or after.",
      ],
      schemaOnly: {
        intro:
          "Output a code-pact roadmap as YAML in exactly the format below. Your project context is already in this session — this prompt only fixes the output shape, so re-use the plan you already have rather than inventing a new one.",
        rulesHeader: "Output Rules",
        rules: [
          "Output ONLY the YAML document — no surrounding prose, and no Markdown code fences.",
          "The top-level key must be `phases:` (an array of phase objects).",
          "Use `verify_commands` (a flat list of real, runnable shell commands, e.g. pnpm test) — NOT the nested `verification:` block.",
          "Annotate every task with ambiguity, risk, context_size, write_surface, and verification_strength.",
          "Where the design is genuinely uncertain, mark it explicitly: set the phase's confidence: low and the task's requires_decision: true instead of defaulting to medium.",
          "The readiness fields (depends_on, reads, writes, decision_refs, acceptance_refs) are optional: include the ones you can determine and omit any you cannot — do not emit empty arrays. `writes` is what powers the declared-writes audit, so set it where you know the task's output paths.",
        ],
      },
    },
    adapterCommon: {
      managedNotice:
        "This file is managed by [code-pact](https://github.com/toshtag/code-pact).",
      editNotice:
        'Edit the sections marked "Project-specific" to reflect your project\'s conventions.',
      workflowHeader: "How to work on a task",
      step0:
        "Prepare the task — the single per-task entry point. The default (minimal) call returns a compact work order: current state, goal, declared read/write scope, done-when criteria, verification commands, the `next` action, and a `more` command to fetch the full envelope. Use `--detail full` or any budget flag to also receive the recommendation, context pack metadata, a structured `next_action`, and a `commands` dictionary:",
      step0Detail:
        "In minimal mode, no context pack is written and no heavy retrieval is performed. Fetch the full detail only when `next.type` is `inspect_decision`, you need the recommendation, or you are instructed to materialize the context pack. In full mode, drive the lifecycle from the returned `commands` dictionary.",
      step1:
        "Fetch the context pack directly only if you need it outside `task prepare` (diagnostic — `task prepare` already reports its metadata):",
      step2: "Implement the task.",
      step3:
        "Mark the task complete. This runs verify and, on pass, records a `done` event under `.code-pact/state/events/`:",
      step3FailDetail:
        "If verify fails, this command exits 1 and no progress event is recorded.",
      step3IdempotentDetail:
        "If a `done` event already exists, it is a no-op (`already_done: true`).",
      step4: "Report the result to the user.",
      verifyNote:
        "The low-level `code-pact verify --phase <p> --task <t>` is still available if you need to inspect verify output without recording a progress event.",
      validateNote:
        "Run `code-pact validate --json` to check overall project state (schema, manifest, plan integrity) before starting a non-trivial task.",
      packNote:
        "**Low-level command:** `code-pact pack` is stable, but `code-pact task context <task-id>` is the preferred agent-facing entry.",
      projectConventionsHeader: "Project-specific conventions",
      projectConventionsHint:
        "Replace this section with your project's actual conventions.",
      projectConventionsSource:
        "See `design/constitution.md` and `design/rules/` for the source of truth.",
      projectConventionsDefault:
        "Follow `design/rules/coding-style.md` for code style.",
      agentContract: {
        // Heading strings are English-locked per
        // design/decisions/agent-contract-rfc.md so the conformance
        // regex (P16-T4) can anchor on them across all locales.
        sectionHeader: "Agent contract",
        whenHeader: "When to invoke code-pact",
        verifyHeader: "What to verify first",
        failHeader: "How to handle failures",
        intro:
          "The canonical code-pact workflow has three axes. A conforming agent honors all three. See [`docs/cli-contract.md`](https://github.com/toshtag/code-pact/blob/main/docs/cli-contract.md) for the full envelope reference.",
        contextCommandBody:
          "`data.commands.context` is only present when `task prepare` is run with `--detail full` or an explicit budget flag that forces full detail. When present, use it exactly as returned. Do not reconstruct, widen, or replace the resolved context budget. Budgeted context may contain deterministic structural projections. Use the projected form first. In minimal mode, fetch the full envelope with `data.more.command` when you need context. Retrieve an exact original section only when a specific missing detail blocks the task and `data.deferred_context.retrieve_command` is non-null; otherwise do not construct a retrieval command from the manifest reference.",
        whenBody: [
          "Bootstrap once (CI-friendly, all non-interactive):",
          "",
          "```sh",
          "code-pact init --non-interactive --agent claude-code --locale en-US --json",
          "",
          "# plan brief: three pairwise-mutually-exclusive modes",
          "code-pact plan brief --from-file brief.yaml --json",
          "# OR: cat brief.yaml | code-pact plan brief --stdin --json",
          '# OR: code-pact plan brief --what "..." --who "..." --differentiator "..." --json',
          "",
          "# plan constitution: same three-mode shape",
          "code-pact plan constitution --from-file constitution.yaml --json",
          '# OR: code-pact plan constitution --description "..." --principle "..." --principle "..." --json',
          "```",
          "",
          "Per task (recommended entry point: `task prepare`):",
          "",
          "```sh",
          "# Minimal default — a compact work order without context pack build/retrieval.",
          "code-pact task prepare <task-id> --agent claude-code --json",
          "",
          "# Full detail — recommendation, context pack metadata, next_action, commands.",
          "code-pact task prepare <task-id> --agent claude-code --detail full --json",
          "",
          "# Any explicit budget flag forces full detail (use it to size the context pack).",
          "code-pact task prepare <task-id> --agent claude-code --budget-bytes 100000 --json",
          "",
          "# Lifecycle verbs the agent invokes based on the prepare response:",
          "code-pact task start    <task-id> --agent claude-code",
          "# ... implement ...",
          "code-pact verify --phase <p> --task <task-id>",
          "code-pact task complete <task-id> --agent claude-code",
          "code-pact task finalize <task-id> --write --json",
          "",
          "# Supporting diagnostics:",
          "code-pact task context <task-id> --agent claude-code",
          "code-pact recommend --phase <p> --task <task-id> --agent claude-code --json",
          "code-pact validate --json",
          "",
          "# CI: use --audit-strict with --base-ref <default-branch> and --json so the audit compares against the merge-base when the working tree is clean.",
          "```",
          "",
          "For sequencing guidance, `code-pact task runbook <id> --json` and `code-pact phase runbook <id> --json` are read-only.",
          "",
          "Activation rules (how the agent should behave):",
          "",
          '- When the user names a task to implement (e.g. "work on P1-T1"), start with the default minimal `task prepare`.',
          "- The default minimal output is a bounded work order: `data.task`, `data.next`, and `data.more.command`. It does not build a context pack and does not perform heavy retrieval.",
          "- Any explicit budget flag (`--budget-bytes`, `--context-budget`, `--recommended-context-budget`) forces `--detail full`, ignoring `--detail minimal`.",
          "- Read `next.type` (minimal) or `next_action.type` (full). The possible values are `start_task`, `continue_implementation`, `wait_for_dependencies`, `resolve_block`, `inspect_decision`, `noop_already_done`, and `investigate_failure`.",
          "- If the next action is `wait_for_dependencies`, do not implement — resolve the blocking dependencies and re-run `task prepare`.",
          "- If the next action is `resolve_block` (manual block), resolve the `block.summary` reason (bounded to 512 UTF-8 bytes) and re-run `task prepare`.",
          "- If the next action is `inspect_decision` (a `requires_decision` task in `planned` state), run the full-detail `task prepare` command in `next.command` to fetch decision commitments before starting.",
          "- If the next action is `investigate_failure`, diagnose the failure from `failure.summary` (bounded to 512 UTF-8 bytes) and re-run `task start` after fixing.",
          "- On `CONTEXT_OVER_BUDGET`, do not widen context unasked; report the budget, a task split, or the minimum achievable bytes.",
          "- Run `task finalize --write` only after `task complete` has recorded the `done` event.",
        ].join("\n"),
        verifyBody: [
          "Before implementing:",
          "",
          "- `data.recommendation` is present only when `task prepare` is run with `--detail full` or an explicit budget flag that forces full detail. Read it from `task prepare --detail full --json` or `recommend --json` when you need the execution profile.",
          "- After `recommend --json`, read `data`.",
          "- Treat that recommendation object as an execution profile, not a report:",
          "  - `tier` / `modelId` → continue, switch model, or — when the runtime **cannot switch model** — report the limitation rather than silently ignoring the recommendation.",
          "  - `effort` → reasoning depth. `planningRequired` → write a plan before editing when true.",
          "  - `lifecycleMode` → choose the loop: `full_loop` (prepare→start→complete→finalize), `decision_loop` (resolve the decision ADR first), or `record_only`.",
          '- `record_only` is a lighter *loop*, not lighter verification: do **not** skip the project verification commands. Implement normally, run verification, then record honest completion with `task record-done --evidence "..."` (which still requires evidence and honors the decision gate).',
          "- Read the task's `writes` field. Mirror real intent into it so the `write_audit` advisory has a useful signal.",
          "",
          "Before `task finalize --write`:",
          "",
          "- Run the same command with `--json` first (no `--write`) to inspect `data.write_audit`. If `outside_declared` or `declared_unused` is non-empty, fix the declared writes first.",
          "- For branch-level audit, pass `--base-ref main` (requires `--json`).",
          "- In CI (working tree is clean / commits are pushed), pair `--audit-strict` with `--base-ref <default-branch>` so the audit compares against the merge-base. Without `--base-ref` the audit only sees uncommitted changes and `TASK_WRITES_AUDIT_DECLARED_UNUSED` will fire for any task whose declared writes the working tree does not currently dirty: `task finalize <id> --audit-strict --write --json --base-ref origin/main`.",
          "- For local pre-commit review (uncommitted working tree is the audit target), drop `--base-ref`: `task finalize <id> --audit-strict --write --json`.",
          "",
          "At PR boundaries:",
          "",
          "- `code-pact validate --json` for project integrity.",
          "- `code-pact plan lint --json` for advisory; `--strict` promotes warnings to exit-relevant (distinct from `--audit-strict`).",
        ].join("\n"),
        failBody: [
          "- **dependency block** (from `task prepare`) — `next.type` (or `next_action.type` in full detail) is `wait_for_dependencies` and `blocked_by` lists the upstream task ids. Resolve those tasks first, then re-run `task prepare`.",
          "- **manual block** (from `task prepare`) — `next.type` is `resolve_block`; `blocked_by` is omitted. Resolve the `block.summary` reason (bounded to 512 UTF-8 bytes) and re-run `task prepare`. A manual `task block` whose reason is resolved can also be lifted with `code-pact task resume <task-id>` before re-running `task prepare`.",
          "- **decision-required planned task** (from `task prepare`) — `next.type` is `inspect_decision`. Run the full-detail `task prepare` command in `next.command` to fetch decision commitments before starting.",
          "- **failed task prepare** (from `task prepare`) — `next.type` is `investigate_failure`; `failure.summary` is the last verify/finalize failure reason bounded to 512 UTF-8 bytes. Diagnose and re-run `task start` (or `task prepare`) after fixing.",
          "- **task complete verification failure** (from `task complete --json --detail agent`) — `error.code` is `VERIFICATION_FAILED` (exit 1). Read `error.cause_code` first: `COMMANDS_FAILED` → fix the failing verification command; `DECISION_REQUIRED` → a `requires_decision` task needs an accepted ADR (write/accept it); `ABORTED` → retry only after the interruption is resolved.",
          "- **standalone verify failure** (from `verify --json --detail agent`) — `error.cause_code` is guaranteed only for cancellation (`ABORTED`). For ordinary failures, branch on `data.failure.kind`: `command_failed` → fix the failing command; `timed_out` → investigate timeout or a hanging command; `decision_required` → resolve the required ADR; `invalid_state` → read `data.failure.check` and `data.failure.reason`.",
          "- For `invalid_state`, representative checks are `progress_event` (a done event is missing or the ledger consistency needs attention; usually inspect the proper `task complete` path) and `task_status` (progress indicates completion but the design task status is not `done`; inspect the `task finalize` path). Read `data.failure.reason` before choosing an action.",
          "- For agent-detail verification failures, `error.message` is intentionally short. Diagnose in this order: `data.failure.kind`, `data.failure.check`, `data.failure.reason`, `data.failure.fingerprint` (when present), `data.failure.stderr_excerpt` (when present), `data.failure.stdout_excerpt` (when present), `data.failure.evidence_available`, `data.failure.evidence_error`, then `data.failure.retrieve_command`.",
          "- `data.prior_local_signal` means only that the same failure fingerprint is retained in the bounded local store (`exact_match_count`, `last_observed_at`). It does not describe previous repair attempts or hypotheses; do not infer them. If the current conversation or diff proves the same change is being rerun unchanged, avoid that rerun. If `stopOnRepeatedFingerprint` is true, follow that stop contract first.",
          "- `fingerprint`, excerpts, and Evidence fields are optional and usually exist only for command-output failures. Do not treat their absence on `invalid_state`, decision, preflight, or configuration failures as a new error.",
          "- Do not retrieve full evidence by default. Use `data.failure.retrieve_command` only for command-output failures when the excerpts are insufficient to decide the fix.",
          "- **missing context pack** — Default minimal `task prepare` does not build or write a context pack. To materialize the pack, use `data.more.command` from minimal output or run `code-pact task prepare <task-id> --agent <name> --detail full --json`. If you only need the pack body, run `code-pact task context <task-id> --agent <name>`.",
          "- **adapter drift** (from `code-pact adapter doctor` or `code-pact adapter conformance <agent>`) — the installed adapter files diverged from the manifest, or the agent contract surface is incomplete. Re-run `code-pact adapter upgrade <agent> --write` (use `--accept-modified` to preserve manual edits).",
          "- **`LOCK_HELD`** — another code-pact mutation is in progress. Wait and retry; `data.lock_holder` identifies the holder.",
          "- **`TASK_FINALIZE_NOT_ELIGIBLE`** — route via `code-pact task complete <task-id>` first; the derived state then advances.",
          "- **`WRITES_AUDIT_STRICT_FAILED`** — `--audit-strict` plus at least one `TASK_WRITES_AUDIT_*` warning. Either (a) fix the declared writes so the audit returns clean, or (b) drop `--audit-strict` and document the deviation. The design YAML is **not** mutated on this failure path (`applied: false`).",
          "- **`CONFIG_ERROR`** — structural argument problem (mutually exclusive flags; missing positional; `--audit-strict` / `--base-ref` without `--json`; `--from-file` + `--stdin` together; etc.). Re-read the command surface.",
        ].join("\n"),
        repairBody: [
          "- After a failure, read the existing repair policy. If you already have a `task prepare --detail full` result (or any explicit budget flag that forces full detail) and `data.recommendation.repairPolicy` is present, use it. Otherwise run `code-pact recommend --phase <p> --task <t> --agent <a> --json` and read `data.repairPolicy`.",
          "- If `mode` is `disabled`, do not automatically repair.",
          "- If `mode` is `bounded`, repair only `command_failed`, and only while `maxRepairAttempts` permits the single attempt.",
          "- Keep `same_model_same_effort_same_context`: do not change model, effort, or context before that first repair.",
          "- Use `failure_delta`: the Failure Capsule plus the current diff. Do not rerun `task prepare`, `task context`, or repository-wide discovery just to expand context.",
          "- The nonretryable kinds are terminal for bounded repair: `timed_out`, `aborted`, `decision_required`, `unsafe_write`, `invalid_state`, and `unknown`.",
          "- Fetch full evidence only when excerpts are insufficient; do not fetch it by default.",
          "- If `stopOnRepeatedFingerprint` is true and the same fingerprint recurs, stop.",
          "- When `afterExhaustion` is `use_allowed_escalation`, consult `data.recommendation.allowedEscalation` from an existing `task prepare --detail full` result, or `data.allowedEscalation` from `recommend --json`.",
        ].join("\n"),
      },
    },
  },
} as const;
