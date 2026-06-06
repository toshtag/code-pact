import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PlanIssue } from "../shared.ts";
import type { Roadmap } from "../../schemas/roadmap.ts";
import { fileExists } from "./fs.ts";

/**
 * Roadmap references a phase file that does not exist on disk. doctor
 * historically reports this under the `ORPHAN_PHASE_FILE` code; plan
 * lint uses the clearer `MISSING_PHASE_FILE` code via
 * `detectMissingPhaseFiles`. Both call sites should treat this as an
 * error.
 */
export async function detectMissingPhaseFiles(
  cwd: string,
  roadmap: Roadmap,
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  for (const ref of roadmap.phases) {
    const absPath = join(cwd, ref.path);
    if (!(await fileExists(absPath))) {
      issues.push({
        code: "MISSING_PHASE_FILE",
        severity: "error",
        message: `roadmap.yaml references "${ref.path}" but the file does not exist`,
        file: ref.path,
        phase_id: ref.id,
      });
    }
  }
  return issues;
}

/**
 * Phase YAML exists under design/phases/ but the roadmap does not
 * reference it. Warning-level so a deliberate stash of work-in-progress
 * does not block CI.
 */
export async function detectOrphanPhaseFiles(
  cwd: string,
  roadmap: Roadmap,
): Promise<PlanIssue[]> {
  const phasesDir = join(cwd, "design", "phases");
  let entries: string[] = [];
  try {
    entries = await readdir(phasesDir);
  } catch {
    return [];
  }
  const referenced = new Set(roadmap.phases.map((r) => r.path));
  const issues: PlanIssue[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    const relPath = `design/phases/${entry}`;
    if (!referenced.has(relPath)) {
      issues.push({
        code: "ORPHAN_PHASE_FILE",
        severity: "warning",
        message: `${relPath} exists but is not referenced in roadmap.yaml`,
        file: relPath,
      });
    }
  }
  return issues;
}
