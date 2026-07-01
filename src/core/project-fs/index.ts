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
  ExplicitUserReadPath,
  OwnedListPath,
} from "./branded-paths.ts";

export type { FileHandle } from "./raw-internal.ts";
export { constants } from "./raw-internal.ts";

export {
  readOwnedText,
  readExplicitUserText,
  statOwned,
  statExplicitUser,
  statOwnedList,
  listOwned,
  listOwnedDirents,
  unlinkOwned,
  accessOwned,
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
  openOwnedRead,
  openOwnedReadWithFlags,
  openOwnedWriteExclusive,
  openOwnedWrite,
  existsOwnedSync,
  readOwnedFileSync,
  readdirOwnedSync,
  listOwnedDirentsSync,
  realpathOwned,
  realpathOwnedSync,
  mkdtempOwned,
  removeOwnedPath,
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
  resolveAdapterStaticReadPath,
  resolveRulesReadPath,
  resolveRulesDirectoryReadPath,
  resolveDoctorConfigReadPath,
  resolveExplicitUserReadPath,
  resolveInitWritePath,
  resolveInitReadPath,
  resolveInitListPath,
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
