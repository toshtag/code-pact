// Lightweight usage/help for the subcommand clusters. Before this, a bare
// `code-pact plan` or `code-pact plan lint --help` hit strictParse and came
// back as CONFIG_ERROR — hostile to both humans and agents probing the CLI.
// These helpers let each cluster emit usage (exit 0) instead.

import { renderLeafHelp } from "./spec/render.ts";
import { ADAPTER_SPECS, ADAPTER_SPEC_ORDER } from "./spec/adapter.ts";
import { DECISION_SPECS, DECISION_SPEC_ORDER } from "./spec/decision.ts";
import { PHASE_SPECS, PHASE_SPEC_ORDER } from "./spec/phase.ts";
import { PLAN_SPECS, PLAN_SPEC_ORDER } from "./spec/plan.ts";
import { SPEC_SPECS, SPEC_SPEC_ORDER } from "./spec/spec.ts";
import { STATE_SPECS, STATE_SPEC_ORDER } from "./spec/state.ts";
import { TASK_SPECS } from "./spec/task.ts";

/** The subcommand list shown for each cluster, mirroring the unknown-subcommand hints. */
const CLUSTER_SUBCOMMANDS: Record<string, string> = {
  plan: `${PLAN_SPEC_ORDER.join(" | ")} | import (alias for "phase import")`,
  task: "add | context | prepare | start | status | block | resume | complete | record-done | finalize | runbook (aliases: reconcile = finalize, next = runbook)",
  phase: `${PHASE_SPEC_ORDER.join(" | ")} (alias: next = runbook)`,
  adapter: ADAPTER_SPEC_ORDER.join(" | "),
  decision: DECISION_SPEC_ORDER.join(" | "),
  state: STATE_SPEC_ORDER.join(" | "),
  spec: SPEC_SPEC_ORDER.join(" | "),
};

const PHASE_NEXT_SPEC = {
  ...PHASE_SPECS.runbook,
  command: "next",
  summary: `${PHASE_SPECS.runbook.summary}\n\nAlias for \`phase runbook\`.`,
  examples: PHASE_SPECS.runbook.examples.map((example) =>
    example.replace("phase runbook", "phase next"),
  ),
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

  "phase next": () => renderLeafHelp(PHASE_NEXT_SPEC),

  "task add": () => renderLeafHelp(TASK_SPECS.add!),

  "task context": () => renderLeafHelp(TASK_SPECS.context!),

  "task start": () => renderLeafHelp(TASK_SPECS.start!),

  "task status": () => renderLeafHelp(TASK_SPECS.status!),

  "task block": () => renderLeafHelp(TASK_SPECS.block!),

  "task resume": () => renderLeafHelp(TASK_SPECS.resume!),

  "task runbook": () => renderLeafHelp(TASK_SPECS.runbook!),

  "adapter list": () => renderLeafHelp(ADAPTER_SPECS.list),

  "adapter install": () => renderLeafHelp(ADAPTER_SPECS.install),

  "adapter upgrade": () => renderLeafHelp(ADAPTER_SPECS.upgrade),

  "adapter doctor": () => renderLeafHelp(ADAPTER_SPECS.doctor),

  "adapter conformance": () => renderLeafHelp(ADAPTER_SPECS.conformance),

  "decision prune": () => renderLeafHelp(DECISION_SPECS.prune),

  "decision retire": () => renderLeafHelp(DECISION_SPECS.retire),

  "state compact": () => renderLeafHelp(STATE_SPECS.compact),

  "state compact-archive": () => renderLeafHelp(STATE_SPECS["compact-archive"]),

  "state archive-retention": () => renderLeafHelp(STATE_SPECS["archive-retention"]),

  "state archive-maintain": () => renderLeafHelp(STATE_SPECS["archive-maintain"]),

  "spec import": () => renderLeafHelp(SPEC_SPECS.import),
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
