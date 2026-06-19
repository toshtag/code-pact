import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { RelativePosixPath } from "./schemas/relative-path.ts";

// A symlink-resolution hop cap, matching the conventional OS `ELOOP` limit. A
// path that needs more hops is treated as an unresolvable cycle and refused with
// a stable path-safety code rather than spinning or surfacing a raw error.
const MAX_SYMLINK_HOPS = 40;

/**
 * Splits a `readlink` target into path components on EITHER separator, dropping
 * empty and `.` segments while PRESERVING `..` (the caller's walk pops a parent
 * for each `..`). Used for the non-root portion of a link target.
 */
function splitLinkSegments(linkBody: string): string[] {
  return linkBody.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
}

// ---------------------------------------------------------------------------
// Neutral path-safety module
//
// These helpers live in a neutral module so non-adapter callers
// (plan lint, finalize, governance) can use them without taking an
// adapter dependency. The adapter file re-exports the same symbols so
// existing call sites (adapter-install / adapter-upgrade /
// adapter-file-state tests) remain untouched.
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
 * Resolves `relPath` against `cwd` and returns the joined absolute path, but
 * throws `PATH_OUTSIDE_PROJECT` if it would resolve OUTSIDE `realpath(cwd)` via a
 * symlink — including a DANGLING symlink whose target does not exist.
 *
 * Why not `realpath`: `realpath()` fails with a bare `ENOENT` on a dangling
 * symlink, indistinguishable from a genuinely not-yet-created path. A walk that
 * trusts `realpath` therefore mistakes `.context -> /outside/does-not-exist` for
 * a safe missing path and lets a later `mkdir`/write escape the project. Instead
 * this canonicalizes `relPath` one component at a time from the real project
 * root, using `lstat`/`readlink` so a symlink is followed to where it POINTS even
 * when that target is absent. The final canonical location must stay within the
 * project; a genuinely non-existent component (not a symlink) ends the walk
 * safely (so creating new files/dirs still works).
 *
 * Contract:
 *  - non-existent in-project path (no symlink)            → allowed (returned)
 *  - existing in-project path / in-project symlink chain  → allowed
 *  - in-project symlink whose target is in-project but    → allowed (write
 *    absent (dangling-but-contained)                          lands in-project)
 *  - any symlink (existing OR dangling) pointing OUTSIDE   → PATH_OUTSIDE_PROJECT
 *  - unresolvable symlink cycle (> MAX_SYMLINK_HOPS)       → PATH_OUTSIDE_PROJECT
 *  - structural path failure (assertSafeRelativePath)      → throws (no code)
 *
 * Returns the path joined to the ORIGINAL `cwd` (not the realpath'd cwd). This
 * matters on macOS where `/var/folders/...` is a symlink to `/private/var/...`;
 * callers passing the former expect the former back. The canonicalization is
 * internal, only for the escape check. The `PATH_OUTSIDE_PROJECT` code lets
 * command layers map a refusal to a structured envelope; broad optional-source
 * catchers that degrade to null are unaffected (they ignore the code).
 */
export async function resolveWithinProject(
  cwd: string,
  relPath: string,
): Promise<string> {
  assertSafeRelativePath(relPath);
  const cwdReal = await realpath(cwd);
  const target = resolve(cwd, relPath);

  const within = (p: string): boolean =>
    p === cwdReal || p.startsWith(cwdReal + sep);

  // `base` is the canonical (symlink-free) absolute prefix resolved so far. It
  // starts at the real project root and only ever grows by a literal component,
  // a `..` pop, or a symlink redirect — each re-checked at the end.
  let base = cwdReal;
  const pending = relPath.split("/").filter((s) => s.length > 0 && s !== ".");
  let hops = 0;

  while (pending.length > 0) {
    const seg = pending.shift()!;
    if (seg === "..") {
      base = dirname(base);
      continue;
    }
    const candidate = join(base, seg);
    let st: import("node:fs").Stats;
    try {
      st = await lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // `candidate` does not exist as ANY entry (not even a symlink): a plain,
        // not-yet-created child of `base`. Nothing below it can be a symlink, so
        // adopt it and keep consuming the remaining literal segments.
        base = candidate;
        continue;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      if (++hops > MAX_SYMLINK_HOPS) {
        const cycle = new Error(
          `path "${relPath}" resolves through an unresolvable symlink cycle (at "${candidate}")`,
        );
        (cycle as NodeJS.ErrnoException).code = "PATH_OUTSIDE_PROJECT";
        throw cycle;
      }
      // Follow the link to where it POINTS, target existence irrelevant. An
      // absolute link restarts `base` at its root; a relative link resolves
      // against the directory holding it (`base`). Either way the link's segments
      // are re-processed, so a chain that leaves and re-enters the project is
      // judged by its FINAL canonical location, like realpath.
      const link = await readlink(candidate);
      if (isAbsolute(link)) {
        const root = parse(link).root;
        base = root;
        pending.unshift(...splitLinkSegments(link.slice(root.length)));
      } else {
        pending.unshift(...splitLinkSegments(link));
      }
      continue;
    }
    // A real (non-symlink) directory or file. `base` stays canonical.
    base = candidate;
  }

  if (!within(base)) {
    const escape = new Error(
      `path "${relPath}" resolves outside project root (→ "${base}")`,
    );
    (escape as NodeJS.ErrnoException).code = "PATH_OUTSIDE_PROJECT";
    throw escape;
  }
  return target;
}
