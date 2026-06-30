/**
 * Branded filesystem API seam for code-pact.
 *
 * This module exports ONLY branded path types and branded operations.
 * Raw fs primitives are available from {@link ./raw-internal.ts} — but only
 * trusted modules (listed in `TRUSTED_FS_MODULES` in `check-fs-authority.mjs`)
 * may import from there. The `check:fs-authority` AST gate enforces this at
 * CI time.
 *
 * Domain modules MUST use the branded operations or namespace-specific
 * resolvers (e.g. {@link ./control-plane.ts}) instead of raw fs functions.
 */
export type {
  SymlinkFreeContainedPath,
  OwnedReadPath,
  OwnedWritePath,
  OwnedDeletePath,
} from "./branded-paths.ts";
import {
  unbrand,
  type OwnedDeletePath,
  type OwnedReadPath,
  type OwnedWritePath,
} from "./branded-paths.ts";
import {
  readFile as readFileRaw,
  writeFile as writeFileRaw,
  rm as rmRaw,
  readdir as readdirRaw,
  rename as renameRaw,
  copyFile as copyFileRaw,
} from "./raw-internal.ts";

export async function readOwnedText(path: OwnedReadPath): Promise<string> {
  return readFileRaw(unbrand(path), "utf8");
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

export async function listOwned(path: OwnedReadPath): Promise<string[]> {
  return readdirRaw(unbrand(path));
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
