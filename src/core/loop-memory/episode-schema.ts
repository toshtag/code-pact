import { z } from "zod";
import { canonicalJson } from "../content-addressed-store/canonical-json.ts";
import { PlanId } from "../schemas/plan-id.ts";
import { TaskType } from "../schemas/task.ts";
import { loopMemoryInvalid } from "./memory-errors.ts";
import { containsAbsolutePathLike } from "./path-safety.ts";

export const MAX_EPISODE_BYTES = 8 * 1024;
export const MAX_FAILED_COMMAND_BYTES = 512;
export const MAX_FAILED_CHECK_BYTES = 128;

const FAILURE_KINDS = [
  "command_failed",
  "timed_out",
  "aborted",
  "decision_required",
  "unsafe_write",
  "invalid_state",
  "unknown",
] as const;

const LIFECYCLE_MODES = ["full_loop", "record_only", "decision_loop"] as const;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(maxBytes: number) {
  return z.string().superRefine((value, ctx) => {
    if (utf8Bytes(value) > maxBytes) {
      ctx.addIssue({
        code: "custom",
        message: `string exceeds ${maxBytes} UTF-8 bytes`,
      });
    }
    if (containsAbsolutePathLike(value)) {
      ctx.addIssue({
        code: "custom",
        message: "absolute paths are not allowed in loop-memory episodes",
      });
    }
  });
}

function isCanonicalUtcIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

const Verification = z.strictObject({
  ok: z.boolean(),
  failure_kind: z.enum(FAILURE_KINDS).optional(),
  failure_fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  failed_check: boundedString(MAX_FAILED_CHECK_BYTES).optional(),
  failed_command: boundedString(MAX_FAILED_COMMAND_BYTES).optional(),
}).superRefine((value, ctx) => {
  const failureFields = [
    "failure_kind",
    "failure_fingerprint",
    "failed_check",
    "failed_command",
  ] as const;

  if (value.ok) {
    for (const field of failureFields) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "success episodes must not include failure fields",
        });
      }
    }
  } else if (value.failure_kind === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["failure_kind"],
      message: "failure episodes require failure_kind",
    });
  }
});

export const LoopMemoryEpisodeSchema = z.strictObject({
  schema_version: z.literal(1),
  recorded_at: z.string().refine(isCanonicalUtcIsoTimestamp, {
    message: "recorded_at must be Date.prototype.toISOString() UTC format",
  }),
  kind: z.enum(["verification_failed", "verification_passed"]),
  task: z.strictObject({
    phase_id: PlanId,
    task_id: PlanId,
    task_type: TaskType,
  }),
  execution: z.strictObject({
    lifecycle_mode: z.enum(LIFECYCLE_MODES),
    repair_mode: z.enum(["bounded", "disabled"]),
  }),
  verification: Verification,
}).superRefine((value, ctx) => {
  if (value.kind === "verification_passed" && !value.verification.ok) {
    ctx.addIssue({
      code: "custom",
      path: ["kind"],
      message: "verification_passed episodes require verification.ok=true",
    });
  }
  if (value.kind === "verification_failed" && value.verification.ok) {
    ctx.addIssue({
      code: "custom",
      path: ["kind"],
      message: "verification_failed episodes require verification.ok=false",
    });
  }
});

export type LoopMemoryEpisode = z.infer<typeof LoopMemoryEpisodeSchema>;
export type LoopMemoryFailureKind = z.infer<typeof Verification>["failure_kind"];

export function parseLoopMemoryEpisode(input: unknown): LoopMemoryEpisode {
  const parsed = LoopMemoryEpisodeSchema.parse(input);
  const bytes = utf8Bytes(canonicalJson(parsed));
  if (bytes > MAX_EPISODE_BYTES) {
    throw loopMemoryInvalid(`loop-memory episode exceeds ${MAX_EPISODE_BYTES} bytes`);
  }
  return parsed;
}

export function safeParseLoopMemoryEpisode(input: unknown):
  | { success: true; data: LoopMemoryEpisode }
  | { success: false; error: unknown } {
  try {
    return { success: true, data: parseLoopMemoryEpisode(input) };
  } catch (error) {
    return { success: false, error };
  }
}
