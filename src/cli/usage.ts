// Lightweight usage/help for the subcommand clusters. Before this, a bare
// `code-pact plan` or `code-pact plan lint --help` hit strictParse and came
// back as CONFIG_ERROR — hostile to both humans and agents probing the CLI.
// These helpers let each cluster emit usage (exit 0) instead.

import { renderLeafHelp } from "./spec/render.ts";
import { PHASE_SPECS } from "./spec/phase.ts";
import { PLAN_SPECS } from "./spec/plan.ts";
import { TASK_SPECS } from "./spec/task.ts";

/** The subcommand list shown for each cluster, mirroring the unknown-subcommand hints. */
const CLUSTER_SUBCOMMANDS: Record<string, string> = {
  plan: "brief | prompt | adopt | constitution | lint | normalize | analyze | sync-paths | migrate | import (alias for \"phase import\")",
  task: "add | context | prepare | start | status | block | resume | complete | record-done | finalize | runbook (aliases: reconcile = finalize, next = runbook)",
  phase: "add | new | ls | show | import | reconcile | archive | runbook (alias: next = runbook)",
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

  "task record-done": () => renderLeafHelp(TASK_SPECS["record-done"]!),

  "task finalize": () => renderLeafHelp(TASK_SPECS.finalize!),

  "plan brief": () => renderLeafHelp(PLAN_SPECS.brief),

  "plan prompt": () => renderLeafHelp(PLAN_SPECS.prompt),

  "plan adopt": () => renderLeafHelp(PLAN_SPECS.adopt),

  "plan constitution": () => renderLeafHelp(PLAN_SPECS.constitution),

  "plan lint": () => renderLeafHelp(PLAN_SPECS.lint),

  "plan normalize": () => renderLeafHelp(PLAN_SPECS.normalize),

  "plan analyze": () => renderLeafHelp(PLAN_SPECS.analyze),

  "plan sync-paths": () => renderLeafHelp(PLAN_SPECS["sync-paths"]),

  "plan migrate": () => renderLeafHelp(PLAN_SPECS.migrate),

  "phase add": () => renderLeafHelp(PHASE_SPECS.add),

  "phase new": () => renderLeafHelp(PHASE_SPECS.new),

  "phase ls": () => renderLeafHelp(PHASE_SPECS.ls),

  "phase show": () => renderLeafHelp(PHASE_SPECS.show),

  "phase import": () => renderLeafHelp(PHASE_SPECS.import),

  "phase reconcile": () => renderLeafHelp(PHASE_SPECS.reconcile),

  "phase archive": () => renderLeafHelp(PHASE_SPECS.archive),

  "phase runbook": () => renderLeafHelp(PHASE_SPECS.runbook),

  "task add": () => renderLeafHelp(TASK_SPECS.add!),

  "task context": () => renderLeafHelp(TASK_SPECS.context!),

  "task start": () => renderLeafHelp(TASK_SPECS.start!),

  "task status": () => renderLeafHelp(TASK_SPECS.status!),

  "task block": () => renderLeafHelp(TASK_SPECS.block!),

  "task resume": () => renderLeafHelp(TASK_SPECS.resume!),

  "task runbook": () => renderLeafHelp(TASK_SPECS.runbook!),

  "adapter install": () =>
    [
      "Usage: code-pact adapter install <agent> [options]",
      "",
      "Install an agent adapter — writes its instruction files and skills, and",
      "enables the agent in project config. Mutating.",
      "",
      "Options:",
      "  --model <version>   Pin the agent's model_version at install time.",
      "  --regen-skills      Refresh built-in skill files. A divergent DYNAMIC",
      "                      command-skill that collides with a user file is",
      "                      refused, not overwritten (security).",
      "  --force             Adopt or replace UNMANAGED files only. Does NOT",
      "                      overwrite a managed file with local modifications",
      "                      (use `adapter upgrade --write --accept-modified`).",
      "  --json              Emit JSON.",
      "",
      "Examples:",
      "  code-pact adapter install claude-code --json",
      "  code-pact adapter install claude-code --model claude-opus-4-8 --json",
    ].join("\n"),

  "adapter upgrade": () =>
    [
      "Usage: code-pact adapter upgrade <agent> (--check | --write) [options]",
      "",
      "Re-sync an installed adapter's managed files to the current manifest.",
      "Exactly one of --check or --write is required (they are mutually exclusive):",
      "--check reports drift and exits non-zero if any, writing nothing; --write",
      "applies the upgrade. Mutating only with --write.",
      "",
      "Options:",
      "  --check             Report drift and exit non-zero if any (no writes).",
      "  --write             Apply the upgrade.",
      "  --accept-modified   ALLOW overwriting a managed file that has local",
      "                      modifications with current generator output (this is",
      "                      the destructive flag — without it such files are kept).",
      "  --regen-skills      Refresh built-in skill files. A divergent DYNAMIC",
      "                      command-skill that collides with a user file is",
      "                      refused, not overwritten (security).",
      "  --model <version>   Update the agent's model_version (requires --write).",
      "  --force             Adopt or replace UNMANAGED files only. Does NOT",
      "                      overwrite a modified managed file (use --accept-modified).",
      "  --json              Emit JSON.",
      "",
      "Examples:",
      "  code-pact adapter upgrade claude-code --check --json",
      "  code-pact adapter upgrade claude-code --write --json",
      "  code-pact adapter upgrade claude-code --accept-modified --write --json",
    ].join("\n"),
};

/**
 * Every rendered rich leaf-help string. Introspection helper: lets a guard
 * test scan all examples (e.g. assert every `--model <value>` example actually
 * validates) without reaching into the private LEAF_USAGE registry.
 */
export function allLeafUsages(): string[] {
  return Object.values(LEAF_USAGE).map((render) => render());
}

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
