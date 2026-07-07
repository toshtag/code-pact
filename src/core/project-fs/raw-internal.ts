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
  lstatSync as lstatSyncRaw,
  openSync as openSyncRaw,
  readFileSync as readFileSyncRaw,
} from "node:fs";
import {
  lstat as lstatRaw,
  open as openRaw,
  constants as constantsRaw,
} from "node:fs/promises";
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

function isNoFollowUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

function symlinkRefusalError(path: string): NodeJS.ErrnoException {
  const error = new Error(`path is a symbolic link: ${path}`);
  (error as NodeJS.ErrnoException).code = "ELOOP";
  return error as NodeJS.ErrnoException;
}

function notRegularFileError(): NodeJS.ErrnoException {
  const error = new Error("path is not a regular file");
  (error as NodeJS.ErrnoException).code = "ENOTFILE";
  return error as NodeJS.ErrnoException;
}

function notDirectoryError(): NodeJS.ErrnoException {
  const error = new Error("path is not a directory");
  (error as NodeJS.ErrnoException).code = "ENOTDIR";
  return error as NodeJS.ErrnoException;
}

function identityChangedError(): NodeJS.ErrnoException {
  const error = new Error("path changed between lstat and open");
  (error as NodeJS.ErrnoException).code = "EAGAIN";
  return error as NodeJS.ErrnoException;
}

function hasComparableIdentity(stats: { dev: number; ino: number }): boolean {
  return (
    Number.isFinite(stats.dev) &&
    Number.isFinite(stats.ino) &&
    stats.ino !== 0
  );
}

function assertSameIdentity(
  before: { dev: number; ino: number },
  after: { dev: number; ino: number },
): void {
  if (!hasComparableIdentity(before) || !hasComparableIdentity(after)) return;
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw identityChangedError();
  }
}

async function openReadPortableNoFollow(path: string): Promise<FileHandle> {
  const before = await lstatRaw(path);
  if (before.isSymbolicLink()) throw symlinkRefusalError(path);
  const handle = await openRaw(path, constantsRaw.O_RDONLY);
  try {
    const after = await handle.stat();
    assertSameIdentity(before, after);
    if (!after.isFile()) throw notRegularFileError();
    return handle;
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

async function openDirectoryPortableNoFollow(path: string): Promise<FileHandle> {
  const before = await lstatRaw(path);
  if (before.isSymbolicLink()) throw symlinkRefusalError(path);
  if (!before.isDirectory()) throw notDirectoryError();
  const handle = await openRaw(path, constantsRaw.O_RDONLY);
  try {
    const after = await handle.stat();
    assertSameIdentity(before, after);
    if (!after.isDirectory()) throw notDirectoryError();
    return handle;
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

export async function openReadNoFollow(path: string): Promise<FileHandle> {
  if (typeof constantsRaw.O_NOFOLLOW !== "number") {
    return openReadPortableNoFollow(path);
  }
  const flags = constantsRaw.O_RDONLY | constantsRaw.O_NOFOLLOW;
  try {
    return await openRaw(path, flags);
  } catch (err) {
    if (isNoFollowUnsupported(err)) {
      return openReadPortableNoFollow(path);
    }
    throw err;
  }
}

export async function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  if (typeof constantsRaw.O_NOFOLLOW !== "number") {
    return openDirectoryPortableNoFollow(path);
  }
  const flags =
    constantsRaw.O_RDONLY |
    constantsRaw.O_NOFOLLOW |
    constantsRaw.O_DIRECTORY;
  try {
    return await openRaw(path, flags);
  } catch (err) {
    if (isNoFollowUnsupported(err)) {
      return openDirectoryPortableNoFollow(path);
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
 * On platforms where O_NOFOLLOW is not available, the fallback first rejects a
 * symlink final component via lstat, then verifies the opened descriptor is the
 * same regular file where the platform exposes comparable file identity.
 */
export async function readRegularOwnedText(path: string): Promise<string> {
  const handle = await openReadNoFollow(path);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw notRegularFileError();
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function openReadNoFollowSync(path: string): number {
  if (typeof constantsRaw.O_NOFOLLOW === "number") {
    const flags = constantsRaw.O_RDONLY | constantsRaw.O_NOFOLLOW;
    try {
      return openSyncRaw(path, flags);
    } catch (err) {
      if (!isNoFollowUnsupported(err)) throw err;
    }
  }

  const before = lstatSyncRaw(path);
  if (before.isSymbolicLink()) throw symlinkRefusalError(path);
  const fd = openSyncRaw(path, constantsRaw.O_RDONLY);
  try {
    const after = fstatSyncRaw(fd);
    assertSameIdentity(before, after);
    if (!after.isFile()) throw notRegularFileError();
    return fd;
  } catch (err) {
    closeSyncRaw(fd);
    throw err;
  }
}

export function readRegularOwnedTextSync(path: string): string {
  const fd = openReadNoFollowSync(path);
  try {
    const stats = fstatSyncRaw(fd);
    if (!stats.isFile()) {
      throw notRegularFileError();
    }
    return readFileSyncRaw(fd, "utf8");
  } finally {
    closeSyncRaw(fd);
  }
}
