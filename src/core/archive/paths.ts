import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { assertSafePlanId } from "../schemas/plan-id.ts";
import { normalizePrunedDecisionPath } from "../decisions/pruned-ledger.ts";

// Record locations for the archive layer. One file per record (mirroring the
// per-event ledger and `baselines/initial.json` precedents) — an append-only
// single file would reintroduce the cross-branch merge hazard the event shard
// was built to remove.
export const ARCHIVE_PHASES_DIR_SEGMENTS = [
  ".code-pact",
  "state",
  "archive",
  "phases",
] as const;
export const ARCHIVE_DECISIONS_DIR_SEGMENTS = [
  ".code-pact",
  "state",
  "archive",
  "decisions",
] as const;
export const ARCHIVE_EVENT_PACKS_DIR_SEGMENTS = [
  ".code-pact",
  "state",
  "archive",
  "event-packs",
] as const;
/** Archive bundles (bounded-archive compaction): one file folds many per-item records. */
export const ARCHIVE_BUNDLES_DIR_SEGMENTS = [
  ".code-pact",
  "state",
  "archive",
  "bundles",
] as const;

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * First 8 hex chars of sha256 over the CANONICAL normalized ref (POSIX,
 * project-relative). Never feed an OS-native path here — a raw Windows path
 * would hash differently than its POSIX form and split one record into two.
 */
export function pathHash8(canonicalRef: string): string {
  return sha256Hex(canonicalRef).slice(0, 8);
}

export function phaseSnapshotPath(cwd: string, phaseId: string): string {
  assertSafePlanId(phaseId, "Phase id");
  return join(cwd, ...ARCHIVE_PHASES_DIR_SEGMENTS, `${phaseId}.json`);
}

/** The archive phases directory. Used by step-4b discovery to enumerate
 *  `<id>.json` snapshots when no roadmap ref names them. */
export function archivePhasesDir(cwd: string): string {
  return join(cwd, ...ARCHIVE_PHASES_DIR_SEGMENTS);
}

/**
 * Path of one event pack: `.code-pact/state/archive/event-packs/<phaseId>.json`.
 * An event pack holds the compacted per-event ledger for an archived phase. One
 * file per phase, mirroring `phaseSnapshotPath` (and the same `assertSafePlanId`
 * guard so a malformed id can never escape the directory).
 */
export function eventPackPath(cwd: string, phaseId: string): string {
  assertSafePlanId(phaseId, "Phase id");
  return join(cwd, ...ARCHIVE_EVENT_PACKS_DIR_SEGMENTS, `${phaseId}.json`);
}

/** The archive event-packs directory, for enumeration by the pack reader. */
export function archiveEventPacksDir(cwd: string): string {
  return join(cwd, ...ARCHIVE_EVENT_PACKS_DIR_SEGMENTS);
}

/** The archive bundles directory, for enumeration by the bundle loader. */
export function archiveBundlesDir(cwd: string): string {
  return join(cwd, ...ARCHIVE_BUNDLES_DIR_SEGMENTS);
}

/** The archive decisions directory, for enumeration by the bundle writer. */
export function archiveDecisionsDir(cwd: string): string {
  return join(cwd, ...ARCHIVE_DECISIONS_DIR_SEGMENTS);
}

/**
 * Path of one bundle file: `bundles/<kind>-<idsHash16>.json`. CONTENT-ADDRESSED by
 * the member-id-SET hash (`member_ids_sha256`, first 16 hex), so the same id set of
 * the same kind always maps to the same file (idempotent re-write), and a different
 * id set is a different file (bundles of one kind can coexist — the multi-bundle
 * model the cross-bundle uniqueness rule already covers). `idsHash16` is hex from a
 * trusted sha256; never an external path component.
 */
export function archiveBundlePath(cwd: string, kind: string, memberIdsSha256: string): string {
  return join(cwd, ...ARCHIVE_BUNDLES_DIR_SEGMENTS, `${kind}-${memberIdsSha256.slice(0, 16)}.json`);
}

/**
 * Normalize a raw decision ref to its canonical form, or null to reject it.
 * Reuses the PRUNED.md normalizer on purpose: identical confinement semantics
 * (top-level `design/decisions/*.md` only; never README.md / PRUNED.md, never
 * nested, never traversal/absolute/drive paths).
 */
export function normalizeDecisionRef(raw: string): string | null {
  return normalizePrunedDecisionPath(raw);
}

/** `<stem>-<hash8>.json`; hash8 from the canonical ref to survive stem collisions. */
export function decisionRecordPath(cwd: string, canonicalRef: string): string {
  const stem = posix.basename(canonicalRef, ".md");
  return join(
    cwd,
    ...ARCHIVE_DECISIONS_DIR_SEGMENTS,
    `${stem}-${pathHash8(canonicalRef)}.json`,
  );
}
