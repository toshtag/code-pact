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

/** Per-subcommand usage. Synopsis is intentionally light; points back to cluster help. */
export function subcommandUsage(cluster: string, subcommand: string): string {
  return [
    `Usage: code-pact ${cluster} ${subcommand} [options]`,
    `Run "code-pact ${cluster} --help" for the full subcommand list.`,
  ].join("\n");
}

/**
 * Rich, command-specific help for `task record-done`. This is a newly added
 * public command (v1.21); shipping it with only the generic stub invites
 * misuse, so it gets a full synopsis with flags and examples.
 */
export function taskRecordDoneUsage(): string {
  return [
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
  ].join("\n");
}

/** Writes usage to stdout and returns exit code 0. Mirrors top-level `--help`. */
export function emitUsage(text: string): number {
  process.stdout.write(`${text}\n`);
  return 0;
}
