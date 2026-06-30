import { readFile } from "../project-fs/index.ts";
import { DecisionStateRecord } from "../schemas/decision-state-record.ts";
import { decisionRecordRelPath, resolveArchiveOwnedPath } from "./paths.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { decisionRecordStem } from "./archive-bundle-binding.ts";
import {
  resolveArchiveRecordBytes,
  type RawLooseRecord,
} from "./resolve-archive-record.ts";

// ---------------------------------------------------------------------------
// The FIRST reader of the `.code-pact/state/archive/decisions/<stem>-<hash8>.json`
// decision-state records written by `decision-record.ts` (step 3). The DECISION
// analogue of `load-phase-snapshot.ts` (step 4): it makes a RETIRED decision
// (its `design/decisions/*.md` deleted) still resolve from its record, so an
// active gate that needs it survives `rm -rf design/decisions` (criterion A3).
//
// This module is a PURE LOCATOR only. The two locked reader predicates
// (gate-release vs lint-soften, both of which FIRST require a true-ENOENT live
// file — never caller discipline) live in `decisions/decision-gate-archive.ts`.
// `loadDecisionRecord` knows nothing about live files; callers always pass the
// CANONICAL ref (`normalizeDecisionRef(raw)`) — a ref that does not normalize
// (`docs/...`, traversal, README/PRUNED) gets no lookup at all.
// ---------------------------------------------------------------------------

/** Outcome of loading one decision-state record off disk. `invalid` is NEVER
 * collapsed to `absent` — a present-but-corrupt record is a louder signal than
 * "nothing there" and must fail closed distinctly (same rule as the snapshots). */
export type LoadDecisionRecordResult =
  | { kind: "absent" }
  | { kind: "invalid"; error: unknown }
  | { kind: "valid"; record: DecisionStateRecord };

/**
 * Read `.code-pact/state/archive/decisions/<stem>-<hash8>.json` for `canonicalRef`,
 * JSON-parse, and `DecisionStateRecord.parse()`-validate. ENOENT → `absent`; any
 * other read error (EACCES/EISDIR) or a JSON/schema failure → `invalid` (never
 * collapsed to `absent`). `canonicalRef` MUST be a normalized
 * `.md` decision record path under `design/decisions/` (the caller's
 * `normalizeDecisionRef`); the schema's `DecisionRefPath` would reject anything
 * else at parse time anyway.
 */
/**
 * Read the LOOSE decision record's raw bytes off disk (no parsing). ENOENT →
 * `absent`; any other read error (EACCES/EISDIR) → `invalid` (never collapsed to
 * `absent`). Factored out of {@link loadDecisionRecord} so the loose ∪ bundle
 * resolver can compare loose↔bundle byte-for-byte (the loose writer emits the same
 * canonical `serializeDecisionRecord` bytes a bundle member carries).
 */
export async function readLooseDecisionRecordRaw(
  cwd: string,
  canonicalRef: string,
): Promise<RawLooseRecord> {
  const path = await resolveArchiveOwnedPath(cwd, decisionRecordRelPath(canonicalRef));
  try {
    return { kind: "present", bytes: await readFile(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", error };
  }
}

export async function loadDecisionRecord(
  cwd: string,
  canonicalRef: string,
): Promise<LoadDecisionRecordResult> {
  const raw = await readLooseDecisionRecordRaw(cwd, canonicalRef);
  if (raw.kind === "absent") return { kind: "absent" };
  if (raw.kind === "invalid") return { kind: "invalid", error: raw.error };
  try {
    const record = DecisionStateRecord.parse(JSON.parse(raw.bytes) as unknown);
    return { kind: "valid", record };
  } catch (error) {
    return { kind: "invalid", error };
  }
}

/**
 * Resolve a decision-state record from loose ∪ bundle (`reader-loose-wins`): the
 * loose record wins; a RETIRED + compacted decision resolves from its bundle member
 * once its loose copy is gone. Returns the SAME {@link LoadDecisionRecordResult}
 * shape `loadDecisionRecord` returns, so the gate / lint predicates and
 * `recordMatchingRef` consume it unchanged — they keep their own identity authority
 * checks (`canonical_ref` / `original_path` / `path_sha256`).
 *
 * POSTURE: a bundle-integrity fault (the shared resolver throws) is fail-closed
 * mapped to `invalid` here and never re-thrown — for the gate that yields
 * `not_released`, for lint-soften it yields "do not soften" (the lint stays at its
 * original severity; the reader never crashes — fail-soft). A bundle-only decision
 * still passes `recordMatchingRef`'s identity checks, since `bindBundleMember` alone
 * is not full authority.
 */
export async function resolveArchiveDecisionRecord(
  cwd: string,
  canonicalRef: string,
): Promise<LoadDecisionRecordResult> {
  let resolved;
  try {
    resolved = await resolveArchiveRecordBytes({
      kind: "decision_record",
      id: decisionRecordStem(canonicalRef),
      mode: "reader-loose-wins",
      readLooseRaw: () => readLooseDecisionRecordRaw(cwd, canonicalRef),
      loadBundleIndex: () => loadArchiveBundles(cwd).index,
    });
  } catch (error) {
    return { kind: "invalid", error };
  }
  if (resolved.kind === "invalid") return { kind: "invalid", error: resolved.error };
  if (resolved.kind === "absent") return { kind: "absent" };
  try {
    const record = DecisionStateRecord.parse(JSON.parse(resolved.bytes) as unknown);
    return { kind: "valid", record };
  } catch (error) {
    return { kind: "invalid", error };
  }
}
