// Type declarations for check-package-tarball.mjs (consumed by the unit test;
// the script itself runs as plain Node ESM).

export function checkPackageTarball(opts: {
  tarballPath: string;
  repoPkg: {
    name: string;
    version: string;
    bin: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  tarRunner?: (args: string[], cwd?: string) => Promise<{ stdout: string; stderr: string }>;
  tempDirMaker?: (prefix: string) => Promise<string>;
  tempDirRemover?: (dir: string) => Promise<void>;
  fileReader?: (path: string) => Promise<string>;
}): Promise<{ ok: boolean; problems: string[] }>;
