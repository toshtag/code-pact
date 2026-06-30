/**
 * Raw filesystem primitives for trusted modules only.
 *
 * This module re-exports the raw `node:fs` functions that implement the
 * filesystem boundary itself. Domain modules MUST NOT import from here
 * directly — they should use the branded-path API from {@link ./index.ts}
 * or the authority resolvers in {@link ./owned-read.ts} and
 * {@link ./control-plane.ts}.
 *
 * The `check:fs-authority` AST gate treats this module as a trusted fs
 * primitive (listed in `TRUSTED_FS_MODULES`). Non-trusted modules that
 * import from here will be flagged by the checker.
 */
export {
  access,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
export type { FileHandle } from "node:fs/promises";
export {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
  constants,
} from "node:fs";
export type { Dirent, Stats } from "node:fs";

import { open as openRaw, constants as constantsRaw } from "node:fs/promises";

/**
 * Read a regular text file via an O_NOFOLLOW file descriptor, preventing
 * final-entry symlink swap races (CWE-59). Opens the file with O_RDONLY|O_NOFOLLOW
 * — if the final path component is a symlink, the open fails with ELOOP on
 * POSIX. Once the fd is open, stat and read from the fd directly, so a
 * concurrent rename/symlink swap between stat and read cannot redirect to a
 * different file.
 *
 * Threat model:
 *   - Static malicious repository with pre-existing symlinks: DEFENDED
 *   - Final-entry concurrent swap (stat→readFile TOCTOU): DEFENDED by O_NOFOLLOW
 *   - Ancestor directory concurrent swap (openat-less hostile FS): NON-GOAL
 *     (Node.js standard API lacks openat(2); documented explicitly)
 *
 * On platforms where O_NOFOLLOW is not available, this throws with code
 * ENOSYS rather than silently falling back to an unsafe read.
 */
export async function readRegularOwnedText(path: string): Promise<string> {
  const flags = constantsRaw.O_RDONLY | constantsRaw.O_NOFOLLOW;
  let handle;
  try {
    handle = await openRaw(path, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EINVAL") {
      const error = new Error(
        "O_NOFOLLOW is not supported on this platform; refusing to read without symlink protection",
      );
      (error as NodeJS.ErrnoException).code = "ENOSYS";
      throw error;
    }
    throw err;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      const error = new Error("path is not a regular file");
      (error as NodeJS.ErrnoException).code = "ENOTFILE";
      throw error;
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}
