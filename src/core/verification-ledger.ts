import { createHash } from "node:crypto";
import {
  mkdirOwned,
  readOwnedText,
  writeOwnedText,
  resolveVerificationLedgerReadPath,
  resolveVerificationLedgerWritePath,
  resolveVerificationRunsDirWritePath,
} from "./project-fs/index.ts";
import {
  runBoundedCommand,
  type CommandExecutionResult,
} from "./process/bounded-command.ts";

export type VerificationLedgerStage = "focused" | "full";

export type VerificationLedgerEntry = {
  schema_version: 1;
  started_at: string;
  finished_at: string;
  task_id: string;
  phase_id: string;
  head_sha: string | null;
  working_tree_diff_digest: string;
  stage: VerificationLedgerStage;
  commands: {
    command: string;
    exit_code: number | null;
    duration_ms: number;
  }[];
  duration_ms: number;
  failure: boolean;
  attempt_number: number;
};

export type VerificationStateKey = {
  headSha: string | null;
  workingTreeDiffDigest: string;
};

const GIT_STATE_TIMEOUT_MS = 30_000;

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function gitOutput(cwd: string, command: string): Promise<string> {
  const result = await runBoundedCommand(
    command,
    cwd,
    GIT_STATE_TIMEOUT_MS,
  );
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    return `git-state-error:${command}:${result.exitCode}:${result.stderr}`;
  }
  return result.stdout;
}

export async function currentVerificationState(
  cwd: string,
): Promise<VerificationStateKey> {
  const headRaw = await gitOutput(cwd, "git rev-parse HEAD");
  const head = /^[0-9a-f]{40}$/i.test(headRaw.trim()) ? headRaw.trim() : null;
  const [status, diff] = await Promise.all([
    gitOutput(
      cwd,
      "git status --porcelain=v1 -z -- . ':(exclude).code-pact/cache/verification-runs/**'",
    ),
    gitOutput(
      cwd,
      "git diff --binary --no-ext-diff HEAD -- . ':(exclude).code-pact/cache/verification-runs/**'",
    ),
  ]);
  return {
    headSha: head,
    workingTreeDiffDigest: sha256(
      JSON.stringify({ head, status, diff }),
    ),
  };
}

export async function readVerificationLedger(
  cwd: string,
): Promise<VerificationLedgerEntry[]> {
  let raw: string;
  try {
    raw = await readOwnedText(await resolveVerificationLedgerReadPath(cwd));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  try {
    return raw
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as VerificationLedgerEntry);
  } catch (cause) {
    const err = new Error(
      `Verification ledger is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    (err as NodeJS.ErrnoException).code = "VERIFICATION_LEDGER_INVALID";
    throw err;
  }
}

export function stageAttemptCount(
  ledger: VerificationLedgerEntry[],
  taskId: string,
  stage: VerificationLedgerStage,
): number {
  return ledger.filter(entry => entry.task_id === taskId && entry.stage === stage)
    .length;
}

export function lastStageEntryForState(
  ledger: VerificationLedgerEntry[],
  taskId: string,
  state: VerificationStateKey,
  stage: VerificationLedgerStage,
): VerificationLedgerEntry | undefined {
  return ledger.findLast(
    entry =>
      entry.task_id === taskId &&
      entry.stage === stage &&
      entry.head_sha === state.headSha &&
      entry.working_tree_diff_digest === state.workingTreeDiffDigest,
  );
}

export async function appendVerificationLedgerEntry(
  cwd: string,
  entry: Omit<VerificationLedgerEntry, "schema_version" | "attempt_number">,
): Promise<VerificationLedgerEntry> {
  const ledger = await readVerificationLedger(cwd);
  const fullEntry: VerificationLedgerEntry = {
    schema_version: 1,
    ...entry,
    attempt_number: stageAttemptCount(ledger, entry.task_id, entry.stage) + 1,
  };
  await mkdirOwned(await resolveVerificationRunsDirWritePath(cwd), {
    recursive: true,
  });
  const existing = ledger.map(item => JSON.stringify(item)).join("\n");
  const next = `${existing}${existing.length > 0 ? "\n" : ""}${JSON.stringify(fullEntry)}\n`;
  await writeOwnedText(await resolveVerificationLedgerWritePath(cwd), next);
  return fullEntry;
}

export function ledgerCommandsFromCheck(
  check: { command?: string; commands?: CommandExecutionResult[]; exitCode?: number | null; elapsedMs?: number },
): VerificationLedgerEntry["commands"] {
  if (check.commands && check.commands.length > 0) {
    return check.commands.map(command => ({
      command: command.command,
      exit_code: command.exitCode,
      duration_ms: command.elapsedMs,
    }));
  }
  if (check.command) {
    return [
      {
        command: check.command,
        exit_code: check.exitCode ?? null,
        duration_ms: check.elapsedMs ?? 0,
      },
    ];
  }
  return [];
}
