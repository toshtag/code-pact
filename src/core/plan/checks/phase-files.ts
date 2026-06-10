import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PlanIssue } from "../shared.ts";
import type { Roadmap } from "../../schemas/roadmap.ts";
import { fileExists } from "./fs.ts";
import { resolveMissingPhaseRef } from "../../archive/load-phase-snapshot.ts";

/**
 * Roadmap references a phase file that does not exist on disk. doctor
 * reports this under the `ORPHAN_PHASE_FILE` code; plan
 * lint uses the clearer `MISSING_PHASE_FILE` code via
 * `detectMissingPhaseFiles`. Both call sites should treat this as an
 * error.
 *
 * design-docs-ephemeral (step 4a): a COMPLETED phase whose YAML was hand-deleted
 * but whose roadmap ref still points at it is TOLERATED when a valid archive
 * snapshot proves it (no issue). A missing file with NO valid snapshot stays a
 * `MISSING_PHASE_FILE` error; a present-but-corrupt/mismatched snapshot is a
 * `PHASE_SNAPSHOT_INVALID` error (loud fail-closed — never a silent pass). Live
 * file present → never consults the snapshot (live-wins).
 */
export async function detectMissingPhaseFiles(
  cwd: string,
  roadmap: Roadmap,
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  for (const ref of roadmap.phases) {
    const absPath = join(cwd, ref.path);
    if (await fileExists(absPath)) continue; // live-wins
    const res = await resolveMissingPhaseRef(cwd, ref);
    if (res.kind === "tolerated") continue; // archived completed phase — fine
    if (res.kind === "fail_invalid") {
      issues.push({
        code: "PHASE_SNAPSHOT_INVALID",
        severity: "error",
        message: `roadmap.yaml references "${ref.path}" but the file does not exist and its archive snapshot cannot release it: ${res.reason}`,
        file: ref.path,
        phase_id: ref.id,
      });
      continue;
    }
    // fail_missing — no snapshot at all: the original behavior, unchanged.
    issues.push({
      code: "MISSING_PHASE_FILE",
      severity: "error",
      message: `roadmap.yaml references "${ref.path}" but the file does not exist`,
      file: ref.path,
      phase_id: ref.id,
    });
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
