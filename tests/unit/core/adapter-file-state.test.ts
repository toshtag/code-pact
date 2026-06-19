import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertSafeRelativePath,
  classifyFileState,
  decideAction,
  resolveWithinProject,
  type ActionDecisionInput,
  type AdapterMode,
} from "../../../src/core/adapters/file-state.ts";

// ---------------------------------------------------------------------------
// assertSafeRelativePath
// ---------------------------------------------------------------------------

describe("assertSafeRelativePath", () => {
  it("accepts a simple filename", () => {
    expect(() => assertSafeRelativePath("CLAUDE.md")).not.toThrow();
  });

  it("accepts a nested POSIX path", () => {
    expect(() => assertSafeRelativePath(".claude/skills/context.md")).not.toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() => assertSafeRelativePath("/etc/passwd")).toThrow();
  });

  it("rejects a `..` segment", () => {
    expect(() => assertSafeRelativePath("../etc/passwd")).toThrow();
  });

  it("rejects an embedded `..` segment", () => {
    expect(() => assertSafeRelativePath("foo/../bar")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => assertSafeRelativePath("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveWithinProject
// ---------------------------------------------------------------------------

describe("resolveWithinProject", () => {
  let dir: string;
  let outside: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "code-pact-resolve-")));
    outside = await realpath(await mkdtemp(join(tmpdir(), "code-pact-outside-")));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("resolves a simple relative path within the project", async () => {
    const got = await resolveWithinProject(dir, "CLAUDE.md");
    expect(got).toBe(join(dir, "CLAUDE.md"));
  });

  it("resolves a nested path that does not yet exist", async () => {
    const got = await resolveWithinProject(dir, ".claude/skills/context.md");
    expect(got).toBe(join(dir, ".claude/skills/context.md"));
  });

  it("resolves an existing nested path", async () => {
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "file.md"), "hello", "utf8");
    const got = await resolveWithinProject(dir, "sub/file.md");
    expect(got).toBe(join(dir, "sub/file.md"));
  });

  it("rejects an absolute relPath via assertSafeRelativePath", async () => {
    await expect(resolveWithinProject(dir, "/etc/passwd")).rejects.toThrow();
  });

  it("rejects a `..` relPath via assertSafeRelativePath", async () => {
    await expect(resolveWithinProject(dir, "../outside")).rejects.toThrow();
  });

  it("rejects when a parent directory is a symlink escaping the project", async () => {
    // Create a symlink `escape` inside the project that points outside,
    // then try to resolve a file under that symlink.
    await symlink(outside, join(dir, "escape"), "dir");
    await expect(
      resolveWithinProject(dir, "escape/loot.txt"),
    ).rejects.toThrow(/outside project root/);
  });

  it("rejects when the target itself is a symlink to outside", async () => {
    await writeFile(join(outside, "loot.txt"), "secret", "utf8");
    await symlink(join(outside, "loot.txt"), join(dir, "leak.txt"), "file");
    await expect(
      resolveWithinProject(dir, "leak.txt"),
    ).rejects.toThrow(/outside project root/);
  });

  it("accepts a symlink that stays inside the project", async () => {
    await mkdir(join(dir, "real"), { recursive: true });
    await writeFile(join(dir, "real", "file.md"), "ok", "utf8");
    await symlink(join(dir, "real"), join(dir, "linked"), "dir");
    const got = await resolveWithinProject(dir, "linked/file.md");
    expect(got).toBe(join(dir, "linked/file.md"));
  });

  // SECURITY (CWE-59): realpath() reports a DANGLING symlink as a bare ENOENT,
  // indistinguishable from a not-yet-created path. A walk that trusts realpath
  // would mistake `.ctx -> /outside/does-not-exist` for a safe missing path and
  // let a later mkdir/write escape. resolveWithinProject must follow the link to
  // where it POINTS (lstat/readlink), target existence irrelevant.
  it("rejects an ANCESTOR dangling symlink pointing outside the project", async () => {
    // `.ctx` points at a path under `outside` that does NOT exist.
    await symlink(join(outside, "does-not-exist"), join(dir, ".ctx"), "dir");
    await expect(
      resolveWithinProject(dir, ".ctx/claude-code"),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_PROJECT" });
  });

  it("rejects a FINAL dangling symlink pointing outside the project", async () => {
    await symlink(join(outside, "missing.md"), join(dir, "leak.md"), "file");
    await expect(
      resolveWithinProject(dir, "leak.md"),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_PROJECT" });
  });

  it("tags a dangling-outside escape with the PATH_OUTSIDE_PROJECT code", async () => {
    await symlink(join(outside, "does-not-exist"), join(dir, ".ctx"), "dir");
    await expect(
      resolveWithinProject(dir, ".ctx/x"),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_PROJECT" });
  });

  it("rejects an in-project DANGLING symlink (write-safe preflight refuses broken links)", async () => {
    // Points within the project but at a not-yet-created dir. A `mkdir`/write
    // through a dangling symlink fails (ENOENT) — accepting it in the preflight
    // would strand a partial side effect (e.g. a persisted --model pin) when the
    // later write fails. A write-safe containment check refuses ALL dangling
    // symlinks; only a PLAIN (non-symlink) missing path is a create target.
    await symlink(join(dir, "real-DNE"), join(dir, ".inlink"), "dir");
    await expect(
      resolveWithinProject(dir, ".inlink/file.md"),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_PROJECT" });
  });

  it("rejects an unresolvable symlink cycle with a stable path-safety code", async () => {
    await symlink(join(dir, ".loopb"), join(dir, ".loopa"), "dir");
    await symlink(join(dir, ".loopa"), join(dir, ".loopb"), "dir");
    await expect(
      resolveWithinProject(dir, ".loopa/file"),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_PROJECT" });
  });

  it("still accepts an ordinary deep non-existent path (no symlink)", async () => {
    const got = await resolveWithinProject(dir, ".new/a/b/c.md");
    expect(got).toBe(join(dir, ".new/a/b/c.md"));
  });

  it("resolves paths whose ancestor only exists at the project root", async () => {
    // No intermediate directories — entire suffix is non-existent.
    const got = await resolveWithinProject(dir, "a/b/c/d/e.md");
    expect(got).toBe(join(dir, "a/b/c/d/e.md"));
  });
});

// ---------------------------------------------------------------------------
// classifyFileState
// ---------------------------------------------------------------------------

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);

describe("classifyFileState", () => {
  it("new — no manifest, no disk", () => {
    expect(
      classifyFileState({ manifestHash: null, diskHash: null, desiredHash: H1 }),
    ).toEqual({ local: "new", desired: "absent" });
  });

  it("new — no manifest, no disk, no desired", () => {
    expect(
      classifyFileState({ manifestHash: null, diskHash: null, desiredHash: null }),
    ).toEqual({ local: "new", desired: "absent" });
  });

  it("unmanaged — disk matches desired (adoptable)", () => {
    expect(
      classifyFileState({ manifestHash: null, diskHash: H1, desiredHash: H1 }),
    ).toEqual({ local: "unmanaged", desired: "current" });
  });

  it("unmanaged — disk differs from desired", () => {
    expect(
      classifyFileState({ manifestHash: null, diskHash: H1, desiredHash: H2 }),
    ).toEqual({ local: "unmanaged", desired: "stale" });
  });

  it("unmanaged — disk present but generator no longer emits", () => {
    expect(
      classifyFileState({ manifestHash: null, diskHash: H1, desiredHash: null }),
    ).toEqual({ local: "unmanaged", desired: "stale" });
  });

  it("managed-clean — disk matches manifest matches desired", () => {
    expect(
      classifyFileState({ manifestHash: H1, diskHash: H1, desiredHash: H1 }),
    ).toEqual({ local: "managed-clean", desired: "current" });
  });

  it("managed-clean × stale — disk matches manifest but generator output changed", () => {
    expect(
      classifyFileState({ manifestHash: H1, diskHash: H1, desiredHash: H2 }),
    ).toEqual({ local: "managed-clean", desired: "stale" });
  });

  it("managed-modified × current — manifest hash drifted but content is now the desired content", () => {
    expect(
      classifyFileState({ manifestHash: H1, diskHash: H2, desiredHash: H2 }),
    ).toEqual({ local: "managed-modified", desired: "current" });
  });

  it("managed-modified × stale — true local modification", () => {
    expect(
      classifyFileState({ manifestHash: H1, diskHash: H2, desiredHash: H3 }),
    ).toEqual({ local: "managed-modified", desired: "stale" });
  });

  it("managed-missing — manifest entry but file deleted", () => {
    expect(
      classifyFileState({ manifestHash: H1, diskHash: null, desiredHash: H1 }),
    ).toEqual({ local: "managed-missing", desired: "absent" });
  });

  it("managed-missing — disk gone and generator stopped emitting too", () => {
    expect(
      classifyFileState({ manifestHash: H1, diskHash: null, desiredHash: null }),
    ).toEqual({ local: "managed-missing", desired: "absent" });
  });
});

// ---------------------------------------------------------------------------
// decideAction — exhaustive matrix
// ---------------------------------------------------------------------------

function decide(
  partial: Partial<ActionDecisionInput> &
    Pick<ActionDecisionInput, "local" | "desired" | "mode">,
) {
  return decideAction({
    force: false,
    acceptModified: false,
    ...partial,
  });
}

describe("decideAction — install", () => {
  const mode: AdapterMode = "install";

  it("new → write", () => {
    expect(decide({ local: "new", desired: "absent", mode })).toBe("write");
  });

  it("managed-missing → write (recreate)", () => {
    expect(decide({ local: "managed-missing", desired: "absent", mode })).toBe("write");
  });

  it("unmanaged × current without --force → skip", () => {
    expect(decide({ local: "unmanaged", desired: "current", mode })).toBe("skip");
  });

  it("unmanaged × current with --force → adopt", () => {
    expect(decide({ local: "unmanaged", desired: "current", mode, force: true })).toBe(
      "adopt",
    );
  });

  it("unmanaged × stale without --force → skip", () => {
    expect(decide({ local: "unmanaged", desired: "stale", mode })).toBe("skip");
  });

  it("unmanaged × stale with --force → replace_unmanaged", () => {
    expect(decide({ local: "unmanaged", desired: "stale", mode, force: true })).toBe(
      "replace_unmanaged",
    );
  });

  it("managed-clean × current → skip (idempotent re-install)", () => {
    expect(decide({ local: "managed-clean", desired: "current", mode })).toBe("skip");
  });

  it("managed-clean × stale → update (re-render verbatim generator output; no manifest trust)", () => {
    // SECURITY: install must NOT trust a project-shipped manifest hash to keep a
    // stale (or forged-to-match-malicious) managed-clean file. The file is
    // verbatim generator output, so refreshing it to current desired content
    // destroys no edits and self-heals poisoned instructions.
    expect(decide({ local: "managed-clean", desired: "stale", mode })).toBe("update");
  });

  it("managed-modified × current → skip (install is hands-off for local edits)", () => {
    expect(decide({ local: "managed-modified", desired: "current", mode })).toBe("skip");
  });

  it("managed-modified × stale → refuse (surfaced, not silently skipped; not overwritten)", () => {
    // SECURITY: content matches NEITHER the manifest nor the generator. Install
    // does not overwrite (possible local edit) but must not silently pass over
    // it either — a hostile repo could ship exactly this shape. --accept-modified
    // is not an install flag, so it is irrelevant here.
    expect(
      decide({ local: "managed-modified", desired: "stale", mode }),
    ).toBe("refuse");
    expect(
      decide({
        local: "managed-modified",
        desired: "stale",
        mode,
        acceptModified: true,
      }),
    ).toBe("refuse");
  });
});

describe("decideAction — upgrade --check", () => {
  const mode: AdapterMode = "upgrade-check";

  it("new → write (would be created)", () => {
    expect(decide({ local: "new", desired: "absent", mode })).toBe("write");
  });

  it("managed-missing → write (would be recreated)", () => {
    expect(decide({ local: "managed-missing", desired: "absent", mode })).toBe("write");
  });

  it("unmanaged × current → warn (adoptable, --force needed)", () => {
    expect(decide({ local: "unmanaged", desired: "current", mode })).toBe("warn");
  });

  it("unmanaged × stale → warn (would need --force to replace)", () => {
    expect(decide({ local: "unmanaged", desired: "stale", mode })).toBe("warn");
  });

  it("unmanaged × current with --force → still warn (check is read-only)", () => {
    expect(
      decide({ local: "unmanaged", desired: "current", mode, force: true }),
    ).toBe("warn");
  });

  it("managed-clean × current → skip (already up to date)", () => {
    expect(decide({ local: "managed-clean", desired: "current", mode })).toBe("skip");
  });

  it("managed-clean × stale → update (safe, --accept-modified NOT required)", () => {
    expect(decide({ local: "managed-clean", desired: "stale", mode })).toBe("update");
  });

  it("managed-modified × current → update_manifest (hash drift only)", () => {
    expect(decide({ local: "managed-modified", desired: "current", mode })).toBe(
      "update_manifest",
    );
  });

  it("managed-modified × stale → refuse", () => {
    expect(decide({ local: "managed-modified", desired: "stale", mode })).toBe("refuse");
  });

  it("managed-modified × stale even with --accept-modified → refuse (check is informational)", () => {
    expect(
      decide({
        local: "managed-modified",
        desired: "stale",
        mode,
        acceptModified: true,
      }),
    ).toBe("refuse");
  });
});

describe("decideAction — upgrade --write", () => {
  const mode: AdapterMode = "upgrade-write";

  it("new → write", () => {
    expect(decide({ local: "new", desired: "absent", mode })).toBe("write");
  });

  it("managed-missing → write (recreate)", () => {
    expect(decide({ local: "managed-missing", desired: "absent", mode })).toBe("write");
  });

  it("unmanaged × current without --force → skip", () => {
    expect(decide({ local: "unmanaged", desired: "current", mode })).toBe("skip");
  });

  it("unmanaged × current with --force → adopt", () => {
    expect(decide({ local: "unmanaged", desired: "current", mode, force: true })).toBe(
      "adopt",
    );
  });

  it("unmanaged × stale without --force → skip", () => {
    expect(decide({ local: "unmanaged", desired: "stale", mode })).toBe("skip");
  });

  it("unmanaged × stale with --force → replace_unmanaged", () => {
    expect(decide({ local: "unmanaged", desired: "stale", mode, force: true })).toBe(
      "replace_unmanaged",
    );
  });

  it("managed-clean × current → skip", () => {
    expect(decide({ local: "managed-clean", desired: "current", mode })).toBe("skip");
  });

  it("managed-clean × stale → update (no --accept-modified needed)", () => {
    expect(decide({ local: "managed-clean", desired: "stale", mode })).toBe("update");
  });

  it("managed-modified × current → update_manifest (no --accept-modified needed)", () => {
    expect(decide({ local: "managed-modified", desired: "current", mode })).toBe(
      "update_manifest",
    );
  });

  it("managed-modified × stale without --accept-modified → refuse", () => {
    expect(decide({ local: "managed-modified", desired: "stale", mode })).toBe("refuse");
  });

  it("managed-modified × stale with --accept-modified → update (overwrite local mod)", () => {
    expect(
      decide({
        local: "managed-modified",
        desired: "stale",
        mode,
        acceptModified: true,
      }),
    ).toBe("update");
  });

  it("--force does NOT override managed-modified × stale (safety invariant)", () => {
    expect(
      decide({
        local: "managed-modified",
        desired: "stale",
        mode,
        force: true,
        acceptModified: false,
      }),
    ).toBe("refuse");
  });

  it("--force does NOT override managed-modified × current either — it's manifest drift", () => {
    expect(
      decide({
        local: "managed-modified",
        desired: "current",
        mode,
        force: true,
      }),
    ).toBe("update_manifest");
  });
});
