import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findProtectedPathOverlaps,
  globToRegex,
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
