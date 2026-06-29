import { mkdir, rename, unlink, readFile, open } from "../core/project-fs/index.ts";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Temp-file token generation
//
// Temp paths used to be `${path}.tmp-${pid}-${Date.now()}` — predictable, and
// opened with a plain (symlink-following) write. An attacker who pre-created a
// symlink at the predicted temp path could make the write land on (clobber) an
// out-of-project target before the rename. Defenses:
//   1. UNPREDICTABLE name (crypto-random) so the path cannot be pre-created.
//   2. EXCLUSIVE create (flag "wx" = O_CREAT|O_EXCL|O_WRONLY): if the temp path
//      already exists — including as a symlink — open fails with EEXIST and is
//      never followed (POSIX guarantees O_CREAT|O_EXCL fails on a symlink).
// `tempToken` is injectable so a test can force a known suffix and assert the
// exclusive-create refuses a pre-planted symlink.
// ---------------------------------------------------------------------------

const defaultTempToken = (): string => randomUUID();
let tempToken: () => string = defaultTempToken;

/** Test-only seam: force the temp-name token, or pass null to restore random. */
export function __setAtomicTempTokenForTests(fn: (() => string) | null): void {
  tempToken = fn ?? defaultTempToken;
}

/**
 * Test-only seam: force a write failure AFTER the exclusive temp file has been
 * created (i.e. we own it), to prove the temp is cleaned up rather than leaked.
 * Returns the error to throw, or null to write normally.
 */
let failAfterTempOpen: (() => Error) | null = null;
export function __setAtomicWriteFailAfterOpenForTests(fn: (() => Error) | null): void {
  failAfterTempOpen = fn;
}

/**
 * Creates a same-directory temp file with EXCLUSIVE, no-follow semantics and
 * writes `content` into it; returns the temp path. Retries on the (astronomically
 * unlikely with a UUID) EEXIST collision. An EEXIST that never clears — e.g. a
 * squatting symlink at a forced/fixed token — exhausts the retries and throws,
 * so the squatted target is never written through.
 *
 * Ownership is claimed with `open(tmp, "wx")` (O_CREAT|O_EXCL — refuses and never
 * follows a symlink) BEFORE writing. Once that open succeeds the temp file is
 * OURS, so if the subsequent write (or fsync-less close) fails — EFBIG, ENOSPC,
 * EIO — we close the handle and `unlink` the partial temp before rethrowing,
 * never leaking a stray `.tmp-<uuid>`. An EEXIST from `open` is NOT ours, so it
 * is retried (a fresh token) and never unlinked.
 */
async function createExclusiveTemp(path: string, content: string): Promise<string> {
  const MAX_ATTEMPTS = 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const tmp = `${path}.tmp-${tempToken()}`;
    let handle;
    try {
      handle = await open(tmp, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // The temp path is occupied (incl. a squatting symlink) — NOT ours.
        // Retry with a fresh token; do NOT unlink someone else's path.
        lastErr = err;
        continue;
      }
      throw err;
    }
    // We now exclusively own `tmp`. Any failure past this point must clean it up.
    try {
      const injected = failAfterTempOpen?.();
      if (injected) throw injected;
      await handle.writeFile(content, "utf8");
      await handle.close();
      return tmp;
    } catch (err) {
      await handle.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
  throw lastErr ?? new Error("could not create a unique temp file");
}

/**
 * The expected on-disk state of a destination just before an atomic write — used
 * for the pre-rename drift re-check. `absent` and `present` are DISTINCT: an empty
 * file appearing where absence was expected is a drift, not a match (which a bare
 * `""` content compare would miss).
 */
export type ExpectedState = { kind: "absent" } | { kind: "present"; content: string };

async function verifyExpected(path: string, expected: ExpectedState): Promise<void> {
  if (expected.kind === "absent") {
    let exists = true;
    try {
      await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") exists = false;
      else throw err;
    }
    if (exists) throw new Error("destination appeared before write (expected absent)");
  } else {
    // A `present`-expected destination that vanished (ENOENT) throws here too — a drift.
    const current = await readFile(path, "utf8");
    if (current !== expected.content) throw new Error("destination changed before write");
  }
}

async function writeThenRename(
  path: string,
  content: string,
  expected?: ExpectedState,
): Promise<void> {
  // Exclusive create: if this throws (e.g. a squatting symlink at the temp
  // path), no temp file of ours exists to clean up, and nothing was written
  // through the squatted path.
  const tmp = await createExclusiveTemp(path, content);
  try {
    // Re-check just before rename: refuse if the destination drifted since the
    // caller's read (narrows, does not close, the window).
    if (expected !== undefined) await verifyExpected(path, expected);
    await rename(tmp, path);
  } catch (err) {
    // Best-effort: never leave a stray temp file behind, whether the failure was
    // the drift re-check or the rename.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Best-effort atomic write for raw text content, **creating** the file when
 * absent. Writes to a temp file in the same directory then renames to the
 * destination, so a crash mid-write cannot leave the target half-written; a
 * rename failure cleans up the temp file. Does NOT protect against concurrent
 * writers — that is a known limitation noted in docs/cli-contract.md.
 *
 * By default it also creates any missing **parent directories** (`mkdir`).
 * Pass `{ mkdir: false }` for a destructive in-place context where re-creating a
 * vanished parent would be wrong (e.g. `decision prune --write`'s ledger append:
 * the parent `design/decisions/` must already exist; if it was removed since the
 * verdict, the write fails rather than resurrecting the tree).
 *
 * When `expected` is given, the destination's existence + content are re-checked
 * after the temp write and just before the rename (narrowing, not closing, the
 * drift window). `{kind:"absent"}` requires the destination to still not exist
 * (an empty file appearing is refused); `{kind:"present", content}` requires it
 * to still hold exactly `content`.
 */
export async function atomicWriteText(
  path: string,
  content: string,
  expected?: ExpectedState,
  opts: { mkdir?: boolean } = {},
): Promise<void> {
  if (opts.mkdir !== false) await mkdir(dirname(path), { recursive: true });
  await writeThenRename(path, content, expected);
}

/**
 * Atomic **replace** for an existing file — like {@link atomicWriteText} but it
 * does NOT create parent directories. If the parent directory has disappeared
 * (e.g. a concurrent `rm -rf` of the tree between read and write), the temp
 * write fails rather than silently re-creating the deleted tree with stale
 * content. For destructive in-place rewrites (e.g. `decision prune --write`
 * delinking inbound references) where re-creating a vanished file would be wrong.
 *
 * When `expectedCurrent` is given, the destination is re-read AFTER the temp
 * write and just BEFORE the rename and the replace is refused if it no longer
 * matches — narrowing (not eliminating) the drift window down to the gap between
 * that read and the rename. This is **not** a filesystem compare-and-swap: a
 * destination that disappears or is rewritten in that final gap cannot be
 * distinguished portably. The caller should still re-read before calling.
 */
export async function atomicReplaceExistingText(
  path: string,
  content: string,
  expectedCurrent?: string,
): Promise<void> {
  const expected: ExpectedState | undefined =
    expectedCurrent !== undefined ? { kind: "present", content: expectedCurrent } : undefined;
  await writeThenRename(path, content, expected);
}
