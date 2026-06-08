import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import type { PhaseEntry } from "../plan/state.ts";
import { resolveWithinProject } from "../path-safety.ts";
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
  | { gate: "dependency_status_unknown"; decision: string; status: string | null }
  | { gate: "dependency_unreadable"; decision: string }
  | { gate: "decision_scan_unreadable"; detail: string }
  | { gate: "plan_artifacts_unreadable"; detail: string }
  | { gate: "link_rewrite_scan_unreadable"; detail: string }
  | { gate: "link_rewrite_unsupported"; detail: string };

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

function errText(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code) return code;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Does `content` contain a markdown link that resolves to `target` (relative to
 * design/decisions/)? Covers both **inline** links — `[t](url)` / `[t](url
 * "title")` — and **reference-style** definitions — `[label]: url`. This is the
 * **conservative eligibility gate** (a missed link would be fail-open), NOT the
 * rewrite collector: it deliberately over-counts (e.g. reference-style links the
 * collector can't rewrite) so a live decision that mentions the target blocks
 * the prune. The rewrite plan is `link-collector.ts`, a separate, precise pass.
 */
function stripAngleBrackets(raw: string): string {
  const s = raw.trim();
  return s.startsWith("<") && s.endsWith(">") ? s.slice(1, -1) : s;
}

function decisionLinksTo(content: string, target: string): boolean {
  const urls: string[] = [];
  // inline: [t](<url> | url) with an optional "title" / 'title' / (title)
  const inline =
    /\[(?:[^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  // reference definition: [label]: <url> | url with an optional title
  const refDef =
    /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(<[^>]+>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(content)) !== null) urls.push(m[1]!);
  while ((m = refDef.exec(content)) !== null) urls.push(m[1]!);
  for (const raw of urls) {
    const link = stripAngleBrackets(raw).split("#")[0]!.trim();
    // Same external/protocol-relative test as check-doc-links / the link collector.
    if (link === "" || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link)) continue;
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

  // The target must be a readable regular file INSIDE the project — read it ONCE
  // through the symlink-escape guard and key both the "is it accepted" and "open
  // commitments" checks off the same content. `normalizePrunedDecisionPath` only
  // rejects syntactic `..`/absolute paths; `resolveWithinProject` additionally
  // rejects an existing ancestor symlink that resolves outside `cwd` — so a
  // `design/decisions` symlinked out of the repo can never become a prune (and
  // therefore a PR-C2 `unlink`) target. A missing file (ENOENT), an unreadable
  // one (a directory named `*.md`, EACCES, EISDIR), and a path-escape are all
  // fail-CLOSED blocks; we never proceed as if a file we could not read was
  // accepted or commitment-free.
  let content: string | null = null;
  try {
    const absTarget = await resolveWithinProject(cwd, decision);
    content = await readFile(absTarget, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      blocks.push({ gate: "target_missing", detail: `${decision} does not exist on disk` });
    } else if (code === undefined) {
      // resolveWithinProject throws a plain Error (no errno) on a path escape.
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

  // Gate 1 — referencing tasks (collect all; block on any not-done). A pure
  // verdict never throws: if the decision scan itself is unreadable (e.g. a
  // filename-scan candidate is a directory named `*.md`), record it as a
  // fail-CLOSED block rather than letting `evaluatePrune` reject.
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
      const explicit = (task.decision_refs ?? []).some(
        (r) => normalizePrunedDecisionPath(r) === decision,
      );
      let viaGate = false;
      if (!explicit && resolver !== null && isDecisionRequiredForTask(phase, task)) {
        try {
          const res = await resolver.resolve(task.id, task.decision_refs);
          viaGate = res.considered.some(
            (c) => normalizePrunedDecisionPath(c.path) === decision,
          );
        } catch (err) {
          blocks.push({
            gate: "decision_scan_unreadable",
            detail: `cannot resolve the decision gate for "${task.id}": ${errText(err)}`,
          });
        }
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

  // Gate 3 — no decision that LINKS to the target can be a live (or unverifiable)
  // dependant. Check the link first, then the linker's status: a `proposed`/
  // `draft` linker is a live dependant; an `unknown_status` (e.g. a typo'd
  // status) linker cannot be confirmed non-live, so it fails closed too —
  // symmetric with the target itself, which `unknown_status` cannot be pruned.
  // Settled linkers (accepted / rejected / superseded) are historical and fine.
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
      const absOther = await resolveWithinProject(cwd, otherPath);
      other = await readFile(absOther, "utf8");
    } catch (err) {
      // ENOENT = raced away between readdir and read → cannot be a dependant; skip.
      // Anything else (escape, EACCES, EISDIR) → cannot verify → fail closed.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
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

  return { decision, eligible: blocks.length === 0, blocks, referencing_tasks: referencing };
}
