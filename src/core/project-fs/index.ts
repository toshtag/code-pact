/**
 * Central filesystem API seam for code-pact.
 *
 * All src/ modules MUST import fs functions from this module instead of
 * `node:fs/promises` directly. This creates a single import point that:
 *
 * - Can be mocked exhaustively in tests (one `vi.mock` covers all fs ops).
 * - Is audited by `check:fs-authority` as the sole raw-fs import site.
 * - Can later enforce symlink-free resolution or other safety policies
 *   without touching dozens of call sites.
 *
 * The `check:fs-authority` AST gate treats this module as a trusted fs
 * module (its own `node:fs/promises` import is exempt). All other src/
 * files that import from `node:fs/promises` directly are flagged.
 *
 * Re-exports match the `node:fs/promises` surface 1:1 so callers can use
 * the same function names and types.
 */
export * from "node:fs/promises";
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
} from "node:fs/promises";

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
