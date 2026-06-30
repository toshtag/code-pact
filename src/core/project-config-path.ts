import { readFile, stat } from "./project-fs/raw-internal.ts";
import { resolveSymlinkFreeProjectPath } from "./path-safety.ts";

const PROJECT_YAML_LOCALE_MAX_BYTES = 64 * 1024;

/**
 * Single source of truth for the project config path. Uses
 * {@link resolveSymlinkFreeProjectPath} so an in-project symlink alias
 * (e.g. `.code-pact/project.yaml -> ../alt/project.yaml`) is rejected
 * before any read. Containment is not ownership.
 */
export async function resolveProjectConfigPath(cwd: string): Promise<string> {
  return resolveSymlinkFreeProjectPath(cwd, ".code-pact/project.yaml");
}

/**
 * Best-effort locale discovery via symlink-free resolution. Returns the raw
 * YAML string if the file is safe to read, or `null` on any error (symlink
 * escape, missing, too large, not a regular file). The caller parses locale
 * from the returned string — this helper only guards the filesystem boundary.
 *
 * This is used by CLI locale detection (a best-effort path that must never
 * read through a symlink) and by other callers that need the raw project.yaml
 * content without full schema validation.
 */
export async function readProjectYamlStrictOrNull(
  cwd: string,
): Promise<string | null> {
  try {
    const path = await resolveProjectConfigPath(cwd);
    const s = await stat(path);
    if (!s.isFile()) return null;
    if (s.size > PROJECT_YAML_LOCALE_MAX_BYTES) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
