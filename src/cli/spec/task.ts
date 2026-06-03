// The single source for the task cluster's CLI surface.
//
// P46 step 1 covers prepare / complete / finalize (the vertical slice that
// proves parse + help + reference all derive from one place). The remaining
// task verbs are ported in step 2. See design/decisions/cli-command-spec-rfc.md.

import type { CommandSpec } from "./types.ts";

const prepare: CommandSpec = {
  cluster: "task",
  command: "prepare",
  positional: "<task-id>",
  summary: [
    "The single per-task entry point. Returns the current state, the execution",
    "recommendation (tier/model/effort/budget), context-pack metadata, a",
    "structured next_action, and a commands dictionary with the exact next",
    "commands to run. Progress-read-only — never mutates progress.yaml, but",
    "writes the context pack unless --dry-run is passed.",
  ].join("\n"),
  // NOT `readOnly: true`: prepare leaves progress.yaml untouched but DOES write
  // the context pack (unless --dry-run), so the generic "Read-only — never
  // mutates progress.yaml" note would mislead. The precise progress-read-only
  // note is inlined in the summary above.
  // See design/decisions/context-pack-write-contract-hygiene-rfc.md.
  flags: [
    { name: "agent", value: "<name>", description: "Agent name. Defaults to project default_agent." },
    { name: "budget-bytes", value: "<N>", description: "Cap the rendered context pack at N bytes." },
    { name: "context-budget", value: "<profile>", description: "Use a named context budget profile (tight, balanced, wide, or an agent-defined profile). Resolves to a byte budget. Mutually exclusive with --budget-bytes." },
    { name: "dry-run", description: "Report the would-write pack path without writing it." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: ["code-pact task prepare P1-T1 --agent claude-code --json"],
};

const complete: CommandSpec = {
  cluster: "task",
  command: "complete",
  positional: "<task-id>",
  summary: [
    "Run verification and, on pass, append a `done` event (source: loop) to",
    "progress.yaml. Idempotent — a second call from `done` returns already_done.",
    "A `blocked` task must be resumed first. To record a `done` without running",
    "verification here — external completion, or a record_only task you verified",
    "yourself — use `task record-done` instead.",
  ].join("\n"),
  flags: [
    { name: "agent", value: "<name>", description: "Agent name. Defaults to project default_agent." },
    { name: "dry-run", description: "Show the event without writing progress.yaml." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: ["code-pact task complete P1-T1 --agent claude-code --json"],
};

const finalize: CommandSpec = {
  cluster: "task",
  command: "finalize",
  positional: "<task-id>",
  summary: [
    "Flip the task's design status to `done` in its phase YAML and audit declared",
    "vs. actual writes. Eligibility: the task's derived state must be `done` (run",
    "`task complete` or `task record-done` first). Dry-run is the default — pass",
    "--write to apply.",
  ].join("\n"),
  flags: [
    { name: "write", description: "Apply the status flip (default is a dry-run preview)." },
    { name: "base-ref", value: "<ref>", description: "Audit against the merge-base with <ref> (branch-level)." },
    { name: "audit-strict", description: "Promote write-audit warnings to a non-zero exit." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact task finalize P1-T1 --json",
    "code-pact task finalize P1-T1 --write --json",
    "code-pact task finalize P1-T1 --audit-strict --base-ref origin/main --write --json",
  ],
};

const add: CommandSpec = {
  cluster: "task",
  command: "add",
  positional: "<phase-id>",
  summary: [
    "Append a task to a phase. Two paths: with no --description on a TTY it runs",
    "an interactive wizard; with --description it is non-interactive and --type",
    "is required. For bulk creation from a draft, use `phase import` instead.",
  ].join("\n"),
  flags: [
    { name: "description", value: "<text>", description: "Add non-interactively (skips the wizard); requires --type." },
    { name: "type", value: "<type>", description: "Task type (feature | refactor | docs | test | …). Required with --description." },
    { name: "id", value: "<task-id>", description: "Override the generated task id. Valid in both paths." },
    { name: "depends-on", value: "<id>", repeatable: true, description: "Upstream task dependency." },
    { name: "decision-ref", value: "<path>", repeatable: true, description: "ADR this task depends on." },
    { name: "read", value: "<path>", repeatable: true, description: "Declared read scope." },
    { name: "write", value: "<path>", repeatable: true, description: "Declared write scope." },
    { name: "acceptance-ref", value: "<path>", repeatable: true, description: "Acceptance reference." },
    { name: "ambiguity", value: "<level>", description: "Optional sizing/readiness field; see the task schema for allowed values." },
    { name: "risk", value: "<level>", description: "Optional sizing/readiness field; see the task schema for allowed values." },
    { name: "context-size", value: "<size>", description: "Optional sizing/readiness field; see the task schema for allowed values." },
    { name: "write-surface", value: "<size>", description: "Optional sizing/readiness field; see the task schema for allowed values." },
    { name: "verification-strength", value: "<level>", description: "Optional sizing/readiness field; see the task schema for allowed values." },
    { name: "expected-duration", value: "<dur>", description: "Optional sizing/readiness field; see the task schema for allowed values." },
    { name: "json", description: "Emit JSON. Valid in both paths." },
  ],
  examples: [
    "code-pact task add P1                         # interactive wizard (TTY)",
    'code-pact task add P1 --description "Add X" --type feature --json',
  ],
};

const context: CommandSpec = {
  cluster: "task",
  command: "context",
  positional: "<task-id>",
  summary: [
    "Build and print the task's context pack. `task prepare` bundles this with",
    "the recommendation; call `task context` directly when you only need the pack.",
  ].join("\n"),
  readOnly: true,
  flags: [
    { name: "agent", value: "<name>", description: "Agent name. Defaults to project default_agent." },
    { name: "explain", description: "Print the section-budget table instead of the pack body." },
    { name: "budget-bytes", value: "<N>", description: "Cap the pack at N bytes (positive integer); over budget returns CONTEXT_OVER_BUDGET with the minimum achievable size." },
    { name: "context-budget", value: "<profile>", description: "Use a named context budget profile (tight, balanced, wide, or an agent-defined profile). Resolves to a byte budget. Mutually exclusive with --budget-bytes." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact task context P1-T1 --agent claude-code --json",
    "code-pact task context P1-T1 --explain",
  ],
};

const start: CommandSpec = {
  cluster: "task",
  command: "start",
  positional: "<task-id>",
  summary: [
    "Append a `started` event to progress.yaml. Idempotent — a second call from",
    "`started` returns already_started without a duplicate event. Run once per",
    "implementation pass; then `task complete` when verification passes.",
  ].join("\n"),
  flags: [
    { name: "agent", value: "<name>", description: "Agent name. Defaults to project default_agent." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: ["code-pact task start P1-T1 --agent claude-code --json"],
};

const status: CommandSpec = {
  cluster: "task",
  command: "status",
  positional: "<task-id>",
  summary: [
    "Print the task's derived state (planned / started / resumed / blocked /",
    "done / failed) and its progress-event history. Agent-neutral (takes no --agent).",
  ].join("\n"),
  readOnly: true,
  flags: [{ name: "json", description: "Emit JSON." }],
  examples: ["code-pact task status P1-T1 --json"],
};

const block: CommandSpec = {
  cluster: "task",
  command: "block",
  positional: "<task-id>",
  summary: [
    "Append a `blocked` event to progress.yaml. A blocked task must be resumed",
    "(`task resume`) before it can complete. `--reason` is required.",
  ].join("\n"),
  flags: [
    { name: "reason", value: "<text>", required: true, description: "Why the task is blocked." },
    { name: "agent", value: "<name>", description: "Agent name. Defaults to project default_agent." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: ['code-pact task block P1-T1 --reason "waiting on upstream API" --json'],
};

const resume: CommandSpec = {
  cluster: "task",
  command: "resume",
  positional: "<task-id>",
  summary: [
    "Append a `resumed` event to progress.yaml, clearing a prior block. A",
    "`blocked` task must be resumed before `task complete` will run.",
  ].join("\n"),
  flags: [
    { name: "agent", value: "<name>", description: "Agent name. Defaults to project default_agent." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: ["code-pact task resume P1-T1 --agent claude-code --json"],
};

const runbook: CommandSpec = {
  cluster: "task",
  command: "runbook",
  positional: "<task-id>",
  summary: [
    "Print the ordered next-steps for a task (\"what should I do next?\") from its",
    "derived state. Alias: `task next`.",
  ].join("\n"),
  readOnly: true,
  flags: [
    { name: "json", description: "Emit JSON (read data.next_steps[0].command for the next command)." },
  ],
  examples: ["code-pact task runbook P1-T1 --json"],
};

const recordDone: CommandSpec = {
  cluster: "task",
  command: "record-done",
  positional: "<task-id>",
  summary: [
    "Record a task as done WITHOUT running task complete's verification.",
    "",
    "Use this for:",
    "  1. externally completed work — already-merged work, or changes that",
    "     cannot be verified from the current working tree.",
    "  2. lifecycleMode: record_only tasks — after you have run the project",
    "     verification yourself (record_only is a lighter loop, not lighter",
    "     verification).",
    "",
    "This does NOT run verification commands — the proof is the --evidence you",
    "supply. The decision gate is still enforced for requires_decision tasks.",
    "The event is recorded with source: external.",
  ].join("\n"),
  flags: [
    { name: "evidence", value: "<text>", required: true, description: "Completion proof — a PR, a CI result, or the verification command you ran." },
    { name: "notes", value: "<text>", description: "Optional note stored on the progress event." },
    { name: "agent", value: "<name>", description: "Agent name. Defaults to project default_agent." },
    { name: "dry-run", description: "Show the event without writing progress.yaml." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    'code-pact task record-done P1-T1 --evidence "PR #123" --notes "Already merged"',
    'code-pact task record-done P1-T2 --evidence "pnpm test passed; docs-only record_only task"',
  ],
};

/** task-cluster specs, keyed by subcommand. */
export const TASK_SPECS: Record<string, CommandSpec> = {
  prepare,
  complete,
  finalize,
  add,
  context,
  start,
  status,
  block,
  resume,
  runbook,
  "record-done": recordDone,
};
