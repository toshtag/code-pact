import { collectPlanArtifacts } from "../core/plan/state.ts";
import { evaluatePrune, type PruneEvaluation } from "../core/decisions/prune.ts";

/**
 * The deterministic part of the dry-run plan PR-C2 will execute: remove the
 * decision file and append a `PRUNED.md` row. The inbound-`.md`-link rewrite
 * list is NOT here yet — it is collected by a separate, shared collector
 * (PR-C1c) and added to this object as an additive field, so callers must treat
 * the plan as **partial** until then. (The collector is intentionally distinct
 * from the conservative eligibility parser `decisionLinksTo`.)
 */
export type PrunePlan = {
  remove_file: string;
  append_ledger: boolean;
  /** True until PR-C1c lands the inbound-link collector; the plan is not yet complete. */
  link_rewrite_pending: true;
};

/** Roadmap / phase-file load issues mean the task graph is only partially known. */
function planArtifactsUnreadable(
  fileIssues: { file?: string }[],
  skippedChecks: string[],
): string | null {
  const graphIssue = fileIssues.find(
    (i) => i.file?.includes("roadmap.yaml") || i.file?.includes("design/phases/"),
  );
  if (graphIssue) return `cannot read the plan graph: ${graphIssue.file}`;
  if (skippedChecks.length > 0) {
    return "roadmap is missing or unparseable, so referencing tasks cannot be fully verified";
  }
  return null;
}

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
  const { state, fallbackPhases, fileIssues, skippedChecks } =
    await collectPlanArtifacts(cwd);
  const phases = state?.phases ?? fallbackPhases;
  const evaluation = await evaluatePrune(cwd, target, phases);

  // Fail CLOSED if the plan graph could not be fully loaded: an unreadable
  // roadmap/phase could hide a not-done task that references the target, so
  // "all referencing tasks are done" is unprovable. (progress/event-ledger
  // issues are out of scope — prune only needs the task/phase graph.)
  const artifactDetail = planArtifactsUnreadable(fileIssues, skippedChecks);
  if (artifactDetail !== null) {
    evaluation.blocks = [
      { gate: "plan_artifacts_unreadable", detail: artifactDetail },
      ...evaluation.blocks,
    ];
    evaluation.eligible = false;
  }

  const warnings: string[] = [];
  if (evaluation.eligible && evaluation.referencing_tasks.length === 0) {
    warnings.push(
      "No task references this decision. Pruning may be safe, but prune cannot prove the decision was shipped through a task reference — confirm it is genuinely retired, not an unconnected record.",
    );
  }

  const plan: PrunePlan | null =
    evaluation.eligible && evaluation.decision !== null
      ? { remove_file: evaluation.decision, append_ledger: true, link_rewrite_pending: true }
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
    case "plan_artifacts_unreadable":
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
    lines.push(`  (partial plan — the inbound-link rewrite list is added in a later release)`);
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

/**
 * A short, stable message for the `DECISION_PRUNE_NOT_ELIGIBLE` error envelope.
 * In JSON mode the full block list is already in `data.blocks`, so the
 * "run with --json" hint is dropped.
 */
export function notEligibleMessage(result: DecisionPruneResult, json = false): string {
  const target = result.decision ?? "(invalid target)";
  const first = result.evaluation.blocks[0];
  const n = result.evaluation.blocks.length;
  const reason = first ? describeBlock(first) : "ineligible";
  if (n > 1) {
    const more = `${target} cannot be pruned: ${reason} (and ${n - 1} more)`;
    return json ? more : `${more} — run with --json for the full block list`;
  }
  return `${target} cannot be pruned: ${reason}`;
}
