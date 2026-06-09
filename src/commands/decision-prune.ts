import { collectPlanArtifacts } from "../core/plan/state.ts";
import { evaluatePrune, type PruneEvaluation } from "../core/decisions/prune.ts";
import {
  collectInboundLinks,
  type LinkRewriteItem,
} from "../core/decisions/link-collector.ts";
import {
  applyPrune,
  PrunePlanStaleError,
  PruneWriteError,
  type AppliedRewrite,
  type ApplyPruneHooks,
  type PruneStaleSpan,
  type PruneWritePhase,
} from "../core/decisions/prune-executor.ts";
import {
  resolveRetention,
  type DecisionRetention,
  type RetentionSource,
} from "../core/decisions/retention.ts";

export type { LinkRewriteItem, AppliedRewrite, PruneStaleSpan, PruneWritePhase };

/**
 * The plan `--write` (PR-C2) will execute: remove the decision file, append a
 * `PRUNED.md` row, and apply each collected inbound reference's `rewrite_action`
 * (`tombstone` or `delink`). `link_rewrite.status` is `"ready"` with the
 * collected `items` (the dry-run preview and `--write` share this collector
 * output). Links inside code or image embeds never enter the plan.
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
  /** The effective retention policy in force, and where it came from. */
  policy: DecisionRetention;
  policy_source: RetentionSource;
  warnings: string[];
};

/** Build the pruning verdict + dry-run plan. Pure of side effects (no writes). */
export async function runDecisionPrune(
  cwd: string,
  target: string,
  opts: { policyOverride?: DecisionRetention } = {},
): Promise<DecisionPruneResult> {
  const { policy, source: policy_source } = await resolveRetention(cwd, opts.policyOverride);
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
      const at = `${iss.source_file}:${iss.line ?? "?"}`;
      if (iss.reason === "unreadable") {
        evaluation.blocks.push({
          gate: "link_rewrite_scan_unreadable",
          detail: `cannot read ${iss.source_file} to plan its inbound-link rewrites`,
        });
      } else if (iss.reason === "protected_ledger") {
        evaluation.blocks.push({
          gate: "link_rewrite_unsupported",
          detail: `${at} is a markdown link to the decision inside the append-only ledger (PRUNED.md), which prune must not rewrite — remove that link by hand first`,
        });
      } else {
        evaluation.blocks.push({
          gate: "link_rewrite_unsupported",
          detail: `${at} links to the decision with a reference-style link, which prune cannot yet rewrite — convert it to an inline link first`,
        });
      }
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
    policy,
    policy_source,
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
      lines.push(`  inbound references in the write plan: none`);
    } else {
      lines.push(`  inbound references considered by the write plan (${items.length}):`);
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
  lines.push(`  retention policy: ${result.policy} (${result.policy_source})`);
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
    policy: result.policy,
    policy_source: result.policy_source,
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

// ── --write (PR-C2): execute the dry-run plan ──────────────────────────────

/**
 * The outcome of `decision prune --write`. The dry-run verdict + plan is built
 * by the SAME {@link runDecisionPrune} call the preview uses, then executed:
 *
 *  - `ineligible` — a gate blocks the prune; nothing is written (the CLI emits
 *    `DECISION_PRUNE_NOT_ELIGIBLE`, identical to dry-run).
 *  - `stale` — the working tree changed under the plan (a span no longer
 *    matches); the executor wrote nothing (the CLI emits `DECISION_PRUNE_PLAN_STALE`).
 *  - `applied` — inbound links rewritten and the record removed; the ledger was
 *    either appended or already recorded (`ledger_action`).
 */
export type DecisionPruneWriteOutcome =
  | { kind: "ineligible"; dryRun: DecisionPruneResult }
  | { kind: "stale"; decision: string; stale: PruneStaleSpan[] }
  | {
      kind: "write_failed";
      decision: string;
      phase: PruneWritePhase;
      partial_applied: boolean;
      message: string;
    }
  | {
      kind: "applied";
      decision: string;
      removed_file: string;
      link_rewrites_applied: AppliedRewrite[];
      ledger_row: string;
      ledger_action: "appended" | "already_recorded";
      policy: DecisionRetention;
      policy_source: RetentionSource;
      warnings: string[];
    };

/** YYYY-MM-DD (UTC) from an injected clock — keeps the ledger date testable. */
function formatPrunedDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Run the prune verdict and, when eligible, EXECUTE it in least-harmful order:
 * append/verify the ledger row, rewrite inbound links, then delete the record
 * last. Re-validates the target, every link span, and the ledger before touching
 * disk — a stale plan aborts with zero writes. `now` is injected so the ledger
 * date is deterministic under test.
 */
export async function runDecisionPruneWrite(
  cwd: string,
  target: string,
  opts: { now: Date; hooks?: ApplyPruneHooks; policyOverride?: DecisionRetention },
): Promise<DecisionPruneWriteOutcome> {
  const dryRun = await runDecisionPrune(cwd, target, { policyOverride: opts.policyOverride });
  if (!dryRun.eligible || dryRun.plan === null || dryRun.decision === null) {
    return { kind: "ineligible", dryRun };
  }
  const refs = dryRun.evaluation.referencing_tasks.map((t) => t.task_id);
  try {
    const applied = await applyPrune(
      cwd,
      {
        remove_file: dryRun.plan.remove_file,
        items: dryRun.plan.link_rewrite.items,
        ledger: {
          decision: dryRun.decision,
          phase_task: refs.length > 0 ? refs.join(", ") : "—",
          pruned_date: formatPrunedDate(opts.now),
          rationale_home: "git history",
        },
        // The verdict was computed from these exact bytes; the executor refuses to
        // delete the record if it has been edited in place since.
        expected_target_content: dryRun.evaluation.target_content ?? "",
      },
      opts.hooks ?? {},
    );
    return {
      kind: "applied",
      decision: dryRun.decision,
      removed_file: applied.removed_file,
      link_rewrites_applied: applied.link_rewrites_applied,
      ledger_row: applied.ledger_row,
      ledger_action: applied.ledger_action,
      policy: dryRun.policy,
      policy_source: dryRun.policy_source,
      warnings: dryRun.warnings,
    };
  } catch (err) {
    if (err instanceof PrunePlanStaleError) {
      return { kind: "stale", decision: dryRun.decision, stale: err.stale };
    }
    if (err instanceof PruneWriteError) {
      return {
        kind: "write_failed",
        decision: dryRun.decision,
        phase: err.phase,
        partial_applied: err.partial_applied,
        message: err.detail,
      };
    }
    throw err;
  }
}

/** JSON `data` payload for an APPLIED `--write` (the contract surface). */
export function serializeDecisionPruneWrite(
  outcome: Extract<DecisionPruneWriteOutcome, { kind: "applied" }>,
): Record<string, unknown> {
  return {
    mode: "write",
    decision: outcome.decision,
    removed_file: outcome.removed_file,
    link_rewrites_applied: outcome.link_rewrites_applied,
    ledger_row: outcome.ledger_row,
    ledger_action: outcome.ledger_action,
    policy: outcome.policy,
    policy_source: outcome.policy_source,
    warnings: outcome.warnings,
  };
}

/** Human summary for an applied `--write`. */
export function formatDecisionPruneWriteHuman(
  outcome: Extract<DecisionPruneWriteOutcome, { kind: "applied" }>,
): string {
  const lines: string[] = [];
  lines.push(`decision prune (write): ${outcome.decision} — PRUNED`);
  lines.push(`  removed: ${outcome.removed_file}`);
  const n = outcome.link_rewrites_applied.length;
  if (n === 0) {
    lines.push(`  inbound references rewritten: none`);
  } else {
    lines.push(`  inbound references rewritten (${n}):`);
    for (const r of outcome.link_rewrites_applied) {
      lines.push(`    ${r.source_file}:${r.line} — ${r.rewrite_action}`);
    }
  }
  lines.push(
    outcome.ledger_action === "appended"
      ? `  ledger: appended to design/decisions/PRUNED.md`
      : `  ledger: already recorded in design/decisions/PRUNED.md (not re-appended)`,
  );
  lines.push(`  retention policy: ${outcome.policy} (${outcome.policy_source})`);
  for (const w of outcome.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join("\n");
}

/** Message for the `DECISION_PRUNE_PLAN_STALE` error envelope. */
export function planStaleMessage(stale: PruneStaleSpan[]): string {
  const first = stale[0];
  const at = first ? `${first.source_file}:${first.line}:${first.column}` : "an inbound link";
  const more = stale.length > 1 ? ` (and ${stale.length - 1} more)` : "";
  return `prune aborted — the working tree changed under the plan at ${at}${more}; nothing was written. Re-run decision prune to rebuild the plan`;
}

/** `data` payload + message for the `DECISION_PRUNE_WRITE_FAILED` error envelope. */
export function serializeDecisionPruneWriteFailed(
  outcome: Extract<DecisionPruneWriteOutcome, { kind: "write_failed" }>,
): Record<string, unknown> {
  return {
    mode: "write",
    decision: outcome.decision,
    phase: outcome.phase,
    partial_applied: outcome.partial_applied,
    message: outcome.message,
  };
}

export function writeFailedMessage(
  outcome: Extract<DecisionPruneWriteOutcome, { kind: "write_failed" }>,
): string {
  const state = outcome.partial_applied
    ? "some changes were already applied — inspect the working tree before retrying"
    : "nothing was written";
  return `${outcome.decision}: prune --write failed during ${outcome.phase} (${outcome.message}); ${state}`;
}
