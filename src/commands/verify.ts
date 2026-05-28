import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../core/schemas/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import { Task } from "../core/schemas/task.ts";
import { ProgressLog } from "../core/schemas/progress-event.ts";
import { hasDecisionAdrForTaskId } from "../core/decisions/adr.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerifyOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  dryRun: boolean;
  /**
   * When true, skip the `progress_event` and `task_status` checks.
   * Used by `task complete` to evaluate the deterministic preconditions
   * (commands, decision) without requiring the state that task complete
   * is itself about to produce.
   */
  skipConsistencyChecks?: boolean;
};

export type CheckResult = {
  name: string;
  ok: boolean;
  reason?: string;
  stdout?: string;
  stderr?: string;
};

export type VerifyResult = {
  ok: boolean;
  checks: CheckResult[];
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadRoadmap(cwd: string): Promise<Roadmap> {
  const raw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  return Roadmap.parse(parseYaml(raw) as unknown);
}

export async function loadPhase(cwd: string, path: string): Promise<Phase> {
  const raw = await readFile(join(cwd, path), "utf8");
  return Phase.parse(parseYaml(raw) as unknown);
}

async function loadProgressLog(cwd: string): Promise<ProgressLog> {
  const raw = await readFile(join(cwd, ".code-pact", "state", "progress.yaml"), "utf8");
  return ProgressLog.parse(parseYaml(raw) as unknown);
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

type CommandRun = { exitCode: number; stdout: string; stderr: string };

const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const TRUNCATED_OUTPUT_MESSAGE = `\n[code-pact: output truncated after ${MAX_COMMAND_OUTPUT_BYTES} bytes]\n`;

function createOutputCapture(): { append: (chunk: Buffer) => void; value: () => string } {
  let text = "";
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk: Buffer): void {
      if (truncated) return;

      const remaining = MAX_COMMAND_OUTPUT_BYTES - bytes;
      if (chunk.byteLength <= remaining) {
        text += chunk.toString();
        bytes += chunk.byteLength;
        return;
      }

      if (remaining > 0) {
        text += chunk.subarray(0, remaining).toString();
      }
      text += TRUNCATED_OUTPUT_MESSAGE;
      bytes = MAX_COMMAND_OUTPUT_BYTES;
      truncated = true;
    },
    value(): string {
      return text;
    },
  };
}

function runCommand(cmd: string, cwd: string): Promise<CommandRun> {
  return new Promise((resolve) => {
    const shellCommand = cmd.trim();
    if (!shellCommand) {
      resolve({ exitCode: 1, stdout: "", stderr: "empty verification command" });
      return;
    }

    const proc = spawn(shellCommand, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    const stdout = createOutputCapture();
    const stderr = createOutputCapture();
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    proc.on("close", (code) =>
      resolve({ exitCode: code ?? 1, stdout: stdout.value(), stderr: stderr.value() }),
    );
    proc.on("error", () =>
      resolve({ exitCode: 1, stdout: stdout.value(), stderr: stderr.value() }),
    );
  });
}

async function checkCommands(
  commands: string[],
  cwd: string,
  dryRun: boolean,
): Promise<CheckResult> {
  if (dryRun) {
    return {
      name: "commands",
      ok: true,
      reason: `dry-run: would execute: ${commands.join(", ")}`,
    };
  }

  for (const cmd of commands) {
    const { exitCode, stdout, stderr } = await runCommand(cmd, cwd);
    if (exitCode !== 0) {
      return {
        name: "commands",
        ok: false,
        reason: `"${cmd}" exited with code ${exitCode}`,
        ...(stdout && { stdout }),
        ...(stderr && { stderr }),
      };
    }
  }
  return { name: "commands", ok: true };
}

async function checkProgressEvent(
  log: ProgressLog,
  taskId: string,
): Promise<CheckResult> {
  const event = log.events.find((e) => e.task_id === taskId && e.status === "done");
  if (!event) {
    return {
      name: "progress_event",
      ok: false,
      reason: `No "done" event for task "${taskId}" in progress.yaml`,
    };
  }
  // Zod already validates the datetime format, so if it parsed it's valid
  return { name: "progress_event", ok: true };
}

export async function checkDecision(
  cwd: string,
  phase: Phase,
  task: Task,
): Promise<CheckResult> {
  const taskId = task.id;
  if (!phase.requires_decision && !task.requires_decision) {
    return { name: "decision", ok: true };
  }

  const decisionsDir = join(cwd, "design", "decisions");
  let entries: string[];
  try {
    entries = await readdir(decisionsDir);
  } catch {
    return {
      name: "decision",
      ok: false,
      reason: `design/decisions/ does not exist but requires_decision is true`,
    };
  }

  // Shared predicate with plan lint's TASK_DECISION_UNRESOLVED advisory so
  // verify and lint never diverge on what "resolved" means. The dir-existence
  // distinction above is kept verify-side for its more specific reason.
  if (!hasDecisionAdrForTaskId(entries, taskId)) {
    return {
      name: "decision",
      ok: false,
      reason: `No ADR found for task "${taskId}" in design/decisions/`,
    };
  }
  return { name: "decision", ok: true };
}

function checkTaskStatus(phase: Phase, taskId: string): CheckResult {
  const task = phase.tasks?.find((t) => t.id === taskId);
  if (!task) {
    return {
      name: "task_status",
      ok: false,
      reason: `Task "${taskId}" not found in phase definition`,
    };
  }
  if (task.status !== "done") {
    return {
      name: "task_status",
      ok: false,
      reason: `Task "${taskId}" status is "${task.status}", expected "done"`,
    };
  }
  return { name: "task_status", ok: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runVerify(opts: VerifyOptions): Promise<VerifyResult> {
  const { cwd, phaseId, taskId, dryRun } = opts;
  const skipConsistency = opts.skipConsistencyChecks === true;

  // Resolve phase
  const roadmap = await loadRoadmap(cwd);
  const ref = roadmap.phases.find((p) => p.id === phaseId);
  if (!ref) {
    const err = new Error(`Phase "${phaseId}" not found in roadmap.yaml.`);
    (err as NodeJS.ErrnoException).code = "PHASE_NOT_FOUND";
    throw err;
  }

  // progress.yaml is only loaded when the consistency checks need it.
  const phase = await loadPhase(cwd, ref.path);

  // Verify task exists in phase before running checks
  const taskExists = phase.tasks?.some((t) => t.id === taskId) ?? false;
  if (!taskExists) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  const task = phase.tasks!.find((t) => t.id === taskId)!;

  // Deterministic preflight checks: would always be runnable on a fresh
  // task before any state mutation. `task complete` calls runVerify with
  // skipConsistencyChecks: true so these are the only checks evaluated.
  const checks: CheckResult[] = [
    await checkCommands(phase.verification.commands, cwd, dryRun),
    await checkDecision(cwd, phase, task),
  ];

  // State-consistency checks: only meaningful AFTER the task has been
  // recorded as done. `verify` (standalone) runs them; `task complete`
  // skips them because it is the action that produces that state.
  if (!skipConsistency) {
    const log = await loadProgressLog(cwd);
    checks.splice(1, 0, await checkProgressEvent(log, taskId));
    checks.push(checkTaskStatus(phase, taskId));
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

// ---------------------------------------------------------------------------
// Human-readable formatter
// ---------------------------------------------------------------------------

export function formatVerify(result: VerifyResult): string {
  const lines = result.checks.map((c) => {
    const mark = c.ok ? "✓" : "✗";
    const reason = c.reason ? `  → ${c.reason}` : "";
    return `  ${mark} ${c.name}${reason}`;
  });
  const summary = result.ok ? "All checks passed." : "Verification failed.";
  return [summary, ...lines].join("\n");
}
