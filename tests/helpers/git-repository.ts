import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const HERMETIC_GIT_ENV = {
  GIT_AUTHOR_NAME: "code-pact-test",
  GIT_AUTHOR_EMAIL: "test@code-pact.dev",
  GIT_COMMITTER_NAME: "code-pact-test",
  GIT_COMMITTER_EMAIL: "test@code-pact.dev",
  GIT_CONFIG_NOSYSTEM: "1",
} as const;

export class TestGitError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly args: readonly string[],
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "TestGitError";
  }
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const command = `git ${args.map(a => JSON.stringify(a)).join(" ")}`;
  try {
    await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, ...HERMETIC_GIT_ENV },
    });
  } catch (error) {
    const err = error as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout =
      typeof err.stdout === "string"
        ? err.stdout
        : (err.stdout?.toString("utf8") ?? "");
    const stderr =
      typeof err.stderr === "string"
        ? err.stderr
        : (err.stderr?.toString("utf8") ?? "");
    throw new TestGitError(
      `Hermetic git command failed: ${command}\n${err.message}`,
      command,
      args,
      stdout,
      stderr,
    );
  }
}

/** Initialize a fresh git repository with a deterministic local identity.
 *
 * The repository-local user.name and user.email are set, and the environment
 * supplies author/committer names, so the repo works even when `HOME` is
 * empty and global Git configuration is unavailable.
 */
export async function initTestGitRepository(cwd: string): Promise<void> {
  await git(cwd, ["init", "--quiet", "--initial-branch=main"]);
  await git(cwd, ["config", "user.name", HERMETIC_GIT_ENV.GIT_AUTHOR_NAME]);
  await git(cwd, ["config", "user.email", HERMETIC_GIT_ENV.GIT_AUTHOR_EMAIL]);
}

/** Returns a copy of the current process environment with the hermetic
 * Git identity layered on top. Useful for subprocess-based CLI tests that
 * spawn the built CLI and rely on Git commands running inside it. */
export function withHermeticGitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...HERMETIC_GIT_ENV };
}

/** Commit the staged changes with a deterministic identity. */
export async function gitCommit(cwd: string, message: string): Promise<void> {
  await git(cwd, ["commit", "--quiet", "-m", message]);
}
