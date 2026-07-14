// Shared test helpers for subprocess-based CLI integration tests.
//
// Integration tests spawn the built CLI and assert on its JSON envelopes.
// This module owns the spawnSync wrapper, mkdtemp boilerplate, and envelope
// assertions so the test files import a shared `run()`/`RunResult` instead
// of re-implementing them. A couple of tests with special spawn needs keep
// their own wrappers.
//
// Build posture: integration tests expect dist/cli.js to have been built
// before Vitest starts. `pnpm test:integration` and CI both run `pnpm build`
// once up front, avoiding per-file tsup races and repeated rebuilds.

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
export const cliPath = join(repoRoot, "dist", "cli.js");

export type RunResult = { code: number; stdout: string; stderr: string };

export type JsonOk<T> = { ok: true; data: T };
export type JsonErr = {
  ok: false;
  error: { code: string; message: string };
  data?: unknown;
};
export type JsonEnvelope<T> = JsonOk<T> | JsonErr;

/**
 * Assert dist/cli.js exists. Call this from beforeAll() in subprocess
 * integration tests so a missing prebuild fails with a direct diagnostic.
 */
export function ensureCliBuilt(): void {
  if (!existsSync(cliPath)) {
    throw new Error(
      `Missing ${cliPath}. Run "pnpm build" first, or use "pnpm test:integration".`,
    );
  }
}

/**
 * Spawn `node dist/cli.js <args>` in `cwd` and capture stdout / stderr.
 * The CLI is invoked through the same Node binary that's running vitest
 * so version skew can't cause test flake.
 *
 * Pass `opts.input` (or env as the third positional shorthand) to feed
 * stdin to the subprocess — used by v1.6 P17-T2 `plan brief --stdin`
 * integration tests.
 */
export function run(
  cwd: string,
  args: string[],
  envOrOpts?: NodeJS.ProcessEnv | { env?: NodeJS.ProcessEnv; input?: string },
): RunResult {
  // Back-compat: the original signature took `env` as the third arg.
  // The new options-object form lets callers pass `input` for stdin
  // without breaking any existing call site.
  const opts: { env?: NodeJS.ProcessEnv; input?: string } =
    envOrOpts && "env" in envOrOpts || envOrOpts && "input" in envOrOpts
      ? (envOrOpts as { env?: NodeJS.ProcessEnv; input?: string })
      : { env: envOrOpts as NodeJS.ProcessEnv | undefined };

  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    input: opts.input,
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/**
 * Create a temp project for a single test. Returns a bundle with:
 *
 * - `dir`     — absolute path to the temp project
 * - `cleanup` — call from afterEach / afterAll to remove the dir
 * - `run`     — run(args[]) bound to this project's cwd
 * - `runJson` — run + JSON.parse; throws on empty stdout
 *
 * Pass `init: false` to skip the default `init --non-interactive
 * --agent claude-code --locale en-US --json` step (useful when a test
 * needs to assert behaviour on an uninitialized project). Pass an
 * `init` array to override the init argv (e.g. multi-agent setups).
 */
export async function createTempProject(opts?: {
  init?: boolean | string[];
  prefix?: string;
}): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
  run: (
    args: string[],
    envOrOpts?: NodeJS.ProcessEnv | { env?: NodeJS.ProcessEnv; input?: string },
  ) => RunResult;
  runJson: <T = unknown>(
    args: string[],
    envOrOpts?: NodeJS.ProcessEnv | { env?: NodeJS.ProcessEnv; input?: string },
  ) => JsonEnvelope<T>;
}> {
  ensureCliBuilt();
  const prefix = opts?.prefix ?? "code-pact-test-";
  const dir = await mkdtemp(join(tmpdir(), prefix));

  if (opts?.init !== false) {
    const initArgs = Array.isArray(opts?.init)
      ? opts.init
      : ["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"];
    const initRes = run(dir, initArgs);
    if (initRes.code !== 0) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(
        `createTempProject: init failed (exit ${initRes.code})\nargs: ${JSON.stringify(initArgs)}\nstdout:\n${initRes.stdout}\nstderr:\n${initRes.stderr}`,
      );
    }
  }

  const projectRun = (
    args: string[],
    envOrOpts?: NodeJS.ProcessEnv | { env?: NodeJS.ProcessEnv; input?: string },
  ) => run(dir, args, envOrOpts);
  const projectRunJson = <T = unknown>(
    args: string[],
    envOrOpts?: NodeJS.ProcessEnv | { env?: NodeJS.ProcessEnv; input?: string },
  ): JsonEnvelope<T> => {
    const r = projectRun(args, envOrOpts);
    if (r.stdout.trim().length === 0) {
      throw new Error(
        `runJson: empty stdout (exit ${r.code})\nargs: ${JSON.stringify(args)}\nstderr:\n${r.stderr}`,
      );
    }
    return JSON.parse(r.stdout) as JsonEnvelope<T>;
  };

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    run: projectRun,
    runJson: projectRunJson,
  };
}

/**
 * Assert that a RunResult contains a success JSON envelope ({ok:true, data})
 * and exit 0. Returns the parsed envelope (narrowed to ok:true) for
 * downstream `.data` access. Throws with a useful diagnostic on failure.
 */
export function expectJsonOk<T = unknown>(res: RunResult): JsonOk<T> {
  if (res.stdout.trim().length === 0) {
    throw new Error(
      `expectJsonOk: empty stdout (exit ${res.code})\nstderr:\n${res.stderr}`,
    );
  }
  const parsed = JSON.parse(res.stdout) as JsonEnvelope<T>;
  if (parsed.ok !== true) {
    throw new Error(
      `expectJsonOk: expected ok:true, got ${JSON.stringify(parsed)}\nstderr:\n${res.stderr}`,
    );
  }
  if (res.code !== 0) {
    throw new Error(
      `expectJsonOk: expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
  return parsed;
}

/**
 * Assert that a RunResult contains an error JSON envelope ({ok:false,
 * error}). Optionally check that error.code matches an expected value.
 * Does NOT assert a specific exit code — callers should verify exit
 * separately (different codes carry different semantics: 1 vs 2).
 */
export function expectJsonErr(
  res: RunResult,
  expectedCode?: string,
): JsonErr {
  if (res.stdout.trim().length === 0) {
    throw new Error(
      `expectJsonErr: empty stdout (exit ${res.code})\nstderr:\n${res.stderr}`,
    );
  }
  const parsed = JSON.parse(res.stdout) as JsonEnvelope<unknown>;
  if (parsed.ok !== false || !parsed.error) {
    throw new Error(
      `expectJsonErr: expected ok:false with error, got ${JSON.stringify(parsed)}`,
    );
  }
  if (expectedCode && parsed.error.code !== expectedCode) {
    throw new Error(
      `expectJsonErr: expected error.code "${expectedCode}", got "${parsed.error.code}"\nmessage: ${parsed.error.message}`,
    );
  }
  return parsed;
}
