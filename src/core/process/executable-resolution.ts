import { existsSync, statSync } from "node:fs";
import { win32 as winPath } from "node:path";

// ---------------------------------------------------------------------------
// OS executable resolution
//
// This module answers ONE question: given a program name a caller wants to
// launch, what image would the operating system actually start, and can its
// argv survive the launch?
//
// That is deliberately NOT the question `src/core/project-fs` answers. The
// project authorities decide whether a path belongs to the project and may be
// read or written; PATH entries are system directories that no project
// authority owns, and nothing here reads file CONTENT. This module is the only
// place in `src/` allowed to touch `node:fs` for that purpose, it is read-only,
// and it is limited to existence probes of PATH + PATHEXT candidates. Callers
// receive a resolution and never a filesystem handle — `bounded-command.ts`
// imports no filesystem module at all.
//
// Why it exists: the verification classifier emits `["pnpm", ...]`. On Windows
// `pnpm` is normally the batch shim `pnpm.cmd`, which is not a process image —
// Node refuses to spawn one without a shell — so a shell-free spawn of the
// bare name fails with ENOENT. The earlier attempt keyed off `npm_execpath`,
// but that is a `pnpm run` lifecycle variable: under `pnpm exec`, and under the
// plain `node dist/cli.js` the CLI actually runs as, it is unset.
//
// Windows resolution order is fixed:
//   1. the package manager's own entrypoint from a valid `npm_execpath`
//   2. a PATH-resolved `.exe` / `.com`, launched directly
//   3. a PATH-resolved `.cmd` / `.bat`, through the dedicated shim launcher
//   4. otherwise, fail closed — never a general-purpose shell
// ---------------------------------------------------------------------------

/** How a resolved program should be started. */
export type ExecutableResolution =
  /** Start `executable` with `args` as a process image. Argv survives exactly. */
  | { kind: "direct"; executable: string; args: string[] }
  /**
   * A Windows batch shim. Only `cmd.exe` can run it, so the caller must use the
   * dedicated shim launcher; `shimPath` is the resolved `.cmd` / `.bat`.
   */
  | { kind: "windows-shim"; shimPath: string; args: string[] }
  /** No launch preserves the argv. The caller refuses to run. */
  | { kind: "unresolvable"; reason: string };

export type ResolveExecutableInput = {
  program: string;
  args: readonly string[];
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The Node binary used to run a JavaScript entrypoint. */
  nodeExecPath: string;
  /**
   * Existence probe for a candidate path. Injected so every branch is testable
   * from any host; the default is the read-only probe below.
   */
  fileExists?: (path: string) => boolean;
};

const JAVASCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const WINDOWS_NATIVE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Read-only existence probe. No content is read, and nothing is written. */
export function executableExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    // A PATH entry we cannot stat (permissions, a dead mount) is simply not a
    // candidate. Treating it as absent keeps resolution fail-closed.
    return false;
  }
}

/** `C:\\pnpm\\bin\\pnpm.cjs` and `pnpm` both reduce to `pnpm`. */
function commandIdentity(pathOrName: string): string {
  return winPath
    .basename(pathOrName, winPath.extname(pathOrName))
    .toLowerCase();
}

/**
 * Every candidate PATH lookup would try for `program`, in PATHEXT order.
 * Exported for the tests that pin the search itself.
 */
export function windowsPathCandidates(
  program: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const extensions = (env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(";")
    .map(ext => ext.trim())
    .filter(ext => ext.startsWith("."));
  const withExtensions = (base: string): string[] =>
    winPath.extname(base) !== ""
      ? [base]
      : extensions.map(ext => base + ext.toLowerCase());

  // A program carrying a separator is a path, not a name to search for.
  if (program.includes("/") || program.includes("\\")) {
    return withExtensions(program);
  }
  const entries = (env.PATH ?? env.Path ?? "")
    .split(winPath.delimiter)
    // An empty PATH entry means "the current directory" to some shells. Never
    // honour that: resolution must not depend on the caller's cwd.
    .filter(entry => entry.trim() !== "");
  return entries.flatMap(entry => withExtensions(winPath.join(entry, program)));
}

/**
 * Decides how to start `program` so that every element of `args` reaches the
 * child unchanged. Never returns a shell command line.
 */
export function resolveExecutable(
  input: ResolveExecutableInput,
): ExecutableResolution {
  const { program, platform, env, nodeExecPath } = input;
  const fileExists = input.fileExists ?? executableExists;
  const args = [...input.args];

  if (!program) {
    return { kind: "unresolvable", reason: "the program is empty" };
  }
  if (platform !== "win32") {
    // POSIX has no shim layer: execvp starts the file PATH finds, and argv is
    // passed as an array either way.
    return { kind: "direct", executable: program, args };
  }

  // 1. The package manager's own entrypoint, when the environment points at one
  //    AND it is the program being asked for. The identity check matters:
  //    without it a `["node", "dist/cli.js"]` command would be rewritten to run
  //    the package manager with `dist/cli.js` as an argument.
  const execPath = env.npm_execpath;
  if (
    execPath !== undefined &&
    commandIdentity(execPath) === commandIdentity(program) &&
    fileExists(execPath)
  ) {
    const extension = winPath.extname(execPath).toLowerCase();
    if (JAVASCRIPT_EXTENSIONS.has(extension)) {
      return {
        kind: "direct",
        executable: nodeExecPath,
        args: [execPath, ...args],
      };
    }
    if (WINDOWS_NATIVE_EXTENSIONS.has(extension)) {
      return { kind: "direct", executable: execPath, args };
    }
    // A `.cmd` here is the shim again; fall through to the PATH search rather
    // than treat the variable as authoritative.
  }

  const resolved = windowsPathCandidates(program, env).find(fileExists);
  if (resolved === undefined) {
    return {
      kind: "unresolvable",
      reason: `"${program}" was not found on PATH`,
    };
  }

  // 2. A native image starts directly and keeps its argv.
  const extension = winPath.extname(resolved).toLowerCase();
  if (WINDOWS_NATIVE_EXTENSIONS.has(extension)) {
    return { kind: "direct", executable: resolved, args };
  }

  // 3. A batch shim needs cmd.exe. The caller uses the dedicated launcher.
  if (WINDOWS_SHIM_EXTENSIONS.has(extension)) {
    return { kind: "windows-shim", shimPath: resolved, args };
  }

  // 4. Anything else is not something we know how to start.
  return {
    kind: "unresolvable",
    reason: `"${program}" resolves to "${resolved}", which is not an executable image`,
  };
}
