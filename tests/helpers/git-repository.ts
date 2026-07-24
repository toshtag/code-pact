import { spawnSync } from "node:child_process";

/**
 * Deterministic Git identity used in integration tests.
 *
 * The CLI test runner merges these variables into the subprocess environment
 * so the built CLI can run git commands even when the parent has no global
 * Git configuration or when HOME/XDG_CONFIG_HOME are unset.
 */
export const HERMETIC_GIT_ENV = {
  GIT_AUTHOR_NAME: "code-pact-test",
  GIT_AUTHOR_EMAIL: "test@code-pact.dev",
  GIT_COMMITTER_NAME: "code-pact-test",
  GIT_COMMITTER_EMAIL: "test@code-pact.dev",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
} as const;

/**
 * Run a short-lived git command with the hermetic identity.
 * Exposed so individual tests can set up deterministic local repositories
 * without depending on ambient git config.
 */
export function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...HERMETIC_GIT_ENV, ...env },
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
}
