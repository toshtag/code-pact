// Lightweight usage/help for the subcommand clusters. Before this, a bare
// `code-pact plan` or `code-pact plan lint --help` hit strictParse and came
// back as CONFIG_ERROR — hostile to both humans and agents probing the CLI.
// These helpers let each cluster emit usage (exit 0) instead.

import { renderLeafHelp } from "./spec/render.ts";
import { TASK_SPECS } from "./spec/task.ts";

/** The subcommand list shown for each cluster, mirroring the unknown-subcommand hints. */
const CLUSTER_SUBCOMMANDS: Record<string, string> = {
  plan: "brief | prompt | adopt | constitution | lint | normalize | analyze | import (alias for \"phase import\")",
  task: "add | context | prepare | start | status | block | resume | complete | record-done | finalize | runbook (aliases: reconcile = finalize, next = runbook)",
  phase: "add | new | ls | show | import | reconcile | runbook (alias: next = runbook)",
  adapter: "list | install | upgrade | doctor | conformance",
};

/** True for the tokens that request help: `help`, `--help`, `-h`. */
export function isHelpToken(token: string | undefined): boolean {
  return token === "help" || token === "--help" || token === "-h";
}

/** True when `--help`/`-h` appears anywhere in a subcommand's argument list. */
export function hasHelpFlag(args: string[]): boolean {
  return args.some((a) => a === "--help" || a === "-h");
}

/** Cluster-level usage: the list of subcommands. */
export function clusterUsage(cluster: string): string {
  const subs = CLUSTER_SUBCOMMANDS[cluster] ?? "";
  return [
    `Usage: code-pact ${cluster} <subcommand> [options]`,
    `Subcommands: ${subs}`,
    `Run "code-pact ${cluster} <subcommand> --help" for a specific subcommand.`,
  ].join("\n");
}

/** Generic per-subcommand stub. Used when no rich leaf help is registered. */
function subcommandStub(cluster: string, subcommand: string): string {
  return [
    `Usage: code-pact ${cluster} ${subcommand} [options]`,
    `Run "code-pact ${cluster} --help" for the full subcommand list.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Rich leaf help
//
// Agents probe the CLI by reading `--help`. A bare two-line stub is enough to
// say "this exists", but the lifecycle verbs agents actually drive are worth a
// full synopsis with flags and examples. Each entry below is keyed by
// `"<cluster> <subcommand>"`; commands without an entry fall back to the stub.
// Flag lists mirror the strictParse surface of the corresponding command.
// ---------------------------------------------------------------------------

const LEAF_USAGE: Record<string, () => string> = {
  // P46 step 1 — prepare / complete / finalize derive from CommandSpec
  // (src/cli/spec/task.ts) so parse + help + reference share one source.
  "task prepare": () => renderLeafHelp(TASK_SPECS.prepare!),

  "task complete": () => renderLeafHelp(TASK_SPECS.complete!),

  "task record-done": () =>
    [
      "Usage: code-pact task record-done <task-id> --evidence <text> [options]",
      "",
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
      "",
      "Options:",
      "  --evidence <text>   Required. Completion proof — a PR, a CI result, or",
      "                      the verification command you ran.",
      "  --notes <text>      Optional note stored on the progress event.",
      "  --agent <name>      Agent name. Defaults to project default_agent.",
      "  --dry-run           Show the event without writing progress.yaml.",
      "  --json              Emit JSON.",
      "",
      "Examples:",
      "  code-pact task record-done P1-T1 --evidence \"PR #123\" --notes \"Already merged\"",
      "  code-pact task record-done P1-T2 --evidence \"pnpm test passed; docs-only record_only task\"",
    ].join("\n"),

  "task finalize": () => renderLeafHelp(TASK_SPECS.finalize!),

  "plan prompt": () =>
    [
      "Usage: code-pact plan prompt [options]",
      "",
      "Emit a planning prompt that asks an agent to produce a code-pact roadmap",
      "YAML. By default it embeds design/brief.md and design/constitution.md; in",
      "--schema-only mode it emits just the YAML format example and output rules",
      "for agents that already hold the project context.",
      "",
      "Options:",
      "  --schema-only    Emit only the format example + output rules (no brief/constitution).",
      "  --clipboard      Copy the prompt to the system clipboard.",
      "  --json           Emit JSON.",
      "",
      "Examples:",
      "  code-pact plan prompt --schema-only",
      "  code-pact plan prompt --clipboard",
    ].join("\n"),

  "phase import": () =>
    [
      "Usage: code-pact phase import <file> [options]",
      "",
      "Import phases and tasks from a YAML draft into the roadmap. Lenient by",
      "default (applies schema defaults to AI-generated YAML); --strict rejects",
      "any input that needs defaulting. Reserved ids (e.g. TUTORIAL) and id",
      "collisions are rejected with the whole input left unwritten.",
      "",
      "Options:",
      "  --force                Skip phases whose ids already exist in the roadmap",
      "                         (the rest still import). Task-id collisions are",
      "                         never bypassed.",
      "  --scaffold-decisions   Scaffold a `proposed` ADR stub for every",
      "                         requires_decision task that lacks one (RFC §3-D).",
      "  --strict               Reject input that relies on schema defaults.",
      "  --json                 Emit JSON.",
      "",
      "Examples:",
      "  code-pact phase import design/roadmap-draft.yaml --json",
      "  code-pact phase import design/roadmap-draft.yaml --scaffold-decisions --json",
    ].join("\n"),

  "task add": () =>
    [
      "Usage: code-pact task add <phase-id> [options]",
      "",
      "Append a task to a phase. Two paths: with no --description on a TTY it runs",
      "an interactive wizard; with --description it is non-interactive and --type",
      "is required. For bulk creation from a draft, use `phase import` instead.",
      "",
      "Options:",
      "  --description <text>     Add non-interactively (skips the wizard); requires --type.",
      "  --type <type>            Task type (feature | refactor | docs | test | …). Required with --description.",
      "  --id <task-id>           Override the generated task id. Valid in both paths.",
      "  --depends-on <id>        Upstream task dependency. Repeatable.",
      "  --decision-ref <path>    ADR this task depends on. Repeatable.",
      "  --read <path>            Declared read scope. Repeatable.",
      "  --write <path>           Declared write scope. Repeatable.",
      "  --acceptance-ref <path>  Acceptance reference. Repeatable.",
      "  --ambiguity, --risk, --context-size, --write-surface, --verification-strength, --expected-duration",
      "                           Optional sizing/readiness fields; see the task schema for allowed values.",
      "  --json                   Emit JSON. Valid in both paths.",
      "",
      "Examples:",
      "  code-pact task add P1                         # interactive wizard (TTY)",
      "  code-pact task add P1 --description \"Add X\" --type feature --json",
    ].join("\n"),

  "task context": () =>
    [
      "Usage: code-pact task context <task-id> [options]",
      "",
      "Build and print the task's context pack. Read-only — never mutates",
      "progress.yaml. `task prepare` bundles this with the recommendation; call",
      "`task context` directly when you only need the pack.",
      "",
      "Options:",
      "  --agent <name>        Agent name. Defaults to project default_agent.",
      "  --explain             Print the section-budget table instead of the pack body.",
      "  --budget-bytes <N>    Cap the pack at N bytes (positive integer); over budget",
      "                        returns CONTEXT_OVER_BUDGET with the minimum achievable size.",
      "  --json                Emit JSON.",
      "",
      "Examples:",
      "  code-pact task context P1-T1 --agent claude-code --json",
      "  code-pact task context P1-T1 --explain",
    ].join("\n"),

  "task start": () =>
    [
      "Usage: code-pact task start <task-id> [options]",
      "",
      "Append a `started` event to progress.yaml. Idempotent — a second call from",
      "`started` returns already_started without a duplicate event. Run once per",
      "implementation pass; then `task complete` when verification passes.",
      "",
      "Options:",
      "  --agent <name>    Agent name. Defaults to project default_agent.",
      "  --json            Emit JSON.",
      "",
      "Examples:",
      "  code-pact task start P1-T1 --agent claude-code --json",
    ].join("\n"),

  "task status": () =>
    [
      "Usage: code-pact task status <task-id> [options]",
      "",
      "Print the task's derived state (planned / started / resumed / blocked /",
      "done / failed) and its progress-event history. Read-only — never mutates",
      "progress.yaml. Agent-neutral (takes no --agent).",
      "",
      "Options:",
      "  --json    Emit JSON.",
      "",
      "Examples:",
      "  code-pact task status P1-T1 --json",
    ].join("\n"),

  "task block": () =>
    [
      "Usage: code-pact task block <task-id> --reason <text> [options]",
      "",
      "Append a `blocked` event to progress.yaml. A blocked task must be resumed",
      "(`task resume`) before it can complete. `--reason` is required.",
      "",
      "Options:",
      "  --reason <text>   Required. Why the task is blocked.",
      "  --agent <name>    Agent name. Defaults to project default_agent.",
      "  --json            Emit JSON.",
      "",
      "Examples:",
      "  code-pact task block P1-T1 --reason \"waiting on upstream API\" --json",
    ].join("\n"),

  "task resume": () =>
    [
      "Usage: code-pact task resume <task-id> [options]",
      "",
      "Append a `resumed` event to progress.yaml, clearing a prior block. A",
      "`blocked` task must be resumed before `task complete` will run.",
      "",
      "Options:",
      "  --agent <name>    Agent name. Defaults to project default_agent.",
      "  --json            Emit JSON.",
      "",
      "Examples:",
      "  code-pact task resume P1-T1 --agent claude-code --json",
    ].join("\n"),

  "task runbook": () =>
    [
      "Usage: code-pact task runbook <task-id> [options]",
      "",
      "Print the ordered next-steps for a task (\"what should I do next?\") from its",
      "derived state. Read-only — never mutates progress.yaml. Alias: `task next`.",
      "",
      "Options:",
      "  --json    Emit JSON (read data.next_steps[0].command for the next command).",
      "",
      "Examples:",
      "  code-pact task runbook P1-T1 --json",
    ].join("\n"),
};

/**
 * Per-subcommand usage. Returns the rich leaf help when one is registered for
 * `"<cluster> <subcommand>"`, otherwise the generic two-line stub. Synopsis is
 * intentionally light for unregistered commands; points back to cluster help.
 */
export function subcommandUsage(cluster: string, subcommand: string): string {
  const rich = LEAF_USAGE[`${cluster} ${subcommand}`];
  return rich ? rich() : subcommandStub(cluster, subcommand);
}

/** Writes usage to stdout and returns exit code 0. Mirrors top-level `--help`. */
export function emitUsage(text: string): number {
  process.stdout.write(`${text}\n`);
  return 0;
}
