import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../schemas/roadmap.ts";

/**
 * Strict loader for the phase registry at `design/roadmap.yaml`.
 *
 * Reads and schema-validates the roadmap, throwing on a missing or invalid
 * file (the throw-on-invalid contract every caller relied on). This is the
 * **strict** counterpart to the lenient plan-lint / `collectPlanArtifacts`
 * loader, which falls back to scanning `design/phases/` when the roadmap is
 * unreadable — the two are intentionally separate; do not conflate them.
 *
 * Extracted verbatim from eight identical per-command copies (no behaviour
 * change). See `design/decisions/control-plane-v2-rfc.md` (PR0): consolidating
 * the discovery seam is the prerequisite for later glob-based phase discovery.
 */
export async function loadRoadmap(cwd: string): Promise<Roadmap> {
  const raw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  return Roadmap.parse(parseYaml(raw) as unknown);
}
