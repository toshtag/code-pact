import { mkdir, rename, writeFile, unlink, readFile } from "node:fs/promises";
import { dirname } from "node:path";

async function writeThenRename(tmp: string, path: string, content: string): Promise<void> {
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch (err) {
    // Best-effort: never leave a stray temp file behind, whether the failure was
    // the temp write (e.g. ENOSPC mid-write) or the rename.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Best-effort atomic write for raw text content, **creating** the file (and any
 * missing parent directories) when absent. Writes to a temp file in the same
 * directory then renames to the destination, so a crash mid-write cannot leave
 * the target half-written; a rename failure cleans up the temp file. Does NOT
 * protect against concurrent writers — that is a known limitation noted in
 * docs/cli-contract.md.
 */
export async function atomicWriteText(
  path: string,
  content: string,
): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeThenRename(tmp, path, content);
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
  try {
    await writeFile(tmp, content, "utf8");
    if (expectedCurrent !== undefined) {
      const current = await readFile(path, "utf8");
      if (current !== expectedCurrent) throw new Error("destination changed before replace");
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
