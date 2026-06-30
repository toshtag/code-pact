import { access } from "../project-fs/raw-internal.ts";
import {
  loadDecisionRecord,
  resolveArchiveDecisionRecord,
} from "../archive/load-decision-record.ts";
import { normalizeDecisionRef, sha256Hex } from "../archive/paths.ts";
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";
import type { DecisionStateRecord } from "../schemas/decision-state-record.ts";

// ---------------------------------------------------------------------------
// Step 5 — retired-decision resolution from the `.code-pact/state` decision-state
// records. The gate-aware WRAPPER that composes the live decision reader with the
// record fallback. Per the 2b contract, the record fallback lives HERE, never
// inside the live primitives (`readLiveDecisionFile`/`readLiveDecisionDir` stay
// live-only so pack render / ADR-quality scans never see retired records).
//
// LOCKED reader contract (the two predicates self-enforce it — NEVER caller
// discipline; see the 4a/4b lesson on exported APIs guarding their own inputs):
//   - LIVE WINS, true-ENOENT only: the record is consulted ONLY when the canonical
//     live decision path is GENUINELY absent (ENOENT). A present-but-inaccessible
//     file (EACCES/EPERM/EISDIR/ENOTDIR/parse failure) NEVER consults a record and
//     fails closed. "missing" must mean absent, never unreadable.
//   - Identity re-checked (writer NOT trusted): canonical_ref === ref AND
//     original_path === ref AND path_sha256 === sha256(ref). A ref that does not
//     `normalizeDecisionRef` (`docs/`/traversal/README/PRUNED) is never
//     record-backed.
//   - TWO predicates, DIFFERENT eligibility:
//       Gate-RELEASE needs `may_satisfy_active_gate` (== accepted) — this is A3.
//       Lint-SOFTEN needs only a valid identity-checked record of ANY status (a
//       deliberately-archived blocked/empty decision still proves intentional
//       absence, like a PRUNED.md row).
// ---------------------------------------------------------------------------

/** Result of asking whether a missing `decision_refs` path is gate-released. */
export type RetiredDecisionGate =
  | { kind: "released"; record: DecisionStateRecord }
  | { kind: "not_released" };

/** The shared identity checklist (writer not trusted). Returns the valid record
 * iff every line holds, else null. Does NOT check live presence — the two
 * exported predicates do that first. Exported (export-only, behavior unchanged)
 * so `decision retire`'s post-write readback verify uses the SAME identity
 * contract step 5's readers use, never a re-implementation. */
export function recordMatchingRef(
  res: Awaited<ReturnType<typeof loadDecisionRecord>>,
  canonical: string,
): DecisionStateRecord | null {
  if (res.kind !== "valid") return null;
  const r = res.record;
  if (r.canonical_ref !== canonical) return null;
  if (r.original_path !== canonical) return null;
  if (r.path_sha256 !== sha256Hex(canonical)) return null;
  return r;
}

/**
 * Three-way presence for the canonical live decision path, SYMLINK-ESCAPE-AWARE:
 *   - first `resolveWithinProject` (structural `..`/absolute guard AND ancestor
 *     symlink-escape guard — the SAME check the live decision reader uses); a path
 *     that escapes the project root → `inaccessible` (NEVER `absent`);
 *   - then `access` the realpath-confined target: ENOENT → `absent`; any other
 *     access error → `inaccessible`.
 *
 * "true ENOENT" must mean "a canonical live path that passed project-root symlink
 * safety and is then genuinely absent" — NOT a bare `access()` ENOENT (which a
 * `design/decisions -> /outside` symlink would report for a missing outside file,
 * even though the live reader correctly treats it as unsafe). Without this, the
 * record fallback could RELEASE a gate / SOFTEN a lint for a path the live gate
 * fails closed on — a live-wins-inaccessible hole.
 */
async function decisionFilePresence(
  cwd: string,
  canonical: string,
): Promise<"present" | "absent" | "inaccessible"> {
  let abs: string;
  try {
    abs = await resolveSymlinkFreeProjectPath(cwd, canonical);
  } catch {
    return "inaccessible"; // unsafe path / symlink escape — never a record-consult
  }
  try {
    await access(abs);
    return "present";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "inaccessible";
  }
}

/**
 * True iff the canonical live decision path is GENUINELY absent — the ONLY state
 * in which a record may be consulted. Uses the symlink-escape-aware
 * {@link decisionFilePresence}; `present` short-circuits to live-wins,
 * `inaccessible` (any non-ENOENT failure, INCLUDING a symlink escape) fails closed
 * and never reads a record.
 */
async function liveDecisionAbsent(
  cwd: string,
  canonical: string,
): Promise<boolean> {
  return (await decisionFilePresence(cwd, canonical)) === "absent";
}

/**
 * Predicate A (GATE-RELEASE). Whether a MISSING `decision_refs` path is released
 * by a gate-eligible record. SELF-CHECKS live presence: returns `not_released`
 * unless the live file is genuinely absent (ENOENT). A future caller that calls
 * this directly cannot re-open the live-wins-inaccessible hole.
 */
export async function resolveRetiredDecisionGate(
  cwd: string,
  rawRef: string,
): Promise<RetiredDecisionGate> {
  const canonical = normalizeDecisionRef(rawRef);
  if (canonical === null) return { kind: "not_released" };
  if (!(await liveDecisionAbsent(cwd, canonical)))
    return { kind: "not_released" };
  // Resolve from loose ∪ bundle: a retired+compacted decision resolves from its
  // bundle member. Identity authority stays here (recordMatchingRef); a bundle fault
  // is fail-closed to `invalid` → not_released.
  const record = recordMatchingRef(
    await resolveArchiveDecisionRecord(cwd, canonical),
    canonical,
  );
  if (record === null) return { kind: "not_released" };
  if (!record.may_satisfy_active_gate) return { kind: "not_released" };
  return { kind: "released", record };
}

/**
 * Predicate B (LINT-SOFTEN). Whether a MISSING `decision_refs` / `acceptance_refs`
 * lint warning may downgrade error→advisory — a valid identity-checked record of
 * ANY status (NOT requiring `may_satisfy`). SELF-CHECKS live presence (true-ENOENT
 * only); a present or inaccessible live file returns false.
 */
export async function decisionRecordSoftensMissingRef(
  cwd: string,
  rawRef: string,
): Promise<boolean> {
  const canonical = normalizeDecisionRef(rawRef);
  if (canonical === null) return false;
  if (!(await liveDecisionAbsent(cwd, canonical))) return false;
  // Resolve from loose ∪ bundle (a retired+compacted decision softens via its bundle
  // member). A bundle fault is fail-closed to `invalid` → not softened (the lint
  // stays at its original severity); the reader never throws — fail-soft lenient.
  return (
    recordMatchingRef(
      await resolveArchiveDecisionRecord(cwd, canonical),
      canonical,
    ) !== null
  );
}
