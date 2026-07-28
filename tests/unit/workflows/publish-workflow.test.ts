import { describe, it, expect } from "vitest";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {
  PUBLISH_RUN_HASH,
  GITHUB_RELEASE_RUN_HASH,
} from "../../../scripts/check-supply-chain-invariants.mjs";

const CHILD_TIMEOUT_MS = 10_000;
const CHILD_KILL_SIGNAL = "SIGKILL";
const CHILD_MAX_BUFFER = 10 * 1024 * 1024;

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

/**
 * Pull one inline `node <<'DELIM'` heredoc out of a run script.
 *
 * A step can hold several — the publish step carries its npm gate, its manifest
 * check, and its registry probe — so the caller names the one it means. Without
 * the name this returns the first, which silently changes meaning the moment a
 * new heredoc is added above the intended one.
 */
function extractNodeScript(
  runScript: string,
  delimiter?: string,
): string | undefined {
  const pattern = delimiter
    ? new RegExp(`node\\s+<<'(${delimiter})'\\n([\\s\\S]*?)\\n\\1`)
    : /node\s+<<'(\w+)'\n([\s\S]*?)\n\1/;
  const match = runScript.match(pattern);
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
    execFileSync(process.execPath, [tmpFile], {
      encoding: "utf8",
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: "pipe",
      timeout: CHILD_TIMEOUT_MS,
      killSignal: CHILD_KILL_SIGNAL,
      maxBuffer: CHILD_MAX_BUFFER,
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

    // The range is bounded on both sides. Below 11.5.1 there is no Trusted
    // Publishing; at 13 and above there is no measured `npm pack --json`
    // payload shape, and scripts/npm-pack-json.mjs reads only the two that
    // were measured. Widening either end belongs in a change that moves the
    // parser with it.
    for (const version of ["11.5.1", "11.16.0", "12.0.0", "12.99.99"]) {
      it(`passes with npm ${version}`, () => {
        const nodeScript = extractNodeScript(versionCheckScript!);
        expect(nodeScript).toBeDefined();
        runNodeScript(nodeScript!, { env: { NPM_VERSION: version } });
      });
    }

    for (const version of ["10.0.0", "10.99.99", "11.5.0", "11.4.99"]) {
      it(`fails below the Trusted Publishing floor: npm ${version}`, () => {
        const nodeScript = extractNodeScript(versionCheckScript!);
        runNodeScriptThrows(nodeScript!, { env: { NPM_VERSION: version } });
      });
    }

    for (const version of ["13.0.0", "99.0.0"]) {
      it(`fails closed on npm ${version} until its payload is measured`, () => {
        const nodeScript = extractNodeScript(versionCheckScript!);
        runNodeScriptThrows(nodeScript!, { env: { NPM_VERSION: version } });
      });
    }

    for (const version of ["garbage", "12.x.0", "v12.0.0", "12.0.0-rc.1"]) {
      it(`fails closed on a malformed npm version: ${JSON.stringify(version)}`, () => {
        const nodeScript = extractNodeScript(versionCheckScript!);
        runNodeScriptThrows(nodeScript!, { env: { NPM_VERSION: version } });
      });
    }

    for (const version of ["12.0", "12", ""]) {
      it(`fails closed on an incomplete npm version: ${JSON.stringify(version)}`, () => {
        const nodeScript = extractNodeScript(versionCheckScript!);
        runNodeScriptThrows(nodeScript!, { env: { NPM_VERSION: version } });
      });
    }

    // The ceiling is this workflow's own contract — the payload shapes its
    // parser has measured — not a Trusted Publishing requirement. Saying
    // otherwise would send a maintainer hunting through npm's release notes
    // for a rule that does not exist.
    it("attributes the upper bound to this workflow, not to Trusted Publishing", () => {
      expect(versionCheckScript).toContain(
        "This release workflow supports npm 11.5.1 through npm 12.x",
      );
      expect(versionCheckScript).not.toMatch(
        /< ?13 is required for Trusted Publishing/,
      );
    });
  });

  describe("prepare job: pack metadata", () => {
    const content = readWorkflow();
    const scripts = extractRunScripts(content, "prepare");
    const packScript = scripts.find(s => s.includes("check-package-tarball"));

    it("script exists in prepare job", () => {
      expect(packScript).toBeDefined();
    });

    it("asks the checker to publish verified metadata", () => {
      expect(packScript).toContain("--metadata-out checked-pack.json");
    });

    it("takes the tarball filename from the verified metadata", () => {
      expect(packScript).toMatch(
        /tarball="\$\(node -p 'require\("\.\/checked-pack\.json"\)\.filename'\)"/,
      );
    });

    it("moves the tarball only after the inspection step", () => {
      const inspectAt = packScript!.indexOf("check-package-tarball");
      const moveAt = packScript!.indexOf('mv -- "$tarball"');
      expect(inspectAt).toBeGreaterThanOrEqual(0);
      expect(moveAt).toBeGreaterThan(inspectAt);
    });

    // The parser refuses a leading `-`, and `mv` gets `--` as well. Quoting
    // stops word splitting, not option parsing, so neither half alone closes
    // the boundary this PR claims to verify.
    it("ends mv option parsing before the filename", () => {
      expect(packScript).toContain('mv -- "$tarball" release-artifact/package.tgz');
      expect(packScript).not.toMatch(/mv "\$tarball"/);
    });

    // The production runner is Ubuntu, and the claim is about how a real shell
    // and a real `mv` treat the name — which a string assertion cannot settle.
    // The command is lifted from the workflow rather than retyped, so a change
    // there is executed here instead of drifting past a hardcoded copy.
    it.runIf(process.platform === "linux")(
      "executes the option-terminated handoff on Linux",
      () => {
        const moveLine = packScript!
          .split("\n")
          .map(line => line.trim())
          .find(line => line.startsWith("mv --"));
        expect(moveLine).toBeDefined();

        const tmpDir = join(repoRoot, "tmp-test-mv-boundary");
        rmSync(tmpDir, { recursive: true, force: true });
        mkdirSync(join(tmpDir, "release-artifact"), { recursive: true });
        try {
          // A name the parser would refuse, used here to prove the shell half
          // of the boundary independently of the parser half.
          const hostileName = "--not-an-option.tgz";
          const bytes = Buffer.from("linux-mv-boundary");
          writeFileSync(join(tmpDir, hostileName), bytes);

          const scriptFile = join(tmpDir, "__run_mv.sh");
          writeFileSync(
            scriptFile,
            ["set -e", `tarball="${hostileName}"`, moveLine!].join("\n"),
          );

          execFileSync("bash", [scriptFile], {
            encoding: "utf8",
            cwd: tmpDir,
            stdio: "pipe",
            timeout: CHILD_TIMEOUT_MS,
            killSignal: CHILD_KILL_SIGNAL,
            maxBuffer: CHILD_MAX_BUFFER,
          });

          expect(existsSync(join(tmpDir, hostileName))).toBe(false);
          expect(
            readFileSync(join(tmpDir, "release-artifact", "package.tgz")),
          ).toEqual(bytes);
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      },
    );

    // The npm prerequisite admits npm 12, whose `npm pack --json` payload is an
    // object keyed by package name rather than an array. A second reader in the
    // workflow would have to know that too, so there is only one reader.
    it("does not parse the raw pack JSON itself", () => {
      for (const script of scripts) {
        expect(script).not.toMatch(/packData\[0\]/);
        expect(script).not.toMatch(/JSON\.parse\([^)]*pack\.json/);
        expect(script).not.toMatch(/pack\.json[^\n]*\[0\]/);
      }
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
      const nodeScript = extractNodeScript(verifyScript!, "NODE");
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
      const nodeScript = extractNodeScript(verifyScript!, "NODE");
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
      const nodeScript = extractNodeScript(verifyScript!, "NODE");
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
      const nodeScript = extractNodeScript(verifyScript!, "NODE");
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
      const nodeScript = extractNodeScript(verifyScript!, "NODE");
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
              timeout: CHILD_TIMEOUT_MS,
              killSignal: CHILD_KILL_SIGNAL,
              maxBuffer: CHILD_MAX_BUFFER,
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

    // The registry probe is inline in the workflow now, so the shell runs the
    // real Node interpreter over it. Only `fetch` is replaced, and only to keep
    // the suite off the network — the probe's own branching, state channel, and
    // ordering are exercised as written.
    //
    // `MOCK_FETCH_STATUS_THROW` is the regression that matters: the request
    // succeeds and the *handler* then fails. That is the shape of a future
    // typo or a ReferenceError, and it must never look like "absent".
    // `MOCK_FETCH_STDOUT_NOISE` covers the other half — a process that exits
    // zero but says something the shell does not recognize.
    const FETCH_STUB = [
      "globalThis.fetch = async () => {",
      "  if (process.env.FETCH_LOG) {",
      '    require("node:fs").appendFileSync(process.env.FETCH_LOG, "fetch\\n");',
      "  }",
      '  if (process.env.MOCK_FETCH_ERROR === "1") {',
      '    throw new Error("synthetic network failure");',
      "  }",
      '  if (process.env.MOCK_FETCH_STDOUT_NOISE === "1") {',
      '    process.stdout.write("noise\\n");',
      "  }",
      '  if (process.env.MOCK_FETCH_STATUS_THROW === "1") {',
      "    return {",
      "      get status() {",
      '        throw new Error("synthetic callback failure");',
      "      },",
      "    };",
      "  }",
      '  return { status: Number(process.env.MOCK_FETCH_STATUS ?? "404") };',
      "};",
      "",
    ].join("\n");

    function makeTmpEnv(opts: {
      manifest?: Record<string, unknown>;
      tarballContent?: Buffer;
    }): { tmpDir: string } {
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

      writeFileSync(join(tmpDir, "mock-fetch.cjs"), FETCH_STUB);

      // The npm stub answers --version so the job's own toolchain gate runs,
      // and records publish invocations. Any other subcommand is a failure:
      // the job must not reach for npm to do anything else.
      writeFileSync(
        join(tmpDir, "bin", "npm"),
        [
          "#!/bin/sh",
          'printf \'%s\\n\' "$*" >> "$NPM_LOG"',
          'if [ "$1" = "--version" ]; then',
          '  printf \'%s\\n\' "${NPM_STUB_VERSION:-12.0.0}"',
          "  exit 0",
          "fi",
          'if [ "$1" = "publish" ]; then',
          "  exit 0",
          "fi",
          "exit 2",
        ].join("\n"),
      );
      chmodSync(join(tmpDir, "bin", "npm"), 0o755);

      // A thin recorder over the real interpreter. It fakes nothing: unlike the
      // node stub it replaces, it cannot make an absent repository file look
      // present, which is exactly how a checkout-less job calling a repository
      // script went unnoticed.
      writeFileSync(
        join(tmpDir, "bin", "node"),
        [
          "#!/bin/sh",
          'printf \'%s\\n\' "$*" >> "$NODE_LOG"',
          `exec ${process.execPath} "$@"`,
        ].join("\n"),
      );
      chmodSync(join(tmpDir, "bin", "node"), 0o755);

      return { tmpDir };
    }

    function runPublishShell(
      tmpDir: string,
      env: Record<string, string> = {},
    ): void {
      const scriptFile = join(tmpDir, "__run_publish.sh");
      writeFileSync(scriptFile, "set -e\n" + publishScript!);
      try {
        execFileSync("bash", [scriptFile], {
          encoding: "utf8",
          cwd: tmpDir,
          env: {
            ...process.env,
            PATH: `${join(tmpDir, "bin")}:${process.env.PATH}`,
            NODE_OPTIONS: `--require=${join(tmpDir, "mock-fetch.cjs")}`,
            EXPECTED_TAG: "v2.0.0",
            EXPECTED_COMMIT: "c".repeat(40),
            NPM_CONFIG_PROVENANCE: "true",
            NPM_REGISTRY: "https://registry.npmjs.org",
            NPM_LOG: join(tmpDir, "npm-calls.log"),
            NODE_LOG: join(tmpDir, "node-calls.log"),
            FETCH_LOG: join(tmpDir, "fetch-calls.log"),
            GITHUB_OUTPUT: join(tmpDir, "github-output.txt"),
            ...env,
          },
          stdio: "pipe",
          timeout: CHILD_TIMEOUT_MS,
          killSignal: CHILD_KILL_SIGNAL,
          maxBuffer: CHILD_MAX_BUFFER,
        });
      } finally {
        rmSync(scriptFile, { force: true });
      }
    }

    function npmCalls(tmpDir: string): string {
      const path = join(tmpDir, "npm-calls.log");
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    }

    function fetchCount(tmpDir: string): number {
      const path = join(tmpDir, "fetch-calls.log");
      if (!existsSync(path)) return 0;
      return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    }

    for (const version of ["12.0.0", "11.5.1", "11.16.0"]) {
      it(`unpublished version on npm ${version}: publishes`, () => {
        const { tmpDir } = makeTmpEnv({});
        try {
          runPublishShell(tmpDir, {
            NPM_STUB_VERSION: version,
            MOCK_FETCH_STATUS: "404",
          });
          expect(npmCalls(tmpDir)).toContain(
            "publish ./release-artifact/package.tgz --ignore-scripts",
          );
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      });
    }

    for (const [label, version] of [
      ["a future major", "13.0.0"],
      ["a malformed version", "garbage"],
      ["an incomplete version", "12.0"],
      ["a prerelease", "12.0.0-rc.1"],
    ] as const) {
      it(`refuses ${label} before probing the registry`, () => {
        const { tmpDir } = makeTmpEnv({});
        try {
          expect(() =>
            runPublishShell(tmpDir, {
              NPM_STUB_VERSION: version,
              MOCK_FETCH_STATUS: "404",
            }),
          ).toThrow();
          expect(fetchCount(tmpDir)).toBe(0);
          expect(npmCalls(tmpDir)).not.toContain("publish");
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      });
    }

    it("existing version: fails as a tag/version collision", () => {
      const { tmpDir } = makeTmpEnv({});
      try {
        expect(() =>
          runPublishShell(tmpDir, { MOCK_FETCH_STATUS: "200" }),
        ).toThrow();
        expect(npmCalls(tmpDir)).not.toContain("publish");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("registry 5xx: refuses to publish from an unproven state", () => {
      const { tmpDir } = makeTmpEnv({});
      try {
        expect(() =>
          runPublishShell(tmpDir, { MOCK_FETCH_STATUS: "500" }),
        ).toThrow();
        expect(npmCalls(tmpDir)).not.toContain("publish");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // The R4 regression. The request succeeds and the handler then throws, so
    // the probe process fails the way a syntax error or a ReferenceError would.
    // Node exits 1 for all of them — which is exactly why "absent" cannot be an
    // exit code. Nothing about this case is a proven absence.
    it("exception after fetch fulfillment: refuses to publish", () => {
      const { tmpDir } = makeTmpEnv({});
      try {
        expect(() =>
          runPublishShell(tmpDir, { MOCK_FETCH_STATUS_THROW: "1" }),
        ).toThrow();
        expect(fetchCount(tmpDir)).toBe(1);
        expect(npmCalls(tmpDir)).not.toContain("publish");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // A probe that exits zero but says something unrecognized is not a state.
    it("unrecognized probe output: refuses to publish", () => {
      const { tmpDir } = makeTmpEnv({});
      try {
        expect(() =>
          runPublishShell(tmpDir, {
            MOCK_FETCH_STDOUT_NOISE: "1",
            MOCK_FETCH_STATUS: "404",
          }),
        ).toThrow();
        expect(npmCalls(tmpDir)).not.toContain("publish");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("registry network failure: refuses to publish", () => {
      const { tmpDir } = makeTmpEnv({});
      try {
        expect(() =>
          runPublishShell(tmpDir, { MOCK_FETCH_ERROR: "1" }),
        ).toThrow();
        expect(npmCalls(tmpDir)).not.toContain("publish");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("manifest mismatch: fails before the registry probe", () => {
      const { tmpDir } = makeTmpEnv({
        manifest: {
          package: "code-pact",
          version: "9.9.9",
          tag: "v9.9.9",
          commit: "c".repeat(40),
          tarball_sha256: "0".repeat(64),
        },
      });
      try {
        expect(() =>
          runPublishShell(tmpDir, { MOCK_FETCH_STATUS: "404" }),
        ).toThrow();
        expect(fetchCount(tmpDir)).toBe(0);
        expect(npmCalls(tmpDir)).not.toContain("publish");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // The regression that motivated the rewrite: this workspace holds only the
    // downloaded artifact, exactly what the job has after download-artifact.
    // The previous suite passed with a `scripts/` call in the shell because its
    // node stub answered for a file that was never there.
    it("succeeds in an isolated workspace with no repository code", () => {
      const { tmpDir } = makeTmpEnv({});
      try {
        expect(existsSync(join(tmpDir, "scripts"))).toBe(false);
        expect(existsSync(join(tmpDir, "package.json"))).toBe(false);

        runPublishShell(tmpDir, { MOCK_FETCH_STATUS: "404" });

        const nodeArgs = readFileSync(join(tmpDir, "node-calls.log"), "utf8");
        expect(nodeArgs).not.toMatch(/scripts\//);
        expect(npmCalls(tmpDir)).toContain("publish");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("pins the registry against an NPM_CONFIG_REGISTRY override", () => {
      const { tmpDir } = makeTmpEnv({});
      try {
        runPublishShell(tmpDir, {
          MOCK_FETCH_STATUS: "404",
          NPM_CONFIG_REGISTRY: "https://attacker.invalid",
        });
        const calls = npmCalls(tmpDir);
        expect(calls).toContain("--registry=https://registry.npmjs.org");
        expect(calls).not.toContain("attacker.invalid");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("refuses a registry the step env did not pin", () => {
      const { tmpDir } = makeTmpEnv({});
      try {
        expect(() =>
          runPublishShell(tmpDir, {
            NPM_REGISTRY: "https://attacker.invalid",
            MOCK_FETCH_STATUS: "404",
          }),
        ).toThrow();
        expect(npmCalls(tmpDir)).not.toContain("publish");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("github-release job: full shell execution with stub gh", () => {
    const content = readWorkflow();
    const scripts = extractRunScripts(content, "github-release");
    const releaseScript = scripts.find(s => s.includes("gh release"));

    function makeTmpEnv(opts: { ghViewExit?: number }): {
      tmpDir: string;
      ghViewExit: number;
    } {
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
      chmodSync(join(tmpDir, "bin", "gh"), 0o755);

      return { tmpDir, ghViewExit };
    }

    it("new release: calls gh release view then gh release create", () => {
      const { tmpDir } = makeTmpEnv({ ghViewExit: 1 });
      const ghLog = join(tmpDir, "gh-calls.log");
      try {
        const scriptFile = join(tmpDir, "__run_release.sh");
        writeFileSync(scriptFile, "set -e\n" + releaseScript!);
        try {
          execFileSync("bash", [scriptFile], {
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
            timeout: CHILD_TIMEOUT_MS,
            killSignal: CHILD_KILL_SIGNAL,
            maxBuffer: CHILD_MAX_BUFFER,
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
      const { tmpDir } = makeTmpEnv({ ghViewExit: 0 });
      const ghLog = join(tmpDir, "gh-calls.log");
      try {
        const scriptFile = join(tmpDir, "__run_release.sh");
        writeFileSync(scriptFile, "set -e\n" + releaseScript!);
        try {
          execFileSync("bash", [scriptFile], {
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
            timeout: CHILD_TIMEOUT_MS,
            killSignal: CHILD_KILL_SIGNAL,
            maxBuffer: CHILD_MAX_BUFFER,
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
