import { readdir } from "../../project-fs/raw-internal.ts";
import { join } from "node:path";
import type { PlanIssue } from "../shared.ts";
import type { Roadmap } from "../../schemas/roadmap.ts";
import { phaseFilePresence } from "./fs.ts";
import { resolveMissingPhaseRef } from "../../archive/load-phase-snapshot.ts";
import { resolveSymlinkFreeProjectPath } from "../../path-safety.ts";

/**
 * Roadmap references a phase file that does not exist on disk. Both `plan lint`
 * (here, via `detectMissingPhaseFiles`) and `doctor` / `validate` report this as a
 * `MISSING_PHASE_FILE` error — the code name matches the condition (referenced but
 * not present). `ORPHAN_PHASE_FILE` is the inverse (a file present but not
 * roadmap-referenced) and is a warning.
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
    const presence = await phaseFilePresence(absPath);
    if (presence === "present") continue; // live-wins
    if (presence === "inaccessible") {
      // Present but unreadable (e.g. a non-searchable parent dir) — fail closed.
      // The snapshot must NOT release a live file that is actually on disk.
      issues.push({
        code: "MISSING_PHASE_FILE",
        severity: "error",
        message: `roadmap.yaml references "${ref.path}" but it cannot be accessed (present but unreadable — check directory permissions)`,
        file: ref.path,
        phase_id: ref.id,
      });
      continue;
    }
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
  let entries: string[] = [];
  try {
    const phasesDir = await resolveSymlinkFreeProjectPath(cwd, "design/phases");
    entries = await readdir(phasesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return [
        {
          code: "MISSING_PHASE_FILE",
          severity: "error",
          message: `design/phases cannot be safely enumerated: ${(err as Error).message}`,
          file: "design/phases",
        },
      ];
    }
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
