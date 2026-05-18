import {
  runNormalize,
  type NormalizeFileChange,
  type NormalizeMode,
  type NormalizeResult,
} from "../core/plan/normalize.ts";

export type PlanNormalizeOptions = {
  cwd: string;
  /** When omitted, defaults to "check" — safe dry-run. */
  mode?: NormalizeMode;
};

export type PlanNormalizeResult = {
  ok: boolean;
  mode: NormalizeMode;
  changedCount: number;
  changes: NormalizeFileChange[];
  /** Files actually rewritten. Empty unless mode === "write". */
  written: string[];
};

export async function runPlanNormalize(
  opts: PlanNormalizeOptions,
): Promise<PlanNormalizeResult> {
  const mode: NormalizeMode = opts.mode ?? "check";
  const result: NormalizeResult = await runNormalize({ cwd: opts.cwd, mode });

  // Contract:
  // - check mode: ok=false when at least one file would change (exit 1),
  //   ok=true when the tree is already normalized.
  // - write mode: ok=true on success even when files were rewritten —
  //   that is the command's purpose. Failures bubble up as thrown
  //   errors and are translated to exit 3 in the CLI handler.
  const ok = mode === "write" ? true : result.changes.length === 0;

  return {
    ok,
    mode,
    changedCount: result.changes.length,
    changes: result.changes,
    written: result.written,
  };
}

export function serializePlanNormalizeData(
  result: PlanNormalizeResult,
): Record<string, unknown> {
  return {
    mode: result.mode,
    changed_count: result.changedCount,
    changes: result.changes.map((c) => ({
      path: c.path,
      kind: c.kind,
      reasons: c.reasons,
    })),
    written: result.written,
  };
}

export function formatPlanNormalizeHuman(result: PlanNormalizeResult): string {
  if (result.changedCount === 0) {
    return result.mode === "write"
      ? "plan normalize: tree already normalized — nothing to write."
      : "plan normalize: tree is normalized.";
  }
  const verb = result.mode === "write" ? "wrote" : "would change";
  const lines: string[] = [
    `plan normalize: ${verb} ${result.changedCount} file${result.changedCount === 1 ? "" : "s"}.`,
  ];
  for (const change of result.changes) {
    lines.push(`  - ${change.path} (${change.kind}) — ${change.reasons.join(", ")}`);
  }
  return lines.join("\n");
}
