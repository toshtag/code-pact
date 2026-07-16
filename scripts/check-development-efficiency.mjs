#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const repoRoot = process.cwd();
const baselineTask = "P72-T4";

function readYaml(rel) {
  return parseYaml(readFileSync(resolve(repoRoot, rel), "utf8"));
}

function eventFiles() {
  const dir = resolve(repoRoot, ".code-pact/state/events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith(".yaml") || name.endsWith(".yml"))
    .map(name => `.code-pact/state/events/${name}`)
    .sort();
}

function loadDoneEvents() {
  const events = [];
  for (const rel of eventFiles()) {
    const doc = readYaml(rel);
    if (doc?.task_id && doc?.status === "done" && doc?.at) {
      events.push({ task_id: String(doc.task_id), at: String(doc.at), file: rel });
    }
  }
  events.sort((a, b) => a.at.localeCompare(b.at) || a.file.localeCompare(b.file));
  return events;
}

function loadTasksById() {
  const roadmap = readYaml("design/roadmap.yaml");
  const tasks = new Map();
  for (const phaseRef of roadmap?.phases ?? []) {
    if (!phaseRef?.path || !existsSync(resolve(repoRoot, phaseRef.path))) continue;
    const phase = readYaml(phaseRef.path);
    for (const task of phase?.tasks ?? []) {
      if (task?.id) tasks.set(String(task.id), task);
    }
  }
  return tasks;
}

function writesFor(task) {
  return Array.isArray(task?.writes) ? task.writes.map(String) : [];
}

function isDesignOnly(task) {
  const writes = writesFor(task);
  if (writes.length === 0) return true;
  const writesRuntime = writes.some(path =>
    path.startsWith("src/") || path.startsWith("tests/") || path.startsWith("scripts/"),
  );
  if (writesRuntime) return false;
  return writes.every(path =>
    path.startsWith("design/") ||
    path.startsWith("docs/") ||
    path.startsWith(".code-pact/"),
  );
}

const doneEvents = loadDoneEvents();
const baselineIndex = doneEvents.findIndex(event => event.task_id === baselineTask);
if (baselineIndex < 0) {
  console.error(`check-development-efficiency: baseline task ${baselineTask} not found`);
  process.exit(1);
}

const tasks = loadTasksById();
const afterBaseline = doneEvents.slice(baselineIndex + 1);
let completedDesignOnlyTasks = 0;
let completedRuntimeTasks = 0;
let consecutiveDesignOnlyTasks = 0;
let maxConsecutiveDesignOnlyTasks = 0;

for (const event of afterBaseline) {
  const task = tasks.get(event.task_id);
  if (!task) continue;
  if (isDesignOnly(task)) {
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

const pass = maxConsecutiveDesignOnlyTasks <= 1;
const result = {
  baseline_task: baselineTask,
  completed_design_only_tasks: completedDesignOnlyTasks,
  completed_runtime_tasks: completedRuntimeTasks,
  consecutive_design_only_tasks: maxConsecutiveDesignOnlyTasks,
  status: pass ? "pass" : "fail",
  ...(pass ? {} : { code: "DEVELOPMENT_DESIGN_LOOP_EXCEEDED" }),
  historical_debt: {
    scope: "P69-P72",
    design_only_phases: 4,
    design_only_tasks: 11,
    design_files: 14,
    design_lines: 1702,
    runtime_behavior_shipped: 0,
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!pass) process.exit(1);
