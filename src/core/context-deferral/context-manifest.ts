import { createHash } from "node:crypto";
import { canonicalJson } from "../content-addressed-store/canonical-json.ts";
import type { RenderedSection } from "../pack/formatters/markdown.ts";
import { contextRefFromDigest } from "./context-ref.ts";
import {
  ContextManifestSchema,
  DeferredContextSectionNameSchema,
  type ContextManifest,
  type DeferredContextSectionName,
} from "./context-schema.ts";
import type {
  DeferredContextMetadata,
  DeferredContextPublicSection,
} from "./deferred-section.ts";
import { contextError } from "./context-errors.ts";

export type PendingContextManifestArtifact = {
  manifest: ContextManifest;
  content: string;
  digest: string;
  ref: string;
};

export type BuiltContextManifest = {
  artifact: PendingContextManifestArtifact;
  metadata: DeferredContextMetadata;
  deferredBytes: number;
};

export function sha256Utf8(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function buildContextManifest(
  sections: ReadonlyArray<RenderedSection>,
): BuiltContextManifest {
  const seen = new Set<string>();
  const publicSections: DeferredContextPublicSection[] = [];
  const manifestSections = sections.map(section => {
    const name = DeferredContextSectionNameSchema.parse(section.name);
    if (seen.has(name)) {
      throw contextError(
        "CONTEXT_INVALID",
        `duplicate deferred context section: ${name}`,
      );
    }
    seen.add(name);
    const content = section.lines.join("\n");
    const bytes = Buffer.byteLength(content, "utf8");
    const content_sha256 = sha256Utf8(content);
    publicSections.push({ name, bytes });
    return {
      name,
      bytes,
      content_sha256,
      content,
    };
  });

  const manifest = ContextManifestSchema.parse({
    schema_version: 1,
    sections: manifestSections,
  });
  const content = canonicalJson(manifest);
  const digest = sha256Utf8(content);
  const ref = contextRefFromDigest(digest);
  return {
    artifact: { manifest, content, digest, ref },
    metadata: { manifest_ref: ref, sections: publicSections },
    deferredBytes: publicSections.reduce((sum, section) => sum + section.bytes, 0),
  };
}

export function validateContextManifestContent(
  content: string,
  expectedDigest: string,
): PendingContextManifestArtifact {
  const actualDigest = sha256Utf8(content);
  if (actualDigest !== expectedDigest) {
    throw contextError(
      "CONTEXT_DIGEST_MISMATCH",
      "context manifest content does not match reference digest",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch (error) {
    throw contextError("CONTEXT_INVALID", "context manifest is not valid JSON", error);
  }

  const parsedResult = ContextManifestSchema.safeParse(decoded);
  if (!parsedResult.success) {
    throw contextError(
      "CONTEXT_INVALID",
      "context manifest does not match schema",
      parsedResult.error,
    );
  }

  const seen = new Set<DeferredContextSectionName>();
  for (const section of parsedResult.data.sections) {
    if (seen.has(section.name)) {
      throw contextError(
        "CONTEXT_INVALID",
        `duplicate deferred context section: ${section.name}`,
      );
    }
    seen.add(section.name);
    const bytes = Buffer.byteLength(section.content, "utf8");
    if (bytes !== section.bytes) {
      throw contextError(
        "CONTEXT_INVALID",
        `deferred context section byte count mismatch: ${section.name}`,
      );
    }
    if (sha256Utf8(section.content) !== section.content_sha256) {
      throw contextError(
        "CONTEXT_DIGEST_MISMATCH",
        `deferred context section digest mismatch: ${section.name}`,
      );
    }
  }

  const canonical = canonicalJson(parsedResult.data);
  if (canonical !== content) {
    throw contextError(
      "CONTEXT_INVALID",
      "context manifest is not canonically serialized",
    );
  }

  return {
    manifest: parsedResult.data,
    content,
    digest: expectedDigest,
    ref: contextRefFromDigest(expectedDigest),
  };
}
