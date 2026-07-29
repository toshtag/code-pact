// Type declarations for check-package-tarball.mjs (consumed by the unit test;
// the script itself runs as plain Node ESM).

import type { PackRecord } from "./npm-pack-json.mjs";

export interface RepoPkg {
  name: string;
  version: string;
  bin: Record<string, string>;
  dependencies?: Record<string, string>;
}

export interface TarballCheckOptions {
  tarballPath: string;
  repoPkg: RepoPkg;
  tarRunner?: (args: string[], cwd?: string) => Promise<{ stdout: string; stderr: string }>;
  tempDirMaker?: (prefix: string) => Promise<string>;
  tempDirRemover?: (dir: string) => Promise<void>;
  fileReader?: (path: string) => Promise<string>;
}

export interface TarballCheckResult {
  ok: boolean;
  problems: string[];
}

export function checkPackageTarball(
  opts: TarballCheckOptions,
): Promise<TarballCheckResult>;

export function writePackMetadata(
  targetPath: string,
  record: PackRecord & Record<string, unknown>,
): Promise<string>;

export function inspectPackedTarball(opts: {
  payload: unknown;
  repoPkg: RepoPkg;
  tarballDir?: string;
  metadataOut?: string;
  checker?: (opts: TarballCheckOptions) => Promise<TarballCheckResult>;
  metadataWriter?: (targetPath: string, record: PackRecord) => Promise<string>;
}): Promise<
  TarballCheckResult & { record: PackRecord; metadataPath: string | null }
>;
