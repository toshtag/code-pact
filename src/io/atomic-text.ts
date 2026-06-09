import { mkdir, rename, writeFile, unlink } from "node:fs/promises";
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
 * NOTE: this is **not** a compare-and-swap. It does not stat the destination, and
 * `rename` still creates the destination if it vanished after the temp write. The
 * caller is responsible for re-reading / re-stat-ing the destination immediately
 * before calling (as `decision prune --write` does, refusing on any drift).
 */
export async function atomicReplaceExistingText(
  path: string,
  content: string,
): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeThenRename(tmp, path, content);
}
