import { describe, it, expect, vi } from "vitest";
import { checkPackageTarball } from "../../../scripts/check-package-tarball.mjs";
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoPkg = {
  name: "code-pact",
  version: "2.0.1",
  bin: { "code-pact": "dist/cli.js" },
  dependencies: { yaml: "^2.9.0", zod: "^4.4.3" },
  scripts: {},
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

  it("fails when a symlink is in the tarball", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tarball-test-"));
    const tarRunner = makeTarRunner();
    const pkgDir = join(tempDir, "package");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify(repoPkg));
    await writeFile(join(pkgDir, "README.md"), "# code-pact");
    await writeFile(join(pkgDir, "LICENSE"), "MIT");
    await mkdir(join(pkgDir, "dist"), { recursive: true });
    await writeFile(
      join(pkgDir, "dist", "cli.js"),
      "#!/usr/bin/env node\nconsole.log('hi');",
    );
    await symlink(
      join(pkgDir, "dist", "cli.js"),
      join(pkgDir, "dist", "cli-link"),
    );
    const tarballPath = join(tempDir, "test.tgz");
    await tarRunner(["-czf", tarballPath, "-C", tempDir, "package"], tempDir);

    const result = await checkPackageTarball({
      tarballPath,
      repoPkg,
      tarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("symlink"))).toBe(
      true,
    );
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when a hard link is in the tarball", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tarball-test-"));
    const tarRunner = makeTarRunner();
    const pkgDir = join(tempDir, "package");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify(repoPkg));
    await writeFile(join(pkgDir, "README.md"), "# code-pact");
    await writeFile(join(pkgDir, "LICENSE"), "MIT");
    await mkdir(join(pkgDir, "dist"), { recursive: true });
    await writeFile(
      join(pkgDir, "dist", "cli.js"),
      "#!/usr/bin/env node\nconsole.log('hi');",
    );
    await link(
      join(pkgDir, "dist", "cli.js"),
      join(pkgDir, "dist", "cli-hardlink"),
    );
    const tarballPath = join(tempDir, "test.tgz");
    await tarRunner(["-czf", tarballPath, "-C", tempDir, "package"], tempDir);

    const result = await checkPackageTarball({
      tarballPath,
      repoPkg,
      tarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("hard link"))).toBe(
      true,
    );
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when a ../ traversal entry is in the tarball", async () => {
    const fakeListing = [
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
      "package/dist/cli.js",
      "package/../etc/passwd",
    ].join("\n");
    const fakeVerbose = [
      "-rw-r--r-- 0/0 100 2026-01-01 00:00 package/package.json",
      "-rw-r--r-- 0/0 100 2026-01-01 00:00 package/README.md",
      "-rw-r--r-- 0/0 100 2026-01-01 00:00 package/LICENSE",
      "-rw-r--r-- 0/0 100 2026-01-01 00:00 package/dist/cli.js",
      "-rw-r--r-- 0/0 100 2026-01-01 00:00 package/../etc/passwd",
    ].join("\n");
    const mockTarRunner = vi.fn(async (args: string[]): Promise<TarResult> => {
      if (args[0] === "-tzf") return { stdout: fakeListing, stderr: "" };
      if (args[0] === "-tzvf") return { stdout: fakeVerbose, stderr: "" };
      if (args[0] === "-xzf") return { stdout: "", stderr: "" };
      throw new Error(`unexpected tar args: ${args.join(" ")}`);
    });
    const mockFileReader = vi.fn(async (path: string): Promise<string> => {
      if (path.endsWith("package.json")) return JSON.stringify(repoPkg);
      if (path.endsWith("cli.js"))
        return "#!/usr/bin/env node\nconsole.log('hi');";
      if (path.endsWith("README.md")) return "# code-pact";
      if (path.endsWith("LICENSE")) return "MIT";
      throw new Error(`unexpected read: ${path}`);
    });

    const result = await checkPackageTarball({
      tarballPath: "/dev/null",
      repoPkg,
      tarRunner: mockTarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
      fileReader: mockFileReader,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("../"))).toBe(true);
  });

  it("fails when postinstall lifecycle script is in tarball package.json", async () => {
    const fakeListing = [
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
      "package/dist/cli.js",
    ].join("\n");
    const fakeVerbose = [
      "-rw-r--r-- 0/0 100 2026-01-01 00:00 package/package.json",
      "-rw-r--r-- 0/0 100 2026-01-01 00:00 package/README.md",
      "-rw-r--r-- 0/0 100 2026-01-01 00:00 package/LICENSE",
      "-rw-r--r-- 0/0 100 2026-01-01 00:00 package/dist/cli.js",
    ].join("\n");
    const tarballPkg = {
      ...repoPkg,
      scripts: { ...repoPkg.scripts, postinstall: "node malicious.js" },
    };
    const mockTarRunner = vi.fn(async (args: string[]): Promise<TarResult> => {
      if (args[0] === "-tzf") return { stdout: fakeListing, stderr: "" };
      if (args[0] === "-tzvf") return { stdout: fakeVerbose, stderr: "" };
      if (args[0] === "-xzf") return { stdout: "", stderr: "" };
      throw new Error(`unexpected tar args: ${args.join(" ")}`);
    });
    const mockFileReader = vi.fn(async (path: string): Promise<string> => {
      if (path.endsWith("package.json")) return JSON.stringify(tarballPkg);
      if (path.endsWith("cli.js"))
        return "#!/usr/bin/env node\nconsole.log('hi');";
      if (path.endsWith("README.md")) return "# code-pact";
      if (path.endsWith("LICENSE")) return "MIT";
      throw new Error(`unexpected read: ${path}`);
    });

    const result = await checkPackageTarball({
      tarballPath: "/dev/null",
      repoPkg,
      tarRunner: mockTarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
      fileReader: mockFileReader,
    });

    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p: string) =>
        p.includes("forbidden lifecycle script"),
      ),
    ).toBe(true);
  });

  it("fails when preinstall lifecycle script is in tarball package.json", async () => {
    const tarballPkg = {
      ...repoPkg,
      scripts: { ...repoPkg.scripts, preinstall: "echo pwned" },
    };
    const mockTarRunner = vi.fn(async (args: string[]): Promise<TarResult> => {
      if (args[0] === "-tzf")
        return {
          stdout:
            "package/package.json\npackage/README.md\npackage/LICENSE\npackage/dist/cli.js",
          stderr: "",
        };
      if (args[0] === "-tzvf") return { stdout: "", stderr: "" };
      if (args[0] === "-xzf") return { stdout: "", stderr: "" };
      throw new Error(`unexpected tar args: ${args.join(" ")}`);
    });
    const mockFileReader = vi.fn(async (path: string): Promise<string> => {
      if (path.endsWith("package.json")) return JSON.stringify(tarballPkg);
      if (path.endsWith("cli.js"))
        return "#!/usr/bin/env node\nconsole.log('hi');";
      if (path.endsWith("README.md")) return "# code-pact";
      if (path.endsWith("LICENSE")) return "MIT";
      throw new Error(`unexpected read: ${path}`);
    });

    const result = await checkPackageTarball({
      tarballPath: "/dev/null",
      repoPkg,
      tarRunner: mockTarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
      fileReader: mockFileReader,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.includes("preinstall"))).toBe(
      true,
    );
  });

  it("fails when prepublishOnly lifecycle script is in tarball package.json", async () => {
    const tarballPkg = {
      ...repoPkg,
      scripts: { ...repoPkg.scripts, prepublishOnly: "node evil.js" },
    };
    const mockTarRunner = vi.fn(async (args: string[]): Promise<TarResult> => {
      if (args[0] === "-tzf")
        return {
          stdout:
            "package/package.json\npackage/README.md\npackage/LICENSE\npackage/dist/cli.js",
          stderr: "",
        };
      if (args[0] === "-tzvf") return { stdout: "", stderr: "" };
      if (args[0] === "-xzf") return { stdout: "", stderr: "" };
      throw new Error(`unexpected tar args: ${args.join(" ")}`);
    });
    const mockFileReader = vi.fn(async (path: string): Promise<string> => {
      if (path.endsWith("package.json")) return JSON.stringify(tarballPkg);
      if (path.endsWith("cli.js"))
        return "#!/usr/bin/env node\nconsole.log('hi');";
      if (path.endsWith("README.md")) return "# code-pact";
      if (path.endsWith("LICENSE")) return "MIT";
      throw new Error(`unexpected read: ${path}`);
    });

    const result = await checkPackageTarball({
      tarballPath: "/dev/null",
      repoPkg,
      tarRunner: mockTarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
      fileReader: mockFileReader,
    });

    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p: string) => p.includes("prepublishOnly")),
    ).toBe(true);
  });

  it("fails when extra optionalDependencies are in tarball", async () => {
    const tarballPkg = {
      ...repoPkg,
      optionalDependencies: { "left-pad": "1.3.0" },
    };
    const mockTarRunner = vi.fn(async (args: string[]): Promise<TarResult> => {
      if (args[0] === "-tzf")
        return {
          stdout:
            "package/package.json\npackage/README.md\npackage/LICENSE\npackage/dist/cli.js",
          stderr: "",
        };
      if (args[0] === "-tzvf") return { stdout: "", stderr: "" };
      if (args[0] === "-xzf") return { stdout: "", stderr: "" };
      throw new Error(`unexpected tar args: ${args.join(" ")}`);
    });
    const mockFileReader = vi.fn(async (path: string): Promise<string> => {
      if (path.endsWith("package.json")) return JSON.stringify(tarballPkg);
      if (path.endsWith("cli.js"))
        return "#!/usr/bin/env node\nconsole.log('hi');";
      if (path.endsWith("README.md")) return "# code-pact";
      if (path.endsWith("LICENSE")) return "MIT";
      throw new Error(`unexpected read: ${path}`);
    });

    const result = await checkPackageTarball({
      tarballPath: "/dev/null",
      repoPkg,
      tarRunner: mockTarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
      fileReader: mockFileReader,
    });

    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p: string) => p.includes("optionalDependencies")),
    ).toBe(true);
  });

  it("fails when extra peerDependencies are in tarball", async () => {
    const tarballPkg = {
      ...repoPkg,
      peerDependencies: { react: "^18.0.0" },
    };
    const mockTarRunner = vi.fn(async (args: string[]): Promise<TarResult> => {
      if (args[0] === "-tzf")
        return {
          stdout:
            "package/package.json\npackage/README.md\npackage/LICENSE\npackage/dist/cli.js",
          stderr: "",
        };
      if (args[0] === "-tzvf") return { stdout: "", stderr: "" };
      if (args[0] === "-xzf") return { stdout: "", stderr: "" };
      throw new Error(`unexpected tar args: ${args.join(" ")}`);
    });
    const mockFileReader = vi.fn(async (path: string): Promise<string> => {
      if (path.endsWith("package.json")) return JSON.stringify(tarballPkg);
      if (path.endsWith("cli.js"))
        return "#!/usr/bin/env node\nconsole.log('hi');";
      if (path.endsWith("README.md")) return "# code-pact";
      if (path.endsWith("LICENSE")) return "MIT";
      throw new Error(`unexpected read: ${path}`);
    });

    const result = await checkPackageTarball({
      tarballPath: "/dev/null",
      repoPkg,
      tarRunner: mockTarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
      fileReader: mockFileReader,
    });

    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p: string) => p.includes("peerDependencies")),
    ).toBe(true);
  });

  it("fails when bundledDependencies are in tarball", async () => {
    const tarballPkg = {
      ...repoPkg,
      bundledDependencies: ["left-pad"],
    };
    const mockTarRunner = vi.fn(async (args: string[]): Promise<TarResult> => {
      if (args[0] === "-tzf")
        return {
          stdout:
            "package/package.json\npackage/README.md\npackage/LICENSE\npackage/dist/cli.js",
          stderr: "",
        };
      if (args[0] === "-tzvf") return { stdout: "", stderr: "" };
      if (args[0] === "-xzf") return { stdout: "", stderr: "" };
      throw new Error(`unexpected tar args: ${args.join(" ")}`);
    });
    const mockFileReader = vi.fn(async (path: string): Promise<string> => {
      if (path.endsWith("package.json")) return JSON.stringify(tarballPkg);
      if (path.endsWith("cli.js"))
        return "#!/usr/bin/env node\nconsole.log('hi');";
      if (path.endsWith("README.md")) return "# code-pact";
      if (path.endsWith("LICENSE")) return "MIT";
      throw new Error(`unexpected read: ${path}`);
    });

    const result = await checkPackageTarball({
      tarballPath: "/dev/null",
      repoPkg,
      tarRunner: mockTarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
      fileReader: mockFileReader,
    });

    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p: string) => p.includes("bundledDependencies")),
    ).toBe(true);
  });

  it("fails when the attack fixture (postinstall + optionalDependencies) is in tarball", async () => {
    const tarballPkg = {
      ...repoPkg,
      scripts: { ...repoPkg.scripts, postinstall: "node malicious.js" },
      optionalDependencies: { "left-pad": "1.3.0" },
    };
    const mockTarRunner = vi.fn(async (args: string[]): Promise<TarResult> => {
      if (args[0] === "-tzf")
        return {
          stdout:
            "package/package.json\npackage/README.md\npackage/LICENSE\npackage/dist/cli.js",
          stderr: "",
        };
      if (args[0] === "-tzvf") return { stdout: "", stderr: "" };
      if (args[0] === "-xzf") return { stdout: "", stderr: "" };
      throw new Error(`unexpected tar args: ${args.join(" ")}`);
    });
    const mockFileReader = vi.fn(async (path: string): Promise<string> => {
      if (path.endsWith("package.json")) return JSON.stringify(tarballPkg);
      if (path.endsWith("cli.js"))
        return "#!/usr/bin/env node\nconsole.log('hi');";
      if (path.endsWith("README.md")) return "# code-pact";
      if (path.endsWith("LICENSE")) return "MIT";
      throw new Error(`unexpected read: ${path}`);
    });

    const result = await checkPackageTarball({
      tarballPath: "/dev/null",
      repoPkg,
      tarRunner: mockTarRunner,
      tempDirMaker: makeTempDir,
      tempDirRemover: removeTempDir,
      fileReader: mockFileReader,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThanOrEqual(2);
  });
});
