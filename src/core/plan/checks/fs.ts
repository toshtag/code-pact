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

/**
 * Three-way presence used by the design-docs-ephemeral archive readers (step 4a),
 * which must NOT treat "present but inaccessible" as "missing": a non-searchable
 * parent dir makes `access()` reject with EACCES, and collapsing that to "absent"
 * would let the snapshot RELEASE a live file that is actually there — a live-wins
 * violation. So `inaccessible` is a distinct, fail-closed outcome: archive
 * toleration applies ONLY to a genuine `absent` (ENOENT).
 */
export async function phaseFilePresence(
  p: string,
): Promise<"present" | "absent" | "inaccessible"> {
  try {
    await access(p);
    return "present";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "inaccessible";
  }
}
