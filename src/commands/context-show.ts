import { loadContextManifestArtifact } from "../core/context-deferral/context-store.ts";
import type { ContextManifestSection } from "../core/context-deferral/context-schema.ts";

export type ContextShowResult = {
  context_ref: string;
  digest: string;
  schema_version: 1;
  sections: ContextManifestSection[];
  total_deferred_bytes: number;
};

export async function runContextShow(
  cwd: string,
  ref: string,
): Promise<ContextShowResult> {
  const loaded = await loadContextManifestArtifact(cwd, ref);
  return {
    context_ref: loaded.ref,
    digest: loaded.digest,
    schema_version: loaded.manifest.schema_version,
    sections: loaded.manifest.sections,
    total_deferred_bytes: loaded.manifest.sections.reduce(
      (sum, section) => sum + section.bytes,
      0,
    ),
  };
}

export function findContextSection(
  result: ContextShowResult,
  name: string,
): ContextManifestSection | null {
  return result.sections.find(section => section.name === name) ?? null;
}
