import { z } from "zod";
import { RelativePosixPath } from "./relative-path.ts";
import { Sha256Hex } from "./phase-snapshot.ts";

// ---------------------------------------------------------------------------
// Decision-state record — `.code-pact/state/archive/decisions/<stem>-<hash8>.json`.
//
// Records the *settled state* of one decision record (`design/decisions/*.md`)
// as observed at a specific source hash: its ADR status and whether it may
// satisfy an active decision gate. It is NOT a retirement: writing one deletes
// nothing, edits no `PRUNED.md`, rewrites no link (those are the later
// destructive `decision retire` layer). `adr_status_at_snapshot` is therefore
// deliberately named for the snapshot moment; retirement-time fields
// (`retired_at`, status-at-retirement) are reserved for that later layer.
//
// LIVE DESIGN FILE WINS (reader contract, locked here and in the writer tests):
// while the .md still exists, readers MUST resolve from the live file. The
// record is fallback authority ONLY once the file is missing. A record whose
// `source_sha256` no longer matches a still-present live file is STALE — it
// must not silently override the live file, satisfy a gate, or silence a
// missing-ref warning; the writer refuses to overwrite it except in an explicit
// refresh mode with expected old/new hashes.
//
// Gate invariant (the A3 rule, schema-enforced): `may_satisfy_active_gate` can
// be true ONLY when the ADR was classified `accepted` at snapshot time. A bare
// tombstone (e.g. a PRUNED.md backcompat row, which carries no accepted
// classification) is the degenerate `may_satisfy_active_gate: false` form and
// can never release a live gate.
//
// Resolution is by EXACT `canonical_ref` match against `decision_refs` /
// `acceptance_refs` targets — never fuzzy/stem matching. `canonical_ref` is a
// normalized project-relative POSIX path confined to a top-level
// `design/decisions/*.md` (never README.md / PRUNED.md / nested paths), and
// `path_sha256` (and the filename's hash8) are computed from that canonical
// form, never from an OS-native path.
// ---------------------------------------------------------------------------

const DecisionRefPath = RelativePosixPath.refine(
  (s) => s.startsWith("design/decisions/"),
  "decision path must be under design/decisions/",
)
  .refine((s) => s.endsWith(".md"), "decision path must end with .md")
  .refine(
    (s) => !s.slice("design/decisions/".length).includes("/"),
    "decision path must be a top-level record (nested ADRs are not snapshot targets)",
  )
  .refine(
    (s) => s !== "design/decisions/README.md" && s !== "design/decisions/PRUNED.md",
    "README.md / PRUNED.md are never decision records",
  );

export const ADR_STATUS_AT_SNAPSHOT_VALUES = [
  "accepted",
  "blocked",
  "empty",
  "unknown_status",
] as const;

export const DECISION_STATE_RECORD_SCHEMA_VERSION = 1 as const;

// Unknown-keys policy: STRICT (see phase-snapshot.ts — same rationale; future
// retirement-time fields arrive via a schema_version bump, never passthrough).
export const DecisionStateRecord = z
  .strictObject({
    schema_version: z.literal(DECISION_STATE_RECORD_SCHEMA_VERSION),
    canonical_ref: DecisionRefPath,
    original_path: DecisionRefPath,
    path_sha256: Sha256Hex,
    title: z.string().min(1).optional(),
    // The `classifyAdr` acceptance verdict observed at snapshot time (the same
    // classifier the live gate uses, so record and gate can never disagree on
    // vocabulary).
    adr_status_at_snapshot: z.enum(ADR_STATUS_AT_SNAPSHOT_VALUES),
    may_satisfy_active_gate: z.boolean(),
    snapshotted_at: z.iso.datetime({ offset: true }),
    source_sha256: Sha256Hex,
    git_ref: z.string().min(1).optional(),
  })
  .superRefine((r, ctx) => {
    // Bidirectional: may_satisfy_active_gate is exactly (status === accepted).
    // The writer only ever emits this equivalence; making it a two-way schema
    // invariant means a hand-edited "accepted but not gate-usable" or
    // "non-accepted but gate-usable" record fails to parse, rather than slipping
    // past as a shape the writer would never produce.
    if (r.may_satisfy_active_gate !== (r.adr_status_at_snapshot === "accepted")) {
      ctx.addIssue({
        code: "custom",
        path: ["may_satisfy_active_gate"],
        message:
          "may_satisfy_active_gate must equal (adr_status_at_snapshot === 'accepted') — accepted records release a live gate, non-accepted ones never do",
      });
    }
    // v1 invariant: the record's identity IS the canonical ref. A diverging
    // original_path would be a rename-tracking feature this version does not
    // have; allowing it silently would weaken exact-match resolution.
    if (r.canonical_ref !== r.original_path) {
      ctx.addIssue({
        code: "custom",
        path: ["original_path"],
        message: "original_path must equal canonical_ref in schema_version 1",
      });
    }
  });
export type DecisionStateRecord = z.infer<typeof DecisionStateRecord>;
