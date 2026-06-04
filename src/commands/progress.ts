import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadRoadmap } from "../core/plan/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import { BaselineSnapshot } from "../core/schemas/baseline-snapshot.ts";
import { assertSafePlanId } from "../core/schemas/plan-id.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProgressOptions = {
  cwd: string;
  baseline: string; // snapshot name, e.g. "initial"
};

export type ProgressResult = {
  baseline_name: string;
  baseline_total_weight: number;
  current_total_weight: number;
  completed_weight: number;
  baseline_progress_percent: number;
  current_progress_percent: number;
  expanded_work: number;
  high_risk_unfinished: string[];
};

// ---------------------------------------------------------------------------
// Weight contribution per status (MVP rule: in_progress counts as 0.5)
// ---------------------------------------------------------------------------

const STATUS_FACTOR: Record<string, number> = {
  planned: 0,
  in_progress: 0.5,
  done: 1,
  cancelled: 0,
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadPhase(cwd: string, path: string): Promise<Phase> {
  const raw = await readFile(join(cwd, path), "utf8");
  return Phase.parse(parseYaml(raw) as unknown);
}

function throwBaselineNotFound(name: string): never {
  const err = new Error(`Baseline "${name}" not found.`);
  (err as NodeJS.ErrnoException).code = "BASELINE_NOT_FOUND";
  throw err;
}

async function loadBaseline(cwd: string, name: string): Promise<BaselineSnapshot> {
  // `name` is interpolated into `baselines/${name}.json`, so a value like
  // `../../../../outside` would escape the baselines dir. Baseline names are
  // identifiers (default "initial"), so constrain to the PlanId charset.
  assertSafePlanId(name, "Baseline name");
  let raw: string;
  try {
    raw = await readFile(
      join(cwd, ".code-pact", "state", "baselines", `${name}.json`),
      "utf8",
    );
  } catch {
    throwBaselineNotFound(name);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throwBaselineNotFound(name);
  }
  return BaselineSnapshot.parse(data);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runProgress(opts: ProgressOptions): Promise<ProgressResult> {
  const { cwd, baseline: baselineName } = opts;

  const [roadmap, baseline] = await Promise.all([
    loadRoadmap(cwd),
    loadBaseline(cwd, baselineName),
  ]);

  // Load all current phases
  const phases = await Promise.all(roadmap.phases.map((ref) => loadPhase(cwd, ref.path)));

  // Current total weight (may have grown since baseline)
  const current_total_weight = phases.reduce((s, p) => s + p.weight, 0);

  // Completed weight (done=1.0, in_progress=0.5, else 0)
  const completed_weight = phases.reduce((s, p) => {
    const factor = STATUS_FACTOR[p.status] ?? 0;
    return s + p.weight * factor;
  }, 0);

  // High-risk unfinished phases
  const high_risk_unfinished = phases
    .filter((p) => p.risk === "high" && p.status !== "done" && p.status !== "cancelled")
    .map((p) => p.id);

  const baseline_total_weight = baseline.total_weight;

  // Progress % relative to each denominator
  const baseline_progress_percent =
    baseline_total_weight === 0
      ? 0
      : Math.round((completed_weight / baseline_total_weight) * 1000) / 10;

  const current_progress_percent =
    current_total_weight === 0
      ? 0
      : Math.round((completed_weight / current_total_weight) * 1000) / 10;

  // Work added since baseline (can be negative if phases were removed)
  const expanded_work = current_total_weight - baseline_total_weight;

  return {
    baseline_name: baselineName,
    baseline_total_weight,
    current_total_weight,
    completed_weight,
    baseline_progress_percent,
    current_progress_percent,
    expanded_work,
    high_risk_unfinished,
  };
}

// ---------------------------------------------------------------------------
// Human-readable formatter
// ---------------------------------------------------------------------------

export function formatProgress(r: ProgressResult): string {
  const lines: string[] = [
    `Baseline:          ${r.baseline_name}  (${r.baseline_total_weight} pts)`,
    `Current total:     ${r.current_total_weight} pts`,
    `Completed:         ${r.completed_weight} pts`,
    `Progress (vs baseline): ${r.baseline_progress_percent}%`,
    `Progress (vs current):  ${r.current_progress_percent}%`,
  ];
  if (r.expanded_work !== 0) {
    const sign = r.expanded_work > 0 ? "+" : "";
    lines.push(`Expanded work:     ${sign}${r.expanded_work} pts since baseline`);
  }
  if (r.high_risk_unfinished.length > 0) {
    lines.push(`High-risk unfinished: ${r.high_risk_unfinished.join(", ")}`);
  }
  return lines.join("\n");
}
