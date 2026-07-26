import { createHash } from "node:crypto";
import {
  hashOwnedRegularFileSha256,
  lstatOwned,
  mkdirOwned,
  readOwnedText,
  readlinkOwned,
  writeOwnedText,
  resolveVerificationLedgerReadPath,
  resolveVerificationLedgerWritePath,
  resolveVerificationRunsDirWritePath,
  resolveVerificationStateReadPath,
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
const MAX_STATE_ERROR_STDERR_BYTES = 2048;

function sha256(input: string | Buffer): string {
  if (typeof input !== "string") {
    return createHash("sha256").update(input).digest("hex");
  }
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function capText(input: string, maxBytes: number): string {
  const bytes = Buffer.from(input, "utf8");
  if (bytes.length <= maxBytes) return input;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}…[truncated]`;
}

function verificationStateUnavailable(opts: {
  operation: string;
  exitCode?: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  stderr?: string;
}): Error {
  const error = new Error(
    `Verification state is unavailable while running ${opts.operation}.`,
  );
  (error as NodeJS.ErrnoException).code = "VERIFICATION_STATE_UNAVAILABLE";
  (
    error as NodeJS.ErrnoException & {
      operation?: string;
      exit_code?: number | null;
      timed_out?: boolean;
      aborted?: boolean;
      stderr?: string;
    }
  ).operation = opts.operation;
  (
    error as NodeJS.ErrnoException & {
      operation?: string;
      exit_code?: number | null;
      timed_out?: boolean;
      aborted?: boolean;
      stderr?: string;
    }
  ).exit_code = opts.exitCode ?? null;
  (
    error as NodeJS.ErrnoException & {
      operation?: string;
      exit_code?: number | null;
      timed_out?: boolean;
      aborted?: boolean;
      stderr?: string;
    }
  ).timed_out = opts.timedOut ?? false;
  (
    error as NodeJS.ErrnoException & {
      operation?: string;
      exit_code?: number | null;
      timed_out?: boolean;
      aborted?: boolean;
      stderr?: string;
    }
  ).aborted = opts.aborted ?? false;
  if (opts.stderr) {
    (
      error as NodeJS.ErrnoException & {
        operation?: string;
        exit_code?: number | null;
        timed_out?: boolean;
        aborted?: boolean;
        stderr?: string;
      }
    ).stderr = capText(opts.stderr, MAX_STATE_ERROR_STDERR_BYTES);
  }
  return error;
}

async function gitOutput(cwd: string, command: string): Promise<string> {
  const result = await runBoundedCommand(
    command,
    cwd,
    GIT_STATE_TIMEOUT_MS,
  );
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    throw verificationStateUnavailable({
      operation: command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
      stderr: result.stderr,
    });
  }
  return result.stdout;
}

function parseNulDelimited(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function sortPathsByteStable(paths: string[]): string[] {
  return [...paths].sort((a, b) =>
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
  );
}

type UntrackedManifestEntry =
  | {
      path: string;
      type: "file";
      mode: number;
      size: number;
      sha256: string;
    }
  | {
      path: string;
      type: "symlink";
      target_sha256: string;
    };

async function hashUntrackedEntry(
  cwd: string,
  path: string,
): Promise<UntrackedManifestEntry> {
  const readPath = await resolveVerificationStateReadPath(cwd, path);
  let stat;
  try {
    stat = await lstatOwned(readPath);
  } catch (cause) {
    throw verificationStateUnavailable({
      operation: "stat untracked entry",
      stderr: cause instanceof Error ? cause.message : String(cause),
    });
  }

  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = await readlinkOwned(readPath);
    } catch (cause) {
      throw verificationStateUnavailable({
        operation: "read untracked symlink target",
        stderr: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return {
      path,
      type: "symlink",
      target_sha256: sha256(target),
    };
  }

  if (!stat.isFile()) {
    throw verificationStateUnavailable({
      operation: "hash untracked entry",
      stderr: `unsupported file type: mode ${stat.mode}`,
    });
  }

  try {
    return {
      path,
      type: "file",
      mode: stat.mode,
      size: stat.size,
      sha256: await hashOwnedRegularFileSha256(readPath),
    };
  } catch (cause) {
    throw verificationStateUnavailable({
      operation: "hash untracked file content",
      stderr: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

async function collectUntrackedManifest(
  cwd: string,
): Promise<UntrackedManifestEntry[]> {
  const output = await gitOutput(
    cwd,
    "git ls-files --others --exclude-standard -z -- . ':(exclude).code-pact/cache/verification-runs/**'",
  );
  const paths = sortPathsByteStable(parseNulDelimited(output));
  const entries: UntrackedManifestEntry[] = [];
  for (const path of paths) {
    entries.push(await hashUntrackedEntry(cwd, path));
  }
  return entries;
}

export async function currentVerificationState(
  cwd: string,
): Promise<VerificationStateKey> {
  const headRaw = await gitOutput(cwd, "git rev-parse HEAD");
  const head = headRaw.trim();
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    throw verificationStateUnavailable({
      operation: "git rev-parse HEAD",
      stderr: "invalid HEAD",
    });
  }
  const [status, diff, untracked] = await Promise.all([
    gitOutput(
      cwd,
      "git status --porcelain=v1 -z -- . ':(exclude).code-pact/cache/verification-runs/**'",
    ),
    gitOutput(
      cwd,
      "git diff --binary --no-ext-diff HEAD -- . ':(exclude).code-pact/cache/verification-runs/**'",
    ),
    collectUntrackedManifest(cwd),
  ]);
  return {
    headSha: head,
    workingTreeDiffDigest: sha256(
      JSON.stringify({ head, status, diff, untracked }),
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
