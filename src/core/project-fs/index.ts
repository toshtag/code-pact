/**
 * Branded filesystem API seam for code-pact.
 *
 * This module exports ONLY branded path types, branded operations, and
 * namespace-specific authority resolvers. Raw fs primitives are available
 * from {@link ./raw-internal.ts} — but only trusted modules (listed in
 * `TRUSTED_FS_MODULES` in `check-fs-authority.mjs`) may import from there.
 * The `check:fs-authority` AST gate enforces this at CI time.
 *
 * Domain modules MUST use the branded operations or namespace-specific
 * resolvers instead of raw fs functions.
 */
export type {
  SymlinkFreeContainedPath,
  OwnedReadPath,
  OwnedWritePath,
  OwnedDeletePath,
} from "./branded-paths.ts";

export {
  readOwnedText,
  readOwnedBytes,
  statOwned,
  listOwned,
  writeOwnedText,
  removeOwned,
  unlinkOwned,
  renameOwned,
  copyOwnedToOwned,
  accessOwned,
} from "./operations.ts";

export {
  resolveDecisionReadPath,
  resolveDecisionDirectoryReadPath,
  resolvePhaseReadPath,
  resolveRoadmapReadPath,
  resolveProjectConfigReadPath,
  resolveModelProfileReadPath,
  resolveModelProfileDirectoryReadPath,
  resolveProgressReadPath,
  resolveGitignoreReadPath,
  resolveInstructionReadPath,
  resolveContextDirectoryReadPath,
  resolveOwnedDirectoryReadPath,
  resolveAgentProfileReadPath,
  resolveAdapterStaticReadPath,
} from "./authority-resolvers.ts";
