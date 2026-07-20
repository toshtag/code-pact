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

/** Parse `git status --porcelain=v1 -z` output.
 *
 * With `-z`, each entry is `XY <path>\0`. Paths are raw bytes; we interpret
 * them as UTF-8 without quoting or trimming. This keeps leading/trailing
 * spaces, newlines, and other unusual characters intact.
 */
export function parsePorcelainV1Z(buffer: Buffer): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  let i = 0;
  while (i < buffer.length) {
    if (i + 2 >= buffer.length) break;
    const index = String.fromCharCode(buffer[i]!);
    const worktree = String.fromCharCode(buffer[i + 1]!);
    // The format is two status chars, a space, then the path terminated by NUL.
    if (buffer[i + 2]! !== 0x20) {
      i += 1;
      continue;
    }
    const pathStart = i + 3;
    const nul = buffer.indexOf(0, pathStart);
    if (nul === -1) break;
    const path = buffer.toString("utf8", pathStart, nul);
    entries.push({ index, worktree, path });
    i = nul + 1;
  }
  return entries.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    if (a.index < b.index) return -1;
    if (a.index > b.index) return 1;
    if (a.worktree < b.worktree) return -1;
    if (a.worktree > b.worktree) return 1;
    return 0;
  });
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

/** Capture a deterministic git snapshot.
 *
 * Returns a `GitSnapshotError` instead of throwing so callers can fail closed
 * without an exception crossing module boundaries.
 */
export async function getExecutionGitSnapshot(
  cwd: string,
): Promise<GitSnapshot | GitSnapshotError> {
  const headRun = await runGitText(cwd, ["rev-parse", "--verify", "HEAD"]);
  const head = headRun.ok ? headRun.stdout.trim() || null : null;

  const statusRun = await runGitBuffer(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    "--untracked-files=all",
  ]);
  if (!statusRun.ok) {
    return { kind: "git_error", reason: statusRun.reason };
  }

  return {
    kind: "ok",
    head,
    entries: parsePorcelainV1Z(statusRun.stdout),
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
