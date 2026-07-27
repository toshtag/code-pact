import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { runBoundedArgv } from "../process/bounded-command.ts";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "../../commands/verify.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// The verification-scope envelope contract
//
// `scripts/verification-scope.mjs --commands --format json` emits one FLAT,
// non-empty argv array per command — `["pnpm", "exec", "vitest", "run"]` — the
// same shape the script destructures internally (`let [program, ...args] =
// step.command`). This module used to declare the nested pair
// `[string, string[]]` and destructure `[program, args]`, so `args` was the
// string `"exec"` and spreading it produced `"pnpm" "e" "x" "e" "c"`. Every
// classifier command was unrunnable, and `task review-bundle` / `ci-parity`
// refused with a VERIFICATION_FAILED that named a command nobody wrote.
//
// The script's shape is canonical, and the WHOLE envelope is validated here —
// not just `commands`. Nothing crosses this boundary through a cast, and no
// field is defaulted on absence: a producer that stops emitting `failSafe`
// must fail loudly rather than be read as "not fail-safe", which would silently
// narrow verification. Unknown keys are allowed through so the producer can
// grow fields without a lockstep release.
// ---------------------------------------------------------------------------

/**
 * One command as `[program, ...args]`.
 *
 * The program must be a non-empty string. Arguments may be empty strings —
 * `["grep", ""]` is a legitimate argv — so the rest element carries no
 * minimum.
 */
export const VerificationCommand = z
  .tuple([z.string().min(1)])
  .rest(z.string());
export type VerificationCommand = z.infer<typeof VerificationCommand>;

export const VerificationScopeSchema = z.object({
  changedFiles: z.array(z.string()),
  docs: z.boolean(),
  standard: z.boolean(),
  toolchain: z.boolean(),
  processControl: z.boolean(),
  generic: z.boolean(),
  workflow: z.boolean(),
  releaseScript: z.boolean(),
  sharedTestInfra: z.boolean(),
  unknown: z.boolean(),
  highRisk: z.boolean(),
  fallbackFull: z.boolean(),
  fallbackReason: z.string().nullable(),
  mode: z.enum(["focused", "full"]),
  reason: z.string(),
  mergeBase: z.string().nullable(),
});
export type VerificationScope = z.infer<typeof VerificationScopeSchema>;

export const VerificationScopeOutput = z.object({
  scope: VerificationScopeSchema,
  commands: z.array(VerificationCommand),
  failSafe: z.boolean(),
});

export type ClassifiedVerification = {
  scope: VerificationScope & { failSafe: boolean };
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

/**
 * Renders `[program, ...args]` for manifests and failure messages.
 *
 * DIAGNOSTIC ONLY — this string is never executed. It used to be fed to a
 * shell, which silently undid the argv contract: `JSON.stringify` is not shell
 * quoting, so an argument containing `$(...)` was expanded rather than passed
 * through. Commands run from their argv via `runBoundedArgv`; this rendering
 * exists so a human can read what ran.
 */
function formatArgvForDisplay(command: VerificationCommand): string {
  return command.map(arg => JSON.stringify(arg)).join(" ");
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
  const result = VerificationScopeOutput.safeParse(JSON.parse(stdout));
  if (!result.success) {
    throw new Error(
      `verification-scope output does not match the classifier envelope contract: ${result.error.message}`,
    );
  }
  const parsed = result.data;
  return {
    scope: { ...parsed.scope, failSafe: parsed.failSafe },
    commands: parsed.commands,
    failSafe: parsed.failSafe,
  };
}

export async function runVerificationCommands(
  cwd: string,
  commands: VerificationCommand[],
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<{ ok: boolean; results: LocalVerificationResult[] }> {
  const results: LocalVerificationResult[] = [];
  for (const argv of commands) {
    const [program, ...args] = argv;
    const command = formatArgvForDisplay(argv);
    const outcome = await runBoundedArgv(program, args, cwd, timeoutMs);
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
