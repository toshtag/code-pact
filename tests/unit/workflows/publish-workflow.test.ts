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
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";

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
    it("publish job run script hash matches EXPECTED_RUN_HASHES", () => {
      const content = readWorkflow();
      const scripts = extractRunScripts(content, "publish");
      const runScripts = scripts.filter(s => typeof s === "string");
      expect(runScripts.length).toBe(1);
      const normalized = runScripts[0]!.replace(/\r\n/g, "\n").trimEnd() + "\n";
      const hash = createHash("sha256").update(normalized).digest("hex");
      expect(hash).toBe(
        "d0bc8162bedfcd6049329876c422a3a608a01b37b6d9813a7f02b3676a287d30",
      );
    });

    it("github-release job run script hash matches EXPECTED_RUN_HASHES", () => {
      const content = readWorkflow();
      const scripts = extractRunScripts(content, "github-release");
      const runScripts = scripts.filter(s => typeof s === "string");
      expect(runScripts.length).toBe(1);
      const normalized = runScripts[0]!.replace(/\r\n/g, "\n").trimEnd() + "\n";
      const hash = createHash("sha256").update(normalized).digest("hex");
      expect(hash).toBe(
        "99cd20bfe6d10360bb0186e3b37a59d47a8352b8081e4aed2138cf575f8846dd",
      );
    });
  });
});
