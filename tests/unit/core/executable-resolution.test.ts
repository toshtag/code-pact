import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executableExists,
  resolveExecutable,
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

// ---------------------------------------------------------------------------
// Which characters may cross the batch boundary is a property of this module,
// so it is pinned here rather than among the launch-decision tests. The list is
// an allowlist, not an escaper: cmd.exe expands `%VAR%` and treats CR/LF as
// command separators while parsing, and neither can be suppressed by the
// caller. Anything not proven to survive a real shim is refused before a
// process exists — Windows CI runs that proof.
// ---------------------------------------------------------------------------

describe("the batch-shim character contract", () => {
  const SHIM = "C:\\pnpm\\pnpm.cmd";

  function batchLaunch(arg: string) {
    return resolveExecutable({
      program: "pnpm",
      args: [arg],
      platform: "win32",
      env: { PATH: "C:\\pnpm", PATHEXT: ".CMD" },
      nodeExecPath: "C:\\node.exe",
      fileExists: candidate => candidate === SHIM,
    });
  }

  const permitted = [
    ["an empty argument", ""],
    ["a space", "a b"],
    ["non-ASCII text", "日本語"],
    ["a flag", "--config"],
    ["a POSIX-style path", "tests/unit/example.test.ts"],
    ["a Windows-style path", "tests\\unit\\example.test.ts"],
    ["a trailing backslash", "C:\\dir\\"],
    ["a dollar sign", "$HOME"],
    ["a semicolon", "semi;colon"],
    ["a glob star", "star*"],
    ["a glob question mark", "question?"],
    ["an apostrophe", "apostrophe'value"],
    ["a version range", "vitest@^4.1.0".replace("^", "")],
    ["an equals sign", "--reporter=scripts/vitest-ci-reporter.mjs"],
  ] as const;

  for (const [label, arg] of permitted) {
    it(`permits ${label}`, () => {
      expect(batchLaunch(arg).kind).toBe("windows-shim");
    });
  }

  const refused = [
    ["a percent expansion", "%PATH%"],
    ["a delayed expansion", "!VALUE!"],
    ["a caret escape", "^"],
    ["an ampersand", "&"],
    ["a pipe", "|"],
    ["an input redirect", "<"],
    ["an output redirect", ">"],
    ["an opening parenthesis", "("],
    ["a closing parenthesis", ")"],
    ["a double quote", 'quote"value'],
    ["a line feed", "line\nbreak"],
    ["a carriage return", "line\rbreak"],
    ["a NUL byte", "nul\0byte"],
    ["a tab", "tab\tvalue"],
    ["a backtick", "back`tick"],
  ] as const;

  for (const [label, arg] of refused) {
    it(`refuses ${label}`, () => {
      const result = batchLaunch(arg);
      expect(result.kind).toBe("unresolvable");
      if (result.kind !== "unresolvable") return;
      expect(result.reason).toContain("argument 1");
    });
  }
});
