// Shared CLI helpers used across the cli.ts main file and the per-
// cluster modules under `src/cli/commands/`. Extracted in P27-T1 so
// the cluster modules do not need to import back from `src/cli.ts`.
//
// Current contents:
//   - `emitOk` / `emitError`: the canonical JSON-envelope writers. Every
//     command's stdout/stderr error contract flows through these so the
//     `{ok,error,data}` shape, key order, and exit-stream split live in one
//     place instead of being hand-rolled at ~150 call sites.
//   - `withWriteLock`: P14 advisory-write-lock wrapper used by every
//     CLI command that mutates `design/` (roadmap and phase YAML). The
//     per-event progress ledger is lock-free and does not use this wrapper.

import {
  acquireWriteLock,
  isLockHeldError,
  type LockHandle,
} from "../core/locks/write-lock.ts";

/**
 * Write the canonical success envelope `{ok:true,data}` to stdout with a
 * trailing newline. JSON-mode only — every command renders its own human
 * output — so call this from inside the command's `if (json)` branch.
 */
export function emitOk(data: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
}

/**
 * Write the canonical CLI error envelope. This is a CONTRACT surface — the
 * output is byte-compatible with the hand-rolled emissions it replaces:
 *
 * - JSON mode: `{ok:false, error:{code,message}[, data]}` to stdout with a
 *   trailing newline. `data` is omitted entirely when absent; key order is
 *   always ok → error → data.
 * - Human mode: `message` to stderr with a trailing newline. Override the
 *   text via `opts.human` (e.g. a "command failed: …" prefix) or the target
 *   via `opts.humanStream` when a command prints errors to stdout.
 *
 * The caller owns the exit code — this only writes the envelope.
 */
export function emitError(
  json: boolean,
  code: string,
  message: string,
  opts: {
    data?: unknown;
    human?: string;
    humanStream?: "stdout" | "stderr";
  } = {},
): void {
  if (json) {
    const envelope: {
      ok: false;
      error: { code: string; message: string };
      data?: unknown;
    } = { ok: false, error: { code, message } };
    if (opts.data !== undefined) envelope.data = opts.data;
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  const stream = opts.humanStream === "stdout" ? process.stdout : process.stderr;
  stream.write(`${opts.human ?? message}\n`);
}

/**
 * Run `run()` under the project's advisory write lock. The lock is
 * acquired before `run()` starts and released in a `finally` block so
 * a thrown error from `run()` still cleans up.
 *
 * On `LOCK_HELD`, returns 2 with a `{ok: false, error.code: "LOCK_HELD"}`
 * envelope (and `data.lock_holder` / `data.lock_path` for diagnostic
 * display) without invoking `run()`. Other acquire-time errors
 * propagate to the caller.
 *
 * `cmdLabel` is the user-facing command string ("task finalize P14-T5
 * --write" etc.) recorded in the lock file for diagnostic display.
 */
export async function withWriteLock(
  cwd: string,
  cmdLabel: string,
  json: boolean,
  run: () => Promise<number>,
): Promise<number> {
  let lock: LockHandle;
  try {
    lock = await acquireWriteLock(cwd, cmdLabel);
  } catch (err) {
    if (isLockHeldError(err)) {
      emitError(json, "LOCK_HELD", err.message, {
        data: { lock_holder: err.lock_holder, lock_path: err.lock_path },
      });
      return 2;
    }
    throw err;
  }
  try {
    return await run();
  } finally {
    await lock.release();
  }
}
