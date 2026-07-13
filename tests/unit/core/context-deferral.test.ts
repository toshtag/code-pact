import { describe, expect, it } from "vitest";
import { buildContextManifest } from "../../../src/core/context-deferral/context-manifest.ts";
import type { RenderedSection } from "../../../src/core/pack/formatters/markdown.ts";

function section(name: string, body: string): RenderedSection {
  return {
    name,
    lines: body.split("\n"),
  };
}

describe("context deferral manifest", () => {
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
});
