import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../schemas/roadmap.ts";
import { resolveWithinProject } from "../path-safety.ts";

/**
 * Strict loader for the phase registry at `design/roadmap.yaml`.
 *
 * Reads and schema-validates the roadmap, throwing on a missing or invalid
 * file (the throw-on-invalid contract every caller relied on). This is the
 * **strict** counterpart to the lenient plan-lint / `collectPlanArtifacts`
 * loader, which falls back to scanning `design/phases/` when the roadmap is
 * unreadable — the two are intentionally separate; do not conflate them.
 *
 * This is the single roadmap-discovery seam shared by every command.
 */
export async function loadRoadmap(cwd: string): Promise<Roadmap> {
  // Contain the read: a symlinked `design/` or `design/roadmap.yaml` must not
  // pull an out-of-project roadmap into agent-facing output (context pack /
  // generated skills). A path-safety refusal maps to CONFIG_ERROR (fail-closed,
  // structured); a missing/invalid roadmap still throws ENOENT/ZodError as before.
  let abs: string;
  try {
    abs = await resolveWithinProject(cwd, "design/roadmap.yaml");
  } catch (err) {
    const e = new Error(
      `design/roadmap.yaml is not a safe project-relative path: ${(err as Error).message}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  const raw = await readFile(abs, "utf8");
  return Roadmap.parse(parseYaml(raw) as unknown);
}
