import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
  symlink,
  readdir,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ADAPTER_MANIFEST_DIR_SEGMENTS,
  computeContentHash,
  manifestPath,
  readManifest,
  writeManifest,
} from "../../../src/core/adapters/manifest.ts";
import type { AdapterManifest } from "../../../src/core/schemas/adapter-manifest.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-adapter-manifest-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function manifestFixture(
  overrides: Partial<AdapterManifest> = {},
): AdapterManifest {
  return {
    schema_version: 1,
    agent_name: "claude-code",
    generator_version: "0.9.0-alpha.0",
    adapter_schema_version: 1,
    generated_at: "2026-05-19T12:00:00+00:00",
    profile_fingerprint: {
      instruction_filename: "CLAUDE.md",
      context_dir: ".context/claude-code",
      skill_dir: ".claude/skills",
      hook_dir: ".claude/hooks",
    },
    files: [
      {
        path: "CLAUDE.md",
        sha256: "a".repeat(64),
        managed: true,
        role: "instruction",
      },
    ],
    ...overrides,
  };
}

describe("manifestPath", () => {
  it("resolves to .code-pact/adapters/<agent>.manifest.yaml", () => {
    expect(manifestPath(dir, "claude-code")).toBe(
      join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS, "claude-code.manifest.yaml"),
    );
  });

  it("scopes per agent — different agent names produce different paths", () => {
    expect(manifestPath(dir, "codex")).not.toBe(
      manifestPath(dir, "claude-code"),
    );
  });
});

describe("readManifest", () => {
  it("returns null when the manifest file does not exist", async () => {
    expect(await readManifest(dir, "claude-code")).toBeNull();
  });

  it("returns null when the agent's manifest is missing but another agent's exists", async () => {
    await writeManifest(dir, "codex", manifestFixture({ agent_name: "codex" }));
    expect(await readManifest(dir, "claude-code")).toBeNull();
  });

  it("throws on malformed YAML", async () => {
    const path = manifestPath(dir, "claude-code");
    await mkdir(join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS), {
      recursive: true,
    });
    await writeFile(path, "schema_version: 1\n  files: [oops:\n", "utf8");
    await expect(readManifest(dir, "claude-code")).rejects.toThrow();
  });

  it("throws on YAML that fails schema validation", async () => {
    const path = manifestPath(dir, "claude-code");
    await mkdir(join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS), {
      recursive: true,
    });
    await writeFile(
      path,
      "schema_version: 99\nagent_name: claude-code\n",
      "utf8",
    );
    await expect(readManifest(dir, "claude-code")).rejects.toThrow();
  });

  it("throws when the YAML has an absolute path in files[]", async () => {
    const path = manifestPath(dir, "claude-code");
    await mkdir(join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS), {
      recursive: true,
    });
    const yaml = [
      "schema_version: 1",
      "agent_name: claude-code",
      "generator_version: 0.9.0-alpha.0",
      "adapter_schema_version: 1",
      "generated_at: 2026-05-19T12:00:00+00:00",
      "profile_fingerprint:",
      "  instruction_filename: CLAUDE.md",
      "  context_dir: .context/claude-code",
      "files:",
      "  - path: /etc/passwd",
      `    sha256: ${"a".repeat(64)}`,
      "    managed: true",
      "    role: instruction",
      "",
    ].join("\n");
    await writeFile(path, yaml, "utf8");
    await expect(readManifest(dir, "claude-code")).rejects.toThrow();
  });

  it("throws when the YAML has a `..` path in files[]", async () => {
    const path = manifestPath(dir, "claude-code");
    await mkdir(join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS), {
      recursive: true,
    });
    const yaml = [
      "schema_version: 1",
      "agent_name: claude-code",
      "generator_version: 0.9.0-alpha.0",
      "adapter_schema_version: 1",
      "generated_at: 2026-05-19T12:00:00+00:00",
      "profile_fingerprint:",
      "  instruction_filename: CLAUDE.md",
      "  context_dir: .context/claude-code",
      "files:",
      "  - path: ../etc/passwd",
      `    sha256: ${"a".repeat(64)}`,
      "    managed: true",
      "    role: instruction",
      "",
    ].join("\n");
    await writeFile(path, yaml, "utf8");
    await expect(readManifest(dir, "claude-code")).rejects.toThrow();
  });
});

describe("writeManifest", () => {
  it("creates the .code-pact/adapters/ directory on first write", async () => {
    const m = manifestFixture();
    const path = await writeManifest(dir, "claude-code", m);
    expect(path).toBe(manifestPath(dir, "claude-code"));
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("agent_name: claude-code");
  });

  it("round-trips through readManifest with deep-equal content", async () => {
    const m = manifestFixture();
    await writeManifest(dir, "claude-code", m);
    const read = await readManifest(dir, "claude-code");
    expect(read).toEqual(m);
  });

  it("round-trips a manifest with empty files[]", async () => {
    const m = manifestFixture({ files: [] });
    await writeManifest(dir, "claude-code", m);
    const read = await readManifest(dir, "claude-code");
    expect(read?.files).toEqual([]);
  });

  it("round-trips a manifest with multiple file entries", async () => {
    const m = manifestFixture({
      files: [
        {
          path: "CLAUDE.md",
          sha256: "a".repeat(64),
          managed: true,
          role: "instruction",
        },
        {
          path: ".claude/skills/context.md",
          sha256: "b".repeat(64),
          managed: true,
          role: "skill",
        },
        {
          path: ".claude/skills/verify.md",
          sha256: "c".repeat(64),
          managed: true,
          role: "skill",
        },
      ],
    });
    await writeManifest(dir, "claude-code", m);
    const read = await readManifest(dir, "claude-code");
    expect(read?.files).toHaveLength(3);
    expect(read).toEqual(m);
  });

  it("refuses to write a manifest that would fail schema validation", async () => {
    const bad = {
      ...manifestFixture(),
      schema_version: 99,
    } as unknown as AdapterManifest;
    await expect(writeManifest(dir, "claude-code", bad)).rejects.toThrow();
  });

  it("refuses to write a manifest with an absolute path in files[]", async () => {
    const bad = {
      ...manifestFixture(),
      files: [
        {
          path: "/etc/passwd",
          sha256: "a".repeat(64),
          managed: true,
          role: "instruction" as const,
        },
      ],
    } as unknown as AdapterManifest;
    await expect(writeManifest(dir, "claude-code", bad)).rejects.toThrow();
  });

  it("overwrites an existing manifest atomically", async () => {
    await writeManifest(dir, "claude-code", manifestFixture());
    const next = manifestFixture({ generator_version: "0.9.1-alpha.0" });
    await writeManifest(dir, "claude-code", next);
    const read = await readManifest(dir, "claude-code");
    expect(read?.generator_version).toBe("0.9.1-alpha.0");
  });

  it("readManifest throws ADAPTER_MANIFEST_INVALID when agent_name doesn't match", async () => {
    const path = manifestPath(dir, "claude-code");
    await mkdir(join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS), {
      recursive: true,
    });
    const yaml = [
      "schema_version: 1",
      "agent_name: codex",
      "generator_version: 0.9.0-alpha.0",
      "adapter_schema_version: 1",
      "generated_at: 2026-05-19T12:00:00+00:00",
      "profile_fingerprint:",
      "  instruction_filename: CLAUDE.md",
      "  context_dir: .context/claude-code",
      "files:",
      "  - path: CLAUDE.md",
      `    sha256: ${"a".repeat(64)}`,
      "    managed: true",
      "    role: instruction",
      "",
    ].join("\n");
    await writeFile(path, yaml, "utf8");
    await expect(readManifest(dir, "claude-code")).rejects.toMatchObject({
      code: "ADAPTER_MANIFEST_INVALID",
    });
  });

  it("writeManifest throws ADAPTER_MANIFEST_INVALID when agent_name doesn't match", async () => {
    const bad = manifestFixture({ agent_name: "codex" });
    await expect(writeManifest(dir, "claude-code", bad)).rejects.toMatchObject({
      code: "ADAPTER_MANIFEST_INVALID",
    });
  });
});

// ---------------------------------------------------------------------------
// SECURITY: manifest I/O must fail closed if `.code-pact/adapters` is a symlink
// that escapes the project root (CWE-59). A malicious repo could otherwise make
// writeManifest write outside cwd, or readManifest read a foreign manifest.
// ---------------------------------------------------------------------------

describe("manifest symlink containment", () => {
  let outside: string;

  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), "code-pact-adapter-outside-"));
  });
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  async function linkAdaptersOutside(): Promise<void> {
    await mkdir(join(dir, ".code-pact"), { recursive: true });
    // .code-pact/adapters -> <outside dir>
    await symlink(outside, join(dir, ".code-pact", "adapters"));
  }

  it("writeManifest refuses to write through an escaping .code-pact/adapters symlink", async () => {
    await linkAdaptersOutside();
    await expect(
      writeManifest(dir, "claude-code", manifestFixture()),
    ).rejects.toThrow();
    // Nothing landed in the outside directory.
    expect(existsSync(join(outside, "claude-code.manifest.yaml"))).toBe(false);
    expect(await readdir(outside)).toEqual([]);
  });

  it("readManifest does not read a manifest from an escaping symlink target", async () => {
    await linkAdaptersOutside();
    // Plant a valid manifest at the symlink target (outside the project).
    await writeFile(
      join(outside, "claude-code.manifest.yaml"),
      [
        "schema_version: 1",
        "agent_name: claude-code",
        "generator_version: 0.9.0-alpha.0",
        "adapter_schema_version: 1",
        "generated_at: 2026-05-19T12:00:00+00:00",
        "profile_fingerprint:",
        "  instruction_filename: CLAUDE.md",
        "  context_dir: .context/claude-code",
        "files: []",
        "",
      ].join("\n"),
      "utf8",
    );
    // Fail closed: the escape must throw, NOT return the foreign manifest as if
    // it were the project's own (and NOT be swallowed as a missing-manifest null).
    await expect(readManifest(dir, "claude-code")).rejects.toThrow();
  });
});

describe("computeContentHash", () => {
  it("returns 64 lowercase hex characters", () => {
    const h = computeContentHash("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the known sha256 of 'hello' (LF-normalized UTF-8)", () => {
    // echo -n "hello" | sha256sum
    expect(computeContentHash("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("normalizes CRLF to LF before hashing", () => {
    const lf = computeContentHash("a\nb\nc\n");
    const crlf = computeContentHash("a\r\nb\r\nc\r\n");
    expect(lf).toBe(crlf);
  });

  it("does not touch bare CR (legacy Mac-style) — only CRLF→LF", () => {
    // We intentionally keep this narrow: bare CR is exceedingly rare and
    // would mask real edits if we collapsed it. So "a\rb" differs from "a\nb".
    expect(computeContentHash("a\rb")).not.toBe(computeContentHash("a\nb"));
  });

  it("differs for differing content", () => {
    expect(computeContentHash("hello")).not.toBe(computeContentHash("hello!"));
  });

  it("handles empty content", () => {
    // sha256 of empty string
    expect(computeContentHash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("handles unicode content as UTF-8", () => {
    // sha256 of UTF-8 bytes of "日本語"
    expect(computeContentHash("日本語")).toBe(
      "77710aedc74ecfa33685e33a6c7df5cc83004da1bdcef7fb280f5c2b2e97e0a5",
    );
  });
});
