// Advisory write lock.
//
// Serializes design-YAML mutations against concurrent code-pact
// invocations on the same project. Single-process users see no
// behavioural change; concurrent design-mutating invocations fail
// fast with `LOCK_HELD` (exit 2) instead of racing on the phase
// YAML or roadmap writes.
//
// Design:
//
//   - Lock path: `<cwd>/.code-pact/locks/write.lock`. In this repo
//     `.code-pact/` is gitignored, so the lock is never committed.
//     Consumers who track `.code-pact/` config should ignore
//     `.code-pact/locks/` (it is runtime state, not a work product).
//   - Atomic exclusive create via `fs.writeFile(..., { flag: "wx" })`.
//     Cross-platform safe (no POSIX flock dependency).
//   - Lock content is JSON `{ pid, hostname, cmd, created_at }` for
//     diagnostic display when a contender fails.
//   - Release is best-effort `unlink`; on uncaught SIGKILL the lock
//     persists as stale (manual recovery).
//   - Read-only commands NEVER acquire the lock. The 7 design-
//     mutating CLI handlers do; createPhase itself stays lock-agnostic
//     so phase-import can hold a single outer lock across its
//     multi-phase apply loop (batch transactionality).
//
// Test escape: `CODE_PACT_DISABLE_LOCKS=1` short-circuits acquisition
// to a no-op. Used by tests/setup.ts so unrelated tests don't acquire
// real locks; lock-specific tests delete the var in beforeEach to
// exercise the real path. NOT documented in public surfaces — no
// compatibility guarantee.

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export type LockHolder = {
  pid: number;
  hostname: string;
  cmd: string;
  created_at: string;
};

export type LockHandle = {
  release: () => Promise<void>;
};

export type LockHeldError = NodeJS.ErrnoException & {
  lock_holder: LockHolder | null;
  lock_path: string;
};

export function isLockHeldError(err: unknown): err is LockHeldError {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "LOCK_HELD";
}

const NOOP_HANDLE: LockHandle = { release: async () => {} };

function locksDisabledViaEnv(): boolean {
  return process.env.CODE_PACT_DISABLE_LOCKS === "1";
}

export function lockPathFor(cwd: string): string {
  return join(cwd, ".code-pact", "locks", "write.lock");
}

/**
 * Acquire the advisory write lock for the project rooted at `cwd`.
 *
 * On success returns a `LockHandle` whose `.release()` removes the
 * lock file. On contention (lock file already exists) throws an
 * `Error` with `.code === "LOCK_HELD"`, `.lock_holder` carrying
 * diagnostic data from the existing file (or `null` if the file
 * cannot be read or parsed), and `.lock_path` carrying the absolute
 * lock file path so the user can manually clear a stale lock if
 * they are certain no command is running.
 *
 * Callers should wrap their mutation in `try { ... } finally
 * { await handle.release(); }` to ensure release on every exit
 * path (the catch is intentionally outside `finally` so a thrown
 * error propagates to the CLI's standard error-mapping layer).
 *
 * `cmd` is the human-readable command string ("phase reconcile P14
 * --write" etc.) recorded in the lock file for diagnostics. Pass
 * the most user-recognisable form.
 */
export async function acquireWriteLock(
  cwd: string,
  cmd: string,
): Promise<LockHandle> {
  if (locksDisabledViaEnv()) return NOOP_HANDLE;

  const lockPath = lockPathFor(cwd);
  await mkdir(dirname(lockPath), { recursive: true });

  const holder: LockHolder = {
    pid: process.pid,
    hostname: hostname(),
    cmd,
    created_at: new Date().toISOString(),
  };

  try {
    await writeFile(lockPath, JSON.stringify(holder), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Lock already held. Read the existing holder for diagnostics;
      // ignore parse failures (corrupt / partially-written file) and
      // surface `null` in the envelope instead of failing the contender.
      let existing: LockHolder | null = null;
      try {
        const raw = await readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<LockHolder>;
        if (
          typeof parsed.pid === "number" &&
          typeof parsed.hostname === "string" &&
          typeof parsed.cmd === "string" &&
          typeof parsed.created_at === "string"
        ) {
          existing = parsed as LockHolder;
        }
      } catch {
        existing = null;
      }
      const message =
        existing !== null
          ? `Another code-pact mutation is in progress: ${existing.cmd} (pid: ${existing.pid}, host: ${existing.hostname}, started: ${existing.created_at}). If you are certain no command is running, remove ${lockPath} and retry.`
          : `Another code-pact mutation appears to be in progress (lock file at ${lockPath} could not be read). If you are certain no command is running, remove the lock file and retry.`;
      const lockErr: LockHeldError = Object.assign(new Error(message), {
        code: "LOCK_HELD",
        lock_holder: existing,
        lock_path: lockPath,
      });
      throw lockErr;
    }
    throw err;
  }

  return {
    release: async () => {
      try {
        await unlink(lockPath);
      } catch {
        // Best-effort release. The lock file may have been removed
        // externally (manual cleanup of a stale lock by the user)
        // or the directory may have been torn down by a test
        // cleanup hook between acquire and release. Either way the
        // semantic guarantee — "we no longer hold the lock" — still
        // holds.
      }
    },
  };
}
