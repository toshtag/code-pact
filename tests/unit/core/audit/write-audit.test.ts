import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditWrites } from "../../../../src/core/audit/index.ts";

// ---------------------------------------------------------------------------
// Real-git tmpdir fixtures. Matches the existing pattern from
// tests/unit/core/glob.test.ts (filesystem-backed, no spawn mocking).
// ---------------------------------------------------------------------------

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`));
    });
    proc.on("error", reject);
  });
}

async function touch(cwd: string, p: string, content = ""): Promise<void> {
  const abs = join(cwd, p);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-audit-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Non-git fallback
// ---------------------------------------------------------------------------

describe("auditWrites — non-git", () => {
  it("returns the canonical unavailable shape outside a git repo", async () => {
    const result = await auditWrites({
      cwd,
      declaredWrites: ["src/**"],
    });
    expect(result).toEqual({
      git_available: false,
      reason: "not_a_git_repo",
      base_kind: "unavailable",
      base_ref: null,
      files_touched: [],
      outside_declared: [],
      declared_unused: [],
      warnings: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Working-tree mode (default — no baseRef)
// ---------------------------------------------------------------------------

describe("auditWrites — working-tree mode", () => {
  beforeEach(async () => {
    await git(cwd, ["init", "--quiet", "--initial-branch=main"]);
    await touch(cwd, "README.md", "initial\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "--quiet", "-m", "initial"]);
  });

  it("classifies an exact-match declared write as inside the boundary", async () => {
    await touch(cwd, "src/core/audit/write-audit.ts", "// new\n");
    const result = await auditWrites({
      cwd,
      declaredWrites: ["src/core/audit/**"],
    });
    expect(result.git_available).toBe(true);
    expect(result.base_kind).toBe("working-tree");
    expect(result.base_ref).toBeNull();
    expect(result.files_touched).toContain("src/core/audit/write-audit.ts");
    expect(result.outside_declared).toEqual([]);
    expect(result.declared_unused).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("classifies a glob-match declared write as inside the boundary", async () => {
    await touch(cwd, "src/core/audit/deep/nested.ts", "// new\n");
    const result = await auditWrites({
      cwd,
      declaredWrites: ["src/**/*.ts"],
    });
    expect(result.outside_declared).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("flags a file outside any declared glob as outside_declared", async () => {
    await touch(cwd, "src/core/audit/write-audit.ts", "// new\n");
    await touch(cwd, "src/commands/task-finalize.ts", "// new\n");
    const result = await auditWrites({
      cwd,
      declaredWrites: ["src/core/audit/**"],
    });
    expect(result.outside_declared).toEqual(["src/commands/task-finalize.ts"]);
    expect(result.warnings).toEqual(["TASK_WRITES_AUDIT_OUTSIDE_DECLARED"]);
  });

  it("v1.6 P15-T4: populates declared_unused AND raises TASK_WRITES_AUDIT_DECLARED_UNUSED warning when a declared glob matches no files", async () => {
    await touch(cwd, "src/core/audit/write-audit.ts", "// new\n");
    const result = await auditWrites({
      cwd,
      declaredWrites: ["src/core/audit/**", "docs/cli-contract.md"],
    });
    expect(result.declared_unused).toEqual(["docs/cli-contract.md"]);
    expect(result.warnings).toEqual(["TASK_WRITES_AUDIT_DECLARED_UNUSED"]);
  });

  it("v1.6 P15-T4: both OUTSIDE_DECLARED and DECLARED_UNUSED warnings fire independently when both conditions hit", async () => {
    // declared_writes covers `src/core/audit/**` (no files touched there)
    // AND the diff touches `src/commands/...` (outside the declared list)
    await touch(cwd, "src/commands/task-finalize.ts", "// new\n");
    const result = await auditWrites({
      cwd,
      declaredWrites: ["src/core/audit/**"],
    });
    expect(result.outside_declared).toEqual([
      "src/commands/task-finalize.ts",
    ]);
    expect(result.declared_unused).toEqual(["src/core/audit/**"]);
    expect(result.warnings).toEqual([
      "TASK_WRITES_AUDIT_OUTSIDE_DECLARED",
      "TASK_WRITES_AUDIT_DECLARED_UNUSED",
    ]);
  });

  it("treats empty declared_writes as 'everything is outside'", async () => {
    await touch(cwd, "src/core/audit/write-audit.ts", "// new\n");
    const result = await auditWrites({
      cwd,
      declaredWrites: [],
    });
    expect(result.outside_declared).toEqual([
      "src/core/audit/write-audit.ts",
    ]);
    expect(result.warnings).toEqual(["TASK_WRITES_AUDIT_OUTSIDE_DECLARED"]);
  });

  it("includes untracked files in files_touched", async () => {
    // Untracked, never staged — this is the common case for a brand-new
    // file produced by P15-T1 itself.
    await touch(cwd, "src/core/audit/write-audit.ts", "// new\n");
    const result = await auditWrites({
      cwd,
      declaredWrites: ["src/core/audit/**"],
    });
    expect(result.files_touched).toEqual([
      "src/core/audit/write-audit.ts",
    ]);
  });

  it("includes staged changes in files_touched", async () => {
    await touch(cwd, "src/core/audit/write-audit.ts", "// new\n");
    await git(cwd, ["add", "src/core/audit/write-audit.ts"]);
    const result = await auditWrites({
      cwd,
      declaredWrites: ["src/core/audit/**"],
    });
    expect(result.files_touched).toEqual([
      "src/core/audit/write-audit.ts",
    ]);
  });

  it("includes unstaged modifications to tracked files in files_touched", async () => {
    await touch(cwd, "src/lib.ts", "old\n");
    await git(cwd, ["add", "src/lib.ts"]);
    await git(cwd, ["commit", "--quiet", "-m", "lib"]);
    await touch(cwd, "src/lib.ts", "new\n");
    const result = await auditWrites({
      cwd,
      declaredWrites: ["src/**"],
    });
    expect(result.files_touched).toEqual(["src/lib.ts"]);
  });

  it("ignores syntactically invalid globs without raising an error", async () => {
    await touch(cwd, "src/core/audit/write-audit.ts", "// new\n");
    const result = await auditWrites({
      cwd,
      // `{a,b}` is outside the P10 supported subset → silently dropped.
      declaredWrites: ["src/{a,b}/*.ts", "src/core/audit/**"],
    });
    expect(result.outside_declared).toEqual([]);
    // declared_unused only reports VALID globs that didn't match; invalid
    // globs are not reported because they cannot match anything.
    expect(result.declared_unused).toEqual([]);
  });

  it("returns sorted, deduplicated files_touched", async () => {
    await touch(cwd, "b.ts", "x\n");
    await touch(cwd, "a.ts", "x\n");
    const result = await auditWrites({
      cwd,
      declaredWrites: ["**"],
    });
    expect(result.files_touched).toEqual(["a.ts", "b.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Merge-base mode (--base-ref)
// ---------------------------------------------------------------------------

describe("auditWrites — --base-ref mode", () => {
  it("includes committed branch changes when base-ref resolves", async () => {
    await git(cwd, ["init", "--quiet", "--initial-branch=main"]);
    await touch(cwd, "README.md", "initial\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "--quiet", "-m", "initial"]);
    await git(cwd, ["checkout", "--quiet", "-b", "feat/x"]);
    await touch(cwd, "src/lib.ts", "branch-only\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "--quiet", "-m", "branch work"]);

    const result = await auditWrites({
      cwd,
      declaredWrites: ["src/**"],
      baseRef: "main",
    });
    expect(result.base_kind).toBe("merge-base");
    expect(result.base_ref).toBe("main");
    expect(result.base_error).toBeUndefined();
    expect(result.files_touched).toEqual(["src/lib.ts"]);
    expect(result.outside_declared).toEqual([]);
  });

  it("gracefully falls back to working-tree mode when ref is unknown", async () => {
    await git(cwd, ["init", "--quiet", "--initial-branch=main"]);
    await touch(cwd, "README.md", "initial\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "--quiet", "-m", "initial"]);
    await touch(cwd, "src/core/audit/write-audit.ts", "// new\n");

    const result = await auditWrites({
      cwd,
      declaredWrites: ["src/core/audit/**"],
      baseRef: "origin/does-not-exist",
    });
    expect(result.base_kind).toBe("working-tree");
    expect(result.base_ref).toBeNull();
    expect(result.base_error).toEqual({
      code: "REF_NOT_FOUND",
      message: expect.stringContaining("origin/does-not-exist"),
      requested_ref: "origin/does-not-exist",
    });
    // Working-tree audit still runs.
    expect(result.files_touched).toEqual([
      "src/core/audit/write-audit.ts",
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("does NOT mutate exit-relevant signals on base-ref failure (advisory only)", async () => {
    await git(cwd, ["init", "--quiet", "--initial-branch=main"]);
    await touch(cwd, "README.md", "initial\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "--quiet", "-m", "initial"]);

    // No throw, full result object returned even on failure.
    const result = await auditWrites({
      cwd,
      declaredWrites: ["src/**"],
      baseRef: "origin/main",
    });
    expect(result.git_available).toBe(true);
    expect(result.base_error?.requested_ref).toBe("origin/main");
  });
});
