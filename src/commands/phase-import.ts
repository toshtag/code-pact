import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PhaseImportInput, type PhaseImportEntry } from "../core/schemas/phase-import.ts";
import { Roadmap, type PhaseRef } from "../core/schemas/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import { createPhase } from "../core/services/createPhase.ts";

export type PhaseImportOptions = {
  cwd: string;
  /** Absolute or cwd-relative path to the input YAML. */
  inputPath: string;
  /** Skip duplicate phase ids instead of failing. */
  force?: boolean;
};

export type PhaseImportResult = {
  imported_phases: PhaseRef[];
  imported_tasks: string[];
  skipped_phases: string[];
};

async function loadRoadmap(cwd: string): Promise<Roadmap> {
  const raw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  return Roadmap.parse(parseYaml(raw) as unknown);
}

async function loadPhase(cwd: string, relPath: string): Promise<Phase> {
  const raw = await readFile(join(cwd, relPath), "utf8");
  return Phase.parse(parseYaml(raw) as unknown);
}

/**
 * Collect every task id already present in the project (across all phases
 * registered in roadmap.yaml). Used to detect task id collisions before
 * we write anything.
 */
async function collectExistingTaskIds(cwd: string): Promise<Set<string>> {
  const roadmap = await loadRoadmap(cwd);
  const ids = new Set<string>();
  for (const ref of roadmap.phases) {
    try {
      const phase = await loadPhase(cwd, ref.path);
      for (const t of phase.tasks ?? []) ids.add(t.id);
    } catch {
      // A malformed phase YAML in the existing roadmap is not this
      // command's problem; surface it during validation if it bites.
    }
  }
  return ids;
}

function parseInput(raw: string): PhaseImportInput {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const e = new Error(`Could not parse YAML: ${detail}`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  const result = PhaseImportInput.safeParse(parsed);
  if (!result.success) {
    const e = new Error(
      `Input does not match the phase-import schema: ${result.error.message}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  return result.data;
}

function entryToCreatePhaseInput(
  cwd: string,
  entry: PhaseImportEntry,
): Parameters<typeof createPhase>[0] {
  return {
    cwd,
    id: entry.id,
    name: entry.name,
    weight: entry.weight,
    objective: entry.objective,
    confidence: entry.confidence,
    risk: entry.risk,
    verifyCommands: entry.verify_commands,
    doneCriteria: entry.definition_of_done,
    nonGoals: entry.non_goals,
    requiresDecision: entry.requires_decision,
    tasks: entry.tasks,
  };
}

export async function runPhaseImport(
  opts: PhaseImportOptions,
): Promise<PhaseImportResult> {
  const { cwd, inputPath } = opts;
  const force = opts.force === true;

  // ---- Read + schema-validate ------------------------------------------
  let raw: string;
  try {
    raw = await readFile(
      inputPath.startsWith("/") ? inputPath : join(cwd, inputPath),
      "utf8",
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const e = new Error(`Could not read input file: ${detail}`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  const input = parseInput(raw);

  // ---- Pre-write validation pass --------------------------------------
  // Detect duplicate phase ids within the input itself first.
  const inputIdCounts = new Map<string, number>();
  for (const e of input.phases) {
    inputIdCounts.set(e.id, (inputIdCounts.get(e.id) ?? 0) + 1);
  }
  const duplicateInInput = [...inputIdCounts.entries()].filter(([, n]) => n > 1);
  if (duplicateInInput.length > 0) {
    const ids = duplicateInInput.map(([id]) => id).join(", ");
    const e = new Error(
      `Input declares phase id more than once: ${ids}`,
    );
    (e as NodeJS.ErrnoException).code = "DUPLICATE_PHASE_ID";
    throw e;
  }

  // Identify which entries would collide with existing roadmap phases.
  const roadmap = await loadRoadmap(cwd);
  const existingPhaseIds = new Set(roadmap.phases.map((r) => r.id));
  const collidingPhaseIds = input.phases
    .filter((e) => existingPhaseIds.has(e.id))
    .map((e) => e.id);

  if (collidingPhaseIds.length > 0 && !force) {
    const e = new Error(
      `Phase id(s) already exist in roadmap.yaml: ${collidingPhaseIds.join(", ")}. Re-run with --force to skip them.`,
    );
    (e as NodeJS.ErrnoException).code = "DUPLICATE_PHASE_ID";
    (e as NodeJS.ErrnoException & { ids?: string[] }).ids = collidingPhaseIds;
    throw e;
  }

  // Restrict the import set to phases we will actually write.
  const importTargets = input.phases.filter(
    (e) => !existingPhaseIds.has(e.id),
  );
  const skippedPhaseIds = input.phases
    .filter((e) => existingPhaseIds.has(e.id))
    .map((e) => e.id);

  // Task id collision check. We consider:
  //  - task ids declared in the import targets (may collide among themselves)
  //  - task ids already present in existing (kept) roadmap phases
  // Tasks belonging to a SKIPPED input phase are not imported (the phase
  // is skipped), so their ids do not enter this check. `--force` does not
  // bypass task-level collisions: data integrity wins over throughput.
  const existingTaskIds = await collectExistingTaskIds(cwd);
  const targetTaskIds = new Map<string, number>();
  const taskCollisions = new Set<string>();
  for (const entry of importTargets) {
    for (const t of entry.tasks ?? []) {
      if (existingTaskIds.has(t.id)) {
        taskCollisions.add(t.id);
        continue;
      }
      const n = (targetTaskIds.get(t.id) ?? 0) + 1;
      targetTaskIds.set(t.id, n);
      if (n > 1) taskCollisions.add(t.id);
    }
  }
  if (taskCollisions.size > 0) {
    const ids = [...taskCollisions].sort().join(", ");
    const e = new Error(
      `Task id collision detected: ${ids}. Resolve duplicates in the input and try again.`,
    );
    (e as NodeJS.ErrnoException).code = "AMBIGUOUS_TASK_ID";
    (e as NodeJS.ErrnoException & { ids?: string[] }).ids = [...taskCollisions];
    throw e;
  }

  // ---- Write pass (one createPhase call per target) -------------------
  const importedRefs: PhaseRef[] = [];
  const importedTaskIds: string[] = [];
  for (const entry of importTargets) {
    const created = await createPhase(entryToCreatePhaseInput(cwd, entry));
    importedRefs.push(created.ref);
    for (const t of entry.tasks ?? []) importedTaskIds.push(t.id);
  }

  return {
    imported_phases: importedRefs,
    imported_tasks: importedTaskIds,
    skipped_phases: skippedPhaseIds,
  };
}
