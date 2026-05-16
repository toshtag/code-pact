import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../core/schemas/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import { ProgressLog } from "../core/schemas/progress-event.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerifyOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  dryRun: boolean;
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

async function loadPhase(cwd: string, path: string): Promise<Phase> {
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

function runCommand(cmd: string, cwd: string): Promise<CommandRun> {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd.split(/\s+/);
    const proc = spawn(bin ?? cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    proc.on("error", () => resolve({ exitCode: 1, stdout, stderr }));
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

async function checkDecision(
  cwd: string,
  phase: Phase,
  taskId: string,
): Promise<CheckResult> {
  if (!phase.requires_decision) {
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

  const hasAdr = entries.some((f) => f.endsWith(".md") && f.includes(taskId));
  if (!hasAdr) {
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

  // Resolve phase
  const roadmap = await loadRoadmap(cwd);
  const ref = roadmap.phases.find((p) => p.id === phaseId);
  if (!ref) {
    const err = new Error(`Phase "${phaseId}" not found in roadmap.yaml.`);
    (err as NodeJS.ErrnoException).code = "PHASE_NOT_FOUND";
    throw err;
  }

  const [phase, log] = await Promise.all([
    loadPhase(cwd, ref.path),
    loadProgressLog(cwd),
  ]);

  // Verify task exists in phase before running checks
  const taskExists = phase.tasks?.some((t) => t.id === taskId) ?? false;
  if (!taskExists) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  // Run all checks in order
  const checks: CheckResult[] = [
    await checkCommands(phase.verification.commands, cwd, dryRun),
    await checkProgressEvent(log, taskId),
    await checkDecision(cwd, phase, taskId),
    checkTaskStatus(phase, taskId),
  ];

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
