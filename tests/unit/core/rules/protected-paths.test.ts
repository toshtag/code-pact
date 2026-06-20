import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProtectedPaths } from "../../../../src/core/rules/protected-paths.ts";
import { PROTECTED_PATHS } from "../../../../src/core/glob.ts";

// ---------------------------------------------------------------------------
// loadProtectedPaths — v1.6 P15-T3 fixtures
//
// Real filesystem fixtures (consistent with the project's tmpdir-based
// unit test style — see tests/unit/core/audit/write-audit.test.ts and
// tests/unit/core/glob.test.ts).
// ---------------------------------------------------------------------------

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-protected-paths-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function writeRule(content: string): Promise<void> {
  const dir = join(cwd, "design", "rules");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "protected-paths.md"), content, "utf8");
}

describe("loadProtectedPaths — fallback", () => {
  it("returns the hardcoded PROTECTED_PATHS when the rule file is absent", async () => {
    const result = await loadProtectedPaths(cwd);
    expect(result.source).toBe("fallback");
    expect(result.paths).toBe(PROTECTED_PATHS);
  });

  it("treats an unreadable file the same as an absent one (no throw)", async () => {
    // Write a directory in place of the file — the read attempt fails
    // with EISDIR, which loader silently swallows.
    await mkdir(join(cwd, "design", "rules", "protected-paths.md"), {
      recursive: true,
    });
    const result = await loadProtectedPaths(cwd);
    expect(result.source).toBe("fallback");
    expect(result.paths).toBe(PROTECTED_PATHS);
  });

  it("falls back instead of reading a symlinked-outside rule file", async () => {
    const outside = await mkdtemp(join(tmpdir(), "code-pact-protected-paths-outside-"));
    try {
      await writeFile(
        join(outside, "protected-paths.md"),
        "OUTSIDE_SECRET_PROTECTED_PATTERN/**\n",
        "utf8",
      );
      await mkdir(join(cwd, "design", "rules"), { recursive: true });
      await symlink(
        join(outside, "protected-paths.md"),
        join(cwd, "design", "rules", "protected-paths.md"),
      );

      const result = await loadProtectedPaths(cwd);

      expect(result.source).toBe("fallback");
      expect(result.paths).toBe(PROTECTED_PATHS);
      expect(result.paths.map((p) => p.pattern)).not.toContain(
        "OUTSIDE_SECRET_PROTECTED_PATTERN/**",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("loadProtectedPaths — rule-file parsing", () => {
  it("parses one glob per line", async () => {
    await writeRule(["src/private/**", "secrets/**"].join("\n"));
    const result = await loadProtectedPaths(cwd);
    expect(result.source).toBe("rule-file");
    expect(result.paths.map((p) => p.pattern)).toEqual([
      "src/private/**",
      "secrets/**",
    ]);
  });

  it("ignores blank lines and # comments", async () => {
    await writeRule(
      [
        "# This is the project's protected-paths rule file.",
        "",
        "# Section: secrets",
        "secrets/**",
        "",
        "# Section: vendored",
        "vendor/**",
        "",
      ].join("\n"),
    );
    const result = await loadProtectedPaths(cwd);
    expect(result.paths.map((p) => p.pattern)).toEqual([
      "secrets/**",
      "vendor/**",
    ]);
  });

  it("strips end-of-line comments", async () => {
    await writeRule("secrets/**  # all secrets\n");
    const result = await loadProtectedPaths(cwd);
    expect(result.paths.map((p) => p.pattern)).toEqual(["secrets/**"]);
  });

  it("attaches a synthesized sample to each entry (needed by findProtectedPathOverlaps)", async () => {
    await writeRule("secrets/**\n");
    const result = await loadProtectedPaths(cwd);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.sample.startsWith("secrets/")).toBe(true);
    // Sample is concrete (no wildcards) so the regex test in
    // findProtectedPathOverlaps can succeed.
    expect(result.paths[0]?.sample).not.toContain("*");
  });

  it("treats an empty file (or comment-only) as 'no protected paths' — NOT fallback", async () => {
    // Explicit empty file = explicit opt-out. The user authored it;
    // we respect their intent. If they want defaults, they delete
    // the file.
    await writeRule("# only comments\n\n");
    const result = await loadProtectedPaths(cwd);
    expect(result.source).toBe("rule-file");
    expect(result.paths).toEqual([]);
  });

  it("treats a totally empty file as 'no protected paths' — NOT fallback", async () => {
    await writeRule("");
    const result = await loadProtectedPaths(cwd);
    expect(result.source).toBe("rule-file");
    expect(result.paths).toEqual([]);
  });
});

describe("loadProtectedPaths — malformed entry handling", () => {
  it("silently skips an unsafe path (absolute)", async () => {
    await writeRule(["/etc/passwd", "secrets/**"].join("\n"));
    const result = await loadProtectedPaths(cwd);
    expect(result.paths.map((p) => p.pattern)).toEqual(["secrets/**"]);
  });

  it("silently skips a path containing ..", async () => {
    await writeRule(["../outside/**", "secrets/**"].join("\n"));
    const result = await loadProtectedPaths(cwd);
    expect(result.paths.map((p) => p.pattern)).toEqual(["secrets/**"]);
  });

  it("silently skips a glob outside the P10 supported subset", async () => {
    // Brace expansion is not supported.
    await writeRule(["src/{a,b}/*.ts", "secrets/**"].join("\n"));
    const result = await loadProtectedPaths(cwd);
    expect(result.paths.map((p) => p.pattern)).toEqual(["secrets/**"]);
  });

  it("does not fall back to defaults even when every line is malformed", async () => {
    // A file authored entirely with broken entries is treated the same
    // as an explicit empty file. The user opted in by creating the
    // file; we don't silently revert their intent on parse failure.
    await writeRule(["/etc/passwd", "src/{a,b}/*"].join("\n"));
    const result = await loadProtectedPaths(cwd);
    expect(result.source).toBe("rule-file");
    expect(result.paths).toEqual([]);
  });
});

describe("loadProtectedPaths — fallback parity", () => {
  it("fallback list is the same object reference as PROTECTED_PATHS (callers can rely on identity)", async () => {
    // Callers (and downstream tests) sometimes assert "we're using the
    // defaults" via reference equality. This locks that contract.
    const a = await loadProtectedPaths(cwd);
    const b = await loadProtectedPaths(cwd);
    expect(a.paths).toBe(PROTECTED_PATHS);
    expect(b.paths).toBe(PROTECTED_PATHS);
    expect(a.paths).toBe(b.paths);
  });

  it("rule-file override list is structurally compatible with PROTECTED_PATHS shape", async () => {
    await writeRule("secrets/**\n");
    const result = await loadProtectedPaths(cwd);
    for (const entry of result.paths) {
      expect(typeof entry.pattern).toBe("string");
      expect(typeof entry.sample).toBe("string");
      expect(entry.pattern.length).toBeGreaterThan(0);
      expect(entry.sample.length).toBeGreaterThan(0);
    }
  });
});
