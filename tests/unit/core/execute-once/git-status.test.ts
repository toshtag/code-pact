import { describe, expect, it } from "vitest";
import {
  parsePorcelainV1Z,
  getExecutionGitSnapshot,
  snapshotIsClean,
  changedPaths,
  isOnlyWorktreeModifyOf,
  snapshotIndexChanged,
} from "../../../../src/core/execute-once/git-status.ts";

function buf(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

describe("parsePorcelainV1Z", () => {
  it("returns an empty result for no output", () => {
    const result = parsePorcelainV1Z(Buffer.alloc(0));
    expect(result).toEqual({ ok: true, entries: [] });
  });

  it("parses a single worktree modification", () => {
    const result = parsePorcelainV1Z(buf(" M src/example.ts\0"));
    expect(result).toEqual({
      ok: true,
      entries: [{ index: " ", worktree: "M", path: "src/example.ts" }],
    });
  });

  it("parses untracked files with ??", () => {
    const result = parsePorcelainV1Z(buf("?? src/extra.ts\0?? README.md\0"));
    expect(result).toEqual({
      ok: true,
      entries: [
        { index: "?", worktree: "?", path: "README.md" },
        { index: "?", worktree: "?", path: "src/extra.ts" },
      ],
    });
  });

  it("sorts entries deterministically by path", () => {
    const result = parsePorcelainV1Z(buf(" M z/a.ts\0 M a/b.ts\0 M m/c.ts\0"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.map(e => e.path)).toEqual([
        "a/b.ts",
        "m/c.ts",
        "z/a.ts",
      ]);
    }
  });

  it("preserves paths with leading or trailing spaces", () => {
    const result = parsePorcelainV1Z(
      buf(" M  leading-space.ts\0??  trailing-space \0"),
    );
    expect(result).toEqual({
      ok: true,
      entries: [
        { index: " ", worktree: "M", path: " leading-space.ts" },
        { index: "?", worktree: "?", path: " trailing-space " },
      ],
    });
  });

  it("preserves hidden-directory paths", () => {
    const result = parsePorcelainV1Z(buf(" M .agents/executor.mjs\0"));
    expect(result).toEqual({
      ok: true,
      entries: [{ index: " ", worktree: "M", path: ".agents/executor.mjs" }],
    });
  });

  it("rejects a missing space separator after XY", () => {
    const result = parsePorcelainV1Z(buf("Msrc/example.ts\0"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("prefix");
    }
  });

  it("rejects a record missing its NUL terminator", () => {
    const result = parsePorcelainV1Z(buf(" M src/example.ts"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("NUL");
    }
  });

  it("rejects a truncated record", () => {
    const result = parsePorcelainV1Z(buf(" M"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/truncated|missing path/);
    }
  });

  it("rejects an invalid status byte", () => {
    const result = parsePorcelainV1Z(buf("\x01 M src/example.ts\0"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("invalid status byte");
    }
  });

  it("rejects a path containing a newline", () => {
    const result = parsePorcelainV1Z(buf(" M src/ex\nam.ts\0"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([
        { index: " ", worktree: "M", path: "src/ex\nam.ts" },
      ]);
    }
  });
});

describe("getExecutionGitSnapshot", () => {
  it("reports a clean snapshot in a fresh repo", async () => {
    const cwd = await import("node:fs/promises").then(fs =>
      fs.mkdtemp("/tmp/cp-git-status-"),
    );
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd, stdio: "ignore" });
    execSync("git config user.email test@example.com", {
      cwd,
      stdio: "ignore",
    });
    execSync("git config user.name Test", { cwd, stdio: "ignore" });

    const snapshot = await getExecutionGitSnapshot(cwd);
    expect(snapshot.kind).toBe("ok");
    if (snapshot.kind === "ok") {
      expect(snapshot.head).toBeNull();
      expect(snapshotIsClean(snapshot)).toBe(true);
    }

    await import("node:fs/promises").then(fs =>
      fs.rm(cwd, { recursive: true, force: true }),
    );
  });

  it("captures HEAD and worktree modification after a commit", async () => {
    const fs = await import("node:fs/promises");
    const cwd = await fs.mkdtemp("/tmp/cp-git-status-");
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd, stdio: "ignore" });
    execSync("git config user.email test@example.com", {
      cwd,
      stdio: "ignore",
    });
    execSync("git config user.name Test", { cwd, stdio: "ignore" });
    await fs.writeFile(`${cwd}/hello.txt`, "hello", "utf8");
    execSync("git add .", { cwd, stdio: "ignore" });
    execSync("git commit -m init", { cwd, stdio: "ignore" });

    await fs.writeFile(`${cwd}/hello.txt`, "world", "utf8");
    const snapshot = await getExecutionGitSnapshot(cwd);
    expect(snapshot.kind).toBe("ok");
    if (snapshot.kind === "ok") {
      expect(snapshot.head).not.toBeNull();
      expect(changedPaths(snapshot)).toEqual(["hello.txt"]);
      expect(snapshotIndexChanged(snapshot)).toBe(false);
      expect(isOnlyWorktreeModifyOf(snapshot, "hello.txt")).toBe(true);
    }

    await fs.rm(cwd, { recursive: true, force: true });
  });
});
