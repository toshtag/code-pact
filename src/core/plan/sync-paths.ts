import { readdir, readFile } from "../project-fs/index.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";
import { Phase } from "../schemas/phase.ts";

// Apply an explicit old -> new path rename map to the `reads` / `writes`
// arrays of every task in `design/phases/*.yaml`. This exists so that
// renaming or merging a source file referenced by a (often historical, done)
// phase does not leave the plan-lint invariant — every declared `reads` glob
// matches a live file — to be fixed by hand. The map is EXPLICIT (the caller
// supplies old=new): a moved file can become a rename, a merge, or a split, and
// none of those is recoverable from git heuristics, so the human states intent.
//
// Phase YAMLs are kept in `yaml.stringify` canonical form (the same form
// `core/finalize/safe-write.ts` writes), so re-serializing a changed phase
// produces a minimal diff — only the touched `reads` / `writes` lines move.
// (As with safe-write, a hand-edited phase file carrying comments or
// non-canonical formatting would lose them on rewrite; phases are kept
// canonical, so this does not arise in practice.) Files with no matching entry
// are never rewritten.

export type SyncMode = "check" | "write";

export type RenamePair = { from: string; to: string };

export type SyncPathChange = {
  /** Repo-root-relative path of the phase file. */
  file: string;
  task_id: string;
  field: "reads" | "writes";
  from: string;
  to: string;
};

export type SyncPathSkip = {
  file: string;
  reason: string;
};

export type SyncPathsResult = {
  mode: SyncMode;
  renames: RenamePair[];
  changes: SyncPathChange[];
  /** Repo-root-relative phase files that changed. */
  files_changed: string[];
  /** Files actually rewritten. Empty unless mode === "write". */
  written: string[];
  /** Phase files that could not be parsed and were left untouched. */
  skipped: SyncPathSkip[];
};

/**
 * Map one `reads`/`writes` list through the rename map. Records a change for
 * every entry that maps to a different value, and drops duplicates the rename
 * introduces (e.g. `[task-start, task-block, task-resume]` all → `task-progress`
 * collapses to a single entry), preserving first-occurrence order.
 *
 * A list with no matching rename is returned verbatim and `changed: false` —
 * so a no-match run never rewrites a file, and a pre-existing duplicate the
 * caller did not ask to touch is left exactly as authored.
 */
function applyToList(
  list: string[],
  renameMap: Map<string, string>,
  file: string,
  taskId: string,
  field: "reads" | "writes",
  changes: SyncPathChange[],
): { next: string[]; changed: boolean } {
  let renamed = false;
  const mapped: string[] = [];
  for (const entry of list) {
    const to = renameMap.get(entry) ?? entry;
    if (to !== entry) {
      changes.push({ file, task_id: taskId, field, from: entry, to });
      renamed = true;
    }
    mapped.push(to);
  }
  if (!renamed) return { next: list, changed: false };

  // The rename matched: collapse any duplicates it produced, preserving
  // first-occurrence order.
  const seen = new Set<string>();
  const next: string[] = [];
  for (const entry of mapped) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    next.push(entry);
  }
  return { next, changed: true };
}

async function resolveSyncPath(cwd: string, relPath: string): Promise<string> {
  try {
    return await resolveSymlinkFreeProjectPath(cwd, relPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PATH_OUTSIDE_PROJECT" || code === "PATH_NOT_OWNED") {
      const e = new Error(
        `${relPath} is not a safe project-contained sync path: ${(err as Error).message}`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
    throw err;
  }
}

export async function runSyncPaths(opts: {
  cwd: string;
  renames: RenamePair[];
  mode: SyncMode;
}): Promise<SyncPathsResult> {
  const { cwd, renames, mode } = opts;
  const renameMap = new Map(renames.map((r) => [r.from, r.to]));

  const phasesDir = await resolveSyncPath(cwd, "design/phases");
  let entries: string[] = [];
  try {
    entries = await readdir(phasesDir);
  } catch {
    entries = [];
  }
  entries.sort();

  const changes: SyncPathChange[] = [];
  const filesChanged: string[] = [];
  const written: string[] = [];
  const skipped: SyncPathSkip[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    const relPath = `design/phases/${entry}`;
    const absPath = await resolveSyncPath(cwd, relPath);

    // READ-MODIFY-WRITE site — deliberately NOT routed through the
    // core/plan/load-phase.ts seam. It needs the raw bytes to rewrite them in
    // place, and (per the design-docs-ephemeral directive) an RMW must NEVER
    // archive-fallback: you cannot rewrite a phase file you have archived /
    // deleted, so a missing/archived phase must surface here (skipped/failed),
    // never be silently synthesized from a snapshot.
    const raw = await readFile(absPath, "utf8");
    let phase: Phase;
    try {
      phase = Phase.parse(parseYaml(raw) as unknown);
    } catch (err) {
      skipped.push({
        file: relPath,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let fileChanged = false;
    const tasks = (phase.tasks ?? []).map((task) => {
      let next = task;
      for (const field of ["reads", "writes"] as const) {
        const list = task[field];
        if (list === undefined) continue;
        const { next: updated, changed } = applyToList(
          list,
          renameMap,
          relPath,
          task.id,
          field,
          changes,
        );
        if (changed) {
          fileChanged = true;
          next = { ...next, [field]: updated };
        }
      }
      return next;
    });

    if (!fileChanged) continue;
    filesChanged.push(relPath);

    if (mode === "write") {
      const updatedPhase: Phase = { ...phase, tasks };
      await atomicWriteText(absPath, stringifyYaml(updatedPhase));
      written.push(relPath);
    }
  }

  return { mode, renames, changes, files_changed: filesChanged, written, skipped };
}
