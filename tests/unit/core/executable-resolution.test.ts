import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executableExists,
  windowsPathCandidates,
} from "../../../src/core/process/executable-resolution.ts";

// ---------------------------------------------------------------------------
// This module is the one place in src/ allowed to touch node:fs outside the
// project-fs authorities, because it answers an OS question the authorities
// cannot express: which image would the system start for a program name.
//
// The exception is only defensible if it stays exactly that narrow, so these
// tests pin the shape of the probe and of the candidate search — read-only,
// existence only, PATH + PATHEXT only, never the working directory.
//
// The decisions built on top of these live in windows-command-launch.test.ts.
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-executable-resolution-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("executableExists — the probe", () => {
  it("finds a file that exists", async () => {
    const file = join(dir, "tool");
    await writeFile(file, "#!/bin/sh\n", "utf8");

    expect(executableExists(file)).toBe(true);
  });

  it("does not find an absent path", () => {
    expect(executableExists(join(dir, "nothing"))).toBe(false);
  });

  it("rejects a directory, which cannot be launched", async () => {
    const nested = join(dir, "subdir");
    await mkdir(nested);

    expect(executableExists(nested)).toBe(false);
  });

  it("follows a symlink to a real file, as the OS would", async () => {
    const target = join(dir, "real");
    const link = join(dir, "link");
    await writeFile(target, "#!/bin/sh\n", "utf8");
    await symlink(target, link);

    expect(executableExists(link)).toBe(true);
  });

  it("reports a dangling symlink as absent rather than throwing", async () => {
    const link = join(dir, "dangling");
    await symlink(join(dir, "gone"), link);

    expect(executableExists(link)).toBe(false);
  });

  it("treats an unprobeable path as absent, keeping resolution fail-closed", () => {
    // A NUL byte cannot be a path; the probe must answer, not throw.
    expect(executableExists("bad\0path")).toBe(false);
  });
});

describe("windowsPathCandidates — the search", () => {
  it("expands every PATH entry against every PATHEXT extension, in order", () => {
    const candidates = windowsPathCandidates("pnpm", {
      PATH: "C:\\tools;C:\\pnpm",
      PATHEXT: ".EXE;.CMD",
    });

    expect(candidates).toEqual([
      "C:\\tools\\pnpm.exe",
      "C:\\tools\\pnpm.cmd",
      "C:\\pnpm\\pnpm.exe",
      "C:\\pnpm\\pnpm.cmd",
    ]);
  });

  it("never yields a working-directory candidate for an empty PATH entry", () => {
    const candidates = windowsPathCandidates("pnpm", {
      PATH: ";C:\\tools;;",
      PATHEXT: ".EXE",
    });

    expect(candidates).toEqual(["C:\\tools\\pnpm.exe"]);
  });

  it("yields nothing when PATH is absent, so nothing is probed", () => {
    expect(windowsPathCandidates("pnpm", { PATHEXT: ".EXE" })).toEqual([]);
  });

  it("yields nothing when PATH is empty", () => {
    expect(windowsPathCandidates("pnpm", { PATH: "", PATHEXT: ".EXE" })).toEqual(
      [],
    );
  });

  it("accepts the Path spelling Windows also uses", () => {
    const candidates = windowsPathCandidates("pnpm", {
      Path: "C:\\tools",
      PATHEXT: ".EXE",
    });

    expect(candidates).toEqual(["C:\\tools\\pnpm.exe"]);
  });

  it("drops a PATHEXT entry that is not an extension", () => {
    const candidates = windowsPathCandidates("pnpm", {
      PATH: "C:\\tools",
      PATHEXT: ".EXE;junk; ;;.CMD",
    });

    expect(candidates).toEqual(["C:\\tools\\pnpm.exe", "C:\\tools\\pnpm.cmd"]);
  });

  it("keeps a program that already names its extension as written", () => {
    const candidates = windowsPathCandidates("pnpm.exe", {
      PATH: "C:\\tools",
      PATHEXT: ".EXE;.CMD",
    });

    expect(candidates).toEqual(["C:\\tools\\pnpm.exe"]);
  });

  it("treats a program carrying a separator as a path, not a PATH search", () => {
    const candidates = windowsPathCandidates("C:\\custom\\tool", {
      PATH: "C:\\tools",
      PATHEXT: ".EXE;.CMD",
    });

    expect(candidates).toEqual(["C:\\custom\\tool.exe", "C:\\custom\\tool.cmd"]);
  });

  it("splits PATH on the Windows separator regardless of the host", () => {
    // A POSIX host's default delimiter is ":", which would shred a drive
    // letter into its own entry and find nothing.
    const candidates = windowsPathCandidates("pnpm", {
      PATH: "C:\\tools;D:\\other",
      PATHEXT: ".EXE",
    });

    expect(candidates).toEqual(["C:\\tools\\pnpm.exe", "D:\\other\\pnpm.exe"]);
  });
});
