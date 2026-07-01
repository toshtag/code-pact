/**
 * Raw filesystem primitives for trusted modules only.
 *
 * This module re-exports the raw `node:fs` functions that implement the
 * filesystem boundary itself. Domain modules MUST NOT import from here
 * directly — they should use the branded-path API from {@link ./index.ts}
 * or the authority resolvers in {@link ./owned-read.ts} and
 * {@link ./control-plane.ts}.
 *
 * The `check:fs-authority` AST gate allows this module only inside the raw
 * filesystem boundary. Domain modules that import from here are flagged by the
 * checker.
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
import type { FileHandle } from "node:fs/promises";

function unsupportedNoFollowError(): NodeJS.ErrnoException {
  const error = new Error(
    "O_NOFOLLOW is not supported on this platform; refusing to read without symlink protection",
  );
  (error as NodeJS.ErrnoException).code = "ENOSYS";
  return error;
}

export function resolveNoFollowFlag(value: unknown): number {
  if (typeof value !== "number") {
    throw unsupportedNoFollowError();
  }
  return value;
}

export async function openReadNoFollow(path: string): Promise<FileHandle> {
  const flags = constantsRaw.O_RDONLY | resolveNoFollowFlag(constantsRaw.O_NOFOLLOW);
  try {
    return await openRaw(path, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
      throw unsupportedNoFollowError();
    }
    throw err;
  }
}

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
  const handle = await openReadNoFollow(path);
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
