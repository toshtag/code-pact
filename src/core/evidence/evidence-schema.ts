import { z } from "zod";

export const EvidenceArtifactSchema = z.strictObject({
  schema_version: z.literal(1),
  command: z.string(),
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  aborted: z.boolean(),
  elapsed_ms: z.number().int().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  stdout_capture_truncated: z.boolean(),
  stderr_capture_truncated: z.boolean(),
});

export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;
