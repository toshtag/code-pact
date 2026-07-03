// Type declarations for check-release-tag.mjs (consumed by the unit test;
// the script itself runs as plain Node ESM).

export function firstReleasedVersion(changelog: string): string | null;

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
  registryCheck?: (packageName: string, version: string) => Promise<boolean>;
}): Promise<{ ok: boolean; message: string; versionExists: boolean }>;
