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

function isRenameOrCopy(index: string, worktree: string): boolean {
  return index === "R" || worktree === "R" || index === "C" || worktree === "C";
}

function isUnmerged(index: string, worktree: string): boolean {
  return UNMERGED_PAIRS.has(`${index}${worktree}`);
}

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

    let nextIndex = nul + 1;

    // Rename or copy entries carry the origin path as a second NUL-terminated
    // field. We consume it but only record the new path in the snapshot.
    if (isRenameOrCopy(index, worktree)) {
      const originNul = buffer.indexOf(0, nextIndex);
      if (originNul === -1) {
        return { ok: false, reason: "rename/copy record missing origin path" };
      }
      if (originNul === nextIndex) {
        return {
          ok: false,
          reason: "rename/copy record has empty origin path",
        };
      }
      try {
        decodePath(buffer, nextIndex, originNul);
      } catch {
        return { ok: false, reason: "invalid UTF-8 in rename origin path" };
      }
      nextIndex = originNul + 1;
    }

    entries.push({ index, worktree, path });
    i = nextIndex;
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

async function runGitBuffer(
  cwd: string,
  args: readonly string[],
): Promise<{ ok: true; stdout: Buffer } | { ok: false; reason: string }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "core.quotePath=false", ...args],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 2 * 1024 * 1024,
      } as const,
    );
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      reason: `git ${args[0]} failed: ${(error as Error).message}`,
    };
  }
}

async function runGitText(
  cwd: string,
  args: readonly string[],
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "core.quotePath=false", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1 * 1024 * 1024,
      } as const,
    );
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      reason: `git ${args[0]} failed: ${(error as Error).message}`,
    };
  }
}

function isUnbornRepositoryError(reason: string): boolean {
  return (
    reason.includes("Needed a single revision") ||
    reason.includes("unknown revision") ||
    reason.includes("bad revision")
  );
}

export type GitSnapshotProvider = (
  cwd: string,
  deps?: GitSnapshotDeps,
) => Promise<GitSnapshot | GitSnapshotError>;

type GitRunText = (
  cwd: string,
  args: readonly string[],
) => ReturnType<typeof runGitText>;

type GitRunBuffer = (
  cwd: string,
  args: readonly string[],
) => ReturnType<typeof runGitBuffer>;

export type GitSnapshotDeps = {
  runGitText?: GitRunText;
  runGitBuffer?: GitRunBuffer;
};

function trimHead(stdout: string): string | null {
  const trimmed = stdout.trim();
  return trimmed.length === 0 ? null : trimmed;
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

  const headBeforeRun = await runText(cwd, ["rev-parse", "--verify", "HEAD"]);
  let headBefore: string | null;
  if (headBeforeRun.ok) {
    headBefore = trimHead(headBeforeRun.stdout);
  } else if (isUnbornRepositoryError(headBeforeRun.reason)) {
    headBefore = null;
  } else {
    return { kind: "git_error", reason: headBeforeRun.reason };
  }

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

  const headAfterRun = await runText(cwd, ["rev-parse", "--verify", "HEAD"]);
  let headAfter: string | null;
  if (headAfterRun.ok) {
    headAfter = trimHead(headAfterRun.stdout);
  } else if (isUnbornRepositoryError(headAfterRun.reason)) {
    headAfter = null;
  } else {
    return { kind: "git_error", reason: headAfterRun.reason };
  }

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
