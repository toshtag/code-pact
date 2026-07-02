import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  stat,
  lstat,
  access,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSymlinkFreeProjectPath,
  resolveWithinProject,
  pathTraversesSymlink,
} from "../../../src/core/path-safety.ts";

// ---------------------------------------------------------------------------
// Filesystem operation proof test: verify that resolveSymlinkFreeProjectPath
// and resolveWithinProject behave correctly across ALL filesystem operations
// (stat, lstat, access, readdir, mkdir, write, delete) for:
//   1. Plain in-project paths (allowed by both resolvers)
//   2. In-project symlinks (rejected by resolveSymlinkFreeProjectPath,
//      allowed by resolveWithinProject)
//   3. Out-of-project symlinks (rejected by both)
//   4. Dangling symlinks (rejected by both)
//   5. Not-yet-created paths (allowed by both for creation)
// ---------------------------------------------------------------------------

let dir: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-path-proof-"));
  outside = await mkdtemp(join(tmpdir(), "code-pact-path-proof-out-"));
  await mkdir(join(dir, "subdir"), { recursive: true });
  await writeFile(join(dir, "subdir", "file.txt"), "content\n", "utf8");
  await writeFile(join(outside, "outside.txt"), "outside\n", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("resolveSymlinkFreeProjectPath — filesystem operation proof", () => {
  describe("plain in-project paths (allowed)", () => {
    it("stat: resolves and stat succeeds", async () => {
      const resolved = await resolveSymlinkFreeProjectPath(dir, "subdir/file.txt");
      const s = await stat(resolved);
      expect(s.isFile()).toBe(true);
    });

    it("lstat: resolves and lstat succeeds", async () => {
      const resolved = await resolveSymlinkFreeProjectPath(dir, "subdir/file.txt");
      const s = await lstat(resolved);
      expect(s.isFile()).toBe(true);
    });

    it("access: resolves and access succeeds", async () => {
      const resolved = await resolveSymlinkFreeProjectPath(dir, "subdir/file.txt");
      await access(resolved);
    });

    it("readdir: resolves directory and readdir succeeds", async () => {
      const resolved = await resolveSymlinkFreeProjectPath(dir, "subdir");
      const entries = await readdir(resolved);
      expect(entries).toContain("file.txt");
    });

    it("readFile: resolves and readFile succeeds", async () => {
      const resolved = await resolveSymlinkFreeProjectPath(dir, "subdir/file.txt");
      const content = await readFile(resolved, "utf8");
      expect(content).toBe("content\n");
    });

    it("write: resolves not-yet-created path and write succeeds", async () => {
      const resolved = await resolveSymlinkFreeProjectPath(dir, "subdir/new.txt");
      await writeFile(resolved, "new\n", "utf8");
      expect(await readFile(resolved, "utf8")).toBe("new\n");
    });

    it("delete: resolves and unlink succeeds", async () => {
      await writeFile(join(dir, "subdir", "deletable.txt"), "temp\n", "utf8");
      const resolved = await resolveSymlinkFreeProjectPath(dir, "subdir/deletable.txt");
      await unlink(resolved);
      expect(existsSync(resolved)).toBe(false);
    });

    it("mkdir: resolves not-yet-created dir and mkdir succeeds", async () => {
      const resolved = await resolveSymlinkFreeProjectPath(dir, "newdir");
      await mkdir(resolved, { recursive: true });
      const s = await stat(resolved);
      expect(s.isDirectory()).toBe(true);
    });
  });

  describe("in-project symlinks (rejected by symlink-free, allowed by containment)", () => {
    beforeEach(async () => {
      // Create an in-project symlink: subdir/alias.txt -> subdir/file.txt
      await symlink(
        join(dir, "subdir", "file.txt"),
        join(dir, "subdir", "alias.txt"),
      );
      // Create an in-project directory symlink: dirlink -> subdir
      await symlink(join(dir, "subdir"), join(dir, "dirlink"), "dir");
    });

    it("pathTraversesSymlink: detects final-component symlink", async () => {
      expect(await pathTraversesSymlink(dir, "subdir/alias.txt")).toBe(true);
    });

    it("pathTraversesSymlink: detects parent symlink", async () => {
      expect(await pathTraversesSymlink(dir, "dirlink/file.txt")).toBe(true);
    });

    it("pathTraversesSymlink: returns false for plain path", async () => {
      expect(await pathTraversesSymlink(dir, "subdir/file.txt")).toBe(false);
    });

    it("resolveSymlinkFreeProjectPath: rejects final symlink with PATH_NOT_OWNED", async () => {
      await expect(
        resolveSymlinkFreeProjectPath(dir, "subdir/alias.txt"),
      ).rejects.toMatchObject({ code: "PATH_NOT_OWNED" });
    });

    it("resolveSymlinkFreeProjectPath: rejects parent symlink with PATH_NOT_OWNED", async () => {
      await expect(
        resolveSymlinkFreeProjectPath(dir, "dirlink/file.txt"),
      ).rejects.toMatchObject({ code: "PATH_NOT_OWNED" });
    });

    it("resolveWithinProject: allows in-project final symlink (containment)", async () => {
      const resolved = await resolveWithinProject(dir, "subdir/alias.txt");
      // The resolved path is the lexical join, not the symlink target.
      expect(resolved).toBe(join(dir, "subdir", "alias.txt"));
      // And stat through it works (it points to a real file).
      const s = await stat(resolved);
      expect(s.isFile()).toBe(true);
    });

    it("resolveWithinProject: allows in-project parent symlink (containment)", async () => {
      const resolved = await resolveWithinProject(dir, "dirlink/file.txt");
      expect(resolved).toBe(join(dir, "dirlink", "file.txt"));
      const s = await stat(resolved);
      expect(s.isFile()).toBe(true);
    });
  });

  describe("out-of-project symlinks (rejected by both)", () => {
    beforeEach(async () => {
      // Create a symlink pointing outside the project.
      await symlink(
        join(outside, "outside.txt"),
        join(dir, "subdir", "escape.txt"),
      );
      // Create a directory symlink pointing outside.
      await symlink(outside, join(dir, "outsidedir"), "dir");
    });

    it("resolveSymlinkFreeProjectPath: rejects with PATH_NOT_OWNED (symlink detected first)", async () => {
      await expect(
        resolveSymlinkFreeProjectPath(dir, "subdir/escape.txt"),
      ).rejects.toMatchObject({ code: "PATH_NOT_OWNED" });
    });

    it("resolveWithinProject: rejects with PATH_OUTSIDE_PROJECT", async () => {
      await expect(
        resolveWithinProject(dir, "subdir/escape.txt"),
      ).rejects.toMatchObject({ code: "PATH_OUTSIDE_PROJECT" });
    });

    it("resolveSymlinkFreeProjectPath: rejects parent dir symlink with PATH_NOT_OWNED", async () => {
      await expect(
        resolveSymlinkFreeProjectPath(dir, "outsidedir/outside.txt"),
      ).rejects.toMatchObject({ code: "PATH_NOT_OWNED" });
    });

    it("resolveWithinProject: rejects parent dir symlink with PATH_OUTSIDE_PROJECT", async () => {
      await expect(
        resolveWithinProject(dir, "outsidedir/outside.txt"),
      ).rejects.toMatchObject({ code: "PATH_OUTSIDE_PROJECT" });
    });
  });

  describe("dangling symlinks (rejected by both)", () => {
    beforeEach(async () => {
      // Create a dangling symlink (target does not exist).
      await symlink(
        join(dir, "subdir", "nonexistent.txt"),
        join(dir, "subdir", "dangling.txt"),
      );
    });

    it("pathTraversesSymlink: detects dangling symlink", async () => {
      expect(await pathTraversesSymlink(dir, "subdir/dangling.txt")).toBe(true);
    });

    it("resolveSymlinkFreeProjectPath: rejects with PATH_NOT_OWNED", async () => {
      await expect(
        resolveSymlinkFreeProjectPath(dir, "subdir/dangling.txt"),
      ).rejects.toMatchObject({ code: "PATH_NOT_OWNED" });
    });

    it("resolveWithinProject: rejects with PATH_OUTSIDE_PROJECT", async () => {
      await expect(
        resolveWithinProject(dir, "subdir/dangling.txt"),
      ).rejects.toMatchObject({ code: "PATH_OUTSIDE_PROJECT" });
    });
  });

  describe("not-yet-created paths (allowed by both for creation)", () => {
    it("resolveSymlinkFreeProjectPath: allows not-yet-created file", async () => {
      const resolved = await resolveSymlinkFreeProjectPath(dir, "subdir/future.txt");
      expect(resolved).toBe(join(dir, "subdir", "future.txt"));
    });

    it("resolveSymlinkFreeProjectPath: allows not-yet-created nested dir", async () => {
      const resolved = await resolveSymlinkFreeProjectPath(dir, "a/b/c/file.txt");
      expect(resolved).toBe(join(dir, "a", "b", "c", "file.txt"));
    });

    it("resolveWithinProject: allows not-yet-created file", async () => {
      const resolved = await resolveWithinProject(dir, "subdir/future.txt");
      expect(resolved).toBe(join(dir, "subdir", "future.txt"));
    });

    it("write through resolved not-yet-created path succeeds", async () => {
      const resolved = await resolveSymlinkFreeProjectPath(dir, "subdir/future.txt");
      await writeFile(resolved, "future\n", "utf8");
      expect(await readFile(resolved, "utf8")).toBe("future\n");
    });

    it("mkdir through resolved not-yet-created nested path succeeds", async () => {
      const resolved = await resolveSymlinkFreeProjectPath(dir, "new/nested/dir");
      await mkdir(resolved, { recursive: true });
      const s = await stat(resolved);
      expect(s.isDirectory()).toBe(true);
    });
  });
});
