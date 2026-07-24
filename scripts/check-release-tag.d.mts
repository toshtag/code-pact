// Type declarations for check-release-tag.mjs (consumed by the unit test;
// the script itself runs as plain Node ESM).

export function firstReleasedVersion(changelog: string): string | null;

export type RegistryState = "exists" | "absent" | "error" | "unknown";

export function checkReleaseTag(opts: {
  refType: string;
  refName: string;
  sha: string;
  repository: string;
  token: string;
  pkg: { name: string; version: string };
  changelog: string;
  githubApi?: (repo: string, path: string, token: string) => Promise<any>;
  gitRunner?: (args: string[]) => Buffer;
  registryCheck?: (
    packageName: string,
    version: string,
  ) => Promise<RegistryState>;
}): Promise<{
  ok: boolean;
  message: string;
  versionExists: boolean;
  registryState: RegistryState;
}>;
