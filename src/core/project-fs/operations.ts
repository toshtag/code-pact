/**
 * Branded filesystem operations.
 *
 * These operations require branded path types ({@link OwnedReadPath},
 * {@link OwnedWritePath}, {@link OwnedDeletePath}) — raw strings cannot be
 * passed. The brand is acquired through an authority resolver
 * (see {@link ./authority-resolvers.ts}) which validates namespace ownership.
 *
 * Domain modules MUST use these operations instead of raw `node:fs` functions.
 */
import {
  unbrand,
  type OwnedDeletePath,
  type OwnedReadPath,
  type OwnedWritePath,
} from "./branded-paths-internal.ts";
import {
  readFile as readFileRaw,
  writeFile as writeFileRaw,
  rm as rmRaw,
  readdir as readdirRaw,
  rename as renameRaw,
  copyFile as copyFileRaw,
  stat as statRaw,
  lstat as lstatRaw,
  unlink as unlinkRaw,
  access as accessRaw,
  mkdir as mkdirRaw,
  open as openRaw,
  link as linkRaw,
  readRegularOwnedText as readRegularOwnedTextRaw,
  type FileHandle,
} from "./raw-internal.ts";
import {
  readFileSync as readFileSyncRaw,
  writeFileSync as writeFileSyncRaw,
  existsSync as existsSyncRaw,
  readdirSync as readdirSyncRaw,
  statSync as statSyncRaw,
  lstatSync as lstatSyncRaw,
  constants as constantsRaw,
} from "./raw-internal.ts";

export async function readOwnedText(path: OwnedReadPath): Promise<string> {
  return readFileRaw(unbrand(path), "utf8");
}

export async function readOwnedBytes(path: OwnedReadPath): Promise<Buffer> {
  return readFileRaw(unbrand(path));
}

export async function statOwned(path: OwnedReadPath) {
  return statRaw(unbrand(path));
}

export async function listOwned(path: OwnedReadPath): Promise<string[]> {
  return readdirRaw(unbrand(path));
}

export async function listOwnedDirents(
  path: OwnedReadPath,
): Promise<import("node:fs").Dirent[]> {
  return readdirRaw(unbrand(path), { withFileTypes: true });
}

export async function writeOwnedFile(
  path: OwnedWritePath,
  data: string | Buffer,
): Promise<void> {
  await writeFileRaw(unbrand(path), data);
}

export async function writeOwnedText(
  path: OwnedWritePath,
  content: string,
): Promise<void> {
  await writeFileRaw(unbrand(path), content, "utf8");
}

export async function removeOwned(path: OwnedDeletePath): Promise<void> {
  await rmRaw(unbrand(path), { force: true });
}

export async function unlinkOwned(
  path: OwnedDeletePath | OwnedReadPath,
): Promise<void> {
  await unlinkRaw(unbrand(path));
}

export async function renameOwned(
  source: OwnedDeletePath | OwnedWritePath,
  destination: OwnedWritePath,
): Promise<void> {
  await renameRaw(unbrand(source), unbrand(destination));
}

export async function copyOwnedToOwned(
  source: OwnedReadPath | OwnedWritePath,
  destination: OwnedWritePath,
): Promise<void> {
  await copyFileRaw(unbrand(source), unbrand(destination));
}

export async function accessOwned(path: OwnedReadPath): Promise<void> {
  await accessRaw(unbrand(path));
}

export async function lstatOwned(path: OwnedReadPath) {
  return lstatRaw(unbrand(path));
}

export async function mkdirOwned(
  path: OwnedWritePath | OwnedReadPath,
  options?: { recursive?: boolean },
): Promise<void> {
  await mkdirRaw(unbrand(path), options);
}

export async function openOwned(
  path: OwnedWritePath | OwnedReadPath,
  flags: string | number,
): Promise<FileHandle> {
  return openRaw(unbrand(path), flags);
}

export async function linkOwned(
  source: OwnedWritePath,
  destination: OwnedWritePath,
): Promise<void> {
  await linkRaw(unbrand(source), unbrand(destination));
}

export async function readRegularOwnedTextBranded(
  path: OwnedReadPath,
): Promise<string> {
  return readRegularOwnedTextRaw(unbrand(path));
}

// ---- Sync variants ----

export function readOwnedTextSync(path: OwnedReadPath): string {
  return readFileSyncRaw(unbrand(path), "utf8");
}

export function existsOwnedSync(path: OwnedReadPath): boolean {
  return existsSyncRaw(unbrand(path));
}

export function listOwnedSync(path: OwnedReadPath): string[] {
  return readdirSyncRaw(unbrand(path));
}

export function statOwnedSync(path: OwnedReadPath) {
  return statSyncRaw(unbrand(path));
}

export function lstatOwnedSync(path: OwnedReadPath) {
  return lstatSyncRaw(unbrand(path));
}

export function writeOwnedTextSync(
  path: OwnedWritePath,
  content: string,
): void {
  writeFileSyncRaw(unbrand(path), content, "utf8");
}

export { constantsRaw as constants };
