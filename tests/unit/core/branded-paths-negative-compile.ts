/**
 * Negative compile fixture: verifies that the branded path types reject
 * raw `string` at compile time. This file is NOT meant to be executed —
 * it is a static guarantee that `pnpm typecheck` catches misuse.
 *
 * If this file type-checks successfully, the branded path enforcement is
 * working correctly. If it ever compiles without errors when it shouldn't,
 * the brand types have been weakened.
 *
 * The fixture is excluded from the build (tsup entry points are explicit)
 * and from test runs (no `.test.ts` suffix). It lives in the `tests` tree
 * so `tsc --noEmit` picks it up via the project's `tsconfig.json`.
 */
import {
  readOwnedText,
  writeOwnedText,
  removeOwned,
  listOwned,
} from "../../../src/core/project-fs/index.ts";
import type {
  OwnedReadPath,
  OwnedWritePath,
  OwnedDeletePath,
} from "../../../src/core/project-fs/index.ts";

// --- These assignments MUST fail at compile time ---

// @ts-expect-error raw string is not an OwnedReadPath
const _badRead: OwnedReadPath = "/etc/passwd";

// @ts-expect-error raw string is not an OwnedWritePath
const _badWrite: OwnedWritePath = "/tmp/evil";

// @ts-expect-error raw string is not an OwnedDeletePath
const _badDelete: OwnedDeletePath = "/tmp/evil";

// @ts-expect-error readOwnedText rejects raw string
void readOwnedText("/etc/passwd" as string);

// @ts-expect-error writeOwnedText rejects raw string
void writeOwnedText("/tmp/evil" as string, "payload");

// @ts-expect-error removeOwned rejects raw string
void removeOwned("/tmp/evil" as string);

// @ts-expect-error listOwned rejects raw string
void listOwned("/etc" as string);

// --- These usages MUST compile (positive control) ---

// If we had a way to brand a path, these would work. The brand constructors
// are internalized in branded-paths-internal.ts and only available to
// authority boundary modules. This fixture intentionally does NOT import
// from branded-paths-internal.ts — domain modules must not.
// The positive control is that the @ts-expect-error directives above
// are satisfied (i.e. the errors ARE produced), proving the types are sound.
export {};
