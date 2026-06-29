import { readFile } from "../project-fs/index.ts";
import type { PhaseEntry } from "../plan/state.ts";
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";
import { normalizePrunedDecisionPath } from "./pruned-ledger.ts";
import {
  classifyAdr,
  makeDecisionResolver,
  readDecisionAdrFiles,
  parseAdrCommitments,
  isDecisionRequiredForTask,
} from "./adr.ts";
import { isLiveDecisionStatus, decisionLinksTo } from "./prune.ts";

// ---------------------------------------------------------------------------
// `decision retire` eligibility verdict — design-docs-ephemeral step 7 PR-B2.
//
// INDEPENDENT of `evaluatePrune` (the design's `duplication + parity` fallback —
// `evaluatePrune` is too tightly coupled to extract move-only without risking a
// prune regression; PR-B2 must not touch prune behavior). `// keep in sync with
// prune.ts`: the integrity gates here MUST match prune's (target resolution,
// open_commitments, the live-dependant / unreadable-scan gates) so the two
// verdicts can't drift — pinned by a parity test. The ONLY intended differences:
//   - retire accepts ANY status (no `target_not_accepted` gate);
//   - retire rewrites no links (no `link_rewrite_*` gates);
//   - the referencing gate is STATUS-SENSITIVE (see `collectRetireReferences`).
//
// `collectRetireReferences` is reused at the post-write final external-state
// recheck (decision-retire.ts), where "accepted" comes from the readback-verified
// record rather than the live `.md`.
// ---------------------------------------------------------------------------

export type RetireBlock =
  | { gate: "target_invalid"; detail: string }
  | { gate: "target_missing"; detail: string }
  | { gate: "target_unreadable"; detail: string }
  | {
      gate: "referencing_task_not_done";
      task_id: string;
      phase_id: string;
      via: RetireRefVia;
      status: string;
    }
  | { gate: "open_commitments"; open_items: number }
  | { gate: "live_decision_depends"; decision: string; status: string }
  | {
      gate: "dependency_status_unknown";
      decision: string;
      status: string | null;
    }
  | { gate: "dependency_unreadable"; decision: string }
  | { gate: "decision_scan_unreadable"; detail: string }
  | { gate: "plan_artifacts_unreadable"; detail: string };

export type RetireRefVia =
  | "decision_refs"
  | "acceptance_refs"
  | "filename_scan";

export type RetireReferencingTask = {
  task_id: string;
  phase_id: string;
  status: string;
  via: RetireRefVia;
};

export type RetireEvaluation = {
  decision: string | null;
  eligible: boolean;
  blocks: RetireBlock[];
  referencing_tasks: RetireReferencingTask[];
  /** The live `.md` content read once (null when the target was missing/unreadable). */
  target_content: string | null;
};

function errText(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code) return code;
  return err instanceof Error ? err.message : String(err);
}

/**
 * STATUS-SENSITIVE referencing scan (the round-2 fix). Classifies every active
 * (not-done) task's reference to `decision` as `decision_refs` / `acceptance_refs`
 * / `filename_scan`, then decides carriability against `recordAccepted`:
 *   - `decision_refs`   → carried IFF `recordAccepted` (step-5 gate release rule).
 *   - `acceptance_refs` → always carried (step-5 softens on ANY valid record; retire
 *                         writes one, so the lint stays soft at any status).
 *   - `filename_scan`   → NEVER carried (step 5 has no record fallback for it).
 * A `done` task never blocks (settled). Returns referencing entries + blocks.
 *
 * `recordAccepted` is the source of "accepted" truth supplied by the caller:
 *   - pre-write (evaluateRetire): the live `.md`'s `classifyAdr` accepted-ness;
 *   - post-write recheck: the readback-verified record's `may_satisfy_active_gate`.
 */
export async function collectRetireReferences(
  cwd: string,
  decision: string,
  phases: PhaseEntry[],
  recordAccepted: boolean,
): Promise<{ referencing: RetireReferencingTask[]; blocks: RetireBlock[] }> {
  const referencing: RetireReferencingTask[] = [];
  const blocks: RetireBlock[] = [];

  let resolver: Awaited<ReturnType<typeof makeDecisionResolver>> | null = null;
  try {
    resolver = await makeDecisionResolver(cwd);
  } catch (err) {
    blocks.push({
      gate: "decision_scan_unreadable",
      detail: `cannot scan design/decisions to verify referencing gates: ${errText(err)}`,
    });
  }

  for (const { phase } of phases) {
    for (const task of phase.tasks ?? []) {
      const viaDecisionRef = (task.decision_refs ?? []).some(
        r => normalizePrunedDecisionPath(r) === decision,
      );
      const viaAcceptanceRef = (task.acceptance_refs ?? []).some(
        r => normalizePrunedDecisionPath(r) === decision,
      );
      // Filename-scan gate: a `requires_decision` task whose gate the resolver
      // resolves via a filename match on this decision. CRITICAL: this runs whenever
      // the task has NO explicit `decision_refs` — having an `acceptance_refs` to the
      // same target does NOT suppress it. `acceptance_refs` is a reference-integrity
      // annotation, NOT a gate; a `requires_decision` task with no `decision_refs`
      // still has a FILENAME-SCAN gate (verified against the live resolver). A record
      // can never carry a filename-scan gate, so this case MUST block even when the
      // same target is also an `acceptance_refs` (else retire would orphan the gate).
      let viaFilenameScan = false;
      if (
        !viaDecisionRef &&
        resolver !== null &&
        isDecisionRequiredForTask(phase, task)
      ) {
        try {
          const res = await resolver.resolve(task.id, task.decision_refs);
          viaFilenameScan = res.considered.some(
            c => normalizePrunedDecisionPath(c.path) === decision,
          );
        } catch (err) {
          blocks.push({
            gate: "decision_scan_unreadable",
            detail: `cannot resolve the decision gate for "${task.id}": ${errText(err)}`,
          });
        }
      }

      if (!viaDecisionRef && !viaAcceptanceRef && !viaFilenameScan) continue;
      // Precedence: decision_refs (strictest carry rule) > filename_scan (NEVER
      // carriable — outranks acceptance_refs so a target that is BOTH an
      // acceptance_refs AND a filename-scan gate is treated as the un-carriable
      // filename_scan) > acceptance_refs (any valid record softens).
      const via: RetireRefVia = viaDecisionRef
        ? "decision_refs"
        : viaFilenameScan
          ? "filename_scan"
          : "acceptance_refs";
      referencing.push({
        task_id: task.id,
        phase_id: phase.id,
        status: task.status,
        via,
      });

      if (task.status === "done") continue; // settled — never blocks

      // STATUS-SENSITIVE carriability of an ACTIVE reference:
      const carried =
        via === "acceptance_refs"
          ? true
          : via === "decision_refs"
            ? recordAccepted
            : false;
      if (!carried) {
        blocks.push({
          gate: "referencing_task_not_done",
          task_id: task.id,
          phase_id: phase.id,
          via,
          status: task.status,
        });
      }
    }
  }

  return { referencing, blocks };
}

/**
 * Re-run the SHARED integrity gates (target resolution + open_commitments + the
 * live-dependant / unreadable-scan gates) on the current disk state. Independent
 * of `evaluatePrune` but `// keep in sync with prune.ts` (parity-tested). Used by
 * both `evaluateRetire` and the post-write recheck.
 */
async function sharedExternalGates(
  cwd: string,
  decision: string,
): Promise<{ blocks: RetireBlock[]; target_content: string | null }> {
  const blocks: RetireBlock[] = [];

  // Target must be a readable regular file inside the project (symlink-escape-safe).
  let content: string | null = null;
  try {
    const absTarget = await resolveSymlinkFreeProjectPath(cwd, decision);
    content = await readFile(absTarget, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      blocks.push({
        gate: "target_missing",
        detail: `${decision} does not exist on disk`,
      });
    } else if (
      code === "PATH_OUTSIDE_PROJECT" ||
      code === "PATH_NOT_OWNED" ||
      code === undefined
    ) {
      // resolveSymlinkFreeProjectPath tags a symlink traversal `PATH_NOT_OWNED`;
      // resolveWithinProject tags a containment escape `PATH_OUTSIDE_PROJECT`;
      // a structural rejection (assertSafeRelativePath's code-less ZodError) is
      // the `code === undefined` case. All are path-validity failures → invalid.
      blocks.push({
        gate: "target_invalid",
        detail: `${decision} escapes the project root (symlink or unsafe path)`,
      });
    } else {
      blocks.push({
        gate: "target_unreadable",
        detail: `${decision} is not a readable file (${code})`,
      });
    }
  }

  // open_commitments (same content read).
  if (content !== null) {
    const { hasSection, items } = parseAdrCommitments(content);
    const open = items.filter(i => !i.done).length;
    if (hasSection && open > 0)
      blocks.push({ gate: "open_commitments", open_items: open });
  }

  // live_decision_depends / dependency_status_unknown / dependency_unreadable —
  // no live (or unverifiable) decision may depend on the target. (// keep in sync
  // with prune.ts Gate 3.)
  let decisionNames: string[] = [];
  try {
    decisionNames = await readDecisionAdrFiles(cwd);
  } catch (err) {
    blocks.push({
      gate: "decision_scan_unreadable",
      detail: `cannot list design/decisions to verify dependants: ${errText(err)}`,
    });
  }
  for (const name of decisionNames) {
    if (!name.endsWith(".md")) continue;
    const otherPath = `design/decisions/${name}`;
    if (otherPath === decision) continue;
    let other: string;
    try {
      const absOther = await resolveSymlinkFreeProjectPath(cwd, otherPath);
      other = await readFile(absOther, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // raced away
      blocks.push({ gate: "dependency_unreadable", decision: otherPath });
      continue;
    }
    if (!decisionLinksTo(other, decision)) continue;
    const cls = classifyAdr(other);
    if (isLiveDecisionStatus(cls.status.word)) {
      blocks.push({
        gate: "live_decision_depends",
        decision: otherPath,
        status: cls.status.word ?? "proposed",
      });
    } else if (cls.acceptance === "unknown_status") {
      blocks.push({
        gate: "dependency_status_unknown",
        decision: otherPath,
        status: cls.status.word,
      });
    }
  }

  return { blocks, target_content: content };
}

/**
 * The pre-write retire verdict + dry-run preview. ANY status retireable; the only
 * differences from prune are: no `target_not_accepted`, no `link_rewrite_*`, and a
 * status-sensitive referencing gate. "accepted" here is the LIVE `.md`'s
 * classification — the write path re-confirms it against the written record at the
 * post-write recheck (decision-retire.ts), so the irreversible delete never rests
 * on a trusted live read.
 */
export async function evaluateRetire(
  cwd: string,
  rawTarget: string,
  phases: PhaseEntry[],
): Promise<RetireEvaluation> {
  const decision = normalizePrunedDecisionPath(rawTarget);
  if (decision === null) {
    return {
      decision: null,
      eligible: false,
      blocks: [
        {
          gate: "target_invalid",
          detail: `"${rawTarget}" is not a retireable decision — expected a design/decisions/<name>.md record (not README.md / PRUNED.md, not an outside or traversing path)`,
        },
      ],
      referencing_tasks: [],
      target_content: null,
    };
  }

  const { blocks: externalBlocks, target_content } = await sharedExternalGates(
    cwd,
    decision,
  );

  // "accepted" for the pre-write referencing gate = the live `.md`'s classification.
  const liveAccepted =
    target_content !== null &&
    classifyAdr(target_content).acceptance === "accepted";
  const { referencing, blocks: refBlocks } = await collectRetireReferences(
    cwd,
    decision,
    phases,
    liveAccepted,
  );

  const blocks = [...externalBlocks, ...refBlocks];
  return {
    decision,
    eligible: blocks.length === 0,
    blocks,
    referencing_tasks: referencing,
    target_content,
  };
}

/**
 * The post-write FINAL external-state recheck (round-5 + round-6). Re-runs every
 * external-state gate on the CURRENT disk state, judged against the readback-
 * verified record's accepted-ness (`recordAccepted`). Used immediately before the
 * irreversible delete so a gate that newly references / depends on the target in
 * the write→delete window refuses before unlink.
 */
export async function recheckRetireExternalState(
  cwd: string,
  decision: string,
  phases: PhaseEntry[],
  recordAccepted: boolean,
): Promise<RetireBlock[]> {
  // (A) shared external gates re-run on current disk. The target itself is still
  // present here (delete is last), so target_missing isn't expected — but a
  // dependency / scan that became unreadable, or a new live dependant, IS caught.
  const { blocks: externalBlocks } = await sharedExternalGates(cwd, decision);
  // (B) retire-only reference scan re-run, accepted = the written record's verdict.
  const { blocks: refBlocks } = await collectRetireReferences(
    cwd,
    decision,
    phases,
    recordAccepted,
  );
  return [...externalBlocks, ...refBlocks];
}
