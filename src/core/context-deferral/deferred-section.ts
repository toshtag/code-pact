import type { RenderedSection } from "../pack/formatters/markdown.ts";
import type { DeferredContextSectionName } from "./context-schema.ts";

export type DeferredContextPublicSection = {
  name: DeferredContextSectionName;
  bytes: number;
};

export type DeferredContextMetadata = {
  manifest_ref: string;
  sections: DeferredContextPublicSection[];
};

export type DeferredContextProjection = DeferredContextMetadata & {
  persisted: boolean;
  retrieve_command: string | null;
};

export type DeferredContextRenderOptions = {
  projectedSections?: ReadonlySet<DeferredContextSectionName>;
};

export function deferredContextSectionLines(
  metadata: DeferredContextMetadata,
  options: DeferredContextRenderOptions = {},
): string[] {
  const projectedSections = options.projectedSections ?? new Set();
  if (projectedSections.size > 0) {
    return [
      "## Deferred Context",
      "",
      "The exact original forms of the following projected or deferred sections are represented by this manifest:",
      "",
      ...metadata.sections.map(section =>
        projectedSections.has(section.name)
          ? `- ${section.name} — projected inline; exact original represented after materialization`
          : `- ${section.name} — deferred from the inline pack`
      ),
      "",
      `Manifest reference: \`${metadata.manifest_ref}\``,
      "",
      "Exact original section content may be retrieved from the local derived context cache after materialization.",
      "",
    ];
  }

  return [
    "## Deferred Context",
    "",
    "The following sections were withheld to satisfy the context byte budget:",
    "",
    ...metadata.sections.map(section => `- ${section.name}`),
    "",
    `Manifest reference: \`${metadata.manifest_ref}\``,
    "",
    "Exact section content may be retrieved from the local derived context cache after materialization.",
    "",
  ];
}

export function makeDeferredContextRenderedSection(
  metadata: DeferredContextMetadata,
  options: DeferredContextRenderOptions = {},
): RenderedSection {
  return {
    name: "deferred_context",
    details: { manifest_ref: metadata.manifest_ref },
    lines: deferredContextSectionLines(metadata, options),
  };
}
