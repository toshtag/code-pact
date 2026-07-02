/**
 * Branded filesystem API seam for code-pact.
 *
 * This module exports ONLY branded path types, branded operations, and
 * namespace-specific authority resolvers. Raw fs primitives are available
 * from the raw-internal module — but only raw filesystem boundary modules
 * listed in `RAW_FS_IMPORT_ALLOWLIST` in `check-fs-authority.mjs` may import
 * from there.
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
  ExplicitUserReadPath,
  ExplicitUserWritePath,
  OwnedListPath,
  ProjectTreeListPath,
  ProjectPresencePath,
  TemporarySandboxPath,
} from "./branded-paths.ts";

export {
  readOwnedText,
  readExplicitUserText,
  statOwned,
  statExplicitUser,
  statOwnedList,
  listOwned,
  listOwnedDirents,
  listProjectTreeDirents,
  unlinkOwned,
  accessOwned,
  accessProjectPresence,
  lstatOwned,
  lstatExplicitUser,
  lstatOwnedList,
  mkdirOwned,
  writeOwnedText,
  writeOwnedFile,
  removeOwned,
  renameOwned,
  copyOwnedToOwned,
  linkOwned,
  existsOwnedSync,
  existsProjectPresenceSync,
  readOwnedTextSyncNoFollow,
  readdirOwnedSync,
  listOwnedDirentsSync,
  realpathOwned,
  writeOwnedTextExclusive,
  writeOwnedTempDurably,
  fsyncOwnedRegularFile,
  fsyncOwnedDirectory,
} from "./operations.ts";

export {
  resolveDecisionReadPath,
  resolveDecisionDirectoryReadPath,
  resolvePhaseReadPath,
  resolvePhaseDirectoryReadPath,
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
  resolveRulesReadPath,
  resolveRulesDirectoryReadPath,
  resolveDoctorConfigReadPath,
  resolveExplicitUserReadPath,
  // Write resolvers
  resolveDecisionWritePath,
  resolvePhaseWritePath,
  resolveRoadmapWritePath,
  resolveProgressWritePath,
  resolveInstructionWritePath,
  resolveModelProfileWritePath,
  resolveAgentProfileWritePath,
  resolveProjectConfigWritePath,
  resolveGitignoreWritePath,
  // Delete resolvers
  resolveDecisionDeletePath,
  resolvePhaseDeletePath,
  resolveProgressDeletePath,
} from "./authority-resolvers.ts";

export {
  resolveProjectScaffoldReadPath,
  resolveProjectScaffoldWritePath,
} from "./authorities/project-config-authority.ts";
