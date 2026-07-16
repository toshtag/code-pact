#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const BASELINE_TASK = "P72-T4";

const HISTORICAL_DEBT = {
  scope: "P69-P72",
  design_only_phases: 4,
  design_only_tasks: 11,
  design_files: 14,
  design_lines: 1702,
  runtime_behavior_shipped: 0,
};

function readYaml(repoRoot, rel) {
  return parseYaml(readFileSync(resolve(repoRoot, rel), "utf8"));
}

function eventFiles(repoRoot) {
  const dir = resolve(repoRoot, ".code-pact/state/events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith(".yaml") || name.endsWith(".yml"))
    .map(name => `.code-pact/state/events/${name}`)
    .sort();
}

export function loadDoneEvents(repoRoot) {
  const events = [];
  for (const rel of eventFiles(repoRoot)) {
    const doc = readYaml(repoRoot, rel);
    if (doc?.task_id && doc?.status === "done" && doc?.at) {
      events.push({ task_id: String(doc.task_id), at: String(doc.at), file: rel });
    }
  }
  events.sort((a, b) => a.at.localeCompare(b.at) || a.file.localeCompare(b.file));
  return events;
}

export function loadTasksById(repoRoot) {
  const roadmap = readYaml(repoRoot, "design/roadmap.yaml");
  const tasks = new Map();
  for (const phaseRef of roadmap?.phases ?? []) {
    if (!phaseRef?.path || !existsSync(resolve(repoRoot, phaseRef.path))) continue;
    const phase = readYaml(repoRoot, phaseRef.path);
    for (const task of phase?.tasks ?? []) {
      if (task?.id) tasks.set(String(task.id), task);
    }
  }
  return tasks;
}

function writesFor(task) {
  return Array.isArray(task?.writes) ? task.writes.map(String) : [];
}

const ROOT_DOCUMENT_FILES = new Set(["LICENSE", "NOTICE"]);

function isDocumentationOrDesignPath(path) {
  return (
    path.startsWith("design/") ||
    path.startsWith("docs/") ||
    path.startsWith(".code-pact/") ||
    (!path.includes("/") && path.endsWith(".md")) ||
    ROOT_DOCUMENT_FILES.has(path)
  );
}

export function isDesignOnlyTask(task) {
  const writes = writesFor(task);
  if (writes.length === 0) return true;
  const writesImplementation = writes.some(path =>
    path.startsWith("src/") || path.startsWith("tests/") || path.startsWith("scripts/"),
  );
  if (writesImplementation) return false;
  return writes.every(path => isDocumentationOrDesignPath(path));
}

export function evaluateDevelopmentEfficiency({
  doneEvents,
  tasks,
  baselineTask = BASELINE_TASK,
  nextTask,
}) {
  const baselineIndex = doneEvents.findIndex(event => event.task_id === baselineTask);
  if (baselineIndex < 0) {
    return {
      baseline_task: baselineTask,
      status: "fail",
      code: "CONFIG_ERROR",
      message: `baseline task ${baselineTask} not found`,
      historical_debt: HISTORICAL_DEBT,
    };
  }

  const afterBaseline = doneEvents.slice(baselineIndex + 1);
  let completedDesignOnlyTasks = 0;
  let completedRuntimeTasks = 0;
  let consecutiveDesignOnlyTasks = 0;
  let maxConsecutiveDesignOnlyTasks = 0;

  for (const event of afterBaseline) {
    const task = tasks.get(event.task_id);
    if (!task) continue;
    if (isDesignOnlyTask(task)) {
      completedDesignOnlyTasks += 1;
      consecutiveDesignOnlyTasks += 1;
      maxConsecutiveDesignOnlyTasks = Math.max(
        maxConsecutiveDesignOnlyTasks,
        consecutiveDesignOnlyTasks,
      );
    } else {
      completedRuntimeTasks += 1;
      consecutiveDesignOnlyTasks = 0;
    }
  }

  const baseResult = {
    baseline_task: baselineTask,
    completed_design_only_tasks: completedDesignOnlyTasks,
    completed_runtime_tasks: completedRuntimeTasks,
    consecutive_design_only_tasks: consecutiveDesignOnlyTasks,
    max_consecutive_design_only_tasks: maxConsecutiveDesignOnlyTasks,
    historical_debt: HISTORICAL_DEBT,
  };

  if (nextTask !== undefined) {
    const task = tasks.get(nextTask);
    if (!task) {
      return {
        ...baseResult,
        status: "fail",
        code: "CONFIG_ERROR",
        next_task: nextTask,
        message: `unknown next task ${nextTask}`,
      };
    }
    const nextDesignOnly = isDesignOnlyTask(task);
    const prospectiveConsecutiveDesignOnlyTasks = nextDesignOnly
      ? consecutiveDesignOnlyTasks + 1
      : 0;
    const pass = prospectiveConsecutiveDesignOnlyTasks <= 1;
    return {
      ...baseResult,
      next_task: nextTask,
      next_task_design_only: nextDesignOnly,
      prospective_consecutive_design_only_tasks: prospectiveConsecutiveDesignOnlyTasks,
      status: pass ? "pass" : "fail",
      ...(pass ? {} : { code: "DEVELOPMENT_DESIGN_LOOP_EXCEEDED" }),
    };
  }

  const pass = consecutiveDesignOnlyTasks <= 1;
  return {
    ...baseResult,
    status: pass ? "pass" : "fail",
    ...(pass ? {} : { code: "DEVELOPMENT_DESIGN_LOOP_EXCEEDED" }),
  };
}

function parseCliArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--next-task" && args[1]) {
    return { nextTask: args[1] };
  }
  return {
    error: "usage: pnpm check:development-efficiency -- --next-task <task-id>",
  };
}

export function runCli(argv = process.argv.slice(2), repoRoot = process.cwd()) {
  const parsed = parseCliArgs(argv);
  if (parsed.error) {
    const result = {
      baseline_task: BASELINE_TASK,
      status: "fail",
      code: "CONFIG_ERROR",
      message: parsed.error,
      historical_debt: HISTORICAL_DEBT,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 1;
  }

  const result = evaluateDevelopmentEfficiency({
    doneEvents: loadDoneEvents(repoRoot),
    tasks: loadTasksById(repoRoot),
    nextTask: parsed.nextTask,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "pass" ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
