import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitStatusEntry = {
  /** First character: index status. */
  index: string;
  /** Second character: worktree status. */
  worktree: string;
  /** Repo-root-relative path (raw bytes interpreted as UTF-8). */
  path: string;
};

export type GitSnapshot = {
  kind: "ok";
  /** HEAD commit oid, or `null` when the repository has no commits. */
  head: string | null;
  /** Parsed status entries, sorted deterministically. */
  entries: GitStatusEntry[];
};

export type GitSnapshotError = {
  kind: "git_error";
  reason: string;
};

type ParseGitStatusResult =
  | { ok: true; entries: GitStatusEntry[] }
  | { ok: false; reason: string };

const VALID_STATUS_CHARS = new Set([
  " ",
  "M",
  "T",
  "A",
  "D",
  "R",
  "C",
  "U",
  "?",
]);

const UNMERGED_PAIRS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function isUnmerged(index: string, worktree: string): boolean {
  return UNMERGED_PAIRS.has(`${index}${worktree}`);
}

// Allowed XY status pairs from `git status --porcelain=v1 -z --no-renames`.
// Rename/copy pairs (R/C) are intentionally absent because --no-renames should
// prevent them; if they appear, the snapshot is treated as malformed.
const ALLOWED_PORCELAIN_PAIRS = new Set([
  " M",
  "M ",
  "MM",
  "A ",
  "AM",
  "AD",
  "D ",
  " D",
  "DD",
  "T ",
  " T",
  "TM",
  "TD",
  "MD",
  "DM",
  "??",
  ...UNMERGED_PAIRS,
]);

/** Decode a path segment with fatal UTF-8. */
function decodePath(buffer: Buffer, start: number, end: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return decoder.decode(buffer.subarray(start, end));
}

/** Parse `git status --porcelain=v1 -z` output.
 *
 * With `-z`, each entry is `XY <path>\0`. Paths are raw bytes; we interpret
 * them as UTF-8 without quoting or trimming. This keeps leading/trailing
 * spaces, newlines, and other unusual characters intact.
 *
 * The parser is fail-closed: any malformed or truncated record, invalid status
 * character or combination, invalid UTF-8 path, or empty path makes the whole
 * snapshot unusable.
 */
export function parsePorcelainV1Z(buffer: Buffer): ParseGitStatusResult {
  const entries: GitStatusEntry[] = [];
  let i = 0;
  while (i < buffer.length) {
    if (i + 2 >= buffer.length) {
      return { ok: false, reason: "truncated status record" };
    }
    const index = String.fromCharCode(buffer[i]!);
    const worktree = String.fromCharCode(buffer[i + 1]!);

    if (!VALID_STATUS_CHARS.has(index) || !VALID_STATUS_CHARS.has(worktree)) {
      return { ok: false, reason: "invalid status character" };
    }

    if (index === "?" || worktree === "?") {
      if (index !== "?" || worktree !== "?") {
        return { ok: false, reason: "untracked status must be ??" };
      }
    }

    if (index === " " && worktree === " ") {
      return {
        ok: false,
        reason: "unmodified status is not a porcelain record",
      };
    }

    if ((index === "U" || worktree === "U") && !isUnmerged(index, worktree)) {
      return { ok: false, reason: "invalid unmerged status combination" };
    }

    const pair = `${index}${worktree}`;
    if (!ALLOWED_PORCELAIN_PAIRS.has(pair)) {
      return {
        ok: false,
        reason: `disallowed porcelain status pair: ${pair}`,
      };
    }

    // The format is two status chars, a space, then the path terminated by NUL.
    if (buffer[i + 2]! !== 0x20) {
      return { ok: false, reason: "malformed status record prefix" };
    }
    const pathStart = i + 3;
    if (pathStart >= buffer.length) {
      return { ok: false, reason: "status record missing path" };
    }
    const nul = buffer.indexOf(0, pathStart);
    if (nul === -1) {
      return { ok: false, reason: "status record missing NUL terminator" };
    }
    if (nul === pathStart) {
      return { ok: false, reason: "status record has empty path" };
    }

    let path: string;
    try {
      path = decodePath(buffer, pathStart, nul);
    } catch {
      return { ok: false, reason: "invalid UTF-8 in status path" };
    }

    entries.push({ index, worktree, path });
    i = nul + 1;
  }
  return {
    ok: true,
    entries: entries.sort((a, b) => {
      if (a.path < b.path) return -1;
      if (a.path > b.path) return 1;
      if (a.index < b.index) return -1;
      if (a.index > b.index) return 1;
      if (a.worktree < b.worktree) return -1;
      if (a.worktree > b.worktree) return 1;
      return 0;
    }),
  };
}

type GitTextResult =
  | { ok: true; stdout: string; exitCode: number; stderr: string }
  | { ok: false; reason: string; exitCode: number; stderr: string };

type GitBufferResult =
  | { ok: true; stdout: Buffer; exitCode: number; stderr: string }
  | { ok: false; reason: string; exitCode: number; stderr: string };

function stderrString(stderr: Buffer | string): string {
  return Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
}

async function runGitBuffer(
  cwd: string,
  args: readonly string[],
): Promise<GitBufferResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-c", "core.quotePath=false", ...args],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 2 * 1024 * 1024,
      } as const,
    );
    return { ok: true, stdout, exitCode: 0, stderr: stderrString(stderr) };
  } catch (error) {
    const err = error as Error & {
      code?: string | number | null;
      stdout?: Buffer;
      stderr?: Buffer;
    };
    return {
      ok: false,
      reason: `git ${args[0]} failed: ${err.message}`,
      exitCode:
        typeof err.code === "number" ? err.code : err.code === null ? -1 : 1,
      stderr: err.stderr ? stderrString(err.stderr) : "",
    };
  }
}

async function runGitText(
  cwd: string,
  args: readonly string[],
): Promise<GitTextResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-c", "core.quotePath=false", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1 * 1024 * 1024,
      } as const,
    );
    return { ok: true, stdout, exitCode: 0, stderr };
  } catch (error) {
    const err = error as Error & {
      code?: string | number | null;
      stdout?: string;
      stderr?: string;
    };
    return {
      ok: false,
      reason: `git ${args[0]} failed: ${err.message}`,
      exitCode:
        typeof err.code === "number" ? err.code : err.code === null ? -1 : 1,
      stderr: err.stderr ?? "",
    };
  }
}

export type GitSnapshotProvider = (
  cwd: string,
  deps?: GitSnapshotDeps,
) => Promise<GitSnapshot | GitSnapshotError>;

type GitRunText = (
  cwd: string,
  args: readonly string[],
) => Promise<GitTextResult>;

type GitRunBuffer = (
  cwd: string,
  args: readonly string[],
) => Promise<GitBufferResult>;

export type GitSnapshotDeps = {
  runGitText?: GitRunText;
  runGitBuffer?: GitRunBuffer;
};

function trimHead(stdout: string): string | null {
  const trimmed = stdout.trim();
  return trimmed.length === 0 ? null : trimmed;
}

type ResolveHeadResult =
  | { kind: "ok"; head: string | null }
  | { kind: "git_error"; reason: string };

async function resolveHeadForSnapshot(
  cwd: string,
  runText: GitRunText,
): Promise<ResolveHeadResult> {
  const commit = await runText(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD^{commit}",
  ]);
  if (commit.ok) {
    const head = trimHead(commit.stdout);
    return { kind: "ok", head };
  }

  const symref = await runText(cwd, ["symbolic-ref", "-q", "HEAD"]);
  if (!symref.ok) {
    return {
      kind: "git_error",
      reason:
        "GIT_HEAD_UNAVAILABLE: HEAD commit and symbolic ref are both unavailable",
    };
  }

  const ref = trimHead(symref.stdout);
  if (ref === null) {
    return {
      kind: "git_error",
      reason: "GIT_HEAD_UNAVAILABLE: symbolic-ref returned an empty ref",
    };
  }

  const refExists = await runText(cwd, [
    "show-ref",
    "--verify",
    "--quiet",
    ref,
  ]);
  if (refExists.ok) {
    // The branch ref exists but HEAD^{commit} did not resolve. Repository is
    // corrupt or in an unexpected state; do not guess.
    return {
      kind: "git_error",
      reason:
        "GIT_HEAD_UNAVAILABLE: HEAD ref exists but does not point to a commit",
    };
  }

  if (refExists.exitCode === 1) {
    // Ref not found: this is an unborn branch.
    return { kind: "ok", head: null };
  }

  return {
    kind: "git_error",
    reason: `GIT_HEAD_UNAVAILABLE: show-ref failed with exit code ${refExists.exitCode}`,
  };
}

/** Capture a deterministic git snapshot.
 *
 * Returns a `GitSnapshotError` instead of throwing so callers can fail closed
 * without an exception crossing module boundaries.
 *
 * HEAD is read before and after `git status`; if the two reads do not match,
 * the snapshot is rejected because the repository state is not a single
 * coherent point. The caller must not retry.
 */
export async function getExecutionGitSnapshot(
  cwd: string,
  deps?: GitSnapshotDeps,
): Promise<GitSnapshot | GitSnapshotError> {
  const runText = deps?.runGitText ?? runGitText;
  const runBuffer = deps?.runGitBuffer ?? runGitBuffer;

  const headBeforeResult = await resolveHeadForSnapshot(cwd, runText);
  if (headBeforeResult.kind === "git_error") {
    return { kind: "git_error", reason: headBeforeResult.reason };
  }
  const headBefore = headBeforeResult.head;

  const statusRun = await runBuffer(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    "--untracked-files=all",
  ]);
  if (!statusRun.ok) {
    return { kind: "git_error", reason: statusRun.reason };
  }

  const headAfterResult = await resolveHeadForSnapshot(cwd, runText);
  if (headAfterResult.kind === "git_error") {
    return { kind: "git_error", reason: headAfterResult.reason };
  }
  const headAfter = headAfterResult.head;

  if (headBefore !== headAfter) {
    return {
      kind: "git_error",
      reason:
        "GIT_SNAPSHOT_CHANGED_DURING_READ: HEAD changed between snapshot reads",
    };
  }

  const parsed = parsePorcelainV1Z(statusRun.stdout);
  if (!parsed.ok) {
    return { kind: "git_error", reason: parsed.reason };
  }

  return {
    kind: "ok",
    head: headBefore,
    entries: parsed.entries,
  };
}

export function snapshotIsClean(snapshot: GitSnapshot): boolean {
  return snapshot.entries.length === 0;
}

export function findStatusEntry(
  snapshot: GitSnapshot,
  path: string,
): GitStatusEntry | undefined {
  return snapshot.entries.find(e => e.path === path);
}

export function snapshotHeadChanged(
  before: GitSnapshot,
  after: GitSnapshot,
): boolean {
  return before.head !== after.head;
}

export function snapshotIndexChanged(snapshot: GitSnapshot): boolean {
  return snapshot.entries.some(e => e.index !== " ");
}

export function changedPaths(snapshot: GitSnapshot): string[] {
  return snapshot.entries.map(e => e.path);
}

export function isOnlyWorktreeModifyOf(
  snapshot: GitSnapshot,
  path: string,
): boolean {
  return (
    snapshot.entries.length === 1 &&
    snapshot.entries[0]!.path === path &&
    snapshot.entries[0]!.index === " " &&
    snapshot.entries[0]!.worktree === "M"
  );
}

export function snapshotToString(snapshot: GitSnapshot): string {
  const lines = snapshot.entries.map(e => `${e.index}${e.worktree} ${e.path}`);
  return [snapshot.head ?? "(no HEAD)", ...lines].join("\n");
}
