/**
 * @deprecated This module has been replaced by:
 *   - {@link ./authority-resolvers.ts} for namespace-specific read resolvers
 *   - {@link ./operations.ts} for branded filesystem operations
 *
 * The generic `resolveSymlinkFreeReadCandidate` and `readOwnedText(cwd, relPath)`
 * APIs have been removed because they only proved containment, not namespace
 * ownership. Use the specific resolvers from `authority-resolvers.ts` instead.
 */
export {};
