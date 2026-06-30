import { readFile, readdir } from "./index.ts";
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";
import {
  brandContained,
  unbrand,
  type SymlinkFreeContainedPath,
} from "./branded-paths-internal.ts";

/**
 * Resolve a project-relative path for a symlink-free contained read. Unlike
 * {@link resolveWithinProject} (containment-only — allows in-project symlinks),
 * this uses {@link resolveSymlinkFreeProjectPath} so an in-project symlink
 * alias (e.g. `.code-pact/agent-profiles -> ../alt`) is rejected before any
 * read/stat/readdir.
 *
 * Returns a branded `SymlinkFreeContainedPath` — containment only, NOT
 * namespace ownership. The caller must verify the path belongs to an owned
 * namespace (e.g. `.code-pact/project.yaml`, `design/roadmap.yaml`) BEFORE
 * calling.
 */
export async function resolveSymlinkFreeReadCandidate(
  cwd: string,
  relPath: string,
): Promise<SymlinkFreeContainedPath> {
  const abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
  return brandContained(abs);
}

/**
 * Read a text file via owned-read resolution. Throws on ENOENT, symlink
 * escape, or any I/O error — callers handle these per their error-mapping
 * contract.
 */
export async function readOwnedText(
  cwd: string,
  relPath: string,
): Promise<string> {
  const abs = await resolveSymlinkFreeReadCandidate(cwd, relPath);
  return readFile(unbrand(abs), "utf8");
}

/**
 * List a directory via owned-read resolution. Throws on ENOENT, symlink
 * escape, or any I/O error. Returns entry names (not full paths).
 */
export async function listOwnedDirectory(
  cwd: string,
  relPath: string,
): Promise<string[]> {
  const abs = await resolveSymlinkFreeReadCandidate(cwd, relPath);
  return readdir(unbrand(abs));
}
