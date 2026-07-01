/**
 * Branded filesystem operations.
 *
 * These operations require branded path types ({@link OwnedReadPath},
 * {@link OwnedWritePath}, {@link OwnedDeletePath}, {@link ExplicitUserReadPath},
 * {@link OwnedListPath}) — raw strings cannot be passed. The brand is acquired
 * through an authority resolver (see {@link ./authority-resolvers.ts}) which
 * validates namespace ownership.
 *
 * Capability separation is enforced at the type level:
 *   - OwnedReadPath → read, stat, lstat, access, list
 *   - OwnedWritePath → write, mkdir
 *   - OwnedDeletePath → unlink, rm
 *   - ExplicitUserReadPath → read only (CLI --from-file input)
 *   - OwnedListPath → readdir only
 *
 * Domain modules MUST use these operations instead of raw `node:fs` functions.
 */
import {
  unbrand,
  type OwnedDeletePath,
  type OwnedReadPath,
  type OwnedWritePath,
  type ExplicitUserReadPath,
  type OwnedListPath,
} from "./branded-paths-internal.ts";
import {
  readdir as readdirRaw,
  stat as statRaw,
  lstat as lstatRaw,
  unlink as unlinkRaw,
  access as accessRaw,
  mkdir as mkdirRaw,
  writeFile as writeFileRaw,
  rename as renameRaw,
  rm as rmRaw,
  copyFile as copyFileRaw,
  link as linkRaw,
  open as openRaw,
  readRegularOwnedText as readRegularOwnedTextRaw,
} from "./raw-internal.ts";
import type { FileHandle } from "./raw-internal.ts";

export async function readOwnedText(path: OwnedReadPath): Promise<string> {
  return readRegularOwnedTextRaw(unbrand(path));
}

export async function readExplicitUserText(
  path: ExplicitUserReadPath,
): Promise<string> {
  return readRegularOwnedTextRaw(unbrand(path));
}

export async function statOwned(path: OwnedReadPath) {
  return statRaw(unbrand(path));
}

export async function statExplicitUser(path: ExplicitUserReadPath) {
  return statRaw(unbrand(path));
}

export async function lstatExplicitUser(path: ExplicitUserReadPath) {
  return lstatRaw(unbrand(path));
}

export async function listOwnedDirents(
  path: OwnedListPath,
): Promise<import("node:fs").Dirent[]> {
  return readdirRaw(unbrand(path), { withFileTypes: true });
}

export async function listOwned(path: OwnedListPath): Promise<string[]> {
  return readdirRaw(unbrand(path));
}

export async function unlinkOwned(path: OwnedDeletePath): Promise<void> {
  await unlinkRaw(unbrand(path));
}

export async function accessOwned(path: OwnedReadPath): Promise<void> {
  await accessRaw(unbrand(path));
}

export async function lstatOwned(path: OwnedReadPath) {
  return lstatRaw(unbrand(path));
}

export async function statOwnedList(path: OwnedListPath) {
  return statRaw(unbrand(path));
}

export async function lstatOwnedList(path: OwnedListPath) {
  return lstatRaw(unbrand(path));
}

export async function mkdirOwned(
  path: OwnedWritePath,
  options?: { recursive?: boolean },
): Promise<void> {
  await mkdirRaw(unbrand(path), options);
}

export async function writeOwnedText(
  path: OwnedWritePath,
  content: string,
): Promise<void> {
  await writeFileRaw(unbrand(path), content, "utf8");
}

export async function writeOwnedFile(
  path: OwnedWritePath,
  data: string | Buffer | Uint8Array,
): Promise<void> {
  await writeFileRaw(unbrand(path), data);
}

export async function removeOwned(
  path: OwnedDeletePath,
  options?: { recursive?: boolean; force?: boolean },
): Promise<void> {
  await rmRaw(unbrand(path), options);
}

export async function renameOwned(
  src: OwnedWritePath | OwnedDeletePath,
  dst: OwnedWritePath,
): Promise<void> {
  await renameRaw(unbrand(src), unbrand(dst));
}

export async function copyOwnedToOwned(
  src: OwnedReadPath,
  dst: OwnedWritePath,
): Promise<void> {
  await copyFileRaw(unbrand(src), unbrand(dst));
}

export async function linkOwned(
  src: OwnedReadPath,
  dst: OwnedWritePath,
): Promise<void> {
  await linkRaw(unbrand(src), unbrand(dst));
}

export async function openOwnedRead(path: OwnedReadPath): Promise<FileHandle> {
  return openRaw(unbrand(path), "r");
}

export async function openOwnedWriteExclusive(
  path: OwnedWritePath,
): Promise<FileHandle> {
  return openRaw(unbrand(path), "wx");
}
