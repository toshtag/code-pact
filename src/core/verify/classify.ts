import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
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

// ---------------------------------------------------------------------------
// The verification command contract
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
// The script's flat argv is canonical. The consumer no longer trusts the JSON
// through an unchecked cast: `VerificationScopeOutput` validates it, so a
// producer that ever goes back to the nested shape fails at the boundary with
// a parse error instead of silently emitting shell nonsense.
// ---------------------------------------------------------------------------

/** One command as `[program, ...args]`. Non-empty; every element a string. */
export const VerificationCommand = z.tuple([z.string()]).rest(z.string());
export type VerificationCommand = z.infer<typeof VerificationCommand>;

export const VerificationScopeOutput = z.object({
  scope: z.looseObject({
    mergeBase: z.string().nullable(),
    failSafe: z.boolean().optional(),
  }),
  commands: z.array(VerificationCommand),
  failSafe: z.boolean().optional(),
});

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

/** Renders `[program, ...args]` as a quoted shell line for the bounded runner. */
function shellJoin(command: VerificationCommand): string {
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
      `verification-scope returned commands that do not match the [program, ...args] contract: ${result.error.message}`,
    );
  }
  const parsed = result.data;
  return {
    scope: parsed.scope as ClassifiedVerification["scope"],
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
  for (const argv of commands) {
    const command = shellJoin(argv);
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
