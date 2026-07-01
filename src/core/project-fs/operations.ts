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
  readRegularOwnedText as readRegularOwnedTextRaw,
} from "./raw-internal.ts";

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
