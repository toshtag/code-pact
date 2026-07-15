/**
 * Raw filesystem primitives for trusted modules only.
 *
 * This module re-exports the raw `node:fs` functions that implement the
 * filesystem boundary itself. Domain modules MUST NOT import from here
 * directly — they should use the branded-path API from {@link ./index.ts}
 * or the namespace authority resolvers exposed by {@link ./index.ts}.
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
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
  constants,
} from "node:fs";
export type { Dirent, Stats } from "node:fs";

import {
  closeSync as closeSyncRaw,
  fstatSync as fstatSyncRaw,
  openSync as openSyncRaw,
  readFileSync as readFileSyncRaw,
} from "node:fs";
import { isUtf8 } from "node:buffer";
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

export async function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  const flags =
    constantsRaw.O_RDONLY |
    resolveNoFollowFlag(constantsRaw.O_NOFOLLOW) |
    constantsRaw.O_DIRECTORY;
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

export async function readRegularOwnedTextBounded(
  path: string,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  const handle = await openReadNoFollow(path);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      const error = new Error("path is not a regular file");
      (error as NodeJS.ErrnoException).code = "ENOTFILE";
      throw error;
    }
    if (stats.size > maxBytes) {
      const error = new Error(`file exceeds ${maxBytes} bytes`);
      (error as NodeJS.ErrnoException).code = "OWNED_TEXT_TOO_LARGE";
      (error as NodeJS.ErrnoException & { bytes: number; maxBytes: number }).bytes =
        stats.size;
      (error as NodeJS.ErrnoException & { bytes: number; maxBytes: number }).maxBytes =
        maxBytes;
      throw error;
    }

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) {
      const error = new Error(`file exceeds ${maxBytes} bytes`);
      (error as NodeJS.ErrnoException).code = "OWNED_TEXT_TOO_LARGE";
      (error as NodeJS.ErrnoException & { bytes: number; maxBytes: number }).bytes =
        total;
      (error as NodeJS.ErrnoException & { bytes: number; maxBytes: number }).maxBytes =
        maxBytes;
      throw error;
    }
    const bytes = buffer.subarray(0, total);
    if (!isUtf8(bytes)) {
      const error = new Error("file is not valid UTF-8");
      (error as NodeJS.ErrnoException).code = "OWNED_TEXT_INVALID_UTF8";
      (error as NodeJS.ErrnoException & { bytes: number; maxBytes: number }).bytes =
        total;
      (error as NodeJS.ErrnoException & { bytes: number; maxBytes: number }).maxBytes =
        maxBytes;
      throw error;
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

export function readRegularOwnedTextSync(path: string): string {
  const flags =
    constantsRaw.O_RDONLY | resolveNoFollowFlag(constantsRaw.O_NOFOLLOW);
  let fd: number;
  try {
    fd = openSyncRaw(path, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
      throw unsupportedNoFollowError();
    }
    throw err;
  }
  try {
    const stats = fstatSyncRaw(fd);
    if (!stats.isFile()) {
      const error = new Error("path is not a regular file");
      (error as NodeJS.ErrnoException).code = "ENOTFILE";
      throw error;
    }
    return readFileSyncRaw(fd, "utf8");
  } finally {
    closeSyncRaw(fd);
  }
}
