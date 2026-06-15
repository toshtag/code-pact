import { readFile, lstat, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveWithinProject } from "../core/path-safety.ts";
import { sha256Hex, normalizeDecisionRef, decisionRecordPath } from "../core/archive/paths.ts";
import { collectPlanArtifacts } from "../core/plan/state.ts";
import type { PhaseEntry } from "../core/plan/state.ts";
import {
  writeDecisionRecord,
  planDecisionRecord,
  type DecisionRecordBlock,
} from "../core/archive/decision-record.ts";
import { resolveArchiveDecisionRecord } from "../core/archive/load-decision-record.ts";
import { recordMatchingRef } from "../core/decisions/decision-gate-archive.ts";
import {
  evaluateRetire,
  recheckRetireExternalState,
  type RetireBlock,
} from "../core/decisions/retire.ts";

// ---------------------------------------------------------------------------
// `decision retire <path>` — design-docs-ephemeral step 7 PR-B2. The COMPLEX
// destructive verb: write the decision's decision-state record (first prod
// caller of writeDecisionRecord), then delete the `.md`. Two mutations, no link
// rewrite (PR-A's checker resolves the unchanged inbound links as retired), no
// PRUNED ledger. Modeled on PR-B1's `runPhaseArchive`:
//   presence(lstat-first) → inspect baseline → evaluateRetire → writeDecisionRecord
//   → readback verify → POST-WRITE FINAL EXTERNAL-STATE RECHECK → stale guard →
//   lexical unlink. The delete authorization rests on the readback-verified record
//   + the CURRENT external state, never the pre-write verdict alone (TOCTOU).
// `prune` is unchanged; retire is an independent sibling.
// ---------------------------------------------------------------------------

export type RetireStaleReason =
  | "source_changed"
  | "identity_changed"
  | "path_inaccessible"
  | "record_unverified"
  | "gate_would_orphan";

export type DecisionRetireResult =
  | { kind: "would_retire"; decision: string; record_path: string; record_action: "write" | "refresh" | "noop" }
  | { kind: "would_already_retired"; decision: string; record_path: string }
  | { kind: "retired"; decision: string; record_path: string; record_action: "write" | "noop" }
  | { kind: "already_retired"; decision: string; record_path: string }
  | { kind: "ineligible"; decision: string | null; blocks: RetireBlock[] }
  | { kind: "not_retired"; decision: string; reason: string }
  | { kind: "stale"; decision: string; reason: RetireStaleReason; detail: string };

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function recordActionFromPlanKind(kind: string): "write" | "refresh" | "noop" {
  if (kind === "write") return "write";
  if (kind === "refresh") return "refresh";
  return "noop"; // noop_same_source / noop_record_authoritative
}

/** Plan-artifacts fail-closed (a graph file we can't read could hide a not-done
 *  referencing task). Mirrors decision-prune's `planArtifactsUnreadable`. */
function planArtifactsUnreadable(
  fileIssues: { file?: string }[],
  skippedChecks: string[],
): string | null {
  const isGraphFile = (f?: string): boolean =>
    f !== undefined && /(^|\/)design\/(roadmap\.yaml|phases\/)/.test(f.replace(/\\/g, "/"));
  const graphIssue = fileIssues.find((i) => isGraphFile(i.file));
  if (graphIssue) return `cannot read the plan graph: ${graphIssue.file}`;
  if (skippedChecks.length > 0) {
    return "roadmap is missing or unparseable, so referencing tasks cannot be fully verified";
  }
  return null;
}

type Presence =
  | { kind: "present"; abs: string }
  | { kind: "absent" }
  | { kind: "inaccessible"; reason: RetireStaleReason; detail: string };

/** Classify a final-component ENOENT by its PARENT (PR-B1 parity): a dangling
 *  ancestor symlink / missing-or-non-dir parent means the ENOENT is an ancestor
 *  problem, NOT a true-absent retired decision → inaccessible, fail-closed. */
async function classifyParent(parentAbs: string): Promise<Presence> {
  let pst;
  try {
    pst = await lstat(parentAbs);
  } catch (err) {
    return {
      kind: "inaccessible",
      reason: "path_inaccessible",
      detail: isEnoent(err) ? "parent directory of the decision does not exist" : `lstat parent: ${(err as Error).message}`,
    };
  }
  if (pst.isSymbolicLink()) {
    return { kind: "inaccessible", reason: "identity_changed", detail: "decision's parent is a symlink (dangling or redirected)" };
  }
  if (!pst.isDirectory()) {
    return { kind: "inaccessible", reason: "path_inaccessible", detail: "decision's parent is not a directory" };
  }
  return { kind: "absent" };
}

/** lstat-first presence (PR-B1 parity): a dangling final/ancestor symlink is
 *  `inaccessible`, never `absent`. Only a true lexical lstat ENOENT with a real
 *  present parent is `absent`. */
async function decisionMdPresence(cwd: string, canonical: string): Promise<Presence> {
  let abs: string;
  try {
    abs = await resolveWithinProject(cwd, canonical);
  } catch (err) {
    return { kind: "inaccessible", reason: "path_inaccessible", detail: (err as Error).message };
  }
  let st;
  try {
    st = await lstat(abs);
  } catch (err) {
    if (isEnoent(err)) return classifyParent(dirname(abs));
    return { kind: "inaccessible", reason: "path_inaccessible", detail: `lstat: ${(err as Error).message}` };
  }
  if (st.isSymbolicLink()) {
    return { kind: "inaccessible", reason: "identity_changed", detail: "decision path is a symlink (dangling or not); refusing to retire through it" };
  }
  if (!st.isFile()) {
    return { kind: "inaccessible", reason: "identity_changed", detail: st.isDirectory() ? "decision path is a directory" : "decision path is not a regular file" };
  }
  return { kind: "present", abs };
}

type Inspected =
  | { ok: true; abs: string; source_sha256: string; ino: number; dev: number }
  | { ok: false; reason: RetireStaleReason; detail: string };

/** The decision analogue of PR-B1's `inspectPhaseYaml` (written FRESH — prune's
 *  `inspectTarget` is untouched). lstat REFUSES a symlink final component. */
async function inspectDecisionMd(
  cwd: string,
  canonical: string,
  expected?: { source_sha256: string; ino: number; dev: number },
): Promise<Inspected> {
  let abs: string;
  try {
    abs = await resolveWithinProject(cwd, canonical);
  } catch (err) {
    return { ok: false, reason: "path_inaccessible", detail: (err as Error).message };
  }
  let lst;
  try {
    lst = await lstat(abs);
  } catch (err) {
    return { ok: false, reason: isEnoent(err) ? "source_changed" : "path_inaccessible", detail: `lstat: ${(err as Error).message}` };
  }
  if (lst.isSymbolicLink()) return { ok: false, reason: "identity_changed", detail: "decision path is a symlink" };
  if (!lst.isFile()) return { ok: false, reason: "identity_changed", detail: "decision path is not a regular file" };
  let content: string;
  try {
    content = await readFile(abs, "utf8");
  } catch (err) {
    return { ok: false, reason: isEnoent(err) ? "source_changed" : "path_inaccessible", detail: `read: ${(err as Error).message}` };
  }
  const source_sha256 = sha256Hex(content);
  let st;
  try {
    st = await stat(abs);
  } catch (err) {
    return { ok: false, reason: "path_inaccessible", detail: `stat: ${(err as Error).message}` };
  }
  if (expected) {
    if (source_sha256 !== expected.source_sha256) return { ok: false, reason: "source_changed", detail: "decision bytes changed since the baseline" };
    if (st.ino !== expected.ino || st.dev !== expected.dev) return { ok: false, reason: "identity_changed", detail: "decision inode/dev changed (file swapped)" };
  }
  return { ok: true, abs, source_sha256, ino: st.ino, dev: st.dev };
}

/** Validate, via the SAME reader step 5 runs, that a missing-`.md` decision resolves
 *  from its record (identity-checked). Returns the record path + may_satisfy, or null. */
async function readbackResolve(
  cwd: string,
  canonical: string,
): Promise<{ ok: true; record_path: string; may_satisfy: boolean; source_sha256: string } | { ok: false }> {
  // Resolve from loose ∪ bundle so a retired decision whose loose record was compacted
  // into a bundle still reads back as already-retired (not a spurious not_retired). The
  // POST-WRITE verify path is unchanged: the just-written loose record wins (loose-wins).
  const matched = recordMatchingRef(await resolveArchiveDecisionRecord(cwd, canonical), canonical);
  if (matched === null) return { ok: false };
  return {
    ok: true,
    record_path: decisionRecordPath(cwd, canonical),
    may_satisfy: matched.may_satisfy_active_gate,
    source_sha256: matched.source_sha256,
  };
}

export type DecisionRetireOptions = {
  cwd: string;
  path: string;
  write?: boolean;
  now: Date;
};

export async function runDecisionRetire(opts: DecisionRetireOptions): Promise<DecisionRetireResult> {
  const { cwd, path: rawPath, write = false, now } = opts;
  const canonical = normalizeDecisionRef(rawPath);
  if (canonical === null) {
    return {
      kind: "ineligible",
      decision: null,
      blocks: [{ gate: "target_invalid", detail: `"${rawPath}" is not a retireable decision (expected a top-level design/decisions/<name>.md)` }],
    };
  }

  const presence = await decisionMdPresence(cwd, canonical);

  // ---- inaccessible (symlink / non-regular / escape) → never absent, never retire
  if (presence.kind === "inaccessible") {
    return { kind: "stale", decision: canonical, reason: presence.reason, detail: presence.detail };
  }

  // ---- LIVE-ABSENT branch (lexical lstat ENOENT, real parent) ----
  if (presence.kind === "absent") {
    const rb = await readbackResolve(cwd, canonical);
    if (!rb.ok) {
      return { kind: "not_retired", decision: canonical, reason: "the decision is gone and no valid decision-state record resolves it" };
    }
    return write
      ? { kind: "already_retired", decision: canonical, record_path: rb.record_path }
      : { kind: "would_already_retired", decision: canonical, record_path: rb.record_path };
  }

  // ---- LIVE-PRESENT branch ----
  const { state, fallbackPhases, fileIssues, skippedChecks } = await collectPlanArtifacts(cwd);
  const phases: PhaseEntry[] = state?.phases ?? fallbackPhases;
  const artifactDetail = planArtifactsUnreadable(fileIssues, skippedChecks);

  const verdict = await evaluateRetire(cwd, canonical, phases);
  const blocks: RetireBlock[] = [...verdict.blocks];
  if (artifactDetail !== null) blocks.push({ gate: "plan_artifacts_unreadable", detail: artifactDetail });
  if (blocks.length > 0) {
    return { kind: "ineligible", decision: canonical, blocks };
  }

  // Identity baseline (PR-B1 parity — also the dry-run path-safety preflight).
  const baseline = await inspectDecisionMd(cwd, canonical);
  if (!baseline.ok) {
    return { kind: "stale", decision: canonical, reason: baseline.reason, detail: baseline.detail };
  }

  if (!write) {
    // Dry-run: plan the record (it can refuse on a stale existing record, exactly as
    // --write's writeDecisionRecord would — PR-B1 dry-run fidelity). Both the
    // `ineligible` refusal AND a read throw (unreadable / directory record path) map
    // to DECISION_RETIRE_STALE(record_unverified), never an internal error.
    let plan;
    try {
      plan = await planDecisionRecord(cwd, canonical, { now });
    } catch (err) {
      return { kind: "stale", decision: canonical, reason: "record_unverified", detail: `record plan failed: ${(err as Error).message}` };
    }
    if (plan.kind === "ineligible") {
      return { kind: "stale", decision: canonical, reason: "record_unverified", detail: blockDetail(plan.blocks) };
    }
    return {
      kind: "would_retire",
      decision: canonical,
      record_path: decisionRecordPath(cwd, canonical),
      record_action: recordActionFromPlanKind(plan.kind),
    };
  }

  // ---- --write: record → readback verify → post-write recheck → stale guard → delete
  let outcome;
  try {
    outcome = await writeDecisionRecord(cwd, canonical, { now });
  } catch (err) {
    return { kind: "stale", decision: canonical, reason: "record_unverified", detail: `record write failed: ${(err as Error).message}` };
  }
  if (outcome.kind === "ineligible") {
    return { kind: "stale", decision: canonical, reason: "record_unverified", detail: blockDetail(outcome.blocks) };
  }
  const recordAction: "write" | "noop" = outcome.kind === "written" ? "write" : "noop";

  // READBACK VERIFY (writer not trusted): the readers must resolve it + sha must match.
  const rb = await readbackResolve(cwd, canonical);
  if (!rb.ok) {
    return { kind: "stale", decision: canonical, reason: "record_unverified", detail: "the written record is not reader-resolvable (identity check failed)" };
  }
  if (rb.source_sha256 !== baseline.source_sha256) {
    return { kind: "stale", decision: canonical, reason: "record_unverified", detail: "the written record's source_sha256 does not match the live decision bytes" };
  }

  // POST-WRITE FINAL EXTERNAL-STATE RECHECK (TOCTOU): re-run every external-state
  // gate on CURRENT disk, "accepted" = the readback-verified record's may_satisfy.
  const recheckPlan = await collectPlanArtifacts(cwd);
  const recheckPhases: PhaseEntry[] = recheckPlan.state?.phases ?? recheckPlan.fallbackPhases;
  const recheckArtifact = planArtifactsUnreadable(recheckPlan.fileIssues, recheckPlan.skippedChecks);
  if (recheckArtifact !== null) {
    return { kind: "stale", decision: canonical, reason: "path_inaccessible", detail: recheckArtifact };
  }
  const recheckBlocks = await recheckRetireExternalState(cwd, canonical, recheckPhases, rb.may_satisfy);
  if (recheckBlocks.length > 0) {
    // Classify the refusal reason from the blocks present (fail-closed regardless):
    // a target that vanished/became unreadable in the window is a source/path change;
    // an unreadable dependency/scan is path_inaccessible; a new live dependant or a
    // newly-referencing active gate is gate_would_orphan.
    const hasTargetChange = recheckBlocks.some(
      (b) => b.gate === "target_missing" || b.gate === "target_unreadable" || b.gate === "target_invalid",
    );
    const hasUnreadableScan = recheckBlocks.some(
      (b) => b.gate === "dependency_unreadable" || b.gate === "decision_scan_unreadable",
    );
    const reason: RetireStaleReason = hasTargetChange
      ? "source_changed"
      : hasUnreadableScan
        ? "path_inaccessible"
        : "gate_would_orphan";
    return { kind: "stale", decision: canonical, reason, detail: retireBlockDetail(recheckBlocks) };
  }

  // STALE GUARD before delete (PR-B1 — sha + ino/dev + symlink refuse).
  const guard = await inspectDecisionMd(cwd, canonical, {
    source_sha256: baseline.source_sha256,
    ino: baseline.ino,
    dev: baseline.dev,
  });
  if (!guard.ok) {
    return { kind: "stale", decision: canonical, reason: guard.reason, detail: guard.detail };
  }

  // DELETE the `.md` LAST. Unlink the LEXICAL path (guard.abs is lexical, and the
  // lstat above already refused a symlink, so this removes the regular file itself).
  await unlink(guard.abs);

  return {
    kind: "retired",
    decision: canonical,
    record_path: rb.record_path,
    record_action: recordAction,
  };
}

function blockDetail(blocks: DecisionRecordBlock[]): string {
  return blocks.map((b) => b.kind + ("detail" in b ? `: ${b.detail}` : "")).join("; ");
}
function retireBlockDetail(blocks: RetireBlock[]): string {
  return blocks.map((b) => b.gate).join("; ");
}
