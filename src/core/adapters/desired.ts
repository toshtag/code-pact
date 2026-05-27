import type { DesiredAdapterFile } from "./types.ts";

/**
 * Enforces path uniqueness across an adapter's desired file set before the
 * install/upgrade engines consume it.
 *
 * - Same path + identical content → de-duplicated (the duplicate is dropped).
 * - Same path + DIFFERENT content → internal invariant violation; throws.
 *
 * This is defense-in-depth behind each adapter's own collision handling
 * (e.g. the Claude adapter reserves built-in skill names and uniquifies
 * verification-command-derived skills). If a generator regression ever lets
 * two files collide on a path with differing content, we fail loudly here
 * instead of silently letting the manifest's last-write-wins corrupt the
 * adapter's converged state.
 */
export function dedupeDesiredFiles(
  files: readonly DesiredAdapterFile[],
): DesiredAdapterFile[] {
  const byPath = new Map<string, DesiredAdapterFile>();
  const out: DesiredAdapterFile[] = [];
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (existing === undefined) {
      byPath.set(file.path, file);
      out.push(file);
      continue;
    }
    if (existing.content === file.content) {
      // Identical duplicate — drop it; the first occurrence already stands.
      continue;
    }
    const err = new Error(
      `Adapter generator produced two desired files at "${file.path}" with ` +
        `different content. This is an internal bug — desired file paths must ` +
        `be unique.`,
    );
    (err as NodeJS.ErrnoException).code = "ADAPTER_DESIRED_PATH_CONFLICT";
    throw err;
  }
  return out;
}
