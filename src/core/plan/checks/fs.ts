import { accessOwned, existsOwnedSync } from "../../project-fs/operations.ts";
import { projectConfigReadPath } from "../../project-fs/authorities/project-config-authority.ts";
import {
  resolveSymlinkFreeProjectPath,
  resolveSymlinkFreeProjectPathSync,
} from "../../path-safety.ts";

/**
 * True when `p` exists and is accessible. Shared internal helper for the
 * existence detectors that span clusters (phase files in phase-files.ts;
 * decision_refs / acceptance_refs in path-fields.ts). Not re-exported by the
 * `checks.ts` barrel — it is an implementation detail, not part of the lint
 * detector surface.
 */
export async function fileExists(p: string): Promise<boolean> {
  try {
    await accessOwned(projectConfigReadPath(p));
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
    await accessOwned(projectConfigReadPath(p));
    return "present";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "inaccessible";
  }
}

export type ProjectPathPresence = "present" | "absent" | "inaccessible";

/**
 * Three-way presence for project-relative references. Unlike a lexical
 * `access(join(cwd, relPath))`, this refuses external or dangling symlink
 * traversal before probing existence, so refs cannot be satisfied by files
 * outside the project root.
 */
export async function projectPathPresence(
  cwd: string,
  relPath: string,
): Promise<ProjectPathPresence> {
  let abs: string;
  try {
    abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
  } catch {
    return "inaccessible";
  }
  try {
    await accessOwned(projectConfigReadPath(abs));
    return "present";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "inaccessible";
  }
}

export function projectPathPresenceSync(
  cwd: string,
  relPath: string,
): ProjectPathPresence {
  let abs: string;
  try {
    abs = resolveSymlinkFreeProjectPathSync(cwd, relPath);
  } catch {
    return "inaccessible";
  }
  return existsOwnedSync(projectConfigReadPath(abs)) ? "present" : "absent";
}
