import { describe, expect, it } from "vitest";
import { resolveProcessLaunch } from "../../../src/core/process/bounded-command.ts";

// ---------------------------------------------------------------------------
// The verification classifier emits `["pnpm", ...]`. On Windows a `pnpm` on
// PATH is normally the batch shim `pnpm.cmd`, which is not a process image:
// only cmd.exe can run it, and Node refuses to spawn one without a shell.
// Spawning the argv directly — correct on POSIX — would therefore not start
// on Windows at all.
//
// cmd.exe is not an escape hatch. Parsing a command line for a batch file
// expands `%VAR%`, and the caller cannot suppress that, so a shim launcher
// would have to corrupt or reject arguments containing `%` — and `%` is legal
// in a changed-file path. Instead the package manager is launched through its
// JavaScript entrypoint, which is plain argv against a native image.
//
// Resolution is syntactic on purpose: src/ reaches the filesystem only through
// the project-fs authorities, and a PATH probe would sit outside any of them.
// When the choice turns out to be wrong the spawn fails, carrying a hint —
// it never silently runs something else.
// ---------------------------------------------------------------------------

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const PNPM_ENTRYPOINT = "C:\\pnpm\\bin\\pnpm.cjs";

type Overrides = Partial<Parameters<typeof resolveProcessLaunch>[0]>;

function resolve(overrides: Overrides = {}) {
  return resolveProcessLaunch({
    program: "pnpm",
    args: ["exec", "vitest", "run"],
    platform: "win32",
    env: {},
    nodeExecPath: NODE,
    ...overrides,
  });
}

describe("resolveProcessLaunch — POSIX", () => {
  it("launches the program directly and leaves argv untouched", () => {
    const result = resolve({
      platform: "linux",
      args: ["exec", "vitest", "run", "a file.test.ts"],
    });

    expect(result).toEqual({
      executable: "pnpm",
      args: ["exec", "vitest", "run", "a file.test.ts"],
    });
  });

  it("ignores npm_execpath on POSIX, where the bare name is executable", () => {
    const result = resolve({
      platform: "darwin",
      env: { npm_execpath: PNPM_ENTRYPOINT },
    });

    expect(result.executable).toBe("pnpm");
    expect(result.args).toEqual(["exec", "vitest", "run"]);
  });

  it("attaches no spawn-failure hint on POSIX", () => {
    const result = resolve({ platform: "linux" });

    expect(result.spawnFailureHint).toBeUndefined();
  });
});

describe("resolveProcessLaunch — Windows", () => {
  it("runs the package manager through its JavaScript entrypoint", () => {
    const result = resolve({ env: { npm_execpath: PNPM_ENTRYPOINT } });

    expect(result).toEqual({
      executable: NODE,
      args: [PNPM_ENTRYPOINT, "exec", "vitest", "run"],
    });
  });

  it("accepts .js and .mjs entrypoints too", () => {
    for (const entrypoint of ["C:\\p\\pnpm.js", "C:\\p\\pnpm.mjs"]) {
      const result = resolve({ env: { npm_execpath: entrypoint } });
      expect(result.executable).toBe(NODE);
      expect(result.args[0]).toBe(entrypoint);
    }
  });

  it("launches a packaged package-manager binary directly", () => {
    const result = resolve({ env: { npm_execpath: "C:\\pnpm\\pnpm.exe" } });

    expect(result).toEqual({
      executable: "C:\\pnpm\\pnpm.exe",
      args: ["exec", "vitest", "run"],
    });
  });

  it("ignores an npm_execpath that is neither JavaScript nor a native image", () => {
    // A `.cmd` in npm_execpath is the shim again, not something we can launch.
    const result = resolve({ env: { npm_execpath: "C:\\pnpm\\pnpm.cmd" } });

    expect(result.executable).toBe("pnpm");
  });

  it("does not rewrite a command that is not the package manager", () => {
    // Without an identity check, `node dist/cli.js` would be turned into
    // `node <pnpm entrypoint> dist/cli.js` — a different program entirely.
    const result = resolve({
      program: "node",
      args: ["dist/cli.js", "--version"],
      env: { npm_execpath: PNPM_ENTRYPOINT },
    });

    expect(result.executable).toBe("node");
    expect(result.args).toEqual(["dist/cli.js", "--version"]);
  });

  it("matches the package manager regardless of the program's extension", () => {
    const result = resolve({
      program: "pnpm.CMD",
      env: { npm_execpath: PNPM_ENTRYPOINT },
    });

    expect(result.executable).toBe(NODE);
    expect(result.args[0]).toBe(PNPM_ENTRYPOINT);
  });

  it("launches a named executable directly", () => {
    const result = resolve({
      program: "node.exe",
      args: ["--version"],
      env: {},
    });

    expect(result).toEqual({ executable: "node.exe", args: ["--version"] });
  });

  it("carries a shim hint for an extensionless program, since a spawn of a .cmd will fail", () => {
    const result = resolve();

    expect(result.executable).toBe("pnpm");
    expect(result.spawnFailureHint).toContain(".cmd shim");
    expect(result.spawnFailureHint).toContain("%VAR%");
  });

  it("carries no hint when the program names its own extension", () => {
    const result = resolve({ program: "node.exe" });

    expect(result.spawnFailureHint).toBeUndefined();
  });
});

describe("resolveProcessLaunch — argv is never rewritten", () => {
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

    expect(result.args).toEqual(hostile);
  });

  it("passes every argument through unchanged behind the Windows entrypoint", () => {
    const result = resolve({
      args: hostile,
      env: { npm_execpath: PNPM_ENTRYPOINT },
    });

    // Prefixed by the entrypoint, and otherwise identical — no quoting,
    // escaping, or filtering is applied to the caller's argv.
    expect(result.args).toEqual([PNPM_ENTRYPOINT, ...hostile]);
  });

  it("passes every argument through unchanged to a named Windows executable", () => {
    const result = resolve({ program: "node.exe", args: hostile });

    expect(result.args).toEqual(hostile);
  });

  it("does not mutate the caller's argument array", () => {
    const args = ["exec", "vitest"];
    resolve({ args, env: { npm_execpath: PNPM_ENTRYPOINT } });

    expect(args).toEqual(["exec", "vitest"]);
  });
});
