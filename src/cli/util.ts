// Shared CLI helpers used across the cli.ts main file and the per-
// cluster modules under `src/cli/commands/`. Extracted in P27-T1 so
// the cluster modules do not need to import back from `src/cli.ts`.
//
// Current contents:
//   - `withWriteLock`: P14 advisory-write-lock wrapper used by every
//     CLI command that mutates `design/` (roadmap and phase YAML). The
//     per-event progress ledger is lock-free and does not use this wrapper.

import {
  acquireWriteLock,
  isLockHeldError,
  type LockHandle,
} from "../core/locks/write-lock.ts";

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
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: { code: "LOCK_HELD", message: err.message },
            data: { lock_holder: err.lock_holder, lock_path: err.lock_path },
          })}\n`,
        );
      } else {
        process.stderr.write(`${err.message}\n`);
      }
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
