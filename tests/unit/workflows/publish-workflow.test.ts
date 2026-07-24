import { describe, it, expect } from "vitest";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {
  PUBLISH_RUN_HASH,
  GITHUB_RELEASE_RUN_HASH,
} from "../../../scripts/check-supply-chain-invariants.mjs";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const workflowPath = join(repoRoot, ".github", "workflows", "publish.yml");

function readWorkflow(): string {
  return readFileSync(workflowPath, "utf8");
}

function extractRunScripts(content: string, jobName: string): string[] {
  const doc = parseDocument(content);
  const jobs = doc.get("jobs") as {
    items: Array<{
      key: { value?: unknown };
      value: { get: (k: string) => unknown } | null;
    }>;
  } | null;
  if (!jobs || !jobs.items) return [];
  for (const jobPair of jobs.items) {
    const key = String(jobPair.key.value ?? jobPair.key);
    if (key !== jobName) continue;
    const job = jobPair.value;
    if (!job) return [];
    const steps = job.get("steps") as {
      items: Array<{ get: (k: string) => unknown }>;
    } | null;
    if (!steps || !steps.items) return [];
    const scripts: string[] = [];
    for (const step of steps.items) {
      const run = step.get("run");
      if (typeof run === "string") scripts.push(run);
    }
    return scripts;
  }
  return [];
}

function extractNodeScript(runScript: string): string | undefined {
  const match = runScript.match(/node\s+<<'(\w+)'\n([\s\S]*?)\n\1/);
  if (!match) return undefined;
  return match[2];
}

function runNodeScript(
  script: string,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): void {
  const tmpFile = join(opts.cwd ?? repoRoot, "__test_inline_script.cjs");
  writeFileSync(tmpFile, script);
  try {
    execSync(`node ${tmpFile}`, {
      encoding: "utf8",
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: "pipe",
    });
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

function runNodeScriptThrows(
  script: string,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): void {
  expect(() => runNodeScript(script, opts)).toThrow();
}

describe("publish-workflow inline scripts", () => {
  describe("prepare job: npm version check", () => {
    const content = readWorkflow();
    const scripts = extractRunScripts(content, "prepare");
    const versionCheckScript = scripts.find(s => s.includes("NPM_VERSION"));

    it("script exists in prepare job", () => {
      expect(versionCheckScript).toBeDefined();
    });

    it("passes with npm 11.5.1", () => {
      const nodeScript = extractNodeScript(versionCheckScript!);
      expect(nodeScript).toBeDefined();
      runNodeScript(nodeScript!, { env: { NPM_VERSION: "11.5.1" } });
    });

    it("passes with npm 12.0.0", () => {
      const nodeScript = extractNodeScript(versionCheckScript!);
      runNodeScript(nodeScript!, { env: { NPM_VERSION: "12.0.0" } });
    });

    it("fails with npm 11.5.0", () => {
      const nodeScript = extractNodeScript(versionCheckScript!);
      runNodeScriptThrows(nodeScript!, { env: { NPM_VERSION: "11.5.0" } });
    });

    it("fails with npm 10.0.0", () => {
      const nodeScript = extractNodeScript(versionCheckScript!);
      runNodeScriptThrows(nodeScript!, { env: { NPM_VERSION: "10.0.0" } });
    });
  });

  describe("prepare job: manifest generation", () => {
    const content = readWorkflow();
    const scripts = extractRunScripts(content, "prepare");
    const manifestScript = scripts.find(s =>
      s.includes("release-manifest.json"),
    );

    it("script exists in prepare job", () => {
      expect(manifestScript).toBeDefined();
    });

    it("generates valid manifest with correct fields", () => {
      const nodeScript = extractNodeScript(manifestScript!);
      expect(nodeScript).toBeDefined();

      const tmpDir = join(repoRoot, "tmp-test-manifest");
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        mkdirSync(join(tmpDir, "release-artifact"), { recursive: true });

        const tarballContent = Buffer.from("dummy-tarball-content");
        writeFileSync(
          join(tmpDir, "release-artifact", "package.tgz"),
          tarballContent,
        );
        const sha256 = createHash("sha256")
          .update(tarballContent)
          .digest("hex");

        runNodeScript(nodeScript!, {
          cwd: tmpDir,
          env: {
            VERSION: "1.2.3",
            GITHUB_SHA: "a".repeat(40),
            TARBALL_SHA256: sha256,
          },
        });

        const manifestPath = join(
          tmpDir,
          "release-artifact",
          "release-manifest.json",
        );
        expect(existsSync(manifestPath)).toBe(true);

        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        expect(manifest.package).toBe("code-pact");
        expect(manifest.version).toBe("1.2.3");
        expect(manifest.tag).toBe("v1.2.3");
        expect(manifest.commit).toBe("a".repeat(40));
        expect(manifest.tarball_sha256).toBe(sha256);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("rejects invalid version format", () => {
      const nodeScript = extractNodeScript(manifestScript!);
      const tmpDir = join(repoRoot, "tmp-test-manifest-invalid");
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        mkdirSync(join(tmpDir, "release-artifact"), { recursive: true });
        writeFileSync(join(tmpDir, "release-artifact", "package.tgz"), "dummy");

        runNodeScriptThrows(nodeScript!, {
          cwd: tmpDir,
          env: {
            VERSION: "not-a-version",
            GITHUB_SHA: "a".repeat(40),
            TARBALL_SHA256: "b".repeat(64),
          },
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("rejects invalid GITHUB_SHA", () => {
      const nodeScript = extractNodeScript(manifestScript!);
      const tmpDir = join(repoRoot, "tmp-test-manifest-badsha");
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        mkdirSync(join(tmpDir, "release-artifact"), { recursive: true });
        writeFileSync(join(tmpDir, "release-artifact", "package.tgz"), "dummy");

        runNodeScriptThrows(nodeScript!, {
          cwd: tmpDir,
          env: {
            VERSION: "1.0.0",
            GITHUB_SHA: "short",
            TARBALL_SHA256: "b".repeat(64),
          },
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("publish job: manifest verification", () => {
    const content = readWorkflow();
    const scripts = extractRunScripts(content, "publish");
    const verifyScript = scripts.find(s => s.includes("EXPECTED_TAG"));

    it("script exists in publish job", () => {
      expect(verifyScript).toBeDefined();
    });

    it("passes when manifest matches GitHub context", () => {
      const nodeScript = extractNodeScript(verifyScript!);
      expect(nodeScript).toBeDefined();

      const tmpDir = join(repoRoot, "tmp-test-verify");
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        mkdirSync(join(tmpDir, "release-artifact"), { recursive: true });

        const tarballContent = Buffer.from("publish-tarball");
        writeFileSync(
          join(tmpDir, "release-artifact", "package.tgz"),
          tarballContent,
        );
        const sha256 = createHash("sha256")
          .update(tarballContent)
          .digest("hex");

        const manifest = {
          package: "code-pact",
          version: "2.0.0",
          tag: "v2.0.0",
          commit: "c".repeat(40),
          tarball_sha256: sha256,
        };
        writeFileSync(
          join(tmpDir, "release-artifact", "release-manifest.json"),
          JSON.stringify(manifest, null, 2) + "\n",
        );

        runNodeScript(nodeScript!, {
          cwd: tmpDir,
          env: {
            EXPECTED_TAG: "v2.0.0",
            EXPECTED_COMMIT: "c".repeat(40),
            MANIFEST: "release-artifact/release-manifest.json",
            TARBALL: "release-artifact/package.tgz",
          },
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("fails when manifest tag does not match GitHub tag", () => {
      const nodeScript = extractNodeScript(verifyScript!);
      const tmpDir = join(repoRoot, "tmp-test-verify-tagmismatch");
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        mkdirSync(join(tmpDir, "release-artifact"), { recursive: true });

        const tarballContent = Buffer.from("tarball");
        const sha256 = createHash("sha256")
          .update(tarballContent)
          .digest("hex");
        writeFileSync(
          join(tmpDir, "release-artifact", "package.tgz"),
          tarballContent,
        );

        const manifest = {
          package: "code-pact",
          version: "1.0.0",
          tag: "v1.0.0",
          commit: "d".repeat(40),
          tarball_sha256: sha256,
        };
        writeFileSync(
          join(tmpDir, "release-artifact", "release-manifest.json"),
          JSON.stringify(manifest, null, 2) + "\n",
        );

        runNodeScriptThrows(nodeScript!, {
          cwd: tmpDir,
          env: {
            EXPECTED_TAG: "v2.0.0",
            EXPECTED_COMMIT: "d".repeat(40),
            MANIFEST: "release-artifact/release-manifest.json",
            TARBALL: "release-artifact/package.tgz",
          },
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("fails when manifest commit does not match GitHub commit", () => {
      const nodeScript = extractNodeScript(verifyScript!);
      const tmpDir = join(repoRoot, "tmp-test-verify-commitmismatch");
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        mkdirSync(join(tmpDir, "release-artifact"), { recursive: true });

        const tarballContent = Buffer.from("tarball");
        const sha256 = createHash("sha256")
          .update(tarballContent)
          .digest("hex");
        writeFileSync(
          join(tmpDir, "release-artifact", "package.tgz"),
          tarballContent,
        );

        const manifest = {
          package: "code-pact",
          version: "1.0.0",
          tag: "v1.0.0",
          commit: "e".repeat(40),
          tarball_sha256: sha256,
        };
        writeFileSync(
          join(tmpDir, "release-artifact", "release-manifest.json"),
          JSON.stringify(manifest, null, 2) + "\n",
        );

        runNodeScriptThrows(nodeScript!, {
          cwd: tmpDir,
          env: {
            EXPECTED_TAG: "v1.0.0",
            EXPECTED_COMMIT: "f".repeat(40),
            MANIFEST: "release-artifact/release-manifest.json",
            TARBALL: "release-artifact/package.tgz",
          },
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("fails when tarball SHA-256 does not match manifest", () => {
      const nodeScript = extractNodeScript(verifyScript!);
      const tmpDir = join(repoRoot, "tmp-test-verify-shamismatch");
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        mkdirSync(join(tmpDir, "release-artifact"), { recursive: true });

        writeFileSync(
          join(tmpDir, "release-artifact", "package.tgz"),
          "actual-content",
        );

        const manifest = {
          package: "code-pact",
          version: "1.0.0",
          tag: "v1.0.0",
          commit: "g".repeat(40),
          tarball_sha256: "0".repeat(64),
        };
        writeFileSync(
          join(tmpDir, "release-artifact", "release-manifest.json"),
          JSON.stringify(manifest, null, 2) + "\n",
        );

        runNodeScriptThrows(nodeScript!, {
          cwd: tmpDir,
          env: {
            EXPECTED_TAG: "v1.0.0",
            EXPECTED_COMMIT: "g".repeat(40),
            MANIFEST: "release-artifact/release-manifest.json",
            TARBALL: "release-artifact/package.tgz",
          },
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("fails when EXPECTED_TAG is not a valid version tag", () => {
      const nodeScript = extractNodeScript(verifyScript!);
      const tmpDir = join(repoRoot, "tmp-test-verify-badtag");
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        mkdirSync(join(tmpDir, "release-artifact"), { recursive: true });

        const tarballContent = Buffer.from("tarball");
        const sha256 = createHash("sha256")
          .update(tarballContent)
          .digest("hex");
        writeFileSync(
          join(tmpDir, "release-artifact", "package.tgz"),
          tarballContent,
        );

        const manifest = {
          package: "code-pact",
          version: "1.0.0",
          tag: "v1.0.0",
          commit: "h".repeat(40),
          tarball_sha256: sha256,
        };
        writeFileSync(
          join(tmpDir, "release-artifact", "release-manifest.json"),
          JSON.stringify(manifest, null, 2) + "\n",
        );

        runNodeScriptThrows(nodeScript!, {
          cwd: tmpDir,
          env: {
            EXPECTED_TAG: "not-a-tag",
            EXPECTED_COMMIT: "h".repeat(40),
            MANIFEST: "release-artifact/release-manifest.json",
            TARBALL: "release-artifact/package.tgz",
          },
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("run script hash stability", () => {
    it("publish job run script hash matches checker constant", () => {
      const content = readWorkflow();
      const scripts = extractRunScripts(content, "publish");
      const runScripts = scripts.filter(s => typeof s === "string");
      expect(runScripts.length).toBe(1);
      const normalized = runScripts[0]!.replace(/\r\n/g, "\n").trimEnd() + "\n";
      const hash = createHash("sha256").update(normalized).digest("hex");
      expect(hash).toBe(PUBLISH_RUN_HASH);
    });

    it("github-release job run script hash matches checker constant", () => {
      const content = readWorkflow();
      const scripts = extractRunScripts(content, "github-release");
      const runScripts = scripts.filter(s => typeof s === "string");
      expect(runScripts.length).toBe(1);
      const normalized = runScripts[0]!.replace(/\r\n/g, "\n").trimEnd() + "\n";
      const hash = createHash("sha256").update(normalized).digest("hex");
      expect(hash).toBe(GITHUB_RELEASE_RUN_HASH);
    });
  });

  describe("bash -n syntax check for all run steps", () => {
    const content = readWorkflow();
    const allJobs = [
      "prepare",
      "publish",
      "verify",
      "provenance",
      "github-release",
    ];

    for (const jobName of allJobs) {
      it(`${jobName} job: all run scripts pass bash -n`, () => {
        const scripts = extractRunScripts(content, jobName);
        for (const script of scripts) {
          const tmpFile = join(repoRoot, `__test_bash_syntax_${jobName}.sh`);
          writeFileSync(tmpFile, script);
          try {
            execFileSync("bash", ["-n", tmpFile], {
              encoding: "utf8",
              stdio: "pipe",
            });
          } finally {
            rmSync(tmpFile, { force: true });
          }
        }
      });
    }
  });

  describe("publish job: full shell execution with stub npm", () => {
    const content = readWorkflow();
    const scripts = extractRunScripts(content, "publish");
    const publishScript = scripts.find(s => s.includes("EXPECTED_TAG"));

    function makeTmpEnv(opts: {
      npmViewExit?: number;
      manifest?: Record<string, unknown>;
      tarballContent?: Buffer;
    }): string {
      const tmpDir = join(repoRoot, "tmp-test-publish-shell");
      rmSync(tmpDir, { recursive: true, force: true });
      mkdirSync(join(tmpDir, "release-artifact"), { recursive: true });
      mkdirSync(join(tmpDir, "bin"), { recursive: true });

      const tarball = opts.tarballContent ?? Buffer.from("publish-tarball");
      writeFileSync(join(tmpDir, "release-artifact", "package.tgz"), tarball);
      const sha256 = createHash("sha256").update(tarball).digest("hex");

      const manifest = opts.manifest ?? {
        package: "code-pact",
        version: "2.0.0",
        tag: "v2.0.0",
        commit: "c".repeat(40),
        tarball_sha256: sha256,
      };
      writeFileSync(
        join(tmpDir, "release-artifact", "release-manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
      );

      const npmViewExit = opts.npmViewExit ?? 1;
      writeFileSync(
        join(tmpDir, "bin", "npm"),
        [
          "#!/bin/sh",
          'printf \'%s\\n\' "$*" >> "$NPM_LOG"',
          'if [ "$1" = "view" ]; then',
          `  exit ${npmViewExit}`,
          "fi",
          'if [ "$1" = "publish" ]; then',
          "  exit 0",
          "fi",
          "exit 2",
        ].join("\n"),
      );
      execSync(`chmod +x ${join(tmpDir, "bin", "npm")}`);

      return tmpDir;
    }

    it("new version: calls npm view then npm publish", () => {
      const tmpDir = makeTmpEnv({});
      const npmLog = join(tmpDir, "npm-calls.log");
      try {
        const scriptFile = join(tmpDir, "__run_publish.sh");
        writeFileSync(scriptFile, "set -e\n" + publishScript!);
        try {
          execSync(`bash ${scriptFile}`, {
            encoding: "utf8",
            cwd: tmpDir,
            env: {
              ...process.env,
              PATH: `${join(tmpDir, "bin")}:${process.env.PATH}`,
              EXPECTED_TAG: "v2.0.0",
              EXPECTED_COMMIT: "c".repeat(40),
              NPM_CONFIG_PROVENANCE: "true",
              NPM_LOG: npmLog,
              GITHUB_OUTPUT: join(tmpDir, "github-output.txt"),
            },
            stdio: "pipe",
          });
        } finally {
          rmSync(scriptFile, { force: true });
        }

        const log = readFileSync(npmLog, "utf8").trim();
        expect(log).toContain("view code-pact@2.0.0 version");
        expect(log).toContain("--registry=https://registry.npmjs.org");
        expect(log).toContain(
          "publish ./release-artifact/package.tgz --ignore-scripts",
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("existing version: fails as a tag/version collision", () => {
      const tmpDir = makeTmpEnv({ npmViewExit: 0 });
      const npmLog = join(tmpDir, "npm-calls.log");
      try {
        const scriptFile = join(tmpDir, "__run_publish.sh");
        writeFileSync(scriptFile, "set -e\n" + publishScript!);
        let threw = false;
        try {
          execSync(`bash ${scriptFile}`, {
            encoding: "utf8",
            cwd: tmpDir,
            env: {
              ...process.env,
              PATH: `${join(tmpDir, "bin")}:${process.env.PATH}`,
              EXPECTED_TAG: "v2.0.0",
              EXPECTED_COMMIT: "c".repeat(40),
              NPM_CONFIG_PROVENANCE: "true",
              NPM_LOG: npmLog,
            },
            stdio: "pipe",
          });
        } catch {
          threw = true;
        } finally {
          rmSync(scriptFile, { force: true });
        }

        expect(threw).toBe(true);
        const log = readFileSync(npmLog, "utf8").trim();
        expect(log).toContain("view code-pact@2.0.0 version");
        expect(log).not.toContain("publish");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("manifest mismatch: fails before npm view", () => {
      const tmpDir = makeTmpEnv({
        manifest: {
          package: "code-pact",
          version: "1.0.0",
          tag: "v1.0.0",
          commit: "d".repeat(40),
          tarball_sha256: "0".repeat(64),
        },
      });
      const npmLog = join(tmpDir, "npm-calls.log");
      try {
        const scriptFile = join(tmpDir, "__run_publish.sh");
        writeFileSync(scriptFile, "set -e\n" + publishScript!);
        let threw = false;
        try {
          execSync(`bash ${scriptFile}`, {
            encoding: "utf8",
            cwd: tmpDir,
            env: {
              ...process.env,
              PATH: `${join(tmpDir, "bin")}:${process.env.PATH}`,
              EXPECTED_TAG: "v2.0.0",
              EXPECTED_COMMIT: "c".repeat(40),
              NPM_CONFIG_PROVENANCE: "true",
              NPM_LOG: npmLog,
              GITHUB_OUTPUT: join(tmpDir, "github-output.txt"),
            },
            stdio: "pipe",
          });
        } catch {
          threw = true;
        } finally {
          rmSync(scriptFile, { force: true });
        }
        expect(threw).toBe(true);
        expect(existsSync(npmLog)).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("NPM_CONFIG_REGISTRY env does not override --registry flag", () => {
      const tmpDir = makeTmpEnv({});
      const npmLog = join(tmpDir, "npm-calls.log");
      try {
        const scriptFile = join(tmpDir, "__run_publish.sh");
        writeFileSync(scriptFile, "set -e\n" + publishScript!);
        try {
          execSync(`bash ${scriptFile}`, {
            encoding: "utf8",
            cwd: tmpDir,
            env: {
              ...process.env,
              PATH: `${join(tmpDir, "bin")}:${process.env.PATH}`,
              EXPECTED_TAG: "v2.0.0",
              EXPECTED_COMMIT: "c".repeat(40),
              NPM_CONFIG_PROVENANCE: "true",
              NPM_CONFIG_REGISTRY: "https://attacker.invalid",
              NPM_LOG: npmLog,
            },
            stdio: "pipe",
          });
        } finally {
          rmSync(scriptFile, { force: true });
        }

        const log = readFileSync(npmLog, "utf8").trim();
        expect(log).toContain("--registry=https://registry.npmjs.org");
        expect(log).not.toContain("attacker.invalid");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("github-release job: full shell execution with stub gh", () => {
    const content = readWorkflow();
    const scripts = extractRunScripts(content, "github-release");
    const releaseScript = scripts.find(s => s.includes("gh release"));

    function makeTmpEnv(opts: { ghViewExit?: number }): string {
      const tmpDir = join(repoRoot, "tmp-test-ghrelease-shell");
      rmSync(tmpDir, { recursive: true, force: true });
      mkdirSync(join(tmpDir, "release-artifact"), { recursive: true });
      mkdirSync(join(tmpDir, "release-integrity"), { recursive: true });
      mkdirSync(join(tmpDir, "bin"), { recursive: true });

      writeFileSync(
        join(tmpDir, "release-artifact", "release-manifest.json"),
        JSON.stringify(
          {
            package: "code-pact",
            version: "2.0.0",
            tag: "v2.0.0",
            commit: "c".repeat(40),
            tarball_sha256: "0".repeat(64),
          },
          null,
          2,
        ) + "\n",
      );
      writeFileSync(
        join(tmpDir, "release-artifact", "release-notes.md"),
        "## Release notes\n",
      );
      writeFileSync(
        join(tmpDir, "release-integrity", "release-integrity.json"),
        JSON.stringify(
          {
            shasum: "abc123",
            integrity: "sha512-xyz",
            local_sha256: "0".repeat(64),
          },
          null,
          2,
        ) + "\n",
      );

      const ghViewExit = opts.ghViewExit ?? 1;
      writeFileSync(
        join(tmpDir, "bin", "gh"),
        [
          "#!/bin/sh",
          'printf \'%s\\n\' "$*" >> "$GH_LOG"',
          'if [ "$1" = "release" ] && [ "$2" = "view" ]; then',
          `  exit ${ghViewExit}`,
          "fi",
          "exit 0",
        ].join("\n"),
      );
      execSync(`chmod +x ${join(tmpDir, "bin", "gh")}`);

      return tmpDir;
    }

    it("new release: calls gh release view then gh release create", () => {
      const tmpDir = makeTmpEnv({ ghViewExit: 1 });
      const ghLog = join(tmpDir, "gh-calls.log");
      try {
        const scriptFile = join(tmpDir, "__run_release.sh");
        writeFileSync(scriptFile, "set -e\n" + releaseScript!);
        try {
          execSync(`bash ${scriptFile}`, {
            encoding: "utf8",
            cwd: tmpDir,
            env: {
              ...process.env,
              PATH: `${join(tmpDir, "bin")}:${process.env.PATH}`,
              GH_TOKEN: "test-token",
              GH_REPO: "toshtag/code-pact",
              TAG: "v2.0.0",
              GH_LOG: ghLog,
            },
            stdio: "pipe",
          });
        } finally {
          rmSync(scriptFile, { force: true });
        }

        const log = readFileSync(ghLog, "utf8").trim();
        expect(log).toContain("release view v2.0.0");
        expect(log).toContain("release create");
        expect(log).toContain("--verify-tag");

        const notes = readFileSync(join(tmpDir, "final-notes.md"), "utf8");
        expect(notes).toContain("generated through Trusted Publishing");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("existing release: calls gh release view then gh release edit", () => {
      const tmpDir = makeTmpEnv({ ghViewExit: 0 });
      const ghLog = join(tmpDir, "gh-calls.log");
      try {
        const scriptFile = join(tmpDir, "__run_release.sh");
        writeFileSync(scriptFile, "set -e\n" + releaseScript!);
        try {
          execSync(`bash ${scriptFile}`, {
            encoding: "utf8",
            cwd: tmpDir,
            env: {
              ...process.env,
              PATH: `${join(tmpDir, "bin")}:${process.env.PATH}`,
              GH_TOKEN: "test-token",
              GH_REPO: "toshtag/code-pact",
              TAG: "v2.0.0",
              GH_LOG: ghLog,
            },
            stdio: "pipe",
          });
        } finally {
          rmSync(scriptFile, { force: true });
        }

        const log = readFileSync(ghLog, "utf8").trim();
        expect(log).toContain("release view v2.0.0");
        expect(log).toContain("release edit");
        expect(log).toContain("--verify-tag");
        expect(log).not.toContain("release create");

        const notes = readFileSync(join(tmpDir, "final-notes.md"), "utf8");
        expect(notes).toContain("generated through Trusted Publishing");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
