import { loadPhase } from "../core/plan/load-phase.ts";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import {
  atomicWriteText,
  atomicReplaceExistingText,
} from "../io/atomic-text.ts";
import { resolvePhaseInRoadmap } from "../core/plan/resolve-phase.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import {
  resolvePhaseWritePath,
  resolvePhaseReadPath,
  resolveExplicitUserReadPath,
  readExplicitUserText,
  readOwnedText,
} from "../core/project-fs/index.ts";
import type {
  OwnedReadPath,
  OwnedWritePath,
} from "../core/project-fs/branded-paths.ts";
import { Phase } from "../core/schemas/phase.ts";
import { TaskType, type Task } from "../core/schemas/task.ts";
import { assertSafePlanId } from "../core/schemas/plan-id.ts";
import {
  parseTaskRegistrationSpec,
  taskRegistrationDigest,
  lockTimeRegistrationChangedFields,
} from "../core/task-registration-spec.ts";
import { Prompter } from "../lib/prompt.ts";
import { messages as messageCatalog, type Locale } from "../i18n/index.ts";

/**
 * Non-interactive task spec. When `TaskAddOptions.nonInteractive`
 * is provided, `runTaskAdd` bypasses the prompter entirely and uses the
 * supplied values. `--status` is intentionally NOT part of this spec —
 * newly added tasks are always `status: planned`; historical state must
 * use `phase import`.
 */
export type TaskAddNonInteractiveSpec = {
  description: string;
  type: Task["type"];
  ambiguity?: Task["ambiguity"];
  risk?: Task["risk"];
  context_size?: Task["context_size"];
  write_surface?: Task["write_surface"];
  verification_strength?: Task["verification_strength"];
  expected_duration?: Task["expected_duration"];
  depends_on?: string[];
  decision_refs?: string[];
  reads?: string[];
  writes?: string[];
  acceptance_refs?: string[];
};

export type TaskAddOptions = {
  cwd: string;
  phaseId: string;
  locale: Locale;
  /** Explicit task id. Auto-generated as <phaseId>-T<n> when omitted. */
  id?: string;
  /**
   * Non-interactive flag-driven path. When set, the
   * wizard prompter is bypassed and the spec is applied directly.
   */
  nonInteractive?: TaskAddNonInteractiveSpec;
  /**
   * Machine-readable task spec file path. Mutually exclusive with the
   * flag-driven non-interactive path and with all task-field flags.
   */
  specFile?: string;
  prompter?: Prompter;
};

export type TaskAddResult = {
  phaseId: string;
  taskId: string;
  phasePath: string;
  registrationMode?: "spec_file";
  specDigest?: string;
  storedTaskDigest?: string;
  roundTripEqual?: boolean;
};

const TASK_TYPE_LABELS: Record<string, string> = {
  architecture: "Architecture",
  feature: "Feature",
  bugfix: "Bug fix",
  refactor: "Refactor",
  docs: "Docs",
  test: "Test",
  mechanical_refactor: "Mechanical refactor",
  other: "Other",
};

const TASK_TYPE_VALUES = TaskType.options;

function nextTaskId(phaseId: string, existing: Task[]): string {
  const n = existing.length + 1;
  return `${phaseId}-T${n}`;
}

async function askRequired(
  prompter: Prompter,
  question: string,
): Promise<string> {
  for (;;) {
    const raw = await prompter.ask(question);
    if (raw.length > 0) return raw;
  }
}

function buildNonInteractiveTask(
  taskId: string,
  spec: TaskAddNonInteractiveSpec,
): Task {
  return {
    id: taskId,
    type: spec.type,
    ambiguity: spec.ambiguity ?? "medium",
    risk: spec.risk ?? "medium",
    context_size: spec.context_size ?? "medium",
    write_surface: spec.write_surface ?? "medium",
    verification_strength: spec.verification_strength ?? "medium",
    expected_duration: spec.expected_duration ?? "medium",
    status: "planned",
    description: spec.description,
    // Optional fields. Stored as provided (basic string validation
    // happened at the CLI boundary); existence checks / glob validity /
    // unsafe-path detection / protected-path advisories remain the
    // responsibility of `plan lint`.
    ...(spec.depends_on && spec.depends_on.length > 0
      ? { depends_on: spec.depends_on }
      : {}),
    ...(spec.decision_refs && spec.decision_refs.length > 0
      ? { decision_refs: spec.decision_refs }
      : {}),
    ...(spec.reads && spec.reads.length > 0 ? { reads: spec.reads } : {}),
    ...(spec.writes && spec.writes.length > 0 ? { writes: spec.writes } : {}),
    ...(spec.acceptance_refs && spec.acceptance_refs.length > 0
      ? { acceptance_refs: spec.acceptance_refs }
      : {}),
  };
}

async function assertTaskIdUnusedGlobally(
  cwd: string,
  taskId: string,
): Promise<void> {
  try {
    await resolveTaskInRoadmap(cwd, taskId);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "TASK_NOT_FOUND") return;
    if (code === "AMBIGUOUS_TASK_ID") {
      const dup = new Error(
        `Task "${taskId}" already exists in multiple phases.`,
      );
      (dup as NodeJS.ErrnoException).code = "DUPLICATE_TASK_ID";
      throw dup;
    }
    throw err;
  }
  const dup = new Error(`Task "${taskId}" already exists.`);
  (dup as NodeJS.ErrnoException).code = "DUPLICATE_TASK_ID";
  throw dup;
}

type ValidatedTaskSpec = {
  newTask: Task;
  spec: {
    schema_version: 1;
    phase_id: string;
    task: Task;
  };
};

async function loadAndValidateTaskSpec(
  cwd: string,
  phaseId: string,
  specFile: string,
): Promise<ValidatedTaskSpec> {
  let specPath;
  try {
    specPath = await resolveExplicitUserReadPath(cwd, specFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PATH_OUTSIDE_PROJECT" || code === "PATH_NOT_OWNED") {
      const wrapped = new Error(
        `task add: --spec-file "${specFile}" is outside the project or not a safe path.`,
      );
      (wrapped as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw wrapped;
    }
    throw err;
  }

  let raw: string;
  try {
    raw = await readExplicitUserText(specPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const wrapped = new Error(`task add: spec file "${specFile}" not found.`);
      (wrapped as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw wrapped;
    }
    throw err;
  }

  const spec = parseTaskRegistrationSpec(raw);

  if (spec.phase_id !== phaseId) {
    const err = new Error(
      `task add: spec phase_id "${spec.phase_id}" does not match positional phase id "${phaseId}".`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }

  if (spec.task.status !== "planned") {
    const err = new Error(
      `task add: spec task status must be "planned" (got "${spec.task.status}").`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }

  assertSafePlanId(spec.task.id, "Task id");
  await assertTaskIdUnusedGlobally(cwd, spec.task.id);

  const newTask: Task = {
    ...spec.task,
    // Ensure optional fields are explicit in the stored task so the canonical
    // round-trip digest is stable.
    description: spec.task.description,
    requires_decision: spec.task.requires_decision,
    depends_on: spec.task.depends_on,
    decision_refs: spec.task.decision_refs,
    reads: spec.task.reads,
    writes: spec.task.writes,
    acceptance_refs: spec.task.acceptance_refs,
  };

  return { newTask, spec };
}

export async function runTaskAdd(opts: TaskAddOptions): Promise<TaskAddResult> {
  // When `nonInteractive` or `specFile` is set we bypass the prompter entirely —
  // no stdin/stderr handle is opened, which is essential for CI / scripted
  // bootstrap paths.
  const useNonInteractive =
    opts.nonInteractive !== undefined || opts.specFile !== undefined;
  const prompter = useNonInteractive
    ? undefined
    : (opts.prompter ?? Prompter.fromIO());
  const ownsPrompter = !useNonInteractive && opts.prompter === undefined;
  const m = messageCatalog[opts.locale].wizard.task;

  try {
    const ref = await resolvePhaseInRoadmap(opts.cwd, opts.phaseId);
    let absPath: OwnedWritePath;
    let readPath: OwnedReadPath;
    try {
      absPath = await resolvePhaseWritePath(opts.cwd, ref.path);
      readPath = await resolvePhaseReadPath(opts.cwd, ref.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "PATH_OUTSIDE_PROJECT" || code === "PATH_NOT_OWNED") {
        const wrapped = new Error((err as Error).message);
        (wrapped as NodeJS.ErrnoException).code = "CONFIG_ERROR";
        throw wrapped;
      }
      throw err;
    }

    const phase = await loadPhase(opts.cwd, ref.path);
    if (phase.id !== opts.phaseId) {
      const err = new Error(
        `phase reference "${opts.phaseId}" points at "${ref.path}", but that file declares phase "${phase.id}"`,
      );
      (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw err;
    }
    const existingTasks = phase.tasks ?? [];

    let specResult: ValidatedTaskSpec | undefined;
    let taskId: string;
    let newTask: Task;

    if (opts.specFile) {
      specResult = await loadAndValidateTaskSpec(
        opts.cwd,
        opts.phaseId,
        opts.specFile,
      );
      newTask = specResult.newTask;
      taskId = specResult.spec.task.id;
    } else {
      taskId = opts.id ?? nextTaskId(opts.phaseId, existingTasks);

      // A user-supplied `--id` flows into the phase YAML (and downstream into
      // command strings / decision-stub paths), so validate it before writing.
      // Generated ids from nextTaskId are always safe, but guard unconditionally
      // for defense-in-depth — it is a no-op for valid ids.
      assertSafePlanId(taskId, "Task id");

      if (opts.nonInteractive) {
        newTask = buildNonInteractiveTask(taskId, opts.nonInteractive);
      } else {
        const description = await askRequired(prompter!, m.descriptionPrompt);

        const typeLabels = TASK_TYPE_VALUES.map(v => TASK_TYPE_LABELS[v] ?? v);
        const typeIdx = await prompter!.askChoice(m.typePrompt, typeLabels);
        const type = TASK_TYPE_VALUES[typeIdx]!;

        newTask = {
          id: taskId,
          type,
          ambiguity: "medium",
          risk: "medium",
          context_size: "medium",
          write_surface: "medium",
          verification_strength: "medium",
          expected_duration: "medium",
          status: "planned",
          description,
        };
      }
    }

    if (existingTasks.some(t => t.id === taskId)) {
      const err = new Error(
        `Task "${taskId}" already exists in phase "${opts.phaseId}".`,
      );
      (err as NodeJS.ErrnoException).code = "DUPLICATE_TASK_ID";
      throw err;
    }

    // Parse the assembled phase before writing so no invalid plan state is
    // ever persisted (final integrity guard at the write chokepoint).
    const updatedPhase: Phase = Phase.parse({
      ...phase,
      tasks: [...existingTasks, newTask],
    });

    // Capture the original phase bytes so we can CAS rollback if the write
    // succeeds but the post-write sanity re-read fails.
    const originalBytes = await readOwnedText(readPath);

    // Serialize and re-parse in memory before any filesystem mutation. The
    // candidate task is what would be stored; verify it matches the intended
    // registration exactly.
    const candidateYaml = toYaml(updatedPhase);
    const candidatePhase = Phase.parse(parseYaml(candidateYaml));
    const candidateTask = candidatePhase.tasks?.find(t => t.id === taskId);
    if (!candidateTask) {
      const err = new Error(
        `Task "${taskId}" was serialized but could not be re-parsed from the candidate YAML.`,
      );
      (err as NodeJS.ErrnoException).code = "TASK_REGISTRATION_ROUND_TRIP";
      throw err;
    }
    const roundTripDiff = lockTimeRegistrationChangedFields(
      specResult ? specResult.spec.task : newTask,
      candidateTask,
    );
    if (roundTripDiff.length > 0) {
      const err = new Error(
        `Task registration round-trip mismatch for "${taskId}" before write (${roundTripDiff.join(", ")}).`,
      );
      (err as NodeJS.ErrnoException).code = "TASK_REGISTRATION_ROUND_TRIP";
      throw err;
    }

    await atomicWriteText(absPath, candidateYaml);

    // Post-write sanity check: the bytes on disk must round-trip to the same
    // canonical registration. If they do not, attempt a CAS rollback to the
    // original bytes when the file still contains exactly what we wrote.
    const reloaded = await loadPhase(opts.cwd, ref.path);
    const storedTask = reloaded.tasks?.find(t => t.id === taskId);
    const storedDiff =
      storedTask == null
        ? ["missing"]
        : lockTimeRegistrationChangedFields(
            specResult ? specResult.spec.task : newTask,
            storedTask,
          );
    if (storedDiff.length > 0) {
      let currentBytes: string | undefined;
      try {
        currentBytes = await readOwnedText(readPath);
      } catch {
        currentBytes = undefined;
      }
      if (currentBytes === candidateYaml) {
        await atomicReplaceExistingText(absPath, originalBytes, candidateYaml);
      }
      const err = new Error(
        `Task registration round-trip mismatch for "${taskId}" after write (${storedDiff.join(", ")}).`,
      );
      (err as NodeJS.ErrnoException).code = "TASK_REGISTRATION_ROUND_TRIP";
      throw err;
    }

    if (specResult) {
      const inputDigest = taskRegistrationDigest(
        specResult.spec.phase_id,
        specResult.spec.task,
      );
      const storedDigest = taskRegistrationDigest(reloaded.id, storedTask!);
      return {
        phaseId: opts.phaseId,
        taskId,
        phasePath: ref.path,
        registrationMode: "spec_file",
        specDigest: inputDigest,
        storedTaskDigest: storedDigest,
        roundTripEqual: true,
      };
    }

    return { phaseId: opts.phaseId, taskId, phasePath: ref.path };
  } finally {
    if (ownsPrompter && prompter) prompter.close();
  }
}
