import { collectPlanArtifacts } from "../core/plan/state.ts";
import { evaluatePrune, type PruneEvaluation } from "../core/decisions/prune.ts";
import {
  collectInboundLinks,
  type LinkRewriteItem,
} from "../core/decisions/link-collector.ts";

export type { LinkRewriteItem };

/**
 * The plan `--write` (PR-C2) will execute: remove the decision file, append a
 * `PRUNED.md` row, and rewrite each inbound link. `link_rewrite.status` is
 * `"ready"` with the collected `items` (the dry-run preview and `--write` share
 * this collector output).
 */
export type PrunePlan = {
  remove_file: string;
  append_ledger: boolean;
  link_rewrite: { status: "pending" | "ready"; items: LinkRewriteItem[] };
};

/** Roadmap / phase-file load issues mean the task graph is only partially known. */
function planArtifactsUnreadable(
  fileIssues: { file?: string }[],
  skippedChecks: string[],
): string | null {
  // Match on a path-segment boundary (handles both cwd-relative and absolute
  // issue paths) rather than a loose substring.
  const isGraphFile = (f?: string): boolean =>
    f !== undefined &&
    /(^|\/)design\/(roadmap\.yaml|phases\/)/.test(f.replace(/\\/g, "/"));
  const graphIssue = fileIssues.find((i) => isGraphFile(i.file));
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
    evaluation.blocks = [{ gate: "plan_artifacts_unreadable", detail: artifactDetail }, ...evaluation.blocks];
  }

  // Build the rewrite plan from the shared collector. Run it whenever the TARGET
  // itself is valid (a readable, top-level, accepted record) — even if the core
  // verdict already failed on another gate — so `data.blocks[]` lists EVERY
  // failing gate at once (the user shouldn't fix one and hit the next). Fail
  // CLOSED on any scan issue (an unreadable doc source, or a reference-style
  // inbound link the span-local executor can't rewrite without touching usages).
  const TARGET_GATES = new Set([
    "target_invalid",
    "target_missing",
    "target_unreadable",
    "target_not_accepted",
  ]);
  const targetOk =
    evaluation.decision !== null && !evaluation.blocks.some((b) => TARGET_GATES.has(b.gate));
  let planItems: PrunePlan["link_rewrite"]["items"] = [];
  if (targetOk && evaluation.decision !== null) {
    const { items, issues } = await collectInboundLinks(cwd, evaluation.decision);
    for (const iss of issues) {
      evaluation.blocks.push(
        iss.reason === "unreadable"
          ? {
              gate: "link_rewrite_scan_unreadable",
              detail: `cannot read ${iss.source_file} to plan its inbound-link rewrites`,
            }
          : {
              gate: "link_rewrite_unsupported",
              detail: `${iss.source_file}:${iss.line ?? "?"} links to the decision with a reference-style link, which prune cannot yet rewrite — convert it to an inline link first`,
            },
      );
    }
    planItems = items;
  }

  // The verdict is the union of all gates collected above.
  evaluation.eligible = evaluation.blocks.length === 0;

  const warnings: string[] = [];
  if (evaluation.eligible && evaluation.referencing_tasks.length === 0) {
    warnings.push(
      "No task references this decision. Pruning may be safe, but prune cannot prove the decision was shipped through a task reference — confirm it is genuinely retired, not an unconnected record.",
    );
  }

  const plan: PrunePlan | null =
    evaluation.eligible && evaluation.decision !== null
      ? {
          remove_file: evaluation.decision,
          append_ledger: true,
          link_rewrite: { status: "ready", items: planItems },
        }
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
    case "link_rewrite_scan_unreadable":
    case "link_rewrite_unsupported":
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
    const items = result.plan?.link_rewrite.items ?? [];
    if (items.length === 0) {
      lines.push(`  inbound links to rewrite: none`);
    } else {
      lines.push(`  inbound links to rewrite (${items.length}):`);
      for (const it of items) {
        lines.push(`    ${it.source_file}:${it.line} — ${it.rewrite_action} (${it.link_kind})`);
      }
    }
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
