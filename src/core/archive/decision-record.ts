import { readFile } from "node:fs/promises";
import {
  DecisionStateRecord,
  DECISION_STATE_RECORD_SCHEMA_VERSION,
} from "../schemas/decision-state-record.ts";
import { classifyAdr } from "../decisions/adr.ts";
import { resolveWithinProject } from "../path-safety.ts";
import { atomicWriteText, type ExpectedState } from "../../io/atomic-text.ts";
import { decisionRecordPath, normalizeDecisionRef, sha256Hex } from "./paths.ts";
import { readLooseDecisionRecordRaw } from "./load-decision-record.ts";
import { decisionRecordStem } from "./archive-bundle-binding.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { resolveArchiveRecordBytes } from "./resolve-archive-record.ts";

// ---------------------------------------------------------------------------
// Decision-state record writer (record layer — NO CLI, NO reader changes).
//
// Pure `.code-pact/state` writes: never deletes the .md, never edits PRUNED.md,
// never rewrites a link (the later destructive `decision retire` layer owns
// those). Writing a record does NOT make hand deletion safe until the reader
// layers land.
//
// LIVE DESIGN FILE WINS — same locked idempotency/staleness table as the phase
// snapshot writer (pinned by the unit tests):
//   no record + live file                       → write
//   record    + same source_sha256              → noop_same_source
//   record    + different source_sha256         → ineligible (record_stale)
//   record    + different sha + explicit refresh
//     (expected old AND new hashes both match)  → refresh (rewrite from live)
//   live file missing + record exists           → noop_record_authoritative
//   live file missing + record missing          → ineligible (live_file_missing)
// No generic --force.
//
// Trust boundaries:
//   - An existing record is trusted for NO verdict until its identity matches
//     the requested canonical ref exactly (canonical_ref, original_path, and
//     path_sha256 over that ref). Mismatch fails closed
//     (`record_identity_mismatch`) — a valid-looking record for a DIFFERENT
//     decision sitting at this filename must never produce a no-op or be
//     silently replaced.
//   - The live .md is read through `resolveWithinProject` (symlink-escape
//     guard); a record is never built from content outside the project.
//   - The apply step hands the plan's observed destination state to
//     `atomicWriteText` as ExpectedState (absent / exact raw bytes), so a
//     concurrent writer is refused, not overwritten.
// ---------------------------------------------------------------------------

export type DecisionRecordBlock =
  | { kind: "invalid_ref"; raw: string }
  | { kind: "unsafe_path"; canonical_ref: string }
  | { kind: "record_invalid"; detail: string }
  | { kind: "record_identity_mismatch"; detail: string }
  | { kind: "record_state_mismatch"; detail: string }
  | { kind: "record_stale"; existing_source_sha256: string; current_source_sha256: string }
  | {
      kind: "refresh_expectation_mismatch";
      expected_old_source_sha256: string;
      existing_source_sha256: string;
      expected_new_source_sha256: string;
      current_source_sha256: string;
    }
  | { kind: "live_file_missing"; canonical_ref: string }
  | { kind: "compacted_record_refresh_unsupported"; detail: string };

export type DecisionRecordPlan =
  | { kind: "write"; path: string; record: DecisionStateRecord }
  | {
      kind: "refresh";
      path: string;
      record: DecisionStateRecord;
      existing_source_sha256: string;
      current_source_sha256: string;
      /** Exact raw bytes of the record being replaced — the apply-time ExpectedState. */
      existing_raw: string;
    }
  | { kind: "noop_same_source"; path: string }
  | { kind: "noop_record_authoritative"; path: string }
  | { kind: "ineligible"; path: string | null; blocks: DecisionRecordBlock[] };

export type DecisionRecordOptions = {
  /** Timestamp source — explicit so plans/records are deterministic in tests. */
  now: Date;
  refresh?: {
    expected_old_source_sha256: string;
    expected_new_source_sha256: string;
  };
  git_ref?: string;
};

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** First `# ` heading line, if any — a display nicety, never an identity. */
function extractTitle(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

async function readExistingRecord(
  cwd: string,
  canonical: string,
): Promise<
  | { state: "missing" }
  | { state: "invalid"; detail: string }
  | { state: "present"; record: DecisionStateRecord; raw: string; looseFilePresent: boolean }
> {
  // Resolve from loose ∪ bundle (reader-loose-wins): a record compacted into a bundle
  // (loose gone) is still "present", so a re-run reports noop_record_authoritative
  // rather than re-materializing. `looseFilePresent` tells the apply whether a refresh
  // overwrites a loose file or must write a fresh one.
  let resolved;
  try {
    resolved = await resolveArchiveRecordBytes({
      kind: "decision_record",
      id: decisionRecordStem(canonical),
      mode: "reader-loose-wins",
      readLooseRaw: () => readLooseDecisionRecordRaw(cwd, canonical),
      loadBundleIndex: () => loadArchiveBundles(cwd).index,
    });
  } catch (err) {
    return { state: "invalid", detail: err instanceof Error ? err.message : String(err) };
  }
  if (resolved.kind === "absent") return { state: "missing" };
  if (resolved.kind === "invalid") {
    return {
      state: "invalid",
      detail: resolved.error instanceof Error ? resolved.error.message : String(resolved.error),
    };
  }
  const raw = resolved.bytes;
  try {
    return {
      state: "present",
      record: DecisionStateRecord.parse(JSON.parse(raw)),
      raw,
      looseFilePresent: resolved.source === "loose",
    };
  } catch (err) {
    return { state: "invalid", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Exact-identity check: the record must be FOR the requested canonical ref. */
function recordIdentityMismatch(
  record: DecisionStateRecord,
  canonical: string,
): string | null {
  if (record.canonical_ref !== canonical) {
    return `record canonical_ref "${record.canonical_ref}" is not the requested "${canonical}"`;
  }
  if (record.original_path !== canonical) {
    return `record original_path "${record.original_path}" is not the requested "${canonical}"`;
  }
  if (record.path_sha256 !== sha256Hex(canonical)) {
    return `record path_sha256 does not cover the requested canonical ref`;
  }
  return null;
}

/**
 * State equality between two records, ignoring provenance-only stamps
 * (`snapshotted_at`, `git_ref`). Everything that defines the record's meaning is
 * compared: canonical_ref, original_path, path_sha256, title,
 * adr_status_at_snapshot, may_satisfy_active_gate, source_sha256. Canonical JSON
 * of the schema-validated objects suffices (strict schema fixes the key set;
 * `parse()` emits keys in schema order).
 */
function semanticEqual(a: DecisionStateRecord, b: DecisionStateRecord): boolean {
  const strip = (r: DecisionStateRecord) => {
    const { snapshotted_at: _at, git_ref: _ref, ...rest } = r;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

export async function planDecisionRecord(
  cwd: string,
  rawRef: string,
  opts: DecisionRecordOptions,
): Promise<DecisionRecordPlan> {
  const canonical = normalizeDecisionRef(rawRef);
  if (canonical === null) {
    return { kind: "ineligible", path: null, blocks: [{ kind: "invalid_ref", raw: rawRef }] };
  }
  const path = decisionRecordPath(cwd, canonical);

  const existing = await readExistingRecord(cwd, canonical);
  if (existing.state === "invalid") {
    return { kind: "ineligible", path, blocks: [{ kind: "record_invalid", detail: existing.detail }] };
  }
  if (existing.state === "present") {
    const mismatch = recordIdentityMismatch(existing.record, canonical);
    if (mismatch !== null) {
      return {
        kind: "ineligible",
        path,
        blocks: [{ kind: "record_identity_mismatch", detail: mismatch }],
      };
    }
  }

  // Read the live .md through the symlink-escape guard; the record is built
  // FROM the live file, so an unreadable/escaping live file fails closed.
  let content: string;
  try {
    const abs = await resolveWithinProject(cwd, canonical);
    content = await readFile(abs, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      if (existing.state === "present") return { kind: "noop_record_authoritative", path };
      return {
        kind: "ineligible",
        path,
        blocks: [{ kind: "live_file_missing", canonical_ref: canonical }],
      };
    }
    return { kind: "ineligible", path, blocks: [{ kind: "unsafe_path", canonical_ref: canonical }] };
  }
  const currentSha = sha256Hex(content);

  // NOTE: a matching source_sha256 is NOT an early no-op. It only proves the
  // .md content matches what was hashed at record time — it does NOT prove the
  // record BODY still matches what today's classifyAdr derives from that
  // content. A tampered / stale-classifier / stale-schema record can carry a
  // source_sha256 that matches the current .md yet assert a wrong
  // adr_status_at_snapshot / may_satisfy_active_gate. So we always rebuild a
  // candidate from the live .md and compare semantically; the no-op is decided
  // last. (This mirrors phase-snapshot.ts's candidate comparison.)

  // The same classifier the live gate uses — record and gate share vocabulary.
  const { acceptance } = classifyAdr(content);
  const title = extractTitle(content);
  const record = DecisionStateRecord.parse({
    schema_version: DECISION_STATE_RECORD_SCHEMA_VERSION,
    canonical_ref: canonical,
    original_path: canonical,
    path_sha256: sha256Hex(canonical),
    ...(title ? { title } : {}),
    adr_status_at_snapshot: acceptance,
    may_satisfy_active_gate: acceptance === "accepted",
    snapshotted_at: opts.now.toISOString(),
    source_sha256: currentSha,
    ...(opts.git_ref ? { git_ref: opts.git_ref } : {}),
  } satisfies DecisionStateRecord);

  if (existing.state === "missing") {
    return { kind: "write", path, record };
  }

  // The .md content itself changed under the record → stale (default fail;
  // explicit refresh naming both source hashes).
  if (existing.record.source_sha256 !== currentSha) {
    if (!opts.refresh) {
      return {
        kind: "ineligible",
        path,
        blocks: [
          {
            kind: "record_stale",
            existing_source_sha256: existing.record.source_sha256,
            current_source_sha256: currentSha,
          },
        ],
      };
    }
    if (
      opts.refresh.expected_old_source_sha256 !== existing.record.source_sha256 ||
      opts.refresh.expected_new_source_sha256 !== currentSha
    ) {
      return {
        kind: "ineligible",
        path,
        blocks: [
          {
            kind: "refresh_expectation_mismatch",
            expected_old_source_sha256: opts.refresh.expected_old_source_sha256,
            existing_source_sha256: existing.record.source_sha256,
            expected_new_source_sha256: opts.refresh.expected_new_source_sha256,
            current_source_sha256: currentSha,
          },
        ],
      };
    }
    return {
      kind: "refresh",
      path,
      record,
      existing_source_sha256: existing.record.source_sha256,
      current_source_sha256: currentSha,
      existing_raw: existing.raw,
    };
  }

  // Content unchanged: no-op ONLY if the existing record body still equals what
  // we would write today (semantic comparison; provenance stamps excluded).
  // Otherwise the on-disk record contradicts the live .md (e.g. it claims
  // accepted/may_satisfy=true for a now-proposed ADR) → fail, never silent.
  if (semanticEqual(existing.record, record)) {
    return { kind: "noop_same_source", path };
  }
  if (!opts.refresh) {
    return {
      kind: "ineligible",
      path,
      blocks: [
        {
          kind: "record_state_mismatch",
          detail:
            `on-disk record asserts adr_status_at_snapshot="${existing.record.adr_status_at_snapshot}"` +
            ` may_satisfy_active_gate=${existing.record.may_satisfy_active_gate}` +
            ` but the live .md classifies as "${record.adr_status_at_snapshot}"` +
            ` may_satisfy_active_gate=${record.may_satisfy_active_gate}` +
            ` (or title drifted) — refresh explicitly to re-record`,
        },
      ],
    };
  }
  if (
    opts.refresh.expected_old_source_sha256 !== existing.record.source_sha256 ||
    opts.refresh.expected_new_source_sha256 !== currentSha
  ) {
    return {
      kind: "ineligible",
      path,
      blocks: [
        {
          kind: "refresh_expectation_mismatch",
          expected_old_source_sha256: opts.refresh.expected_old_source_sha256,
          existing_source_sha256: existing.record.source_sha256,
          expected_new_source_sha256: opts.refresh.expected_new_source_sha256,
          current_source_sha256: currentSha,
        },
      ],
    };
  }
  // Bundle-only existing record (loose compacted away): refuse the refresh rather than
  // materialize a fresh loose, which would strand a stale bundle member + a diverging
  // loose the current compactor cannot re-fold (id already bundled → not re-bundled;
  // byte-diff → delete gate skips it as bundle_stale). Fail closed until Layer 4 adds
  // bundle member supersession; the bundle stays the single authority for now.
  if (!existing.looseFilePresent) {
    return {
      kind: "ineligible",
      path,
      blocks: [
        {
          kind: "compacted_record_refresh_unsupported",
          detail:
            "the existing record is bundle-only (compacted); refreshing a compacted decision record is not yet supported (would strand a stale bundle member + a diverging loose). Restore/uncompact the loose record first.",
        },
      ],
    };
  }
  return {
    kind: "refresh",
    path,
    record,
    existing_source_sha256: existing.record.source_sha256,
    current_source_sha256: currentSha,
    existing_raw: existing.raw,
  };
}

export type DecisionRecordWriteOutcome =
  | { kind: "written"; path: string; record: DecisionStateRecord }
  | { kind: "noop_same_source"; path: string }
  | { kind: "noop_record_authoritative"; path: string }
  | { kind: "ineligible"; path: string | null; blocks: DecisionRecordBlock[] };

export function serializeDecisionRecord(record: DecisionStateRecord): string {
  return JSON.stringify(record, null, 2) + "\n";
}

/**
 * Apply a `write` / `refresh` plan under the plan's ExpectedState guard
 * (absent for write, exact raw bytes for refresh) — a concurrent writer is
 * refused, not overwritten. Non-mutating plans pass through unchanged.
 */
export async function applyDecisionRecordPlan(
  plan: DecisionRecordPlan,
): Promise<DecisionRecordWriteOutcome> {
  if (plan.kind === "write" || plan.kind === "refresh") {
    const expected: ExpectedState =
      plan.kind === "write"
        ? { kind: "absent" }
        : { kind: "present", content: plan.existing_raw };
    await atomicWriteText(plan.path, serializeDecisionRecord(plan.record), expected);
    return { kind: "written", path: plan.path, record: plan.record };
  }
  return plan;
}

/** Re-plans at write time (decision-prune style) and applies under the ExpectedState guard. */
export async function writeDecisionRecord(
  cwd: string,
  rawRef: string,
  opts: DecisionRecordOptions,
): Promise<DecisionRecordWriteOutcome> {
  return applyDecisionRecordPlan(await planDecisionRecord(cwd, rawRef, opts));
}
