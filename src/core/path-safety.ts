import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { RelativePosixPath } from "./schemas/adapter-manifest.ts";

// ---------------------------------------------------------------------------
// Neutral path-safety module
//
// Originally defined under src/core/adapters/file-state.ts in v0.9 (the
// adapter platform). v1.1 (P10-T3) promotes these helpers to a neutral
// module so plan lint, future P11 finalize, and future P14 governance
// can call them without taking an adapter dependency. The adapter file
// re-exports the same symbols so existing call sites
// (adapter-install / adapter-upgrade / adapter-file-state tests)
// remain untouched.
// ---------------------------------------------------------------------------

/**
 * Throws if `relPath` is not a safe project-relative POSIX path. Delegates
 * to the same zod refinement used by the manifest schema so callers get one
 * consistent rule set: empty / leading `/` / leading `~` / `\` / Windows
 * drive letter / `..` / `.` / empty segments are all rejected.
 *
 * This is a structural check only — it does NOT touch the filesystem. Use
 * `resolveWithinProject` to additionally guard against symlink escape.
 */
export function assertSafeRelativePath(relPath: string): void {
  RelativePosixPath.parse(relPath);
}

/**
 * Resolves `relPath` against `cwd` and returns the joined absolute path,
 * but throws if any existing ancestor of the target resolves outside
 * `realpath(cwd)` via a symlink. The check walks up from the target
 * through existing parents until it finds one that exists on disk; that
 * ancestor's realpath must remain within the project root.
 *
 * Returns the path joined to the ORIGINAL `cwd` (not the realpath'd
 * cwd). This matters on macOS where `/var/folders/...` is a symlink to
 * `/private/var/folders/...`; users passing the former in expect the
 * former back out. The realpath is computed internally only for the
 * symlink-escape safety check.
 *
 * Throws on:
 *  - any structural path failure from `assertSafeRelativePath`
 *  - an existing ancestor whose realpath escapes the project root
 */
export async function resolveWithinProject(
  cwd: string,
  relPath: string,
): Promise<string> {
  assertSafeRelativePath(relPath);
  const cwdReal = await realpath(cwd);
  const target = resolve(cwd, relPath);
  const targetReal = resolve(cwdReal, relPath);

  // Walk up `targetReal` (the realpath-rooted candidate) until we hit
  // something that exists on disk, then verify its realpath is still
  // under cwdReal. This catches symlink escape both for files that
  // exist and for files we are about to create whose parent directory
  // is a symlink to outside the project.
  let ancestor = targetReal;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const ancestorReal = await realpath(ancestor);
      if (
        ancestorReal !== cwdReal &&
        !ancestorReal.startsWith(cwdReal + sep)
      ) {
        throw new Error(
          `path "${relPath}" resolves outside project root (ancestor "${ancestor}" → "${ancestorReal}")`,
        );
      }
      return target;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const parent = dirname(ancestor);
        if (parent === ancestor) {
          // Reached filesystem root without finding an existing ancestor.
          // This cannot happen in practice because cwd itself exists, but
          // guard defensively so we never loop forever.
          return target;
        }
        ancestor = parent;
        continue;
      }
      throw err;
    }
  }
}
