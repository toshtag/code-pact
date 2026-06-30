/**
 * Internal brand constructors for filesystem authority.
 *
 * This module is intentionally separate from {@link ./branded-paths.ts} so
 * that the brand constructor functions are not publicly exported from the
 * main barrel. Only authority boundary modules (see
 * `BRAND_CONSTRUCTOR_IMPORT_ALLOWLIST` in `scripts/check-fs-authority.mjs`)
 * may import from this module. Domain modules must use the typed resolvers
 * (e.g. `resolveOwnedAgentProfilePath`) instead.
 */
import type {
  SymlinkFreeContainedPath,
  OwnedReadPath,
  OwnedWritePath,
  OwnedDeletePath,
} from "./branded-paths.ts";

export type {
  SymlinkFreeContainedPath,
  OwnedReadPath,
  OwnedWritePath,
  OwnedDeletePath,
};

export { unbrand } from "./branded-paths.ts";

export function brandContained(path: string): SymlinkFreeContainedPath {
  return path as SymlinkFreeContainedPath;
}

export function brandOwnedRead(path: string): OwnedReadPath {
  return path as OwnedReadPath;
}

export function brandOwnedWrite(path: string): OwnedWritePath {
  return path as OwnedWritePath;
}

export function brandOwnedDelete(path: string): OwnedDeletePath {
  return path as OwnedDeletePath;
}
