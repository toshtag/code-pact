// Lightweight usage/help for the subcommand clusters. Before this, a bare
// `code-pact plan` or `code-pact plan lint --help` hit strictParse and came
// back as CONFIG_ERROR — hostile to both humans and agents probing the CLI.
// These helpers let each cluster emit usage (exit 0) instead.

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
  "task prepare": () =>
    [
      "Usage: code-pact task prepare <task-id> [options]",
      "",
      "The single per-task entry point. Returns the current state, the execution",
      "recommendation (tier/model/effort/budget), context-pack metadata, a",
      "structured next_action, and a commands dictionary with the exact next",
      "commands to run. Read-only — never mutates progress.yaml.",
      "",
      "Options:",
      "  --agent <name>        Agent name. Defaults to project default_agent.",
      "  --budget-bytes <N>    Cap the rendered context pack at N bytes.",
      "  --dry-run             Report the would-write pack path without writing it.",
      "  --json                Emit JSON.",
      "",
      "Examples:",
      "  code-pact task prepare P1-T1 --agent claude-code --json",
    ].join("\n"),

  "task complete": () =>
    [
      "Usage: code-pact task complete <task-id> [options]",
      "",
      "Run verification and, on pass, append a `done` event (source: loop) to",
      "progress.yaml. Idempotent — a second call from `done` returns already_done.",
      "A `blocked` task must be resumed first. For work completed OUTSIDE the loop,",
      "use `task record-done` instead.",
      "",
      "Options:",
      "  --agent <name>    Agent name. Defaults to project default_agent.",
      "  --dry-run         Show the event without writing progress.yaml.",
      "  --json            Emit JSON.",
      "",
      "Examples:",
      "  code-pact task complete P1-T1 --agent claude-code --json",
    ].join("\n"),

  "task record-done": () =>
    [
      "Usage: code-pact task record-done <task-id> --evidence <text> [options]",
      "",
      "Record a task as done for work completed OUTSIDE the code-pact loop",
      "(already-merged work, or changes that cannot be verified from the current",
      "working tree). Unlike `task complete`, this does NOT run verification",
      "commands — the proof is the --evidence you supply. The decision gate is",
      "still enforced for requires_decision tasks. The event is recorded with",
      "source: external.",
      "",
      "Options:",
      "  --evidence <text>   Required. Evidence for the externally-completed work.",
      "  --notes <text>      Optional note stored on the progress event.",
      "  --agent <name>      Agent name. Defaults to project default_agent.",
      "  --dry-run           Show the event without writing progress.yaml.",
      "  --json              Emit JSON.",
      "",
      "Examples:",
      "  code-pact task record-done P1-T1 --evidence \"PR #123\"",
      "  code-pact task record-done P1-T1 --evidence \"PR #123\" --notes \"Already merged\"",
    ].join("\n"),

  "task finalize": () =>
    [
      "Usage: code-pact task finalize <task-id> [options]",
      "",
      "Flip the task's design status to `done` in its phase YAML and audit declared",
      "vs. actual writes. Eligibility: the task's derived state must be `done` (run",
      "`task complete` or `task record-done` first). Dry-run is the default — pass",
      "--write to apply.",
      "",
      "Options:",
      "  --write             Apply the status flip (default is a dry-run preview).",
      "  --base-ref <ref>    Audit against the merge-base with <ref> (branch-level).",
      "  --audit-strict      Promote write-audit warnings to a non-zero exit.",
      "  --json              Emit JSON.",
      "",
      "Examples:",
      "  code-pact task finalize P1-T1 --json",
      "  code-pact task finalize P1-T1 --write --json",
      "  code-pact task finalize P1-T1 --audit-strict --base-ref origin/main --write --json",
    ].join("\n"),

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
