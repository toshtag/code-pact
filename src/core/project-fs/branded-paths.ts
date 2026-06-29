/**
 * Branded path types for filesystem authority.
 *
 * These nominal types prevent accidental mixing of paths with different
 * authority levels. A `SymlinkFreeContainedPath` cannot be passed where an
 * `OwnedWritePath` is expected without an explicit conversion through the
 * appropriate authority resolver.
 *
 * The brands are structural (using a unique symbol property) so they are
 * erased at runtime — no runtime overhead — but the TypeScript compiler
 * enforces the distinction at compile time.
 */

declare const brand: unique symbol;

/**
 * A path that has been resolved via `resolveSymlinkFreeProjectPath` — it is
 * contained within the project root and has no symlink components. This
 * grants containment but NOT namespace ownership.
 */
export type SymlinkFreeContainedPath = string & {
  readonly [brand]: "symlink_free_contained";
};

/**
 * A path that has been resolved via an owned-read authority resolver. This
 * grants read access to a specific owned namespace (e.g. `.code-pact/`,
 * `design/`).
 */
export type OwnedReadPath = string & {
  readonly [brand]: "owned_read";
};

/**
 * A path that has been resolved via an owned-write authority resolver. This
 * grants write access to a specific owned namespace.
 */
export type OwnedWritePath = string & {
  readonly [brand]: "owned_write";
};

/**
 * A path that has been resolved via an owned-delete authority resolver. This
 * grants delete access to a specific owned namespace.
 */
export type OwnedDeletePath = string & {
  readonly [brand]: "owned_delete";
};

/**
 * Brand a plain string as a symlink-free contained path. Only call this from
 * `resolveSymlinkFreeProjectPath` or its wrappers.
 */
export function brandContained(
  path: string,
): SymlinkFreeContainedPath {
  return path as SymlinkFreeContainedPath;
}

/**
 * Brand a plain string as an owned-read path. Only call this from
 * `resolveOwnedReadPath` or its wrappers.
 */
export function brandOwnedRead(path: string): OwnedReadPath {
  return path as OwnedReadPath;
}

/**
 * Brand a plain string as an owned-write path. Only call this from
 * `resolveOwnedAgentProfilePath` or equivalent owned-write resolvers.
 */
export function brandOwnedWrite(path: string): OwnedWritePath {
  return path as OwnedWritePath;
}

/**
 * Brand a plain string as an owned-delete path. Only call this from
 * owned-delete resolvers.
 */
export function brandOwnedDelete(path: string): OwnedDeletePath {
  return path as OwnedDeletePath;
}

/**
 * Extract the underlying string from any branded path.
 */
export function unbrand(path: SymlinkFreeContainedPath | OwnedReadPath | OwnedWritePath | OwnedDeletePath): string {
  return path as string;
}
