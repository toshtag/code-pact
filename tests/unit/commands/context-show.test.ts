import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdContext } from "../../../src/cli/commands/context.ts";
import { runContextShow } from "../../../src/commands/context-show.ts";
import { buildContextManifest } from "../../../src/core/context-deferral/context-manifest.ts";
import { sha256Utf8 } from "../../../src/core/context-deferral/context-manifest.ts";
import { contextRefFromDigest } from "../../../src/core/context-deferral/context-ref.ts";
import { storeContextManifestArtifact } from "../../../src/core/context-deferral/context-store.ts";
import type { RenderedSection } from "../../../src/core/pack/formatters/markdown.ts";

function section(name: string, content: string): RenderedSection {
  return { name, lines: content.split("\n") };
}

function parseStdout<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

describe("context show", () => {
  const originalCwd = process.cwd();
  let cwd: string;
  let stdout = "";
  let stderr = "";

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "code-pact-context-show-"));
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });
    process.chdir(cwd);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  async function storedManifest() {
    const built = buildContextManifest([
      section("rules", "## Rules\nKeep the exact body."),
      section("reads", "## Declared Reads\n- src/a.ts"),
    ]);
    return storeContextManifestArtifact(cwd, built.artifact);
  }

  it("loads a deferred context manifest and totals original section bytes", async () => {
    const artifact = await storedManifest();

    const result = await runContextShow(cwd, artifact.ref);

    expect(result.context_ref).toBe(artifact.ref);
    expect(result.total_deferred_bytes).toBe(
      Buffer.byteLength("## Rules\nKeep the exact body.", "utf8") +
        Buffer.byteLength("## Declared Reads\n- src/a.ts", "utf8"),
    );
  });

  it("lists section metadata without leaking content in JSON", async () => {
    const artifact = await storedManifest();

    const exit = await cmdContext(["show", artifact.ref, "--list", "--json"], "en-US", false);

    expect(exit).toBe(0);
    expect(stderr).toBe("");
    const parsed = parseStdout<{
      ok: true;
      data: { sections: Array<Record<string, unknown>> };
    }>(stdout);
    expect(parsed.data.sections).toEqual([
      {
        name: "rules",
        bytes: Buffer.byteLength("## Rules\nKeep the exact body.", "utf8"),
        content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      {
        name: "reads",
        bytes: Buffer.byteLength("## Declared Reads\n- src/a.ts", "utf8"),
        content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(stdout).not.toContain("Keep the exact body.");
  });

  it("prints exactly one requested section body without adding a newline", async () => {
    const artifact = await storedManifest();

    const exit = await cmdContext(["show", artifact.ref, "--section", "rules"], "en-US", false);

    expect(exit).toBe(0);
    expect(stdout).toBe("## Rules\nKeep the exact body.");
    expect(stderr).toBe("");
  });

  it("returns configuration errors for malformed refs and unknown sections", async () => {
    const malformed = await cmdContext(
      ["show", "context:sha256:not-a-digest", "--json"],
      "en-US",
      false,
    );
    expect(malformed).toBe(2);
    expect(parseStdout<{ ok: false; error: { code: string } }>(stdout).error.code).toBe(
      "INVALID_CONTEXT_REF",
    );

    stdout = "";
    const artifact = await storedManifest();
    const missingSection = await cmdContext(
      ["show", artifact.ref, "--section", "completed_tasks", "--json"],
      "en-US",
      false,
    );
    expect(missingSection).toBe(2);
    expect(parseStdout<{ ok: false; error: { code: string } }>(stdout).error.code).toBe(
      "CONFIG_ERROR",
    );
  });

  it("reports the underlying platform code for read failures", async () => {
    const digest = sha256Utf8("not used");
    const ref = contextRefFromDigest(digest);
    await mkdir(join(cwd, ".code-pact", "cache", "context", `${digest}.json`), {
      recursive: true,
    });

    const exit = await cmdContext(["show", ref, "--json"], "en-US", false);

    expect(exit).toBe(1);
    const parsed = parseStdout<{
      ok: false;
      error: { code: string };
      data: { system_code: string };
    }>(stdout);
    expect(parsed.error.code).toBe("CONTEXT_READ_FAILED");
    expect(parsed.data.system_code).toMatch(/^E/);
    expect(parsed.data.system_code).not.toBe("CONTEXT_READ_FAILED");
  });
});
