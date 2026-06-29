import { lstat, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { RelativePosixPath } from "./schemas/relative-path.ts";

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
 * True if resolving `relPath` under `cwd` traverses ANY symlink component — a
 * parent dir OR the final entry.
 *
 * This is the OWNERSHIP companion to {@link resolveWithinProject}'s CONTAINMENT.
 * resolveWithinProject only proves the canonical target stays inside the project
 * and returns the LEXICAL path; it deliberately allows an IN-project symlink. But
 * a destructive AUTO action (overwrite / delete of an existing file) authorizes
 * itself by matching that lexical path against an owned-namespace glob — and an
 * in-project symlink (e.g. `.claude/skills -> ../src`) makes the lexical owned
 * path resolve to a DIFFERENT real file (`src/...`), so the glob match is NOT
 * proof of ownership of the real destination. Such actions must refuse a path
 * that traverses a symlink, so lexical path == real destination (CWE-59/CWE-61).
 *
 * Existence-tolerant: a not-yet-created tail returns false (nothing below a
 * missing entry can be a symlink) — callers gate this only for actions on an
 * EXISTING target, where every component exists.
 */
export async function pathTraversesSymlink(
  cwd: string,
  relPath: string,
): Promise<boolean> {
  assertSafeRelativePath(relPath);
  let base = await realpath(cwd);
  for (const seg of relPath.split("/").filter(s => s.length > 0 && s !== ".")) {
    const candidate = join(base, seg);
    let st: import("node:fs").Stats;
    try {
      st = await lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return false; // missing component → nothing below it can be a symlink
    }
    if (st.isSymbolicLink()) return true;
    base = candidate;
  }
  return false;
}

export function pathTraversesSymlinkSync(
  cwd: string,
  relPath: string,
): boolean {
  assertSafeRelativePath(relPath);
  let base = realpathSync(cwd);
  for (const seg of relPath.split("/").filter(s => s.length > 0 && s !== ".")) {
    const candidate = join(base, seg);
    let st: import("node:fs").Stats;
    try {
      st = lstatSync(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return false;
    }
    if (st.isSymbolicLink()) return true;
    base = candidate;
  }
  return false;
}

/**
 * Resolve a project-relative path for an owned automated write/delete namespace.
 *
 * Unlike {@link resolveWithinProject}, this rejects EVERY symlink component,
 * including symlinks whose final target stays inside the project. That stricter
 * ownership rule is required for generated control-plane namespaces such as
 * `design/`, `.code-pact/state/events/`, and archive stores: a lexical path
 * match is not proof that the real destination belongs to that namespace if any
 * component is a symlink.
 *
 * Missing tails are still allowed so callers can create fresh directories/files.
 */
export async function resolveSymlinkFreeProjectPath(
  cwd: string,
  relPath: string,
): Promise<string> {
  if (await pathTraversesSymlink(cwd, relPath)) {
    const err = new Error(
      `path "${relPath}" resolves through a symlink; refusing to write/delete through an unowned project path`,
    );
    (err as NodeJS.ErrnoException).code = "PATH_NOT_OWNED";
    throw err;
  }
  return resolveWithinProject(cwd, relPath);
}

export function resolveSymlinkFreeProjectPathSync(
  cwd: string,
  relPath: string,
): string {
  if (pathTraversesSymlinkSync(cwd, relPath)) {
    const err = new Error(
      `path "${relPath}" resolves through a symlink; refusing to write/delete through an unowned project path`,
    );
    (err as NodeJS.ErrnoException).code = "PATH_NOT_OWNED";
    throw err;
  }
  return resolveWithinProjectSync(cwd, relPath);
}

/** @deprecated Use resolveSymlinkFreeProjectPath instead. */
export const resolveOwnedProjectPath = resolveSymlinkFreeProjectPath;
/** @deprecated Use resolveSymlinkFreeProjectPathSync instead. */
export const resolveOwnedProjectPathSync = resolveSymlinkFreeProjectPathSync;

/**
 * Resolves `relPath` against `cwd` and returns the joined absolute path, but
 * throws `PATH_OUTSIDE_PROJECT` unless it resolves to a location WITHIN
 * `realpath(cwd)`. This is a WRITE-safe containment preflight: a not-yet-created
 * path is allowed (so callers can create files/dirs), but a DANGLING symlink is
 * refused regardless of where it points.
 *
 * Why per-component, not a single `realpath`: `realpath()` on a dangling symlink
 * fails with a bare `ENOENT`, indistinguishable from a genuinely not-yet-created
 * path — so a whole-path `realpath` would mistake `.ctx -> .../missing` for a
 * safe missing path. Instead this walks `relPath` one component at a time from
 * the real project root and uses `lstat` to tell the two apart: a plain missing
 * component ends the walk safely, while a symlink component is resolved with
 * `realpath(candidate)` (which fully follows chains and is correct on
 * case-insensitive / Windows filesystems). If that `realpath` throws, the
 * symlink is DANGLING (`ENOENT`) or cyclic (`ELOOP`) and is refused.
 *
 * Contract:
 *  - plain not-yet-created path (no symlink component)     → allowed (returned)
 *  - existing in-project path / in-project symlink (chain) → allowed
 *  - any symlink pointing OUTSIDE the project              → PATH_OUTSIDE_PROJECT
 *  - any DANGLING symlink (target absent), in- or out-of   → PATH_OUTSIDE_PROJECT
 *    project — writing through it is never intended for a
 *    generated path and would strand a partial side effect
 *  - symlink cycle (ELOOP)                                 → PATH_OUTSIDE_PROJECT
 *  - structural path failure (assertSafeRelativePath)      → throws (no code)
 *
 * Returns the path joined to the ORIGINAL `cwd` (not the realpath'd cwd). This
 * matters on macOS where `/var/folders/...` is a symlink to `/private/var/...`;
 * callers passing the former expect the former back. The resolution is internal,
 * only for the escape check. The `PATH_OUTSIDE_PROJECT` code lets command layers
 * map a refusal to a structured envelope; broad optional-source catchers that
 * degrade to null are unaffected (they ignore the code).
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

  // `base` is the canonical (symlink-resolved, existing) prefix walked so far —
  // always within the project (invariant: it starts at cwdReal and only advances
  // to a realpath'd symlink target that was containment-checked, or to a literal
  // existing child). `relPath` is pre-validated (no `..`, `.`, or empty segment).
  let base = cwdReal;

  for (const seg of relPath.split("/").filter(s => s.length > 0 && s !== ".")) {
    const candidate = join(base, seg);
    let st: import("node:fs").Stats;
    try {
      st = await lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // `candidate` does not exist as ANY entry (not even a symlink): a plain,
        // not-yet-created child of an in-project `base`. Everything below it is
        // likewise non-existent and cannot be a symlink — safe to create.
        return target;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      // Resolve the symlink fully via the OS (follows chains; correct on
      // case-insensitive / Windows paths). A DANGLING symlink surfaces as ENOENT
      // and a cycle as ELOOP — both refused: writing through a broken symlink is
      // never intended for a generated path and would strand a partial side
      // effect (e.g. a persisted `--model` pin) when the later mkdir/write fails.
      let real: string;
      try {
        real = await realpath(candidate);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ELOOP") {
          const broken = new Error(
            `path "${relPath}" resolves through a ${
              code === "ELOOP" ? "symlink cycle" : "dangling symlink"
            } (at "${candidate}")`,
          );
          (broken as NodeJS.ErrnoException).code = "PATH_OUTSIDE_PROJECT";
          throw broken;
        }
        throw err;
      }
      if (!within(real)) {
        const escape = new Error(
          `path "${relPath}" resolves outside project root (symlink "${candidate}" → "${real}")`,
        );
        (escape as NodeJS.ErrnoException).code = "PATH_OUTSIDE_PROJECT";
        throw escape;
      }
      base = real;
      continue;
    }
    // A real (non-symlink) directory or file. `base` stays within the project.
    base = candidate;
  }

  return target;
}

export function resolveWithinProjectSync(cwd: string, relPath: string): string {
  assertSafeRelativePath(relPath);
  const cwdReal = realpathSync(cwd);
  const target = resolve(cwd, relPath);
  const within = (p: string): boolean =>
    p === cwdReal || p.startsWith(cwdReal + sep);

  let base = cwdReal;
  for (const seg of relPath.split("/").filter(s => s.length > 0 && s !== ".")) {
    const candidate = join(base, seg);
    try {
      const st = lstatSync(candidate);
      if (st.isSymbolicLink()) {
        let linkReal: string;
        try {
          linkReal = realpathSync(candidate);
        } catch (err) {
          const e = new Error(
            `path "${relPath}" resolves through an unreadable or dangling symlink at "${seg}"`,
          );
          (e as NodeJS.ErrnoException).code = "PATH_OUTSIDE_PROJECT";
          throw e;
        }
        if (!within(linkReal)) {
          const e = new Error(`path "${relPath}" resolves outside the project`);
          (e as NodeJS.ErrnoException).code = "PATH_OUTSIDE_PROJECT";
          throw e;
        }
        base = linkReal;
      } else {
        base = candidate;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
  }

  if (!within(resolve(cwdReal, relPath))) {
    const e = new Error(`path "${relPath}" resolves outside the project`);
    (e as NodeJS.ErrnoException).code = "PATH_OUTSIDE_PROJECT";
    throw e;
  }
  return target;
}
