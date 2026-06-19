import { readFile } from "node:fs/promises";
import { resolveWithinProject } from "./path-safety.ts";

/**
 * Reads an OPTIONAL, project-contained text file. `relPath` is resolved through
 * {@link resolveWithinProject}, so a path that escapes the project root — `..`,
 * an absolute path, OR a symlink whose ancestor/target leaves `realpath(cwd)` —
 * is refused. Returns `null` when the path is unsafe, missing, or unreadable.
 *
 * This is the read-side guard for any agent-facing "grounding" source whose
 * content is rendered into generated output (context packs, planning prompts).
 * A malicious repo must not be able to symlink such a source to an out-of-
 * project file and leak its contents into the agent-facing artifact (CWE-59).
 * Callers that need to distinguish "absent" from "unsafe" should resolve the
 * path themselves; this helper deliberately collapses both to `null` for the
 * optional-source degrade contract.
 */
export async function readProjectTextOrNull(
  cwd: string,
  relPath: string,
): Promise<string | null> {
  try {
    return await readFile(await resolveWithinProject(cwd, relPath), "utf8");
  } catch {
    return null;
  }
}
