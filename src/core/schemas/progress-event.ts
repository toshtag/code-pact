import { z } from "zod";

export const EventStatus = z.enum([
  "started",
  "blocked",
  "resumed",
  "done",
  "failed",
]);
export const ActorType = z.enum(["human", "agent"]);

// Provenance of a `done` event. `loop` = produced by the normal
// `task complete` path (loop-verified). `external` = recorded by
// `task record-done` — for work completed outside the loop, or for the
// `record_only` lane where verification was run outside `task complete`.
// Only meaningful on `done` events (enforced by superRefine below);
// missing source on a legacy `done` event is treated as `loop` by readers.
export const EventSource = z.enum(["loop", "external"]);

export const ProgressEvent = z
  .object({
    task_id: z.string().min(1),
    status: EventStatus,
    // ISO 8601 datetime string. Stored as string to avoid tz ambiguity in YAML.
    at: z.iso.datetime({ offset: true }),
    actor: ActorType,
    // Agent name that produced the event. Optional for backward compatibility
    // with older logs.
    agent: z.string().min(1).optional(),
    // Human identity of whoever ran the verb — the
    // git `user.name` (or `CODE_PACT_AUTHOR`) captured at write time, regardless
    // of `actor`. Optional and additive: legacy events omit it (and hash
    // identically to before — `canonicalizeEvent` omits absent fields), and
    // capture can be disabled (`collaboration.author: off`). Self-reported
    // coordination metadata, not an audit/security control.
    author: z.string().min(1).optional(),
    evidence: z.array(z.string()).optional(),
    notes: z.string().optional(),
    // Justification for a state transition. Required for `blocked` events
    // (enforced by superRefine below). Distinct from `notes` (free-form memo).
    reason: z.string().min(1).optional(),
    // Completion provenance. Only valid on `done` events.
    source: EventSource.optional(),
    // Opaque reference to a cached verification evidence artifact
    // (e.g. "evidence:sha256:<digest>"). Only valid on `done` events.
    verification_ref: z
      .string()
      .regex(/^evidence:sha256:[0-9a-f]{64}$/)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "blocked" && !value.reason) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: 'reason is required when status is "blocked"',
      });
    }
    if (value.source !== undefined && value.status !== "done") {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: 'source is only valid on "done" events',
      });
    }
    if (value.verification_ref !== undefined && value.status !== "done") {
      ctx.addIssue({
        code: "custom",
        path: ["verification_ref"],
        message: 'verification_ref is only valid on "done" events',
      });
    }
  });
export type ProgressEvent = z.infer<typeof ProgressEvent>;

// The shape of the legacy monolithic file stored at .code-pact/state/progress.yaml.
// Per-event files under .code-pact/state/events/ each store a single ProgressEvent
// (plus a content-id), not a ProgressLog.
export const ProgressLog = z.object({
  events: z.array(ProgressEvent),
});
export type ProgressLog = z.infer<typeof ProgressLog>;
