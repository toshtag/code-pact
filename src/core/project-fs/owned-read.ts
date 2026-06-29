import { readFile, readdir } from "node:fs/promises";
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";

/**
 * Resolve a project-relative path for an OWNED control-plane read. Unlike
 * {@link resolveWithinProject} (containment-only — allows in-project symlinks),
 * this uses {@link resolveSymlinkFreeProjectPath} so an in-project symlink
 * alias (e.g. `.code-pact/agent-profiles -> ../alt`) is rejected before any
 * read/stat/readdir.
 *
 * This module does NOT grant namespace authority — the caller must verify
 * the path belongs to an owned namespace (e.g. `.code-pact/project.yaml`,
 * `design/roadmap.yaml`) BEFORE calling.
 */
export async function resolveOwnedReadPath(
  cwd: string,
  relPath: string,
): Promise<string> {
  return resolveSymlinkFreeProjectPath(cwd, relPath);
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
  const abs = await resolveOwnedReadPath(cwd, relPath);
  return readFile(abs, "utf8");
}

/**
 * List a directory via owned-read resolution. Throws on ENOENT, symlink
 * escape, or any I/O error. Returns entry names (not full paths).
 */
export async function listOwnedDirectory(
  cwd: string,
  relPath: string,
): Promise<string[]> {
  const abs = await resolveOwnedReadPath(cwd, relPath);
  return readdir(abs);
}
