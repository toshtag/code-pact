import { describe, expect, it } from "vitest";
import { resolveExecutable } from "../../../src/core/process/executable-resolution.ts";

// ---------------------------------------------------------------------------
// The verification classifier emits `["pnpm", ...]`. On Windows a `pnpm` on
// PATH is normally the batch shim `pnpm.cmd`, which is not a process image:
// only cmd.exe can run it, and Node refuses to spawn one without a shell.
// Spawning the argv directly — correct on POSIX — does not start on Windows.
//
// An earlier attempt keyed off `npm_execpath`, but that is a `pnpm run`
// lifecycle variable: under `pnpm exec`, and under the plain `node dist/cli.js`
// the CLI actually runs as, it is unset, and Windows CI failed with
// `spawn pnpm ENOENT`. So PATH is searched, and the order below is fixed.
//
// Every branch is driven from an injected platform, environment, and existence
// probe, so a POSIX host exercises the Windows paths.
// ---------------------------------------------------------------------------

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const PNPM_ENTRYPOINT = "C:\\pnpm\\bin\\pnpm.cjs";
const WINDOWS_PATH = "C:\\tools;C:\\pnpm";

type Overrides = Partial<Parameters<typeof resolveExecutable>[0]>;

function resolve(overrides: Overrides = {}) {
  return resolveExecutable({
    program: "pnpm",
    args: ["exec", "vitest", "run"],
    platform: "win32",
    env: { PATH: WINDOWS_PATH, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    nodeExecPath: NODE,
    fileExists: () => false,
    ...overrides,
  });
}

/** Only these paths exist, so a test states exactly what the OS would find. */
function only(...paths: string[]) {
  return (candidate: string) => paths.includes(candidate);
}

describe("resolveExecutable — POSIX", () => {
  it("launches the program directly and leaves argv untouched", () => {
    const result = resolve({
      platform: "linux",
      args: ["exec", "vitest", "run", "a file.test.ts"],
    });

    expect(result).toEqual({
      kind: "direct",
      executable: "pnpm",
      args: ["exec", "vitest", "run", "a file.test.ts"],
    });
  });

  it("does not consult PATH or npm_execpath on POSIX", () => {
    const result = resolve({
      platform: "darwin",
      env: { npm_execpath: PNPM_ENTRYPOINT },
      fileExists: () => {
        throw new Error("no filesystem probe belongs on the POSIX path");
      },
    });

    expect(result).toMatchObject({ kind: "direct", executable: "pnpm" });
  });
});

describe("resolveExecutable — Windows package manager entrypoint", () => {
  it("runs the package manager through its JavaScript entrypoint", () => {
    const result = resolve({
      env: { npm_execpath: PNPM_ENTRYPOINT },
      fileExists: only(PNPM_ENTRYPOINT),
    });

    expect(result).toEqual({
      kind: "direct",
      executable: NODE,
      args: [PNPM_ENTRYPOINT, "exec", "vitest", "run"],
    });
  });

  it("accepts .js and .mjs entrypoints too", () => {
    for (const entrypoint of ["C:\\p\\pnpm.js", "C:\\p\\pnpm.mjs"]) {
      const result = resolve({
        env: { npm_execpath: entrypoint },
        fileExists: only(entrypoint),
      });

      expect(result).toMatchObject({ kind: "direct", executable: NODE });
    }
  });

  it("launches a packaged package-manager binary directly", () => {
    const packaged = "C:\\pnpm\\pnpm.exe";
    const result = resolve({
      env: { npm_execpath: packaged },
      fileExists: only(packaged),
    });

    expect(result).toEqual({
      kind: "direct",
      executable: packaged,
      args: ["exec", "vitest", "run"],
    });
  });

  it("ignores an npm_execpath that does not exist", () => {
    const result = resolve({
      env: { PATH: WINDOWS_PATH, npm_execpath: "C:\\stale\\pnpm.cjs" },
      fileExists: only("C:\\pnpm\\pnpm.exe"),
    });

    expect(result).toMatchObject({
      kind: "direct",
      executable: "C:\\pnpm\\pnpm.exe",
    });
  });

  it("falls through when npm_execpath is itself a shim", () => {
    const result = resolve({
      env: { PATH: WINDOWS_PATH, npm_execpath: "C:\\pnpm\\pnpm.cmd" },
      fileExists: only("C:\\pnpm\\pnpm.cmd", "C:\\pnpm\\pnpm.exe"),
    });

    expect(result).toMatchObject({
      kind: "direct",
      executable: "C:\\pnpm\\pnpm.exe",
    });
  });

  it("does not rewrite a command that is not the package manager", () => {
    // Without an identity check, `node dist/cli.js` would be turned into
    // `node <pnpm entrypoint> dist/cli.js` — a different program entirely.
    const result = resolve({
      program: "node",
      args: ["dist/cli.js", "--version"],
      env: { PATH: WINDOWS_PATH, npm_execpath: PNPM_ENTRYPOINT },
      fileExists: only(PNPM_ENTRYPOINT, "C:\\tools\\node.exe"),
    });

    expect(result).toEqual({
      kind: "direct",
      executable: "C:\\tools\\node.exe",
      args: ["dist/cli.js", "--version"],
    });
  });

  it("matches the package manager regardless of the program's extension", () => {
    const result = resolve({
      program: "pnpm.CMD",
      env: { npm_execpath: PNPM_ENTRYPOINT },
      fileExists: only(PNPM_ENTRYPOINT),
    });

    expect(result).toMatchObject({ kind: "direct", executable: NODE });
  });
});

describe("resolveExecutable — Windows PATH resolution", () => {
  it("prefers a native image found on PATH", () => {
    const result = resolve({ fileExists: only("C:\\pnpm\\pnpm.exe") });

    expect(result).toEqual({
      kind: "direct",
      executable: "C:\\pnpm\\pnpm.exe",
      args: ["exec", "vitest", "run"],
    });
  });

  it("routes a batch shim to the dedicated launcher", () => {
    const result = resolve({ fileExists: only("C:\\pnpm\\pnpm.cmd") });

    expect(result).toEqual({
      kind: "windows-shim",
      shimPath: "C:\\pnpm\\pnpm.cmd",
      args: ["exec", "vitest", "run"],
    });
  });

  it("honours PATHEXT order, so a .exe wins over a .cmd beside it", () => {
    const result = resolve({
      fileExists: only("C:\\pnpm\\pnpm.exe", "C:\\pnpm\\pnpm.cmd"),
    });

    expect(result).toMatchObject({
      kind: "direct",
      executable: "C:\\pnpm\\pnpm.exe",
    });
  });

  it("honours PATH order across directories", () => {
    const result = resolve({
      fileExists: only("C:\\tools\\pnpm.exe", "C:\\pnpm\\pnpm.exe"),
    });

    expect(result).toMatchObject({ executable: "C:\\tools\\pnpm.exe" });
  });

  it("searches a program that carries a separator as a path, not a name", () => {
    const result = resolve({
      program: "C:\\custom\\tool",
      fileExists: only("C:\\custom\\tool.exe"),
    });

    expect(result).toMatchObject({ executable: "C:\\custom\\tool.exe" });
  });

  it("refuses a program PATH cannot resolve", () => {
    const result = resolve();

    expect(result).toEqual({
      kind: "unresolvable",
      reason: '"pnpm" was not found on PATH',
    });
  });

  it("refuses a resolved path that is not an executable image", () => {
    const result = resolve({
      env: { PATH: WINDOWS_PATH, PATHEXT: ".PS1" },
      fileExists: only("C:\\pnpm\\pnpm.ps1"),
    });

    expect(result.kind).toBe("unresolvable");
    if (result.kind !== "unresolvable") return;
    expect(result.reason).toContain("not an executable image");
  });

  it("refuses an empty program before any probe", () => {
    const result = resolve({
      program: "",
      fileExists: () => {
        throw new Error("an empty program must be refused before probing");
      },
    });

    expect(result).toEqual({
      kind: "unresolvable",
      reason: "the program is empty",
    });
  });
});

describe("resolveExecutable — the PATH search itself", () => {
  it("never searches the current directory for an empty PATH entry", () => {
    const probed: string[] = [];
    resolve({
      env: { PATH: "C:\\tools;;  ;C:\\pnpm", PATHEXT: ".EXE" },
      fileExists: candidate => {
        probed.push(candidate);
        return false;
      },
    });

    expect(probed).toEqual(["C:\\tools\\pnpm.exe", "C:\\pnpm\\pnpm.exe"]);
  });

  it("refuses rather than probing when PATH is absent", () => {
    const result = resolve({
      env: { PATHEXT: ".EXE" },
      fileExists: () => {
        throw new Error("an absent PATH has no candidates to probe");
      },
    });

    expect(result.kind).toBe("unresolvable");
  });

  it("falls back to the standard PATHEXT list when it is unset", () => {
    const probed: string[] = [];
    resolve({
      env: { PATH: "C:\\tools" },
      fileExists: candidate => {
        probed.push(candidate);
        return false;
      },
    });

    expect(probed).toEqual([
      "C:\\tools\\pnpm.com",
      "C:\\tools\\pnpm.exe",
      "C:\\tools\\pnpm.bat",
      "C:\\tools\\pnpm.cmd",
    ]);
  });

  it("ignores a malformed PATHEXT entry rather than probing a bad candidate", () => {
    const probed: string[] = [];
    resolve({
      env: { PATH: "C:\\tools", PATHEXT: ".EXE; ;junk;.CMD" },
      fileExists: candidate => {
        probed.push(candidate);
        return false;
      },
    });

    expect(probed).toEqual(["C:\\tools\\pnpm.exe", "C:\\tools\\pnpm.cmd"]);
  });
});

describe("resolveExecutable — argv is never rewritten", () => {
  const hostile = [
    "",
    "a b",
    "%PATH%",
    "!VALUE!",
    "^",
    "&",
    "|",
    "<",
    ">",
    "(",
    ")",
    "$(touch marker)",
    '"quoted"',
    "trailing\\",
    "line\nbreak",
  ];

  it("passes every argument through unchanged on POSIX", () => {
    const result = resolve({ platform: "linux", args: hostile });

    expect(result).toMatchObject({ args: hostile });
  });

  it("passes every argument through unchanged behind the Windows entrypoint", () => {
    const result = resolve({
      args: hostile,
      env: { npm_execpath: PNPM_ENTRYPOINT },
      fileExists: only(PNPM_ENTRYPOINT),
    });

    // Prefixed by the entrypoint, and otherwise identical — no quoting,
    // escaping, or filtering is applied to the caller's argv.
    expect(result).toMatchObject({ args: [PNPM_ENTRYPOINT, ...hostile] });
  });

  it("passes every argument through unchanged to a native Windows image", () => {
    const result = resolve({
      args: hostile,
      fileExists: only("C:\\pnpm\\pnpm.exe"),
    });

    expect(result).toMatchObject({ args: hostile });
  });

  it("hands the shim launcher the caller's argv verbatim", () => {
    const result = resolve({
      args: hostile,
      fileExists: only("C:\\pnpm\\pnpm.cmd"),
    });

    expect(result).toMatchObject({ kind: "windows-shim", args: hostile });
  });

  it("does not mutate the caller's argument array", () => {
    const args = ["exec", "vitest"];
    resolve({
      args,
      env: { npm_execpath: PNPM_ENTRYPOINT },
      fileExists: only(PNPM_ENTRYPOINT),
    });

    expect(args).toEqual(["exec", "vitest"]);
  });
});
