import { mkdir, rename, writeFile, unlink, readFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  tmp: string,
  path: string,
  content: string,
  expected?: ExpectedState,
): Promise<void> {
  try {
    await writeFile(tmp, content, "utf8");
    // Re-check just before rename: refuse if the destination drifted since the
    // caller's read (narrows, does not close, the window).
    if (expected !== undefined) await verifyExpected(path, expected);
    await rename(tmp, path);
  } catch (err) {
    // Best-effort: never leave a stray temp file behind, whether the failure was
    // the temp write (e.g. ENOSPC mid-write), the drift re-check, or the rename.
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
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  if (opts.mkdir !== false) await mkdir(dirname(path), { recursive: true });
  await writeThenRename(tmp, path, content, expected);
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
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const expected: ExpectedState | undefined =
    expectedCurrent !== undefined ? { kind: "present", content: expectedCurrent } : undefined;
  await writeThenRename(tmp, path, content, expected);
}
