import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { PhaseEntry } from "../plan/state.ts";
import { normalizePrunedDecisionPath } from "./pruned-ledger.ts";
import {
  type AdrAcceptance,
  classifyAdr,
  isDecisionRequiredForTask,
  makeDecisionResolver,
  parseAdrCommitments,
  readDecisionAdrFiles,
} from "./adr.ts";

/**
 * Why a decision cannot be retired. One block per failing condition; an empty
 * list means eligible. This is the single eligibility verdict — `decision prune`
 * runs it identically for `--dry-run` (preview) and `--write` (execute); dry-run
 * never relaxes a gate, it only declines to act on the verdict.
 */
export type PruneBlock =
  | { gate: "target_invalid"; detail: string }
  | { gate: "target_missing"; detail: string }
  | { gate: "target_unreadable"; detail: string }
  | { gate: "target_not_accepted"; acceptance: AdrAcceptance; status: string | null }
  | {
      gate: "referencing_task_not_done";
      task_id: string;
      phase_id: string;
      via: "decision_refs" | "decision_gate";
      status: string;
    }
  | { gate: "open_commitments"; open_items: number }
  | { gate: "live_decision_depends"; decision: string; status: string }
  | { gate: "dependency_unreadable"; decision: string };

export type PruneReferencingTask = {
  task_id: string;
  phase_id: string;
  status: string;
  via: "decision_refs" | "decision_gate";
};

export type PruneEvaluation = {
  /** Normalized target path, or null when the argument is not a prunable decision. */
  decision: string | null;
  eligible: boolean;
  blocks: PruneBlock[];
  /** Every task that references the decision (any status) — for the report. */
  referencing_tasks: PruneReferencingTask[];
};

/** A decision still being decided — its rationale may still be built upon. */
function isLiveDecisionStatus(word: string | null): boolean {
  return word === "proposed" || word === "draft";
}

/** Does `content` contain a markdown link that resolves to `target` (relative to design/decisions/)? */
function decisionLinksTo(content: string, target: string): boolean {
  const re = /\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const link = m[1]!.split("#")[0]!.trim();
    if (link === "" || /^[a-z]+:\/\//i.test(link)) continue; // skip empty / absolute URLs
    const resolved = posix
      .normalize(posix.join("design/decisions", link))
      .replace(/^(?:\.\/)+/, "");
    if (resolved === target) return true;
  }
  return false;
}

/**
 * Decide whether a decision record can be retired from the live plane. Pure
 * verdict — no writes. Three gates (all must pass):
 *
 *  1. **No not-done task is broken by removal** — no `planned`/`in_progress`
 *     task references it (explicit `decision_refs`, or a `requires_decision`
 *     gate that resolves to it via the shared resolver). Removing it would turn
 *     a live `decision_refs` into a hard error or unresolve a live gate.
 *  2. **No open implementation commitments** — the decision's
 *     `## Implementation commitments` has no unchecked items (pruning would
 *     orphan declared downstream work).
 *  3. **No live decision depends on it** — no `proposed`/`draft` decision links
 *     to it (a decision still being made may build on this rationale).
 *
 * The target must be a **readable, top-level `design/decisions/<name>.md`**
 * record (not README/PRUNED, not an outside/traversing/nested path) that is an
 * **accepted** decision — `decision prune` retires *settled* records, never a
 * `proposed`/`draft`/`rejected`/`superseded`/empty/unknown one. A status-less
 * ADR is treated as accepted, per the existing lenient classifier.
 */
export async function evaluatePrune(
  cwd: string,
  rawTarget: string,
  phases: PhaseEntry[],
): Promise<PruneEvaluation> {
  const decision = normalizePrunedDecisionPath(rawTarget);
  if (decision === null) {
    return {
      decision: null,
      eligible: false,
      blocks: [
        {
          gate: "target_invalid",
          detail: `"${rawTarget}" is not a prunable decision — expected a design/decisions/<name>.md record (not README.md / PRUNED.md, not an outside or traversing path)`,
        },
      ],
      referencing_tasks: [],
    };
  }

  const blocks: PruneBlock[] = [];
  const referencing: PruneReferencingTask[] = [];

  // The target must be a readable regular file — read it ONCE and key both the
  // "is it accepted" and "open commitments" checks off the same content. A
  // missing file (ENOENT) and an unreadable one (a directory named `*.md`,
  // EACCES, EISDIR) are distinct fail-CLOSED blocks; we never proceed as if a
  // file we could not read had no commitments.
  let content: string | null = null;
  try {
    content = await readFile(join(cwd, decision), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      blocks.push({ gate: "target_missing", detail: `${decision} does not exist on disk` });
    } else {
      blocks.push({
        gate: "target_unreadable",
        detail: `${decision} is not a readable file (${code ?? "read error"})`,
      });
    }
  }

  // Target gate — only an ACCEPTED decision is prunable (settled record).
  if (content !== null) {
    const cls = classifyAdr(content);
    if (cls.acceptance !== "accepted") {
      blocks.push({
        gate: "target_not_accepted",
        acceptance: cls.acceptance,
        status: cls.status.word,
      });
    }
  }

  // Gate 1 — referencing tasks (collect all; block on any not-done).
  const resolver = await makeDecisionResolver(cwd);
  for (const { phase } of phases) {
    for (const task of phase.tasks ?? []) {
      const explicit = (task.decision_refs ?? []).some(
        (r) => normalizePrunedDecisionPath(r) === decision,
      );
      let viaGate = false;
      if (!explicit && isDecisionRequiredForTask(phase, task)) {
        const res = await resolver.resolve(task.id, task.decision_refs);
        viaGate = res.considered.some(
          (c) => normalizePrunedDecisionPath(c.path) === decision,
        );
      }
      if (!explicit && !viaGate) continue;
      const via = explicit ? "decision_refs" : "decision_gate";
      referencing.push({ task_id: task.id, phase_id: phase.id, status: task.status, via });
      if (task.status !== "done") {
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

  // Gate 2 — open implementation commitments on the target (uses the content
  // already read above; skipped when the target was missing/unreadable, which is
  // already a block).
  if (content !== null) {
    const { hasSection, items } = parseAdrCommitments(content);
    const open = items.filter((i) => !i.done).length;
    if (hasSection && open > 0) blocks.push({ gate: "open_commitments", open_items: open });
  }

  // Gate 3 — a live (proposed/draft) decision links to the target.
  for (const name of await readDecisionAdrFiles(cwd)) {
    if (!name.endsWith(".md")) continue;
    const otherPath = `design/decisions/${name}`;
    if (otherPath === decision) continue;
    let other: string;
    try {
      other = await readFile(join(cwd, "design", "decisions", name), "utf8");
    } catch (err) {
      // ENOENT = the file raced away between readdir and read → genuinely gone,
      // so it cannot be a live dependant; skip. Any other error means we could
      // NOT verify it is not a dependant → fail closed with a block.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      blocks.push({ gate: "dependency_unreadable", decision: otherPath });
      continue;
    }
    const cls = classifyAdr(other);
    if (!isLiveDecisionStatus(cls.status.word)) continue;
    if (decisionLinksTo(other, decision)) {
      blocks.push({
        gate: "live_decision_depends",
        decision: otherPath,
        status: cls.status.word ?? "proposed",
      });
    }
  }

  return { decision, eligible: blocks.length === 0, blocks, referencing_tasks: referencing };
}
