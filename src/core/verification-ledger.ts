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
  runBoundedCommandDigest,
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
/**
 * Total budget for one state collection. Individual Git commands are bounded
 * too, but their timeouts must not sum into an unbounded whole once untracked
 * content hashing is added on top.
 */
const STATE_COLLECTION_DEADLINE_MS = 60_000;
/** A path longer than this is not a path Git produced; fail closed instead. */
const MAX_UNTRACKED_PATH_BYTES = 8192;

const PATHSPEC = [".", ":(exclude).code-pact/cache/verification-runs/**"];

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
  // A truncated capture maps distinct outputs onto one value, which would let a
  // stale focused pass authorize a changed tree. It is never usable state.
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw verificationStateUnavailable({
      operation: command,
      exitCode: result.exitCode,
      stderr: "command output exceeded the capture limit",
    });
  }
  return result.stdout;
}

type GitStreamDigest = { sha256: string; bytes: number };

/**
 * Digest one Git state command losslessly.
 *
 * Git status and diff output is unbounded in principle; capturing it as a
 * string would either truncate it or hold the whole diff in memory. Only the
 * digest and byte count are needed to detect a changed tree.
 */
async function gitStreamDigest(
  cwd: string,
  args: string[],
  deadline: number,
  onStdoutChunk?: (chunk: Buffer) => void,
): Promise<GitStreamDigest> {
  const operation = `git ${args.join(" ")}`;
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) {
    throw verificationStateUnavailable({ operation, timedOut: true });
  }
  const result = await runBoundedCommandDigest({
    executable: "git",
    args,
    cwd,
    timeoutMs: Math.min(GIT_STATE_TIMEOUT_MS, remainingMs),
    onStdoutChunk,
  });
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    throw verificationStateUnavailable({
      operation,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
      stderr: result.stderr,
    });
  }
  return { sha256: result.stdoutSha256, bytes: result.stdoutBytes };
}

/**
 * Collect NUL-delimited entries from a byte stream.
 *
 * Paths must be reassembled across chunk boundaries, so entries accumulate
 * until their terminator arrives. Only one pending entry is held at a time,
 * never the whole listing.
 */
function createNulEntryCollector(): {
  append: (chunk: Buffer) => void;
  entries: () => string[];
  pendingBytes: () => number;
} {
  const entries: string[] = [];
  let pending: Buffer = Buffer.alloc(0);

  return {
    append(chunk: Buffer): void {
      let rest = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let index = rest.indexOf(0);
      while (index !== -1) {
        entries.push(rest.subarray(0, index).toString("utf8"));
        rest = rest.subarray(index + 1);
        index = rest.indexOf(0);
      }
      if (rest.length > MAX_UNTRACKED_PATH_BYTES) {
        throw new Error(
          `untracked path exceeded ${MAX_UNTRACKED_PATH_BYTES} bytes`,
        );
      }
      pending = Buffer.from(rest);
    },
    entries: () => entries,
    pendingBytes: () => pending.length,
  };
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
  deadline: number,
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
      sha256: await hashOwnedRegularFileSha256(readPath, { deadline }),
    };
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    throw verificationStateUnavailable({
      operation: "hash untracked file content",
      timedOut: code === "ETIMEDOUT",
      aborted: code === "ABORT_ERR",
      stderr: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

async function collectUntrackedManifest(
  cwd: string,
  deadline: number,
): Promise<UntrackedManifestEntry[]> {
  const collector = createNulEntryCollector();
  await gitStreamDigest(
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...PATHSPEC],
    deadline,
    chunk => collector.append(chunk),
  );
  // Git terminates every entry with NUL. Leftover bytes mean the listing was
  // cut short, and a partial path must never be hashed as if it were complete.
  if (collector.pendingBytes() > 0) {
    throw verificationStateUnavailable({
      operation: "git ls-files --others",
      stderr: "untracked listing ended with an unterminated entry",
    });
  }
  const paths = sortPathsByteStable(collector.entries().filter(Boolean));
  const entries: UntrackedManifestEntry[] = [];
  for (const path of paths) {
    entries.push(await hashUntrackedEntry(cwd, path, deadline));
  }
  return entries;
}

export async function currentVerificationState(
  cwd: string,
): Promise<VerificationStateKey> {
  const deadline = performance.now() + STATE_COLLECTION_DEADLINE_MS;
  const headRaw = await gitOutput(cwd, "git rev-parse HEAD");
  const head = headRaw.trim();
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    throw verificationStateUnavailable({
      operation: "git rev-parse HEAD",
      stderr: "invalid HEAD",
    });
  }
  const [status, diff, untracked] = await Promise.all([
    gitStreamDigest(
      cwd,
      ["status", "--porcelain=v1", "-z", "--", ...PATHSPEC],
      deadline,
    ),
    gitStreamDigest(
      cwd,
      ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...PATHSPEC],
      deadline,
    ),
    collectUntrackedManifest(cwd, deadline),
  ]);
  return {
    headSha: head,
    workingTreeDiffDigest: sha256(
      JSON.stringify({
        head,
        status_sha256: status.sha256,
        status_bytes: status.bytes,
        diff_sha256: diff.sha256,
        diff_bytes: diff.bytes,
        untracked,
      }),
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
