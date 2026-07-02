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
declare const archiveAuthorityBrand: unique symbol;
declare const adapterAuthorityBrand: unique symbol;
declare const validatedAuthorityBrand: unique symbol;

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
 * A path resolved from explicit user output selection (e.g. `--output-dir`).
 * This grants write access ONLY through explicit-user write sinks; it is not an
 * owned namespace path and cannot be read, deleted, or passed to owned writes.
 */
export type ExplicitUserWritePath = string & {
  readonly [brand]: "explicit_user_write";
};

/**
 * A path resolved for directory listing. This grants listing (readdir) access
 * ONLY — it cannot be passed to readOwnedText, write, or delete operations.
 */
export type OwnedListPath = string & {
  readonly [brand]: "owned_list";
};

/**
 * A path resolved only for project-tree walking. This grants directory listing
 * for broad project discovery, but it is intentionally not an OwnedListPath and
 * cannot be passed to read/write/delete operations.
 */
export type ProjectTreeListPath = string & {
  readonly [brand]: "project_tree_list";
};

/**
 * A path resolved only to probe project-relative existence/access. It is not an
 * OwnedReadPath and cannot be used to read file content.
 */
export type ProjectPresencePath = string & {
  readonly [brand]: "project_presence";
};

/**
 * A path admitted by the archive authority. This is a domain proof, not a
 * concrete operation capability; archive-specific helpers convert it to
 * read/write/delete/list capabilities as needed.
 */
export type ArchiveAuthorityPath = string & {
  readonly [archiveAuthorityBrand]: "archive_authority";
};

/**
 * A path admitted by the adapter authority. This covers both adapter-managed
 * project files and adapter-private transaction state after their respective
 * authority checks.
 */
export type AdapterAuthorityPath = string & {
  readonly [adapterAuthorityBrand]: "adapter_authority";
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
 * A path validated by a domain-specific authority boundary that is not
 * necessarily project-relative, such as code-pact's private per-user state
 * directory. This is still only a proof that a boundary checked the path; the
 * operation-specific wrapper grants the concrete read/write/delete capability.
 */
export type ValidatedAuthorityPath = string & {
  readonly [validatedAuthorityBrand]: "validated_authority_path";
};

export type AuthorityPathProof =
  | SymlinkFreeContainedPath
  | OwnedReadPath
  | OwnedWritePath
  | OwnedDeletePath
  | OwnedListPath
  | ProjectTreeListPath
  | ArchiveAuthorityPath
  | AdapterAuthorityPath
  | ValidatedAuthorityPath;

/**
 * Extract the underlying string from any branded path.
 */
export function unbrand(
  path: AuthorityPathProof | ExplicitUserReadPath | ExplicitUserWritePath | ProjectPresencePath | TemporarySandboxPath,
): string {
  return path as string;
}
