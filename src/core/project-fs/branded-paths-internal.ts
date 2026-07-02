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
  ExplicitUserReadPath,
  ExplicitUserWritePath,
  OwnedListPath,
  ProjectTreeListPath,
  ProjectPresencePath,
  ArchiveAuthorityPath,
  AdapterAuthorityPath,
  TemporarySandboxPath,
  AuthorityPathProof,
  ValidatedAuthorityPath,
} from "./branded-paths.ts";

export type {
  SymlinkFreeContainedPath,
  OwnedReadPath,
  OwnedWritePath,
  OwnedDeletePath,
  ExplicitUserReadPath,
  ExplicitUserWritePath,
  OwnedListPath,
  ProjectTreeListPath,
  ProjectPresencePath,
  ArchiveAuthorityPath,
  AdapterAuthorityPath,
  TemporarySandboxPath,
  AuthorityPathProof,
  ValidatedAuthorityPath,
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

export function brandExplicitUserRead(path: string): ExplicitUserReadPath {
  return path as ExplicitUserReadPath;
}

export function brandExplicitUserWrite(path: string): ExplicitUserWritePath {
  return path as ExplicitUserWritePath;
}

export function brandOwnedList(path: string): OwnedListPath {
  return path as OwnedListPath;
}

export function brandProjectTreeList(path: string): ProjectTreeListPath {
  return path as ProjectTreeListPath;
}

export function brandProjectPresence(path: string): ProjectPresencePath {
  return path as ProjectPresencePath;
}

export function brandArchiveAuthority(path: string): ArchiveAuthorityPath {
  return path as ArchiveAuthorityPath;
}

export function brandAdapterAuthority(path: string): AdapterAuthorityPath {
  return path as AdapterAuthorityPath;
}

export function brandTemporarySandbox(path: string): TemporarySandboxPath {
  return path as TemporarySandboxPath;
}

export function brandValidatedAuthorityPath(
  path: string,
): ValidatedAuthorityPath {
  return path as ValidatedAuthorityPath;
}
