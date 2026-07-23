#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const BASELINE_TASK = "P72-T4";
export const CHECKPOINT_PATH = "scripts/development-efficiency-checkpoint.json";

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

function readJson(repoRoot, rel) {
  return JSON.parse(readFileSync(resolve(repoRoot, rel), "utf8"));
}

function eventFiles(repoRoot) {
  const dir = resolve(repoRoot, ".code-pact/state/events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith(".yaml") || name.endsWith(".yml"))
    .map(name => `.code-pact/state/events/${name}`)
    .sort();
}

function bundleFiles(repoRoot) {
  const dir = resolve(repoRoot, ".code-pact/state/archive/bundles");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.startsWith("event_pack-") && name.endsWith(".json"))
    .map(name => `.code-pact/state/archive/bundles/${name}`)
    .sort();
}

function extractEventIdFromFilename(rel) {
  const match = /-([a-f0-9]{64})\.yaml$/i.exec(rel);
  return match ? match[1].toLowerCase() : rel;
}

export function loadDoneEvents(repoRoot) {
  const seen = new Set();
  const events = [];

  for (const rel of eventFiles(repoRoot)) {
    const doc = readYaml(repoRoot, rel);
    if (doc?.task_id && doc?.status === "done" && doc?.at) {
      const id = doc.id || extractEventIdFromFilename(rel);
      if (seen.has(id)) continue;
      seen.add(id);
      events.push({
        id,
        task_id: String(doc.task_id),
        at: String(doc.at),
        file: rel,
      });
    }
  }

  for (const rel of bundleFiles(repoRoot)) {
    const bundle = readJson(repoRoot, rel);
    for (const member of bundle?.members || []) {
      const pack = JSON.parse(member.bytes || "{}");
      for (const entry of pack?.events || []) {
        const ev = entry?.event || {};
        if (entry?.id && ev.task_id && ev.status === "done" && ev.at) {
          const id = String(entry.id).toLowerCase();
          if (seen.has(id)) continue;
          seen.add(id);
          events.push({
            id,
            task_id: String(ev.task_id),
            at: String(ev.at),
            file: entry.file || `${member.id}/${entry.id}`,
          });
        }
      }
    }
  }

  events.sort(
    (a, b) => a.at.localeCompare(b.at) || a.file.localeCompare(b.file),
  );
  return events;
}

export function loadTasksById(repoRoot) {
  const roadmap = readYaml(repoRoot, "design/roadmap.yaml");
  const tasks = new Map();
  for (const phaseRef of roadmap?.phases ?? []) {
    if (!phaseRef?.path || !existsSync(resolve(repoRoot, phaseRef.path)))
      continue;
    const phase = readYaml(repoRoot, phaseRef.path);
    for (const task of phase?.tasks ?? []) {
      if (task?.id) tasks.set(String(task.id), task);
    }
  }
  return tasks;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateCheckpoint(data, baselineTask) {
  if (!data || typeof data !== "object") {
    return { valid: false, message: "checkpoint is not an object" };
  }
  if (data.schema_version !== 1) {
    return { valid: false, message: "checkpoint schema_version must be 1" };
  }
  const b = data.baseline;
  const c = data.checkpoint;
  const s = data.state;
  if (
    !b ||
    typeof b !== "object" ||
    typeof b.task_id !== "string" ||
    typeof b.event_id !== "string" ||
    typeof b.at !== "string"
  ) {
    return { valid: false, message: "checkpoint.baseline is malformed" };
  }
  if (
    !c ||
    typeof c !== "object" ||
    typeof c.task_id !== "string" ||
    typeof c.event_id !== "string" ||
    typeof c.at !== "string"
  ) {
    return { valid: false, message: "checkpoint.checkpoint is malformed" };
  }
  if (
    !s ||
    typeof s !== "object" ||
    !isNonNegativeInteger(s.completed_design_only_tasks) ||
    !isNonNegativeInteger(s.completed_runtime_tasks) ||
    !isNonNegativeInteger(s.consecutive_design_only_tasks) ||
    !isNonNegativeInteger(s.max_consecutive_design_only_tasks)
  ) {
    return { valid: false, message: "checkpoint.state is malformed" };
  }
  if (s.consecutive_design_only_tasks > s.max_consecutive_design_only_tasks) {
    return { valid: false, message: "checkpoint consecutive exceeds maximum" };
  }
  if (b.at > c.at) {
    return {
      valid: false,
      message: "checkpoint baseline at is after checkpoint at",
    };
  }
  if (b.task_id !== baselineTask) {
    return {
      valid: false,
      message: `checkpoint baseline task ${b.task_id} != ${baselineTask}`,
    };
  }
  return { valid: true, checkpoint: data };
}

export function loadDevelopmentEfficiencyCheckpoint(repoRoot) {
  const path = resolve(repoRoot, CHECKPOINT_PATH);
  if (!existsSync(path)) {
    return {
      valid: false,
      message: `checkpoint file not found: ${CHECKPOINT_PATH}`,
    };
  }
  let data;
  try {
    data = readJson(repoRoot, CHECKPOINT_PATH);
  } catch (err) {
    return {
      valid: false,
      message: `checkpoint JSON parse error: ${err.message}`,
    };
  }
  return validateCheckpoint(data, BASELINE_TASK);
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
  const writesImplementation = writes.some(
    path =>
      path.startsWith("src/") ||
      path.startsWith("tests/") ||
      path.startsWith("scripts/"),
  );
  if (writesImplementation) return false;
  return writes.every(path => isDocumentationOrDesignPath(path));
}

function findUniqueEvent(events, predicate) {
  const matches = events
    .map((e, i) => (predicate(e) ? i : -1))
    .filter(i => i >= 0);
  if (matches.length === 0) return { index: -1, error: "event not found" };
  if (matches.length > 1)
    return { index: -1, error: "multiple matching events found" };
  return { index: matches[0] };
}

function makeBaseResult({
  baselineTask,
  checkpointTask,
  completedDesignOnlyTasks,
  completedRuntimeTasks,
  consecutiveDesignOnlyTasks,
  maxConsecutiveDesignOnlyTasks,
}) {
  const result = {
    baseline_task: baselineTask,
    completed_design_only_tasks: completedDesignOnlyTasks,
    completed_runtime_tasks: completedRuntimeTasks,
    consecutive_design_only_tasks: consecutiveDesignOnlyTasks,
    max_consecutive_design_only_tasks: maxConsecutiveDesignOnlyTasks,
    historical_debt: HISTORICAL_DEBT,
  };
  if (checkpointTask !== undefined) {
    result.checkpoint_task = checkpointTask;
  }
  return result;
}

export function evaluateDevelopmentEfficiency({
  doneEvents,
  tasks,
  checkpoint,
  baselineTask = BASELINE_TASK,
  nextTask,
}) {
  let completedDesignOnlyTasks = 0;
  let completedRuntimeTasks = 0;
  let consecutiveDesignOnlyTasks = 0;
  let allowedMaxConsecutive = 1;
  let observedMaxConsecutive = 0;
  let postEvents;
  let checkpointTask;

  if (checkpoint !== undefined) {
    const validation = validateCheckpoint(checkpoint, baselineTask);
    if (!validation.valid) {
      return {
        baseline_task: baselineTask,
        status: "fail",
        code: "CONFIG_ERROR",
        message: validation.message,
        historical_debt: HISTORICAL_DEBT,
      };
    }

    const baseline = findUniqueEvent(
      doneEvents,
      e =>
        e.task_id === checkpoint.baseline.task_id &&
        e.id === checkpoint.baseline.event_id &&
        e.at === checkpoint.baseline.at,
    );
    if (baseline.error) {
      return {
        baseline_task: baselineTask,
        status: "fail",
        code: "CONFIG_ERROR",
        message: `baseline event not resolved: ${baseline.error}`,
        historical_debt: HISTORICAL_DEBT,
      };
    }

    const cp = findUniqueEvent(
      doneEvents,
      e =>
        e.task_id === checkpoint.checkpoint.task_id &&
        e.id === checkpoint.checkpoint.event_id &&
        e.at === checkpoint.checkpoint.at,
    );
    if (cp.error) {
      return {
        baseline_task: baselineTask,
        status: "fail",
        code: "CONFIG_ERROR",
        message: `checkpoint event not resolved: ${cp.error}`,
        historical_debt: HISTORICAL_DEBT,
      };
    }
    if (cp.index <= baseline.index) {
      return {
        baseline_task: baselineTask,
        status: "fail",
        code: "CONFIG_ERROR",
        message: "checkpoint event is not after baseline event",
        historical_debt: HISTORICAL_DEBT,
      };
    }

    checkpointTask = checkpoint.checkpoint.task_id;
    completedDesignOnlyTasks = checkpoint.state.completed_design_only_tasks;
    completedRuntimeTasks = checkpoint.state.completed_runtime_tasks;
    consecutiveDesignOnlyTasks = checkpoint.state.consecutive_design_only_tasks;
    allowedMaxConsecutive = checkpoint.state.max_consecutive_design_only_tasks;
    observedMaxConsecutive = Math.max(
      allowedMaxConsecutive,
      consecutiveDesignOnlyTasks,
    );
    postEvents = doneEvents.slice(cp.index + 1);
  } else {
    const baseline = findUniqueEvent(
      doneEvents,
      e => e.task_id === baselineTask,
    );
    if (baseline.error) {
      return {
        baseline_task: baselineTask,
        status: "fail",
        code: "CONFIG_ERROR",
        message: `baseline task ${baselineTask} not found`,
        historical_debt: HISTORICAL_DEBT,
      };
    }
    // Without a checkpoint the gate allows a single consecutive design-only task.
    allowedMaxConsecutive = 1;
    observedMaxConsecutive = allowedMaxConsecutive;
    postEvents = doneEvents.slice(baseline.index + 1);
  }

  const unclassified = [];
  for (const event of postEvents) {
    const task = tasks.get(event.task_id);
    if (!task) {
      unclassified.push(event.task_id);
      continue;
    }
    if (isDesignOnlyTask(task)) {
      completedDesignOnlyTasks += 1;
      consecutiveDesignOnlyTasks += 1;
      observedMaxConsecutive = Math.max(
        observedMaxConsecutive,
        consecutiveDesignOnlyTasks,
      );
    } else {
      completedRuntimeTasks += 1;
      consecutiveDesignOnlyTasks = 0;
    }
  }

  if (unclassified.length > 0) {
    return {
      baseline_task: baselineTask,
      checkpoint_task: checkpointTask,
      status: "fail",
      code: "CONFIG_ERROR",
      message: "completed task definitions are unavailable",
      unclassified_done_tasks: unclassified,
      historical_debt: HISTORICAL_DEBT,
    };
  }

  const baseResult = makeBaseResult({
    baselineTask,
    checkpointTask,
    completedDesignOnlyTasks,
    completedRuntimeTasks,
    consecutiveDesignOnlyTasks,
    maxConsecutiveDesignOnlyTasks: observedMaxConsecutive,
  });

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
    const pass = prospectiveConsecutiveDesignOnlyTasks <= allowedMaxConsecutive;
    return {
      ...baseResult,
      next_task: nextTask,
      next_task_design_only: nextDesignOnly,
      prospective_consecutive_design_only_tasks:
        prospectiveConsecutiveDesignOnlyTasks,
      status: pass ? "pass" : "fail",
      ...(pass ? {} : { code: "DEVELOPMENT_DESIGN_LOOP_EXCEEDED" }),
    };
  }

  const pass = consecutiveDesignOnlyTasks <= allowedMaxConsecutive;
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

  const checkpoint = loadDevelopmentEfficiencyCheckpoint(repoRoot);
  if (!checkpoint.valid) {
    const result = {
      baseline_task: BASELINE_TASK,
      status: "fail",
      code: "CONFIG_ERROR",
      message: checkpoint.message,
      historical_debt: HISTORICAL_DEBT,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 1;
  }

  const result = evaluateDevelopmentEfficiency({
    doneEvents: loadDoneEvents(repoRoot),
    tasks: loadTasksById(repoRoot),
    checkpoint: checkpoint.checkpoint,
    nextTask: parsed.nextTask,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "pass" ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
