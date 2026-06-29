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
