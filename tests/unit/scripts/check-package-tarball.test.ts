import { describe, it, expect, vi } from "vitest";
import {
  checkPackageTarball,
  inspectPackedTarball,
  writePackMetadata,
} from "../../../scripts/check-package-tarball.mjs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
  access,
} from "node:fs/promises";
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
  tarballName = "test.tgz",
): Promise<string> {
  const pkgDir = join(tempDir, "package");
  await mkdir(pkgDir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(pkgDir, path);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content);
  }
  const tarballPath = join(tempDir, tarballName);
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

describe("inspectPackedTarball", () => {
  const tarballName = `${repoPkg.name}-${repoPkg.version}.tgz`;

  /**
   * The two container shapes `npm pack --json` emits, fed to the checker
   * exactly as npm writes them — no normalization step in between, which is
   * the whole point of the canonical reader.
   */
  const shapes: Array<[string, (record: object) => unknown]> = [
    ["npm 11 array", record => [record]],
    ["npm 12 object", record => ({ [repoPkg.name]: record })],
  ];

  async function packedFixture() {
    const tempDir = await mkdtemp(join(tmpdir(), "tarball-inspect-"));
    const tarRunner = makeTarRunner();
    await buildTarball(
      tempDir,
      {
        "package.json": JSON.stringify(repoPkg),
        "README.md": "# code-pact",
        LICENSE: "MIT",
        "dist/cli.js": "#!/usr/bin/env node\nconsole.log('hi');",
      },
      tarRunner,
      tarballName,
    );
    return { tempDir, tarRunner };
  }

  for (const [label, wrap] of shapes) {
    it(`accepts a raw ${label} payload`, async () => {
      const { tempDir, tarRunner } = await packedFixture();

      const result = await inspectPackedTarball({
        payload: wrap({
          name: repoPkg.name,
          version: repoPkg.version,
          filename: tarballName,
        }),
        repoPkg,
        tarballDir: tempDir,
        checker: opts =>
          checkPackageTarball({
            ...opts,
            tarRunner,
            tempDirMaker: makeTempDir,
            tempDirRemover: removeTempDir,
          }),
      });

      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
      expect(result.record).toEqual({
        name: repoPkg.name,
        version: repoPkg.version,
        filename: tarballName,
      });
      await rm(tempDir, { recursive: true, force: true });
    });
  }

  it("writes canonical metadata after a passing inspection", async () => {
    const { tempDir, tarRunner } = await packedFixture();
    const metadataOut = join(tempDir, "checked-pack.json");

    const result = await inspectPackedTarball({
      payload: { [repoPkg.name]: { name: repoPkg.name, version: repoPkg.version, filename: tarballName } },
      repoPkg,
      tarballDir: tempDir,
      metadataOut,
      checker: opts =>
        checkPackageTarball({
          ...opts,
          tarRunner,
          tempDirMaker: makeTempDir,
          tempDirRemover: removeTempDir,
        }),
    });

    expect(result.ok).toBe(true);
    expect(result.metadataPath).toBe(metadataOut);
    expect(JSON.parse(await readFile(metadataOut, "utf8"))).toEqual({
      name: repoPkg.name,
      version: repoPkg.version,
      filename: tarballName,
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes no metadata when the inspection fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tarball-inspect-"));
    const metadataOut = join(tempDir, "checked-pack.json");
    const metadataWriter = vi.fn();

    const result = await inspectPackedTarball({
      payload: [{ name: repoPkg.name, version: repoPkg.version, filename: tarballName }],
      repoPkg,
      tarballDir: tempDir,
      metadataOut,
      checker: async () => ({ ok: false, problems: ["src/ file in tarball"] }),
      metadataWriter,
    });

    expect(result.ok).toBe(false);
    expect(result.metadataPath).toBeNull();
    expect(metadataWriter).not.toHaveBeenCalled();
    await expect(access(metadataOut)).rejects.toThrow();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("refuses an unreadable payload before inspecting anything", async () => {
    const checker = vi.fn();
    const metadataWriter = vi.fn();

    await expect(
      inspectPackedTarball({
        payload: { "other-pkg": { name: "other-pkg", version: "1.0.0", filename: "other.tgz" } },
        repoPkg,
        checker,
        metadataWriter,
      }),
    ).rejects.toThrow(/keyed by "other-pkg"/);

    expect(checker).not.toHaveBeenCalled();
    expect(metadataWriter).not.toHaveBeenCalled();
  });

  it("reports no metadata path when none was requested", async () => {
    const { tempDir, tarRunner } = await packedFixture();

    const result = await inspectPackedTarball({
      payload: [{ name: repoPkg.name, version: repoPkg.version, filename: tarballName }],
      repoPkg,
      tarballDir: tempDir,
      checker: opts =>
        checkPackageTarball({
          ...opts,
          tarRunner,
          tempDirMaker: makeTempDir,
          tempDirRemover: removeTempDir,
        }),
    });

    expect(result.ok).toBe(true);
    expect(result.metadataPath).toBeNull();
    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("writePackMetadata", () => {
  it("writes only the canonical fields", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pack-metadata-"));
    const target = join(tempDir, "checked-pack.json");

    await writePackMetadata(target, {
      name: "code-pact",
      version: "2.0.1",
      filename: "code-pact-2.0.1.tgz",
      integrity: "sha512-should-not-be-copied",
    });

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      name: "code-pact",
      version: "2.0.1",
      filename: "code-pact-2.0.1.tgz",
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  it("leaves no temp file behind", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pack-metadata-"));
    const target = join(tempDir, "checked-pack.json");

    await writePackMetadata(target, {
      name: "code-pact",
      version: "2.0.1",
      filename: "code-pact-2.0.1.tgz",
    });

    const { readdir } = await import("node:fs/promises");
    expect(await readdir(tempDir)).toEqual(["checked-pack.json"]);
    await rm(tempDir, { recursive: true, force: true });
  });
});
