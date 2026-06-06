import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PhaseImportInput, type PhaseImportEntry, type TaskImport } from "../core/schemas/phase-import.ts";
import { Task } from "../core/schemas/task.ts";
import { type PhaseRef } from "../core/schemas/roadmap.ts";
import { loadRoadmap } from "../core/plan/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import { createPhase, RESERVED_PHASE_IDS } from "../core/services/createPhase.ts";
import {
  isDecisionRequiredForTask,
  readDecisionAdrFiles,
  hasDecisionAdrForTaskId,
} from "../core/decisions/adr.ts";
import {
  scaffoldTargetsForTask,
  assertSafeDecisionFilenameSegment,
  isUnderDecisionsDir,
  writeProposedAdrIfAbsent,
} from "../core/decisions/scaffold.ts";
import { assertSafeRelativePath } from "../core/path-safety.ts";

export type PhaseImportOptions = {
  cwd: string;
  /** Absolute or cwd-relative path to the input YAML. */
  inputPath: string;
  /** Skip duplicate phase ids instead of failing. */
  force?: boolean;
  /**
   * When true, all Task fields must be present in the input. When false
   * (default), missing optional task fields are filled with sensible defaults
   * and reported in `result.completed_fields`.
   */
  strict?: boolean;
  /**
   * When true, scaffold a `proposed` ADR stub for every requires_decision
   * task that has no resolving ADR yet. Opt-in; default off.
   */
  scaffoldDecisions?: boolean;
};

export type CompletedField = {
  taskId: string;
  fields: string[];
};

/**
 * Advisory surfaced by the import (never fails the command).
 * `PHASE_VERIFY_COMMANDS_MISSHAPED`: the input used the full
 * Phase shape `verification: { commands: [...] }` instead of the import
 * shape `verify_commands: [...]`. Because `PhaseImportEntry` is not
 * `.strict()`, zod silently drops the unknown `verification` key — so the
 * mis-shape is detected on the RAW parsed YAML before validation, never
 * on the validated entry (where the evidence is already gone).
 */
export type ImportWarning = {
  code: "PHASE_VERIFY_COMMANDS_MISSHAPED";
  /** Phase id when the raw entry carried a string `id`, else undefined. */
  phase_id?: string;
  message: string;
};

export type PhaseImportResult = {
  imported_phases: PhaseRef[];
  imported_tasks: string[];
  skipped_phases: string[];
  /** Task fields that were filled with defaults (empty when --strict or no gaps). */
  completed_fields: CompletedField[];
  /**
   * Advisories surfaced from the input. Always present, even as [].
   * Field-presence-fixed like `suggested_next_steps`: JSON consumers can
   * assume the key exists. Never affects the exit code.
   */
  warnings: ImportWarning[];
  /**
   * Additive guidance. Always present, even as []. Names
   * the canonical post-import sequence (plan lint → phase runbook → task
   * runbook) so the dogfood loop is CLI-emitted, not docs-only.
   *
   * Field-presence-fixed: JSON consumers can assume the schema is constant.
   */
  suggested_next_steps: string[];
  /**
   * Repo-relative POSIX paths of `proposed` ADR stubs created by
   * `--scaffold-decisions`. Always present, `[]` when the flag is
   * off or nothing was scaffolded.
   */
  scaffolded_decisions: string[];
  /**
   * Scaffold targets that were intentionally NOT written — e.g. a
   * `decision_refs` path outside `design/decisions/`. Always present, `[]`
   * when nothing was skipped. Surfaced so the omission is never silent.
   */
  scaffold_skipped: { ref: string; reason: string }[];
};

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

/**
 * Detect the `verification: { commands: [...] }` mis-shape on the RAW
 * parsed YAML, BEFORE zod validation. `PhaseImportEntry` has no
 * `.strict()`, so `PhaseImportInput.safeParse` silently strips the unknown
 * `verification` key — inspecting the validated entry would never see it.
 * This guard is the only place the evidence still exists, which is why it
 * runs here and not on the parsed `PhaseImportInput`.
 *
 * Warns whenever a phase entry carries `verification.commands` at all, even
 * if a canonical `verify_commands` is also present (in which case the
 * legacy block is silently ignored — the user should know).
 */
export function collectMisshapeWarnings(parsed: unknown): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  if (parsed === null || typeof parsed !== "object") return warnings;
  const phases = (parsed as { phases?: unknown }).phases;
  if (!Array.isArray(phases)) return warnings;

  for (const entry of phases) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const verification = e.verification;
    const hasLegacyCommands =
      verification !== null &&
      typeof verification === "object" &&
      Array.isArray((verification as Record<string, unknown>).commands);
    if (!hasLegacyCommands) continue;

    const phaseId = typeof e.id === "string" ? e.id : undefined;
    const label = phaseId ? `Phase "${phaseId}"` : "A phase entry";
    const hasCanonical = e.verify_commands !== undefined;
    const message = hasCanonical
      ? `${label} declares both \`verify_commands\` and legacy \`verification.commands\`. \`verify_commands\` is canonical and will be used; the nested \`verification.commands\` is ignored.`
      : `${label} uses \`verification.commands\` (the full Phase shape), which \`phase import\` does not read — it is ignored and the phase falls back to the default verify command. Use \`verify_commands\` (a flat top-level list) instead.`;
    warnings.push({ code: "PHASE_VERIFY_COMMANDS_MISSHAPED", ...(phaseId !== undefined ? { phase_id: phaseId } : {}), message });
  }
  return warnings;
}

function parseInput(raw: string): { input: PhaseImportInput; warnings: ImportWarning[] } {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const e = new Error(`Could not parse YAML: ${detail}`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  // Inspect the raw object BEFORE zod strips unknown keys.
  const warnings = collectMisshapeWarnings(parsed);
  const result = PhaseImportInput.safeParse(parsed);
  if (!result.success) {
    const e = new Error(
      `Input does not match the phase-import schema: ${result.error.message}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  return { input: result.data, warnings };
}

function applyTaskDefaults(raw: TaskImport): { task: Task; completedFields: string[] } {
  const completedFields: string[] = [];
  function d<T>(val: T | undefined, def: T, field: string): T {
    if (val === undefined) { completedFields.push(field); return def; }
    return val;
  }
  const task: Task = {
    id: raw.id,
    type: d(raw.type, "feature", "type"),
    ambiguity: d(raw.ambiguity, "medium", "ambiguity"),
    risk: d(raw.risk, "medium", "risk"),
    context_size: d(raw.context_size, "medium", "context_size"),
    write_surface: d(raw.write_surface, "medium", "write_surface"),
    verification_strength: d(raw.verification_strength, "medium", "verification_strength"),
    expected_duration: d(raw.expected_duration, "medium", "expected_duration"),
    status: d(raw.status, "planned", "status"),
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(raw.requires_decision === true ? { requires_decision: true } : {}),
    // Task Readiness Schema. Forward verbatim when present; do
    // not invent synthetic defaults. Absent stays undefined so old
    // YAML behaves unchanged.
    ...(raw.depends_on !== undefined ? { depends_on: raw.depends_on } : {}),
    ...(raw.decision_refs !== undefined ? { decision_refs: raw.decision_refs } : {}),
    ...(raw.reads !== undefined ? { reads: raw.reads } : {}),
    ...(raw.writes !== undefined ? { writes: raw.writes } : {}),
    ...(raw.acceptance_refs !== undefined ? { acceptance_refs: raw.acceptance_refs } : {}),
  };
  return { task, completedFields };
}

function entryToCreatePhaseInput(
  cwd: string,
  entry: PhaseImportEntry,
  resolvedTasks: Task[],
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
    tasks: resolvedTasks.length > 0 ? resolvedTasks : undefined,
  };
}

export async function runPhaseImport(
  opts: PhaseImportOptions,
): Promise<PhaseImportResult> {
  const { cwd, inputPath } = opts;

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
  const { input, warnings } = parseInput(raw);
  return applyParsedPhaseImport({
    cwd,
    input,
    warnings,
    force: opts.force === true,
    strict: opts.strict === true,
    scaffoldDecisions: opts.scaffoldDecisions === true,
  });
}

/**
 * Options for {@link applyParsedPhaseImport}. Mirrors {@link PhaseImportOptions}
 * but takes an already-parsed `PhaseImportInput` (plus any advisories
 * collected while parsing) instead of a file path. Lets callers that build
 * the input in memory — e.g. `plan adopt` — reuse the exact same validation
 * and write pass without round-tripping through a temp file.
 */
export type ApplyParsedPhaseImportOptions = {
  cwd: string;
  input: PhaseImportInput;
  /** Advisories to carry into the result (e.g. mis-shape warnings). */
  warnings: ImportWarning[];
  force?: boolean;
  strict?: boolean;
  /** Scaffold `proposed` ADR stubs for requires_decision tasks. */
  scaffoldDecisions?: boolean;
};

/**
 * The validation + write pass of `phase import`, operating on an
 * already-parsed input. `runPhaseImport` is the file-reading wrapper around
 * this; `plan adopt` calls it directly with an input it built in memory.
 */
export async function applyParsedPhaseImport(
  opts: ApplyParsedPhaseImportOptions,
): Promise<PhaseImportResult> {
  const { cwd, input, warnings } = opts;
  const force = opts.force === true;
  const strict = opts.strict === true;
  const scaffoldDecisions = opts.scaffoldDecisions === true;

  // ---- Reserved-id preflight -------------------------
  // Reject the entire import if ANY phase entry uses a reserved id (e.g.
  // TUTORIAL). Runs BEFORE any createPhase call, so the roadmap is left
  // unchanged on failure — no partial-import state where earlier
  // phases are written and a later reserved-id entry is rejected.
  // `--force` does NOT bypass this; reserved ids are reserved at the
  // governance layer, not the collision-handling layer.
  const reservedHits = input.phases.filter((e) =>
    RESERVED_PHASE_IDS.includes(e.id),
  );
  if (reservedHits.length > 0) {
    const ids = reservedHits.map((p) => `"${p.id}"`).join(", ");
    const e = new Error(
      `Phase id ${ids} is reserved for the sample-phase artifact created by \`init --sample-phase\`. Pick a different id in the import file.`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }

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

  // ---- Strict mode: validate that all Task required fields are present ---
  if (strict) {
    const errors: string[] = [];
    for (const entry of importTargets) {
      for (const rawTask of entry.tasks ?? []) {
        const result = Task.safeParse(rawTask);
        if (!result.success) {
          const missing = Object.keys(result.error.flatten().fieldErrors).join(", ");
          errors.push(`  ${rawTask.id}: missing ${missing}`);
        }
      }
    }
    if (errors.length > 0) {
      const e = new Error(
        `Strict mode: task fields missing — re-run without --strict to apply defaults.\n${errors.join("\n")}`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
  }

  // ---- Resolve tasks (apply defaults unless strict) --------------------
  const completedFieldsAll: CompletedField[] = [];
  type ResolvedEntry = { entry: PhaseImportEntry; tasks: Task[] };
  const resolved: ResolvedEntry[] = importTargets.map((entry) => {
    const tasks: Task[] = [];
    for (const rawTask of entry.tasks ?? []) {
      const { task, completedFields } = applyTaskDefaults(rawTask);
      tasks.push(task);
      if (completedFields.length > 0) {
        completedFieldsAll.push({ taskId: rawTask.id, fields: completedFields });
      }
    }
    return { entry, tasks };
  });

  // ---- Scaffold preflight (atomic) --------------------------
  // Validate every scaffold target BEFORE any write, so an unsafe task id or
  // decision_ref fails the whole import with the roadmap unchanged — no
  // partial-write state. Unsafe → CONFIG_ERROR here; a safe path that simply
  // lives outside design/decisions/ is NOT an error (reported as
  // scaffold_skipped at write time).
  if (scaffoldDecisions) {
    for (const { entry, tasks } of resolved) {
      for (const task of tasks) {
        if (!isDecisionRequiredForTask(entry, task)) continue;
        const refs = task.decision_refs;
        if (!refs || refs.length === 0) {
          assertSafeDecisionFilenameSegment(task.id); // throws CONFIG_ERROR
        }
        for (const target of scaffoldTargetsForTask(task.id, refs)) {
          try {
            assertSafeRelativePath(target);
          } catch {
            const e = new Error(
              `Cannot scaffold decision for task "${task.id}": unsafe path "${target}".`,
            );
            (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
            throw e;
          }
        }
      }
    }
  }

  // ---- Write pass (one createPhase call per target) -------------------
  const importedRefs: PhaseRef[] = [];
  const importedTaskIds: string[] = [];
  for (const { entry, tasks } of resolved) {
    const created = await createPhase(entryToCreatePhaseInput(cwd, entry, tasks));
    importedRefs.push(created.ref);
    for (const t of tasks) importedTaskIds.push(t.id);
  }

  // ---- Scaffold proposed ADR stubs -------------------------
  // Lock still held. Targets were path-validated in the preflight above.
  const scaffoldedDecisions: string[] = [];
  const scaffoldSkipped: { ref: string; reason: string }[] = [];
  if (scaffoldDecisions) {
    const existingAdrs = await readDecisionAdrFiles(cwd);
    for (const { entry, tasks } of resolved) {
      for (const task of tasks) {
        if (!isDecisionRequiredForTask(entry, task)) continue;
        const refs = task.decision_refs;
        const usingDefault = !refs || refs.length === 0;
        for (const target of scaffoldTargetsForTask(task.id, refs)) {
          if (!isUnderDecisionsDir(target)) {
            scaffoldSkipped.push({ ref: target, reason: "outside design/decisions/" });
            continue;
          }
          // Default `<task-id>.md` target: skip when a matching ADR filename
          // already exists (filename-substring rule shared with the gate —
          // not status-aware). decision_refs targets rely on the exact-path
          // existence check inside writeProposedAdrIfAbsent instead.
          if (usingDefault && hasDecisionAdrForTaskId(existingAdrs, task.id)) {
            continue;
          }
          const outcome = await writeProposedAdrIfAbsent(cwd, target, task.id);
          if (outcome === "created") scaffoldedDecisions.push(target);
        }
      }
    }
  }

  return {
    imported_phases: importedRefs,
    imported_tasks: importedTaskIds,
    skipped_phases: skippedPhaseIds,
    completed_fields: completedFieldsAll,
    warnings,
    suggested_next_steps: buildSuggestedNextSteps(
      importedRefs,
      importedTaskIds,
      completedFieldsAll,
      scaffoldedDecisions,
    ),
    scaffolded_decisions: scaffoldedDecisions,
    scaffold_skipped: scaffoldSkipped,
  };
}

/**
 * Builds the additive `suggested_next_steps` array. Returns
 * an empty array when nothing was imported. Otherwise emits the canonical
 * post-import sequence and prepends a defaults-review hint when lenient
 * mode filled fields.
 */
function buildSuggestedNextSteps(
  importedRefs: PhaseRef[],
  importedTaskIds: string[],
  completedFieldsAll: CompletedField[],
  scaffoldedDecisions: string[],
): string[] {
  if (importedRefs.length === 0) return [];

  const steps: string[] = [];

  if (completedFieldsAll.length > 0) {
    steps.push(
      "Review the `completed_fields` array — every entry is a task field code-pact filled with a default. Confirm each is appropriate before treating the imported tasks as source-of-truth.",
    );
  }

  if (scaffoldedDecisions.length > 0) {
    steps.push(
      `Fill in and accept the scaffolded decision records (flip **Status** to \`accepted\` once settled — that releases the gate): ${scaffoldedDecisions.join(", ")}`,
    );
  }

  steps.push(
    "Run `code-pact plan lint --include-quality --json` to validate the imported phase(s) and surface any clarify advisories.",
    "Review the clarify advisories `plan lint --include-quality` surfaces (TASK_DECISION_UNRESOLVED, PHASE_CONFIDENCE_LOW) before relying on phase/task runbooks — they mark deliberately-uncertain design a human should settle first.",
  );

  // One runbook step per imported phase. Keep the suggestions tight when
  // many phases are imported by listing the id explicitly so the user can
  // pipe them straight into a runner.
  for (const ref of importedRefs) {
    steps.push(
      `Run \`code-pact phase runbook ${ref.id} --json\` to see the recommended per-phase next steps (reconcile-batch step is the natural follow-up after the per-task loop starts).`,
    );
  }

  if (importedTaskIds.length > 0) {
    steps.push(
      `Run \`code-pact task runbook ${importedTaskIds[0]} --json\` to see the per-task lifecycle starting from a fresh task.`,
    );
  }

  return steps;
}
