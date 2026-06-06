import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { atomicWriteText } from "../io/atomic-text.ts";
import { resolvePhaseInRoadmap } from "../core/plan/resolve-phase.ts";
import { Phase } from "../core/schemas/phase.ts";
import { TaskType, type Task } from "../core/schemas/task.ts";
import { assertSafePlanId } from "../core/schemas/plan-id.ts";
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
  prompter?: Prompter;
};

export type TaskAddResult = {
  phaseId: string;
  taskId: string;
  phasePath: string;
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

async function loadPhase(cwd: string, relPath: string): Promise<Phase> {
  const raw = await readFile(join(cwd, relPath), "utf8");
  return Phase.parse(parseYaml(raw) as unknown);
}

function nextTaskId(phaseId: string, existing: Task[]): string {
  const n = existing.length + 1;
  return `${phaseId}-T${n}`;
}

async function askRequired(prompter: Prompter, question: string): Promise<string> {
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

export async function runTaskAdd(opts: TaskAddOptions): Promise<TaskAddResult> {
  // When `nonInteractive` is set we bypass the prompter entirely — no
  // stdin/stderr handle is opened, which is essential for CI / scripted
  // bootstrap paths.
  const useNonInteractive = opts.nonInteractive !== undefined;
  const prompter = useNonInteractive
    ? undefined
    : (opts.prompter ?? Prompter.fromIO());
  const ownsPrompter = !useNonInteractive && opts.prompter === undefined;
  const m = messageCatalog[opts.locale].wizard.task;

  try {
    const ref = await resolvePhaseInRoadmap(opts.cwd, opts.phaseId);

    const phase = await loadPhase(opts.cwd, ref.path);
    const existingTasks = phase.tasks ?? [];

    const taskId = opts.id ?? nextTaskId(opts.phaseId, existingTasks);

    // A user-supplied `--id` flows into the phase YAML (and downstream into
    // command strings / decision-stub paths), so validate it before writing.
    // Generated ids from nextTaskId are always safe, but guard unconditionally
    // for defense-in-depth — it is a no-op for valid ids.
    assertSafePlanId(taskId, "Task id");

    if (existingTasks.some((t) => t.id === taskId)) {
      const err = new Error(`Task "${taskId}" already exists in phase "${opts.phaseId}".`);
      (err as NodeJS.ErrnoException).code = "DUPLICATE_TASK_ID";
      throw err;
    }

    let newTask: Task;
    if (opts.nonInteractive) {
      newTask = buildNonInteractiveTask(taskId, opts.nonInteractive);
    } else {
      const description = await askRequired(prompter!, m.descriptionPrompt);

      const typeLabels = TASK_TYPE_VALUES.map((v) => TASK_TYPE_LABELS[v] ?? v);
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

    // Parse the assembled phase before writing so no invalid plan state is
    // ever persisted (final integrity guard at the write chokepoint).
    const updatedPhase: Phase = Phase.parse({
      ...phase,
      tasks: [...existingTasks, newTask],
    });

    const absPath = join(opts.cwd, ref.path);
    await atomicWriteText(absPath, toYaml(updatedPhase));

    return { phaseId: opts.phaseId, taskId, phasePath: ref.path };
  } finally {
    if (ownsPrompter && prompter) prompter.close();
  }
}
