import { readFile } from "./project-fs/index.ts";
import { resolveSymlinkFreeProjectPath } from "./path-safety.ts";

/**
 * Reads an OPTIONAL, project-owned text file. `relPath` is resolved through
 * {@link resolveSymlinkFreeProjectPath}, so any symlink component is refused even when
 * its target remains inside the project root. Returns `null` when the path is
 * unsafe, unowned, missing, or unreadable.
 *
 * This is the read-side guard for any agent-facing "grounding" source whose
 * content is rendered into generated output (context packs, planning prompts).
 * A malicious repo must not be able to symlink such a source to an out-of-
 * project file and leak its contents into the agent-facing artifact (CWE-59).
 * This also rejects in-project aliases such as `design/brief.md -> ../.env`:
 * reserved control-plane paths must be real owned files, not symlink views into
 * other project-local secrets. Callers that need to distinguish "absent" from
 * "unsafe" should resolve the path themselves; this helper deliberately
 * collapses both to `null` for the optional-source degrade contract.
 */
export async function readProjectTextOrNull(
  cwd: string,
  relPath: string,
): Promise<string | null> {
  try {
    return await readFile(await resolveSymlinkFreeProjectPath(cwd, relPath), "utf8");
  } catch {
    return null;
  }
}
