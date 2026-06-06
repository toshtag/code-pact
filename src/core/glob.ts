import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Minimal glob support for the Task Readiness Schema.
//
// Supported subset:
//   - literal path segments
//   - `*` within a single segment (does not match `/`)
//   - `**` as a full path segment only (matches zero or more segments)
//
// Explicitly NOT supported:
//   - brace expansion        `{a,b}`
//   - extglob                `@(...)` / `+(...)` / `*(...)` / `?(...)` / `!(...)`
//   - negation               `!pattern`
//   - character classes      `[abc]`
//   - backslash escape       `\*`
//
// `validateGlobSyntax` returns null when the pattern is in-subset and a
// reason string otherwise. `globToRegex` compiles an in-subset pattern
// to a RegExp anchored with `^...$`. Both treat the input as a POSIX-
// style, repo-root-relative path (forward slashes, no leading `./`).
// ---------------------------------------------------------------------------

/** Standard directory names skipped by `walkAndMatch`. */
const WALK_IGNORE_DIRS = new Set<string>([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".code-pact",
  ".context",
  ".local",
  ".claude",
  ".cursor",
  ".vscode",
  ".idea",
]);

/**
 * Returns null if `pattern` uses only the supported glob subset.
 * Returns a human-readable reason string when the pattern uses syntax
 * outside the subset.
 *
 * The check is purely syntactic — it does not look at the filesystem.
 */
export function validateGlobSyntax(pattern: string): string | null {
  if (pattern.length === 0) return "empty glob pattern";
  if (pattern.startsWith("!")) return "negation patterns ('!') are not supported in P10";
  if (/[{}]/.test(pattern)) return "brace expansion ('{...}') is not supported in P10";
  if (/[@+?!*]\(/.test(pattern)) return "extglob syntax ('@(...)', '+(...)', '*(...)', '?(...)', '!(...)') is not supported in P10";
  if (/[[\]]/.test(pattern)) return "character classes ('[...]') are not supported in P10";
  if (pattern.includes("\\")) return "backslash escapes are not supported in P10";

  for (const segment of pattern.split("/")) {
    if (segment.includes("**") && segment !== "**") {
      return `'**' must occupy a full path segment, got "${segment}"`;
    }
  }
  return null;
}

/**
 * Compiles a subset glob to an anchored RegExp. The caller is
 * expected to have validated the pattern first via `validateGlobSyntax`;
 * calling this with an out-of-subset pattern is undefined behaviour
 * (the regex may still compile but its semantics are not specified).
 *
 * Conversion rules:
 *   - `**` (full segment) consumes zero or more `/`-separated segments
 *   - `*` (in segment) consumes any run of non-`/` characters
 *   - literal characters are regex-escaped
 *
 * Examples (input glob, then resulting regex):
 *   - `src/commands/(star).ts`     -> `^src/commands/[^/](star)\.ts$`
 *   - `tests/(double)/(star).ts`   -> `^tests/(?:.(star)/)?[^/](star)\.ts$`
 *   - `(double)`                   -> `^.(star)$`
 *   - `design/phases/(star).yaml`  -> `^design/phases/[^/](star)\.yaml$`
 *
 * The substitutions `(star)` and `(double)` stand in for the real `*`
 * and `**` tokens here only because the literal sequence would close
 * this block comment. The actual implementation handles them directly.
 */
export function globToRegex(pattern: string): RegExp {
  const DOUBLE = ""; // sentinel for `**` segments
  const segments = pattern.split("/").map((seg) => {
    if (seg === "**") return DOUBLE;
    // Escape regex metachars (excluding `*`), then expand `*` to `[^/]*`.
    const escaped = seg.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    return escaped.replace(/\*/g, "[^/]*");
  });

  let joined = segments.join("/");
  // Collapse `/**/` patterns and boundaries so `**` matches zero+ segments.
  joined = joined
    .replace(new RegExp(`/${DOUBLE}/`, "g"), "/(?:.*/)?")
    .replace(new RegExp(`/${DOUBLE}$`, "g"), "(?:/.*)?")
    .replace(new RegExp(`^${DOUBLE}/`, "g"), "(?:.*/)?")
    .replace(new RegExp(`^${DOUBLE}$`, "g"), ".*")
    .replace(new RegExp(DOUBLE, "g"), ".*");

  return new RegExp(`^${joined}$`);
}

/**
 * Walks `cwd` recursively and returns the repo-root-relative POSIX
 * paths that match `pattern`. Uses `globToRegex` internally; the caller
 * is responsible for validating the pattern's syntax first.
 *
 * Standard ignore directories (.git / node_modules / dist / .code-pact
 * / .context / .local / .claude / .cursor / .vscode / .idea) are
 * skipped to keep the walk bounded for typical projects. Files inside
 * ignored directories are not returned even if they would match.
 *
 * Returns an empty array when nothing matches or `cwd` is unreadable.
 */
export async function walkAndMatch(
  cwd: string,
  pattern: string,
): Promise<string[]> {
  const regex = globToRegex(pattern);
  const matches: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(cwd, abs));
      if (entry.isDirectory()) {
        if (WALK_IGNORE_DIRS.has(entry.name)) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        if (regex.test(rel)) matches.push(rel);
      }
    }
  }

  await walk(cwd);
  return matches.sort();
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}

// ---------------------------------------------------------------------------
// Pattern-vs-pattern overlap check for protected-path detection.
// ---------------------------------------------------------------------------

/**
 * A protected path entry: a glob plus a representative concrete sample
 * that any "covers this protected pattern" check can test the declared
 * write pattern against. The sample is chosen so that
 * `globToRegex(declaredWrite).test(sample)` returning true is a strong
 * signal that the declared write would actually touch a protected
 * resource if executed.
 */
export type ProtectedPathEntry = {
  pattern: string;
  /** Concrete path matched by `pattern`. */
  sample: string;
};

/**
 * Protected-path seed set. Intentionally narrow and advisory.
 */
export const PROTECTED_PATHS: readonly ProtectedPathEntry[] = [
  { pattern: ".git/**", sample: ".git/HEAD" },
  { pattern: "node_modules/**", sample: "node_modules/package/index.js" },
  { pattern: ".code-pact/**", sample: ".code-pact/state/progress.yaml" },
  { pattern: "design/roadmap.yaml", sample: "design/roadmap.yaml" },
  { pattern: "design/phases/*.yaml", sample: "design/phases/P0-example.yaml" },
];

/**
 * Returns the list of protected entries that overlap with the supplied
 * declared write glob. "Overlap" here is approximated by two cheap
 * tests:
 *
 *   1. The declared glob's regex matches the protected pattern's
 *      representative sample. Catches cases where the declared glob is
 *      broader than (or equal to) the protected pattern, e.g.
 *      `design/**` overlaps `design/phases/*.yaml`.
 *   2. The protected pattern's regex matches a concrete sample
 *      synthesized from the declared glob (wildcards swapped for
 *      filler tokens). Catches cases where the declared glob is
 *      narrower than (or equal to) the protected pattern, e.g.
 *      `design/phases/P1-foundation.yaml` overlaps the
 *      `design/phases/*.yaml` pattern.
 *
 * Either match returning true is treated as overlap. This is a coarse
 * but predictable heuristic suitable for an advisory warning
 * surface. False negatives are possible for unusual patterns.
 *
 * Returns an empty array when no overlap is detected, or when the
 * declared pattern's syntax is invalid (the latter is the
 * `TASK_WRITES_GLOB_INVALID` detector's concern, not this one's).
 */
export function findProtectedPathOverlaps(
  declaredGlob: string,
  protectedPaths: readonly ProtectedPathEntry[] = PROTECTED_PATHS,
): ProtectedPathEntry[] {
  if (validateGlobSyntax(declaredGlob) !== null) return [];
  const declaredRe = globToRegex(declaredGlob);
  const declaredSample = synthesizeSample(declaredGlob);
  return protectedPaths.filter((entry) => {
    if (declaredRe.test(entry.sample)) return true;
    const protectedRe = globToRegex(entry.pattern);
    return protectedRe.test(declaredSample);
  });
}

/**
 * Replaces wildcards in a glob with non-empty placeholder tokens to
 * produce one concrete representative path. `*` becomes a single-segment
 * filler, `**` becomes a multi-segment filler. Used by the
 * protected-path overlap heuristic (here and in the loader
 * for `design/rules/protected-paths.md`); the placeholders are
 * deliberately recognizable so test failures point back at this
 * synthesis routine.
 */
export function synthesizeSample(glob: string): string {
  const segments = glob.split("/").map((seg) => {
    if (seg === "**") return "p10sampledir";
    return seg.replace(/\*/g, "p10sample");
  });
  return segments.join("/");
}
