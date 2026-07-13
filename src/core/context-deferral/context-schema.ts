import { z } from "zod";

export const DeferredContextSectionNameSchema = z.enum([
  "completed_tasks",
  "related_decisions",
  "constitution",
  "rules",
  "reads",
]);

export type DeferredContextSectionName = z.infer<
  typeof DeferredContextSectionNameSchema
>;

export const ContextManifestSectionSchema = z.object({
  name: DeferredContextSectionNameSchema,
  bytes: z.number().int().nonnegative(),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  content: z.string(),
});

export const ContextManifestSchema = z.object({
  schema_version: z.literal(1),
  sections: z.array(ContextManifestSectionSchema),
});

export type ContextManifest = z.infer<typeof ContextManifestSchema>;
export type ContextManifestSection = z.infer<
  typeof ContextManifestSectionSchema
>;
