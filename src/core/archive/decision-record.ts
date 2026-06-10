import { readFile } from "node:fs/promises";
import {
  DecisionStateRecord,
  DECISION_STATE_RECORD_SCHEMA_VERSION,
} from "../schemas/decision-state-record.ts";
import { classifyAdr } from "../decisions/adr.ts";
import { resolveWithinProject } from "../path-safety.ts";
import { atomicWriteText, type ExpectedState } from "../../io/atomic-text.ts";
import { decisionRecordPath, normalizeDecisionRef, sha256Hex } from "./paths.ts";

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
  | { kind: "record_stale"; existing_source_sha256: string; current_source_sha256: string }
  | {
      kind: "refresh_expectation_mismatch";
      expected_old_source_sha256: string;
      existing_source_sha256: string;
      expected_new_source_sha256: string;
      current_source_sha256: string;
    }
  | { kind: "live_file_missing"; canonical_ref: string };

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
  path: string,
): Promise<
  | { state: "missing" }
  | { state: "invalid"; detail: string }
  | { state: "present"; record: DecisionStateRecord; raw: string }
> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return { state: "missing" };
    throw err;
  }
  try {
    return { state: "present", record: DecisionStateRecord.parse(JSON.parse(raw)), raw };
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

  const existing = await readExistingRecord(path);
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

  if (existing.state === "present" && existing.record.source_sha256 === currentSha) {
    return { kind: "noop_same_source", path };
  }

  const blocks: DecisionRecordBlock[] = [];
  if (existing.state === "present") {
    if (!opts.refresh) {
      blocks.push({
        kind: "record_stale",
        existing_source_sha256: existing.record.source_sha256,
        current_source_sha256: currentSha,
      });
    } else if (
      opts.refresh.expected_old_source_sha256 !== existing.record.source_sha256 ||
      opts.refresh.expected_new_source_sha256 !== currentSha
    ) {
      blocks.push({
        kind: "refresh_expectation_mismatch",
        expected_old_source_sha256: opts.refresh.expected_old_source_sha256,
        existing_source_sha256: existing.record.source_sha256,
        expected_new_source_sha256: opts.refresh.expected_new_source_sha256,
        current_source_sha256: currentSha,
      });
    }
  }
  if (blocks.length > 0) return { kind: "ineligible", path, blocks };

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

  if (existing.state === "present") {
    return {
      kind: "refresh",
      path,
      record,
      existing_source_sha256: existing.record.source_sha256,
      current_source_sha256: currentSha,
      existing_raw: existing.raw,
    };
  }
  return { kind: "write", path, record };
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
