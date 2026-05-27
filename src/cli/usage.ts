// Lightweight usage/help for the subcommand clusters. Before this, a bare
// `code-pact plan` or `code-pact plan lint --help` hit strictParse and came
// back as CONFIG_ERROR — hostile to both humans and agents probing the CLI.
// These helpers let each cluster emit usage (exit 0) instead.

/** The subcommand list shown for each cluster, mirroring the unknown-subcommand hints. */
const CLUSTER_SUBCOMMANDS: Record<string, string> = {
  plan: "brief | prompt | adopt | constitution | lint | normalize | analyze | import (alias for \"phase import\")",
  task: "add | context | prepare | start | status | block | resume | complete | finalize | runbook (aliases: reconcile = finalize, next = runbook)",
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

/** Writes usage to stdout and returns exit code 0. Mirrors top-level `--help`. */
export function emitUsage(text: string): number {
  process.stdout.write(`${text}\n`);
  return 0;
}
