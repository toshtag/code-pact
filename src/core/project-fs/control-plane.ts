import { readOwnedText, statOwned, listOwned } from "./operations.ts";
import {
  resolvePhaseReadPath,
  resolvePhaseDirectoryReadPath,
  resolveDecisionReadPath,
  resolveDecisionDirectoryReadPath,
  resolveRoadmapReadPath,
  resolveInitReadPath,
} from "./authority-resolvers.ts";
import { PhaseRef } from "../schemas/roadmap.ts";

/**
 * Read a phase YAML from the project. The path must come from a validated
 * PhaseRef (roadmap-declared, under `design/phases/*.yaml`). Symlink-free
 * resolution rejects in-project symlink aliases before any read.
 */
export async function readOwnedPhaseRaw(
  cwd: string,
  ref: PhaseRef,
): Promise<string> {
  PhaseRef.parse(ref);
  return readOwnedText(await resolvePhaseReadPath(cwd, ref.path));
}

/**
 * Read a phase YAML from a raw path string. The path is validated against
 * the PhaseRef namespace contract (under `design/phases/*.yaml`) before
 * symlink-free resolution.
 */
export async function readOwnedPhaseRawByPath(
  cwd: string,
  phasePath: string,
): Promise<string> {
  const ref = PhaseRef.parse({ id: "unknown", path: phasePath, weight: 1 });
  return readOwnedText(await resolvePhaseReadPath(cwd, ref.path));
}

/**
 * Read a decision ADR markdown from the project. The path must be a valid
 * DecisionRefPath (a nested `.md` record under `design/decisions/`). Symlink-free
 * resolution rejects in-project symlink aliases before any read.
 */
export async function readOwnedDecisionRaw(
  cwd: string,
  decisionPath: string,
): Promise<string> {
  return readOwnedText(await resolveDecisionReadPath(cwd, decisionPath));
}

/**
 * Read the roadmap YAML from the project. Uses a fixed path
 * (`design/roadmap.yaml`) with symlink-free resolution.
 */
export async function readOwnedRoadmapRaw(cwd: string): Promise<string> {
  return readOwnedText(await resolveRoadmapReadPath(cwd));
}

/**
 * List the `design/phases/` directory via symlink-free resolution. The
 * directory root itself must not be a symlink. Entries that are symlinks
 * are NOT followed by the caller (readdir withFileTypes distinguishes).
 */
export async function listOwnedPhaseDirectory(cwd: string): Promise<string[]> {
  return listOwned(await resolvePhaseDirectoryReadPath(cwd));
}

/**
 * List the `design/decisions/` directory via symlink-free resolution. The
 * directory root itself must not be a symlink.
 */
export async function listOwnedDecisionDirectory(
  cwd: string,
): Promise<string[]> {
  return listOwned(await resolveDecisionDirectoryReadPath(cwd));
}

/**
 * Check existence of a path via symlink-free resolution + stat. Returns
 * "present", "absent", or "inaccessible". Used for control-plane paths
 * where in-project symlinks must be rejected.
 */
export async function ownedPathPresence(
  cwd: string,
  relPath: string,
): Promise<"present" | "absent" | "inaccessible"> {
  let path;
  try {
    path = await resolveInitReadPath(cwd, relPath);
  } catch {
    return "inaccessible";
  }
  try {
    await statOwned(path);
    return "present";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "inaccessible";
  }
}
