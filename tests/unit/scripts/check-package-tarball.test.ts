import { describe, it, expect, vi } from "vitest";
import { checkPackageTarball } from "../../../scripts/check-package-tarball.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoPkg = {
  name: "code-pact",
  version: "2.0.1",
  bin: { "code-pact": "dist/cli.js" },
  dependencies: { yaml: "^2.9.0", zod: "^4.4.3" },
};

type TarResult = { stdout: string; stderr: string };

function makeTarRunner() {
  return vi.fn((args: string[], cwd?: string): Promise<TarResult> => {
    return new Promise((resolveP, rejectP) => {
      execFile("tar", args, { cwd }, (err, stdout, stderr) => {
        if (err) rejectP(err);
        else resolveP({ stdout, stderr });
      });
    });
  });
}

async function buildTarball(
  tempDir: string,
  files: Record<string, string>,
  tarRunner: (args: string[], cwd: string) => Promise<TarResult>,
): Promise<string> {
  const pkgDir = join(tempDir, "package");
  await mkdir(pkgDir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(pkgDir, path);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content);
  }
  const tarballPath = join(tempDir, "test.tgz");
  await tarRunner(["-czf", tarballPath, "-C", tempDir, "package"], tempDir);
  return tarballPath;
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "extract-"));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe("checkPackageTarball", () => {
  let tempDir: string;

  it("passes when tarball contains only allowed files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tarball-test-"));
    const tarRunner = makeTarRunner();
    const tarballPath = await buildTarball(
      tempDir,
      {
        "package.json": JSON.stringify(repoPkg),
        "README.md": "# code-pact",
        LICENSE: "MIT",
        "dist/cli.js": "#!/usr/bin/env node\nconsole.log('hi');",
      },
      tarRunner,
    );

    const result = await checkPackageTarball({
      tarballPath,
      repoPkg,
      tarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
    });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when src file is in tarball", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tarball-test-"));
    const tarRunner = makeTarRunner();
    const tarballPath = await buildTarball(
      tempDir,
      {
        "package.json": JSON.stringify(repoPkg),
        "README.md": "# code-pact",
        LICENSE: "MIT",
        "dist/cli.js": "#!/usr/bin/env node\nconsole.log('hi');",
        "src/index.ts": "export {};",
      },
      tarRunner,
    );

    const result = await checkPackageTarball({
      tarballPath,
      repoPkg,
      tarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("src/**"))).toBe(
      true,
    );
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when .env is in tarball", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tarball-test-"));
    const tarRunner = makeTarRunner();
    const tarballPath = await buildTarball(
      tempDir,
      {
        "package.json": JSON.stringify(repoPkg),
        "README.md": "# code-pact",
        LICENSE: "MIT",
        "dist/cli.js": "#!/usr/bin/env node\nconsole.log('hi');",
        ".env": "SECRET=123",
      },
      tarRunner,
    );

    const result = await checkPackageTarball({
      tarballPath,
      repoPkg,
      tarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes(".env"))).toBe(true);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when source map is in tarball", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tarball-test-"));
    const tarRunner = makeTarRunner();
    const tarballPath = await buildTarball(
      tempDir,
      {
        "package.json": JSON.stringify(repoPkg),
        "README.md": "# code-pact",
        LICENSE: "MIT",
        "dist/cli.js": "#!/usr/bin/env node\nconsole.log('hi');",
        "dist/cli.js.map": '{"version":3}',
      },
      tarRunner,
    );

    const result = await checkPackageTarball({
      tarballPath,
      repoPkg,
      tarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("*.map"))).toBe(true);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when package version does not match", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tarball-test-"));
    const tarRunner = makeTarRunner();
    const tarballPath = await buildTarball(
      tempDir,
      {
        "package.json": JSON.stringify({ ...repoPkg, version: "9.9.9" }),
        "README.md": "# code-pact",
        LICENSE: "MIT",
        "dist/cli.js": "#!/usr/bin/env node\nconsole.log('hi');",
      },
      tarRunner,
    );

    const result = await checkPackageTarball({
      tarballPath,
      repoPkg,
      tarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("version"))).toBe(
      true,
    );
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when bin is missing", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tarball-test-"));
    const tarRunner = makeTarRunner();
    const tarballPath = await buildTarball(
      tempDir,
      {
        "package.json": JSON.stringify({ ...repoPkg, bin: {} }),
        "README.md": "# code-pact",
        LICENSE: "MIT",
        "dist/cli.js": "#!/usr/bin/env node\nconsole.log('hi');",
      },
      tarRunner,
    );

    const result = await checkPackageTarball({
      tarballPath,
      repoPkg,
      tarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("bin"))).toBe(true);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when shebang is missing from dist/cli.js", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tarball-test-"));
    const tarRunner = makeTarRunner();
    const tarballPath = await buildTarball(
      tempDir,
      {
        "package.json": JSON.stringify(repoPkg),
        "README.md": "# code-pact",
        LICENSE: "MIT",
        "dist/cli.js": "console.log('hi');",
      },
      tarRunner,
    );

    const result = await checkPackageTarball({
      tarballPath,
      repoPkg,
      tarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("shebang"))).toBe(
      true,
    );
    await rm(tempDir, { recursive: true, force: true });
  });
});
