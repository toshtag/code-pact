import { z } from "zod";
import { PlanId } from "./plan-id.ts";
import { PhasePath } from "./phase-path.ts";

// ---------------------------------------------------------------------------
// Phase snapshot record — `.code-pact/state/archive/phases/<phase-id>.json`.
//
// A snapshot records that a *terminal* phase's membership (task ids), terminal
// statuses, and the evidence those statuses rest on were observed at a specific
// source hash. It is NOT an archive: writing one deletes nothing, edits no
// roadmap, rewrites no link (those are the later destructive `phase archive`
// layer), and it is NOT a context document — no objective / definition_of_done /
// non_goals / description prose is ever stored here.
//
// LIVE DESIGN FILE WINS (reader contract, locked here and in the writer tests):
// if the original phase YAML still exists, readers MUST prefer the live file.
// A snapshot is fallback authority ONLY for a missing archived/completed doc or
// explicit historical resolution. If the live file exists and its hash differs
// from `source_sha256`, the record is STALE and must not silently override or
// silence anything; the writer likewise refuses to overwrite a stale record
// except in an explicit refresh mode with expected old/new hashes.
//
// Terminal evidence is structured so the record never *silently* trusts the
// design YAML alone:
//   - `progress_events`        — done events in `.code-pact/state` prove it
//   - `maintainer_attestation` — an explicit, reasoned human override (audit
//                                trail for legacy phases with missing events)
//   - `design_status`          — cancelled tasks ONLY: cancellation has no
//                                event form in the current model, so the design
//                                YAML's `cancelled` is the only primary source;
//                                recording the kind makes that explicit. The
//                                observed YAML is pinned by the record-level
//                                `source_sha256`. Never valid for done tasks.
// ---------------------------------------------------------------------------

export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256 hex digest");

// Unknown-keys policy: STRICT. These are control records future readers will
// trust; an unrecognized field is a drifted/foreign record, not forward-compat
// data to silently strip. Future fields (e.g. step 7's `archived_at` /
// `retired_at`) arrive via an explicit schema_version bump, never via implicit
// passthrough.
export const TerminalEvidence = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("progress_events"),
    event_ids: z.array(Sha256Hex).min(1),
  }),
  z.strictObject({
    kind: z.literal("maintainer_attestation"),
    recorded_at: z.iso.datetime({ offset: true }),
    // Audit trail: a whitespace-only "reason" is no reason.
    reason: z.string().trim().min(1),
  }),
  z.strictObject({
    kind: z.literal("design_status"),
    observed_status: z.literal("cancelled"),
    source_field: z.literal("tasks[].status"),
  }),
]);
export type TerminalEvidence = z.infer<typeof TerminalEvidence>;

export const SnapshotTaskStatus = z.enum(["done", "cancelled"]);
export type SnapshotTaskStatus = z.infer<typeof SnapshotTaskStatus>;

export const SnapshotTask = z
  .strictObject({
    id: PlanId,
    status: SnapshotTaskStatus,
    depends_on: z.array(z.string().min(1)).optional(),
    terminal_evidence: TerminalEvidence,
  })
  .superRefine((t, ctx) => {
    if (t.status === "done" && t.terminal_evidence.kind === "design_status") {
      ctx.addIssue({
        code: "custom",
        path: ["terminal_evidence", "kind"],
        message:
          'design_status evidence is cancelled-only — a done task needs progress_events or an explicit maintainer_attestation, never the design YAML alone',
      });
    }
    if (t.status === "cancelled" && t.terminal_evidence.kind !== "design_status") {
      ctx.addIssue({
        code: "custom",
        path: ["terminal_evidence", "kind"],
        message:
          'a cancelled task\'s evidence must be design_status — cancellation has no progress-event form, so any other kind would misstate the provenance',
      });
    }
  });
export type SnapshotTask = z.infer<typeof SnapshotTask>;

export const PHASE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const PhaseSnapshot = z.strictObject({
  schema_version: z.literal(PHASE_SNAPSHOT_SCHEMA_VERSION),
  phase_id: PlanId,
  phase_name: z.string().min(1),
  original_path: PhasePath,
  // Terminal-only by construction: a snapshot of a planned/in_progress phase is
  // schema-invalid, not merely writer-refused.
  phase_status: z.enum(["done", "cancelled"]),
  weight: z.number().positive(),
  // `snapshotted_at`, deliberately NOT `archived_at`: this layer only records.
  // `archived_at` / `retired_at` are reserved for the destructive archive/retire
  // command to add when it actually retires the source file.
  snapshotted_at: z.iso.datetime({ offset: true }),
  source_sha256: Sha256Hex,
  path_sha256: Sha256Hex,
  git_ref: z.string().min(1).optional(),
  tasks: z.array(SnapshotTask),
});
export type PhaseSnapshot = z.infer<typeof PhaseSnapshot>;
