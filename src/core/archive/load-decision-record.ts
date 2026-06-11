import { readFile } from "node:fs/promises";
import { DecisionStateRecord } from "../schemas/decision-state-record.ts";
import { decisionRecordPath } from "./paths.ts";

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
// (nested ADR, `docs/...`, traversal, README/PRUNED) gets no lookup at all.
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
 * collapsed to `absent`). `canonicalRef` MUST be a normalized top-level
 * `design/decisions/*.md` (the caller's `normalizeDecisionRef`); the schema's
 * `DecisionRefPath` would reject anything else at parse time anyway.
 */
export async function loadDecisionRecord(
  cwd: string,
  canonicalRef: string,
): Promise<LoadDecisionRecordResult> {
  const path = decisionRecordPath(cwd, canonicalRef);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    // Present-but-unreadable (EACCES, EISDIR, …) must NOT be treated as absent —
    // that would silently tolerate a missing decision on a broken record.
    return { kind: "invalid", error };
  }

  try {
    const record = DecisionStateRecord.parse(JSON.parse(raw) as unknown);
    return { kind: "valid", record };
  } catch (error) {
    return { kind: "invalid", error };
  }
}
