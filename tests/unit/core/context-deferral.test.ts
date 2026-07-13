import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildContextManifest,
  sha256Utf8,
} from "../../../src/core/context-deferral/context-manifest.ts";
import {
  loadContextManifestArtifact,
  storeContextManifestArtifact,
} from "../../../src/core/context-deferral/context-store.ts";
import { contextRefFromDigest } from "../../../src/core/context-deferral/context-ref.ts";
import { canonicalJson } from "../../../src/core/content-addressed-store/canonical-json.ts";
import {
  __setAtomicTempTokenForTests,
  __setAtomicWriteFailAfterOpenForTests,
} from "../../../src/io/atomic-text.ts";
import type { RenderedSection } from "../../../src/core/pack/formatters/markdown.ts";

function section(name: string, body: string): RenderedSection {
  return {
    name,
    lines: body.split("\n"),
  };
}

describe("context deferral manifest", () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "code-pact-context-deferral-"));
    try {
      await fn(dir);
    } finally {
      __setAtomicTempTokenForTests(null);
      __setAtomicWriteFailAfterOpenForTests(null);
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function writeArtifactContent(dir: string, content: string): Promise<string> {
    const digest = sha256Utf8(content);
    const ref = contextRefFromDigest(digest);
    await mkdir(join(dir, ".code-pact", "cache", "context"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "cache", "context", `${digest}.json`),
      content,
      "utf8",
    );
    return ref;
  }

  it("builds a deterministic content-addressed reference", () => {
    const first = buildContextManifest([
      section("completed_tasks", "## Completed Tasks\n- P1-T1"),
      section("rules", "## Rules\nKeep contracts stable."),
    ]);
    const second = buildContextManifest([
      section("completed_tasks", "## Completed Tasks\n- P1-T1"),
      section("rules", "## Rules\nKeep contracts stable."),
    ]);

    expect(first.artifact.ref).toMatch(/^context:sha256:[0-9a-f]{64}$/);
    expect(second.artifact.ref).toBe(first.artifact.ref);
    expect(second.artifact.content).toBe(first.artifact.content);
  });

  it("changes reference when section order changes", () => {
    const first = buildContextManifest([
      section("completed_tasks", "## Completed Tasks\n- P1-T1"),
      section("rules", "## Rules\nKeep contracts stable."),
    ]);
    const second = buildContextManifest([
      section("rules", "## Rules\nKeep contracts stable."),
      section("completed_tasks", "## Completed Tasks\n- P1-T1"),
    ]);

    expect(second.artifact.ref).not.toBe(first.artifact.ref);
  });

  it("records exact UTF-8 bytes and content digests", () => {
    const built = buildContextManifest([
      section("reads", "## Declared read surface\n- `src/日本語.ts`"),
    ]);
    const manifestSection = built.artifact.manifest.sections[0]!;

    expect(manifestSection.bytes).toBe(
      Buffer.byteLength(manifestSection.content, "utf8"),
    );
    expect(manifestSection.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.deferredBytes).toBe(manifestSection.bytes);
    expect(built.metadata.sections).toEqual([
      { name: "reads", bytes: manifestSection.bytes },
    ]);
  });

  it("rejects duplicate deferred section names", () => {
    expect(() =>
      buildContextManifest([
        section("rules", "## Rules\nA"),
        section("rules", "## Rules\nB"),
      ]),
    ).toThrow(/duplicate deferred context section/);
  });

  it("rejects names outside the closed deferred section enum", () => {
    expect(() =>
      buildContextManifest([section("task_definition", "## Task Definition")]),
    ).toThrow();
  });

  it("rejects malformed, schema-invalid, and non-canonical artifacts", async () => {
    await withTempDir(async dir => {
      await expect(
        loadContextManifestArtifact(dir, await writeArtifactContent(dir, "not json")),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID" });

      const unknownTopLevel = canonicalJson({
        schema_version: 1,
        sections: [
          {
            name: "rules",
            bytes: 1,
            content_sha256: sha256Utf8("x"),
            content: "x",
          },
        ],
        extra: true,
      });
      await expect(
        loadContextManifestArtifact(
          dir,
          await writeArtifactContent(dir, unknownTopLevel),
        ),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID" });

      const unknownSection = canonicalJson({
        schema_version: 1,
        sections: [
          {
            name: "rules",
            bytes: 1,
            content_sha256: sha256Utf8("x"),
            content: "x",
            extra: true,
          },
        ],
      });
      await expect(
        loadContextManifestArtifact(dir, await writeArtifactContent(dir, unknownSection)),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID" });

      const emptySections = canonicalJson({ schema_version: 1, sections: [] });
      await expect(
        loadContextManifestArtifact(dir, await writeArtifactContent(dir, emptySections)),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID" });

      const nonCanonical = JSON.stringify(
        {
          schema_version: 1,
          sections: [
            {
              name: "rules",
              bytes: 1,
              content_sha256: sha256Utf8("x"),
              content: "x",
            },
          ],
        },
        null,
        2,
      );
      await expect(
        loadContextManifestArtifact(dir, await writeArtifactContent(dir, nonCanonical)),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    });
  });

  it("rejects byte-count, section-digest, manifest-digest, and conflict mismatches", async () => {
    await withTempDir(async dir => {
      const byteMismatch = canonicalJson({
        schema_version: 1,
        sections: [
          {
            name: "rules",
            bytes: 2,
            content_sha256: sha256Utf8("x"),
            content: "x",
          },
        ],
      });
      await expect(
        loadContextManifestArtifact(dir, await writeArtifactContent(dir, byteMismatch)),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID" });

      const sectionDigestMismatch = canonicalJson({
        schema_version: 1,
        sections: [
          {
            name: "rules",
            bytes: 1,
            content_sha256: sha256Utf8("y"),
            content: "x",
          },
        ],
      });
      await expect(
        loadContextManifestArtifact(
          dir,
          await writeArtifactContent(dir, sectionDigestMismatch),
        ),
      ).rejects.toMatchObject({ code: "CONTEXT_DIGEST_MISMATCH" });

      const built = buildContextManifest([section("rules", "## Rules\nA")]);
      await mkdir(join(dir, ".code-pact", "cache", "context"), { recursive: true });
      await writeFile(
        join(dir, ".code-pact", "cache", "context", `${built.artifact.digest}.json`),
        buildContextManifest([section("rules", "## Rules\nB")]).artifact.content,
        "utf8",
      );
      await expect(
        loadContextManifestArtifact(dir, built.artifact.ref),
      ).rejects.toMatchObject({ code: "CONTEXT_DIGEST_MISMATCH" });
      await expect(
        storeContextManifestArtifact(dir, built.artifact),
      ).rejects.toMatchObject({ code: "CONTEXT_DIGEST_MISMATCH" });
    });
  });

  it("fails closed on write failure and cache symlink authority failures", async () => {
    await withTempDir(async dir => {
      const writeError = new Error("disk full");
      (writeError as NodeJS.ErrnoException).code = "ENOSPC";
      __setAtomicWriteFailAfterOpenForTests(() => writeError);
      await expect(
        storeContextManifestArtifact(
          dir,
          buildContextManifest([section("rules", "## Rules\nA")]).artifact,
        ),
      ).rejects.toMatchObject({ code: "CONTEXT_WRITE_FAILED" });
      __setAtomicWriteFailAfterOpenForTests(null);

      await rm(join(dir, ".code-pact", "cache"), { recursive: true, force: true });
      await mkdir(join(dir, ".code-pact"), { recursive: true });
      await symlink(tmpdir(), join(dir, ".code-pact", "cache"));
      await expect(
        storeContextManifestArtifact(
          dir,
          buildContextManifest([section("rules", "## Rules\nB")]).artifact,
        ),
      ).rejects.toMatchObject({ code: "CONTEXT_PATH_UNSAFE" });
    });
  });

  it("returns CONTEXT_NOT_FOUND when exclusive-create conflict loses the artifact before readback", async () => {
    await withTempDir(async dir => {
      const built = buildContextManifest([section("rules", "## Rules\nA")]);
      const token = "context-readback-missing";
      await mkdir(join(dir, ".code-pact", "cache", "context"), { recursive: true });
      await writeFile(
        join(
          dir,
          ".code-pact",
          "cache",
          "context",
          `${built.artifact.digest}.json.tmp-${token}`,
        ),
        "pre-existing temp",
        "utf8",
      );
      __setAtomicTempTokenForTests(() => token);

      await expect(
        storeContextManifestArtifact(dir, built.artifact),
      ).rejects.toMatchObject({ code: "CONTEXT_NOT_FOUND" });
    });
  });
});
