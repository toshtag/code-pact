import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { Roadmap } from "../core/schemas/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import { TaskType, type Task } from "../core/schemas/task.ts";
import { Prompter } from "../lib/prompt.ts";
import { messages as messageCatalog, type Locale, type Messages } from "../i18n/index.ts";

export type TaskAddOptions = {
  cwd: string;
  phaseId: string;
  locale: Locale;
  /** Explicit task id. Auto-generated as <phaseId>-T<n> when omitted. */
  id?: string;
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

async function loadRoadmap(cwd: string): Promise<Roadmap> {
  const raw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  return Roadmap.parse(parseYaml(raw) as unknown);
}

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

export async function runTaskAdd(opts: TaskAddOptions): Promise<TaskAddResult> {
  const prompter = opts.prompter ?? Prompter.fromIO();
  const ownsPrompter = opts.prompter === undefined;
  const m = messageCatalog[opts.locale].wizard.task;

  try {
    const roadmap = await loadRoadmap(opts.cwd);
    const ref = roadmap.phases.find((p) => p.id === opts.phaseId);
    if (!ref) {
      const err = new Error(`Phase "${opts.phaseId}" not found in roadmap.yaml.`);
      (err as NodeJS.ErrnoException).code = "PHASE_NOT_FOUND";
      throw err;
    }

    const phase = await loadPhase(opts.cwd, ref.path);
    const existingTasks = phase.tasks ?? [];

    const taskId = opts.id ?? nextTaskId(opts.phaseId, existingTasks);

    if (existingTasks.some((t) => t.id === taskId)) {
      const err = new Error(`Task "${taskId}" already exists in phase "${opts.phaseId}".`);
      (err as NodeJS.ErrnoException).code = "DUPLICATE_TASK_ID";
      throw err;
    }

    const description = await askRequired(prompter, m.descriptionPrompt);

    const typeLabels = TASK_TYPE_VALUES.map((v) => TASK_TYPE_LABELS[v] ?? v);
    const typeIdx = await prompter.askChoice(m.typePrompt, typeLabels);
    const type = TASK_TYPE_VALUES[typeIdx]!;

    const newTask: Task = {
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

    const updatedPhase: Phase = {
      ...phase,
      tasks: [...existingTasks, newTask],
    };

    const absPath = join(opts.cwd, ref.path);
    await writeFile(absPath, toYaml(updatedPhase), "utf8");

    return { phaseId: opts.phaseId, taskId, phasePath: ref.path };
  } finally {
    if (ownsPrompter) prompter.close();
  }
}
