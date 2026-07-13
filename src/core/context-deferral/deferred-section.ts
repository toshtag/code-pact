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

export function deferredContextSectionLines(
  metadata: DeferredContextMetadata,
): string[] {
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
): RenderedSection {
  return {
    name: "deferred_context",
    details: { manifest_ref: metadata.manifest_ref },
    lines: deferredContextSectionLines(metadata),
  };
}
