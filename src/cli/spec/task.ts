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
    "commands to run.",
  ].join("\n"),
  readOnly: true,
  flags: [
    { name: "agent", value: "<name>", description: "Agent name. Defaults to project default_agent." },
    { name: "budget-bytes", value: "<N>", description: "Cap the rendered context pack at N bytes." },
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

/** task-cluster specs, keyed by subcommand. */
export const TASK_SPECS: Record<string, CommandSpec> = {
  prepare,
  complete,
  finalize,
};
