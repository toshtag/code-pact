import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../schemas/roadmap.ts";
import { resolveOwnedProjectPath } from "../path-safety.ts";

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
  // OWN the read: `design/roadmap.yaml` is control-plane. A symlinked `design/`
  // or `design/roadmap.yaml` — even one pointing INSIDE the project (e.g. to a
  // `.local/` private file) — must not pull an aliased roadmap into agent-facing
  // output (context pack / generated skills). resolveOwnedProjectPath rejects
  // EVERY symlink component, matching the strict loadPlanState contract on the
  // same control plane (Blocker: roadmap/phase symlink-alias parity). A refusal
  // maps to CONFIG_ERROR (fail-closed); a missing/invalid roadmap still throws
  // ENOENT/ZodError as before.
  let abs: string;
  try {
    abs = await resolveOwnedProjectPath(cwd, "design/roadmap.yaml");
  } catch (err) {
    const e = new Error(
      `design/roadmap.yaml is not a safe owned project path: ${(err as Error).message}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    // ENOENT stays RAW (callers treat a missing roadmap as "no project yet").
    // Any other read failure (a directory at the path → EISDIR, ENOTDIR, EACCES)
    // is structured rather than an uncoded exit-3.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
    const e = new Error(`design/roadmap.yaml cannot be read: ${(err as Error).message}`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  try {
    return Roadmap.parse(parseYaml(raw) as unknown);
  } catch (err) {
    const e = new Error(`design/roadmap.yaml is malformed (YAML or schema): ${(err as Error).message}`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
}
