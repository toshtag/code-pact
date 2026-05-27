import { describe, it, expect } from "vitest";
import { dedupeDesiredFiles } from "../../../../src/core/adapters/desired.ts";
import type { DesiredAdapterFile } from "../../../../src/core/adapters/types.ts";
import {
  AdapterManifest,
  AdapterManifestLenient,
} from "../../../../src/core/schemas/adapter-manifest.ts";

const skill = (path: string, content: string): DesiredAdapterFile => ({
  path,
  role: "skill",
  content,
});

describe("dedupeDesiredFiles", () => {
  it("passes through a unique set unchanged", () => {
    const files = [skill("a.md", "A"), skill("b.md", "B")];
    expect(dedupeDesiredFiles(files)).toEqual(files);
  });

  it("drops an identical-content duplicate path", () => {
    const out = dedupeDesiredFiles([skill("a.md", "A"), skill("a.md", "A"), skill("b.md", "B")]);
    expect(out.map((f) => f.path)).toEqual(["a.md", "b.md"]);
  });

  it("throws ADAPTER_DESIRED_PATH_CONFLICT on same path with different content", () => {
    expect(() => dedupeDesiredFiles([skill("a.md", "A"), skill("a.md", "DIFFERENT")])).toThrow(
      expect.objectContaining({ code: "ADAPTER_DESIRED_PATH_CONFLICT" }),
    );
  });
});

describe("AdapterManifest duplicate-path constraint", () => {
  const base = {
    schema_version: 1 as const,
    agent_name: "claude-code",
    generator_version: "1.20.0",
    adapter_schema_version: 0,
    generated_at: "2026-05-27T00:00:00.000Z",
    profile_fingerprint: { instruction_filename: "CLAUDE.md", context_dir: ".context/claude-code" },
  };
  const file = (path: string) => ({
    path,
    sha256: "a".repeat(64),
    managed: true,
    role: "skill" as const,
  });

  it("strict schema rejects duplicate files[].path", () => {
    const result = AdapterManifest.safeParse({
      ...base,
      files: [file(".claude/skills/verify.md"), file(".claude/skills/verify.md")],
    });
    expect(result.success).toBe(false);
  });

  it("strict schema accepts a unique file set", () => {
    const result = AdapterManifest.safeParse({
      ...base,
      files: [file(".claude/skills/verify.md"), file(".claude/skills/verify-2.md")],
    });
    expect(result.success).toBe(true);
  });

  it("lenient schema tolerates duplicate paths (repair-read only)", () => {
    const result = AdapterManifestLenient.safeParse({
      ...base,
      files: [file(".claude/skills/verify.md"), file(".claude/skills/verify.md")],
    });
    expect(result.success).toBe(true);
  });
});
