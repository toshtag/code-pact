import { readOwnedText, resolveRulesReadPath } from "../project-fs/index.ts";
import {
  PROTECTED_PATHS,
  synthesizeSample,
  validateGlobSyntax,
  type ProtectedPathEntry,
} from "../glob.ts";
import { assertSafeRelativePath } from "../path-safety.ts";

// ---------------------------------------------------------------------------
// Configurable protected paths.
//
// Loads `design/rules/protected-paths.md` and returns the list of
// `ProtectedPathEntry` records that `findProtectedPathOverlaps` should
// consult. When the file is absent, returns the hardcoded
// `PROTECTED_PATHS` constant from `src/core/glob.ts` for projects that
// have not opted into the override.
//
// File format (one entry per line):
//   - Lines starting with `#` are comments.
//   - Blank lines are ignored.
//   - Everything else is treated as a glob pattern in the supported
//     subset (literal segments, `*`, `**`).
//
// A file that exists but contains zero valid entries is interpreted as
// an explicit "no protected paths" — the user has opted out, NOT
// "fall back to defaults". This is the principle of least surprise: a
// hand-edited file is the source of truth for whoever edited it.
//
// Malformed entries (unsafe paths, glob syntax outside the supported subset)
// are silently skipped. The lint surface does not currently emit a
// diagnostic for malformed rule-file entries — that could ship as a
// future doctor / validate diagnostic if it proves useful in practice.
// ---------------------------------------------------------------------------

export const PROTECTED_PATHS_RULE_FILE = "design/rules/protected-paths.md";

export type LoadProtectedPathsResult = {
  paths: readonly ProtectedPathEntry[];
  /** Where the resolved list came from — useful for doctor / debugging. */
  source: "rule-file" | "fallback";
};

/**
 * Loads the configured protected-paths list, falling back to the
 * hardcoded `PROTECTED_PATHS` when the rule file is absent.
 *
 * Never throws on parse / read errors: an unreadable file is treated
 * the same as an absent file (fallback). This keeps `plan lint` robust
 * against transient filesystem issues.
 */
export async function loadProtectedPaths(
  cwd: string,
): Promise<LoadProtectedPathsResult> {
  let raw: string;
  try {
    raw = await readOwnedText(
      await resolveRulesReadPath(cwd, PROTECTED_PATHS_RULE_FILE),
    );
  } catch {
    return { paths: PROTECTED_PATHS, source: "fallback" };
  }

  const paths: ProtectedPathEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    // Strip end-of-line comments (`pattern  # note`). Keep simple — no
    // escape support; if someone needs a literal `#` in a glob they can
    // open an issue.
    const hashIdx = trimmed.indexOf("#");
    const pattern = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx).trim();
    if (pattern.length === 0) continue;

    if (!isSafePath(pattern)) continue;
    if (validateGlobSyntax(pattern) !== null) continue;

    paths.push({ pattern, sample: synthesizeSample(pattern) });
  }
  return { paths, source: "rule-file" };
}

function isSafePath(p: string): boolean {
  try {
    assertSafeRelativePath(p);
    return true;
  } catch {
    return false;
  }
}
