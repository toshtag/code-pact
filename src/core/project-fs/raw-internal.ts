/**
 * Raw filesystem primitives for trusted modules only.
 *
 * This module re-exports the raw `node:fs` functions that implement the
 * filesystem boundary itself. Domain modules MUST NOT import from here
 * directly — they should use the branded-path API from {@link ./index.ts}
 * or the authority resolvers in {@link ./owned-read.ts} and
 * {@link ./control-plane.ts}.
 *
 * The `check:fs-authority` AST gate treats this module as a trusted fs
 * primitive (listed in `TRUSTED_FS_MODULES`). Non-trusted modules that
 * import from here will be flagged by the checker.
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
