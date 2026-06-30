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
  unlink as unlinkRaw,
  access as accessRaw,
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

export async function writeOwnedText(
  path: OwnedWritePath,
  content: string,
): Promise<void> {
  await writeFileRaw(unbrand(path), content, "utf8");
}

export async function removeOwned(path: OwnedDeletePath): Promise<void> {
  await rmRaw(unbrand(path), { force: true });
}

export async function unlinkOwned(path: OwnedDeletePath): Promise<void> {
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
