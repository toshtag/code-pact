import {
  runSyncPaths,
  type RenamePair,
  type SyncMode,
  type SyncPathsResult,
} from "../core/plan/sync-paths.ts";

export type { RenamePair, SyncMode, SyncPathsResult };

export async function runPlanSyncPaths(opts: {
  cwd: string;
  renames: RenamePair[];
  mode?: SyncMode;
}): Promise<SyncPathsResult> {
  return runSyncPaths({
    cwd: opts.cwd,
    renames: opts.renames,
    mode: opts.mode ?? "check",
  });
}

export function serializePlanSyncPathsData(
  result: SyncPathsResult,
): Record<string, unknown> {
  return {
    mode: result.mode,
    renames: result.renames.map((r) => ({ from: r.from, to: r.to })),
    changes: result.changes.map((c) => ({
      file: c.file,
      task_id: c.task_id,
      field: c.field,
      from: c.from,
      to: c.to,
    })),
    files_changed: result.files_changed,
    written: result.written,
    skipped: result.skipped.map((s) => ({ file: s.file, reason: s.reason })),
  };
}

export function formatPlanSyncPathsHuman(result: SyncPathsResult): string {
  const lines: string[] = [];
  if (result.changes.length === 0) {
    lines.push(
      "plan sync-paths: no matching reads/writes entries — nothing to change.",
    );
  } else {
    const verb = result.mode === "write" ? "updated" : "would update";
    lines.push(
      `plan sync-paths: ${verb} ${result.changes.length} entr${result.changes.length === 1 ? "y" : "ies"} across ${result.files_changed.length} file${result.files_changed.length === 1 ? "" : "s"}.`,
    );
    for (const c of result.changes) {
      lines.push(`  ${c.file} ${c.task_id}.${c.field}: ${c.from} -> ${c.to}`);
    }
    if (result.mode === "check") {
      lines.push("Re-run with --write to apply.");
    }
  }
  for (const s of result.skipped) {
    lines.push(`  warning: skipped unparseable phase ${s.file}: ${s.reason}`);
  }
  return lines.join("\n");
}
