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
 * A path resolved from explicit user input (e.g. `--from-file`). This grants
 * read access ONLY — it cannot be passed to write, delete, or mkdir operations.
 */
export type ExplicitUserReadPath = string & {
  readonly [brand]: "explicit_user_read";
};

/**
 * A path resolved for directory listing. This grants listing (readdir) access
 * ONLY — it cannot be passed to readOwnedText, write, or delete operations.
 */
export type OwnedListPath = string & {
  readonly [brand]: "owned_list";
};

/**
 * A temporary sandbox path created by a dedicated sandbox authority. It is not
 * an owned project write path and cannot be passed to project write/delete
 * operations.
 */
export type TemporarySandboxPath = string & {
  readonly [brand]: "temporary_sandbox";
};

/**
 * Extract the underlying string from any branded path.
 */
export function unbrand(
  path:
    | SymlinkFreeContainedPath
    | OwnedReadPath
    | OwnedWritePath
    | OwnedDeletePath
    | ExplicitUserReadPath
    | OwnedListPath
    | TemporarySandboxPath,
): string {
  return path as string;
}
