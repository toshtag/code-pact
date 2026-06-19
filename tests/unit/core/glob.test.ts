import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findProtectedPathOverlaps,
  globToRegex,
  matchGlob,
  MAX_GLOB_LENGTH,
  PROTECTED_PATHS,
  validateGlobSyntax,
  walkAndMatch,
} from "../../../src/core/glob.ts";

describe("validateGlobSyntax", () => {
  it("accepts literal segments", () => {
    expect(validateGlobSyntax("src/commands/init.ts")).toBeNull();
  });

  it("accepts single-segment *", () => {
    expect(validateGlobSyntax("src/commands/task-*.ts")).toBeNull();
  });

  it("accepts ** as a full path segment", () => {
    expect(validateGlobSyntax("tests/**/integration.ts")).toBeNull();
  });

  it("accepts standalone **", () => {
    expect(validateGlobSyntax("**")).toBeNull();
  });

  it("rejects empty pattern", () => {
    expect(validateGlobSyntax("")).toContain("empty");
  });

  it("rejects negation", () => {
    expect(validateGlobSyntax("!src/private.ts")).toContain("negation");
  });

  it("rejects brace expansion", () => {
    expect(validateGlobSyntax("src/{a,b}/*.ts")).toContain("brace");
  });

  it("rejects extglob", () => {
    expect(validateGlobSyntax("src/@(a|b)/*.ts")).toContain("extglob");
  });

  it("rejects character classes", () => {
    expect(validateGlobSyntax("src/[abc].ts")).toContain("character classes");
  });

  it("rejects backslash escape", () => {
    expect(validateGlobSyntax("src\\foo.ts")).toContain("backslash");
  });

  it("rejects partial **  inside a segment (e.g. foo**bar)", () => {
    const reason = validateGlobSyntax("src/foo**bar/baz.ts");
    expect(reason).toContain("full path segment");
  });

  it("rejects an over-length pattern (DoS guard)", () => {
    const huge = "a/".repeat(MAX_GLOB_LENGTH) + "b.ts";
    expect(huge.length).toBeGreaterThan(MAX_GLOB_LENGTH);
    expect(validateGlobSyntax(huge)).toContain(`${MAX_GLOB_LENGTH}`);
  });

  it("accepts a pattern at exactly the length bound", () => {
    const pat = "a".repeat(MAX_GLOB_LENGTH);
    expect(pat.length).toBe(MAX_GLOB_LENGTH);
    expect(validateGlobSyntax(pat)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchGlob — the linear, backtrack-free runtime matcher (replaces
// globToRegex on the file-walk / audit / doctor hot paths). It must agree
// with globToRegex's semantics AND must not blow up on `**`-heavy patterns.
// ---------------------------------------------------------------------------

describe("matchGlob", () => {
  it("matches literal paths exactly", () => {
    expect(matchGlob("src/commands/init.ts", "src/commands/init.ts")).toBe(true);
    expect(matchGlob("src/commands/init.ts", "src/commands/init.js")).toBe(false);
  });

  it("single * does not cross /", () => {
    expect(matchGlob("src/commands/*.ts", "src/commands/init.ts")).toBe(true);
    expect(matchGlob("src/commands/*.ts", "src/commands/sub/init.ts")).toBe(false);
  });

  it("** matches zero or more segments", () => {
    expect(matchGlob("src/**/foo.ts", "src/foo.ts")).toBe(true);
    expect(matchGlob("src/**/foo.ts", "src/a/foo.ts")).toBe(true);
    expect(matchGlob("src/**/foo.ts", "src/a/b/c/foo.ts")).toBe(true);
    expect(matchGlob("src/**/foo.ts", "other/foo.ts")).toBe(false);
  });

  it("standalone ** matches everything", () => {
    expect(matchGlob("**", "foo.ts")).toBe(true);
    expect(matchGlob("**", "src/a/b/c.ts")).toBe(true);
  });

  it("treats regex metachars in segments as literals", () => {
    expect(matchGlob("src/a.b/c+d.ts", "src/a.b/c+d.ts")).toBe(true);
    expect(matchGlob("src/a.b/c+d.ts", "src/aXb/cXdXts")).toBe(false);
  });

  it("multiple * within one segment", () => {
    expect(matchGlob("src/task-*-*.ts", "src/task-add-impl.ts")).toBe(true);
    expect(matchGlob("src/task-*-*.ts", "src/task-add.ts")).toBe(false);
  });

  it("agrees with globToRegex across a sample of patterns and paths", () => {
    const patterns = [
      "src/commands/*.ts",
      "src/**/*.ts",
      "**/*.test.ts",
      "design/phases/*.yaml",
      "**",
      "a/b/c.ts",
      "src/**/test/**/*.ts",
      // Adjacent doublestar segments — these previously DIVERGED (matchGlob let
      // each match zero, globToRegex forced an intermediate segment).
      "a/**/**",
      "a/**/**/b",
      "design/**/**/roadmap.yaml",
    ];
    const paths = [
      "src/commands/a.ts",
      "src/a/b/c.ts",
      "src/x.test.ts",
      "design/phases/P1.yaml",
      "a/b/c.ts",
      "src/a/test/b/c.ts",
      "README.md",
      "a",
      "a/b",
      "a/x/b",
      "design/roadmap.yaml",
      "design/sub/roadmap.yaml",
    ];
    for (const p of patterns) {
      const re = globToRegex(p);
      for (const s of paths) {
        expect(matchGlob(p, s), `pattern="${p}" path="${s}"`).toBe(re.test(s));
      }
    }
  });

  it("treats adjacent `**` segments as one (each matches zero) — parity with globToRegex", () => {
    // Regression for the Round-5 divergence: a declared write with repeated `**`
    // matched a protected file at runtime but evaded globToRegex-based checks.
    for (const [p, s] of [
      ["a/**/**", "a"],
      ["a/**/**/b", "a/b"],
      ["design/**/**/roadmap.yaml", "design/roadmap.yaml"],
    ] as const) {
      expect(matchGlob(p, s)).toBe(true);
      expect(globToRegex(p).test(s)).toBe(true);
    }
  });

  it("handles a pathological **-heavy non-match FAST (no catastrophic backtracking)", () => {
    // The old regex matcher took ~35s for 5 doublestars over a long path; the
    // linear matcher is bounded. Use a deep path + many `**` and a final literal
    // that cannot match, so any backtracking matcher would explore exponentially.
    const pattern = Array(12).fill("**").join("/") + "/zzz.ts";
    const path = Array(200).fill("dir").join("/") + "/actual.ts";
    const start = Date.now();
    const result = matchGlob(pattern, path);
    const elapsedMs = Date.now() - start;
    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(1000); // sub-ms in practice; 1s is a huge margin
  });
});

describe("globToRegex", () => {
  it("matches a literal path", () => {
    const re = globToRegex("src/commands/init.ts");
    expect(re.test("src/commands/init.ts")).toBe(true);
    expect(re.test("src/commands/init.js")).toBe(false);
  });

  it("single * does not cross /", () => {
    const re = globToRegex("src/commands/*.ts");
    expect(re.test("src/commands/init.ts")).toBe(true);
    expect(re.test("src/commands/sub/init.ts")).toBe(false);
  });

  it("** matches zero segments", () => {
    const re = globToRegex("src/**/foo.ts");
    expect(re.test("src/foo.ts")).toBe(true);
  });

  it("** matches one or more segments", () => {
    const re = globToRegex("src/**/foo.ts");
    expect(re.test("src/a/foo.ts")).toBe(true);
    expect(re.test("src/a/b/c/foo.ts")).toBe(true);
  });

  it("standalone ** matches everything", () => {
    const re = globToRegex("**");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("src/a/b/c.ts")).toBe(true);
  });

  it("escapes regex metachars in literal segments", () => {
    const re = globToRegex("src/a.b/c+d.ts");
    expect(re.test("src/a.b/c+d.ts")).toBe(true);
    // Make sure the dot is not treated as wildcard.
    expect(re.test("src/aXb/cXdXts")).toBe(false);
  });
});

describe("findProtectedPathOverlaps", () => {
  it("flags an exact match against design/roadmap.yaml", () => {
    const overlaps = findProtectedPathOverlaps("design/roadmap.yaml");
    expect(overlaps.map((e) => e.pattern)).toContain("design/roadmap.yaml");
  });

  it("flags a glob that would match design/phases/*.yaml", () => {
    const overlaps = findProtectedPathOverlaps("design/phases/P10-foo.yaml");
    expect(overlaps.map((e) => e.pattern)).toContain("design/phases/*.yaml");
  });

  it("flags a path under the .code-pact protected tree", () => {
    const overlaps = findProtectedPathOverlaps(".code-pact/state/progress.yaml");
    expect(overlaps.map((e) => e.pattern)).toContain(".code-pact/**");
  });

  it("flags a wildcard glob that covers protected resources", () => {
    const overlaps = findProtectedPathOverlaps(".code-pact/**");
    expect(overlaps.map((e) => e.pattern)).toContain(".code-pact/**");
  });

  it("does not flag a write to an unrelated path", () => {
    const overlaps = findProtectedPathOverlaps("src/commands/foo.ts");
    expect(overlaps).toEqual([]);
  });

  it("flags a repeated-`**` glob that the runtime matcher would match (no evasion)", () => {
    // Round-5 regression: `design/**/**/roadmap.yaml` matches design/roadmap.yaml
    // via the runtime matchGlob walk, so the advisory must flag it too — it must
    // NOT slip through because the old check used the divergent globToRegex.
    expect(matchGlob("design/**/**/roadmap.yaml", "design/roadmap.yaml")).toBe(true);
    const overlaps = findProtectedPathOverlaps("design/**/**/roadmap.yaml");
    expect(overlaps.map((e) => e.pattern)).toContain("design/roadmap.yaml");
  });

  it("does not flag when the pattern syntax is invalid", () => {
    const overlaps = findProtectedPathOverlaps("src/{a,b}/*.ts");
    expect(overlaps).toEqual([]);
  });

  it("PROTECTED_PATHS samples each match their own pattern", () => {
    for (const entry of PROTECTED_PATHS) {
      const re = globToRegex(entry.pattern);
      expect(
        re.test(entry.sample),
        `sample "${entry.sample}" does not match pattern "${entry.pattern}"`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// walkAndMatch (filesystem-backed)
// ---------------------------------------------------------------------------

let cwd: string;

async function touch(p: string): Promise<void> {
  const abs = join(cwd, p);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, "", "utf8");
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-glob-walk-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("walkAndMatch", () => {
  it("returns matching files for a simple glob", async () => {
    await touch("src/commands/a.ts");
    await touch("src/commands/b.ts");
    await touch("src/commands/sub/c.ts");
    const matched = await walkAndMatch(cwd, "src/commands/*.ts");
    expect(matched.sort()).toEqual(["src/commands/a.ts", "src/commands/b.ts"]);
  });

  it("** matches across directory depths", async () => {
    await touch("src/a.ts");
    await touch("src/sub/b.ts");
    await touch("src/sub/deeper/c.ts");
    const matched = await walkAndMatch(cwd, "src/**/*.ts");
    expect(matched.sort()).toEqual([
      "src/a.ts",
      "src/sub/b.ts",
      "src/sub/deeper/c.ts",
    ]);
  });

  it("skips ignored directories (node_modules / .git)", async () => {
    await touch("src/a.ts");
    await touch("node_modules/pkg/b.ts");
    await touch(".git/refs/heads/main.ts");
    const matched = await walkAndMatch(cwd, "**/*.ts");
    expect(matched).toEqual(["src/a.ts"]);
  });

  it("returns [] when nothing matches", async () => {
    await touch("src/a.ts");
    const matched = await walkAndMatch(cwd, "tests/**/*.ts");
    expect(matched).toEqual([]);
  });
});
