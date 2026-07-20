import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runBoundedCommand } from "../process/bounded-command.ts";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "../../commands/verify.ts";

const execFileAsync = promisify(execFile);

export type VerificationScope = {
  changedFiles: string[];
  docs: boolean;
  standard: boolean;
  toolchain: boolean;
  processControl: boolean;
  generic: boolean;
  reason: string;
};

export type VerificationCommand = [string, string[]];

export type ClassifiedVerification = {
  scope: VerificationScope & { mergeBase: string | null; failSafe: boolean };
  commands: VerificationCommand[];
  failSafe: boolean;
};

export type LocalVerificationResult = {
  command: string;
  exit_code: number;
  duration_ms: number;
  stdout_excerpt: string;
  stderr_excerpt: string;
};

const MAX_EXCERPT_BYTES = 4096;
const SCRIPT = "scripts/verification-scope.mjs";

function excerpt(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_EXCERPT_BYTES) return text;
  let cut = MAX_EXCERPT_BYTES;
  // Do not cut in the middle of a UTF-8 sequence.
  while (cut > 0 && (text.charCodeAt(cut) & 0xc0) === 0x80) {
    cut -= 1;
  }
  return `${text.slice(0, cut)}\n[code-pact: excerpt truncated]\n`;
}

function shellJoin(program: string, args: string[]): string {
  return [program, ...args].map(arg => JSON.stringify(arg)).join(" ");
}

export async function classifyVerification(
  cwd: string,
  baseRef: string,
): Promise<ClassifiedVerification> {
  const { stdout } = await execFileAsync(
    "node",
    [SCRIPT, "--base", baseRef, "--commands", "--format", "json"],
    { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as {
    scope: VerificationScope & { mergeBase: string | null; failSafe: boolean };
    commands: VerificationCommand[];
    failSafe: boolean;
  };
  if (!Array.isArray(parsed.commands)) {
    throw new Error("verification-scope did not return commands");
  }
  return {
    scope: parsed.scope,
    commands: parsed.commands,
    failSafe: parsed.failSafe ?? false,
  };
}

export async function runVerificationCommands(
  cwd: string,
  commands: VerificationCommand[],
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<{ ok: boolean; results: LocalVerificationResult[] }> {
  const results: LocalVerificationResult[] = [];
  for (const [program, args] of commands) {
    const command = shellJoin(program, args);
    const outcome = await runBoundedCommand(command, cwd, timeoutMs);
    results.push({
      command,
      exit_code: outcome.exitCode ?? -1,
      duration_ms: outcome.elapsedMs,
      stdout_excerpt: excerpt(outcome.stdout),
      stderr_excerpt: excerpt(outcome.stderr),
    });
    if ((outcome.exitCode ?? 1) !== 0) {
      return { ok: false, results };
    }
  }
  return { ok: true, results };
}
