import { access } from "node:fs/promises";

/**
 * True when `p` exists and is accessible. Shared internal helper for the
 * existence detectors that span clusters (phase files in phase-files.ts;
 * decision_refs / acceptance_refs in path-fields.ts). Not re-exported by the
 * `checks.ts` barrel — it is an implementation detail, not part of the lint
 * detector surface.
 */
export async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
