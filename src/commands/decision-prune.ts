import { collectPlanArtifacts } from "../core/plan/state.ts";
import { evaluatePrune, type PruneEvaluation } from "../core/decisions/prune.ts";

/**
 * The dry-run plan: what `--write` (PR-C2) WOULD do. PR-C1b carries only the
 * deterministic parts — remove the decision file and append a `PRUNED.md` row.
 * The inbound-`.md`-link rewrite list is a separate collector (PR-C1c) that the
 * dry-run report and `--write` will share; it is intentionally NOT the
 * eligibility parser (`decisionLinksTo`), which is conservative on purpose.
 */
export type PrunePlan = {
  remove_file: string;
  append_ledger: boolean;
  /** Filled by PR-C1c. */
  rewrite_links: null;
};

export type DecisionPruneResult = {
  mode: "dry-run";
  decision: string | null;
  eligible: boolean;
  evaluation: PruneEvaluation;
  /** Present only when eligible (there is something to plan). */
  plan: PrunePlan | null;
  warnings: string[];
};

/** Build the pruning verdict + dry-run plan. Pure of side effects (no writes). */
export async function runDecisionPrune(
  cwd: string,
  target: string,
): Promise<DecisionPruneResult> {
  const { state, fallbackPhases } = await collectPlanArtifacts(cwd);
  const phases = state?.phases ?? fallbackPhases;
  const evaluation = await evaluatePrune(cwd, target, phases);

  const warnings: string[] = [];
  if (evaluation.eligible && evaluation.referencing_tasks.length === 0) {
    warnings.push(
      "No task references this decision. Pruning may be safe, but prune cannot prove the decision was shipped through a task reference — confirm it is genuinely retired, not an unconnected record.",
    );
  }

  const plan: PrunePlan | null =
    evaluation.eligible && evaluation.decision !== null
      ? { remove_file: evaluation.decision, append_ledger: true, rewrite_links: null }
      : null;

  return {
    mode: "dry-run",
    decision: evaluation.decision,
    eligible: evaluation.eligible,
    evaluation,
    plan,
    warnings,
  };
}

/** One-line human reason for a block (for `--help`-less human output). */
export function describeBlock(block: PruneEvaluation["blocks"][number]): string {
  switch (block.gate) {
    case "target_invalid":
    case "target_missing":
    case "target_unreadable":
    case "decision_scan_unreadable":
      return block.detail;
    case "target_not_accepted":
      return `target is not an accepted decision (status: ${block.status ?? "none"}, ${block.acceptance})`;
    case "referencing_task_not_done":
      return `task ${block.task_id} (${block.phase_id}) is ${block.status}, not done — references it via ${block.via}`;
    case "open_commitments":
      return `${block.open_items} open implementation commitment(s) remain`;
    case "live_decision_depends":
      return `live decision ${block.decision} (${block.status}) links to it`;
    case "dependency_status_unknown":
      return `${block.decision} links to it but has an unrecognized status (${block.status ?? "none"})`;
    case "dependency_unreadable":
      return `cannot read ${block.decision} to rule it out as a dependant`;
  }
}

/** Human-readable summary (non-JSON mode). */
export function formatDecisionPruneHuman(result: DecisionPruneResult): string {
  const lines: string[] = [];
  const target = result.decision ?? "(invalid target)";
  if (result.eligible) {
    lines.push(`decision prune (dry-run): ${target} — ELIGIBLE`);
    lines.push(`  would remove: ${target}`);
    lines.push(`  would append a row to design/decisions/PRUNED.md`);
    lines.push(`  inbound-link rewrite: computed by \`--write\` (not shown in this dry-run)`);
    const refs = result.evaluation.referencing_tasks;
    lines.push(
      refs.length === 0
        ? `  referencing tasks: none`
        : `  referencing tasks (all done): ${refs.map((r) => r.task_id).join(", ")}`,
    );
  } else {
    lines.push(`decision prune (dry-run): ${target} — NOT ELIGIBLE`);
    for (const b of result.evaluation.blocks) lines.push(`  ✗ ${describeBlock(b)}`);
  }
  for (const w of result.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join("\n");
}

/** JSON `data` payload (the contract surface). */
export function serializeDecisionPrune(result: DecisionPruneResult): Record<string, unknown> {
  return {
    mode: result.mode,
    decision: result.decision,
    eligible: result.eligible,
    blocks: result.evaluation.blocks,
    referencing_tasks: result.evaluation.referencing_tasks,
    plan: result.plan,
    warnings: result.warnings,
  };
}

/** A short, stable message for the `DECISION_PRUNE_NOT_ELIGIBLE` error envelope. */
export function notEligibleMessage(result: DecisionPruneResult): string {
  const target = result.decision ?? "(invalid target)";
  const first = result.evaluation.blocks[0];
  const n = result.evaluation.blocks.length;
  const reason = first ? describeBlock(first) : "ineligible";
  return n > 1
    ? `${target} cannot be pruned: ${reason} (and ${n - 1} more) — run with --json for the full block list`
    : `${target} cannot be pruned: ${reason}`;
}
