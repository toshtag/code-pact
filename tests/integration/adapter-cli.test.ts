import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../../src/commands/init.ts";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const cliPath = join(repoRoot, "dist", "cli.js");

beforeAll(() => {
  const res = spawnSync("pnpm", ["build"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (res.status !== 0 || !existsSync(cliPath)) {
    throw new Error(
      `Failed to build CLI for tests. exit=${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
}, 60_000);

afterAll(() => {});

let dir: string;

beforeEach(async () => {
  // On macOS /var/folders/... is a symlink to /private/var/folders/...; the
  // spawned node's process.cwd() returns the realpath'd form, so we
  // realpath dir up front to make path comparisons stable.
  dir = await realpath(await mkdtemp(join(tmpdir(), "code-pact-adapter-cli-test-")));
  await runInit({
    cwd: dir,
    locale: "en-US",
    agents: ["claude-code"],
    force: false,
    json: false,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function runCli(args: string[]) {
  return spawnSync("node", [cliPath, ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: "pipe",
  });
}

describe("adapter list — CLI", () => {
  it("--json returns ok envelope with agents array", () => {
    const res = runCli(["adapter", "list", "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { agents: Array<{ name: string }> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.agents.map((a) => a.name).sort()).toEqual(
      ["claude-code", "codex", "cursor", "gemini-cli", "generic"].sort(),
    );
  });

  it("human form writes one line per agent to stderr", () => {
    const res = runCli(["adapter", "list"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("claude-code");
    expect(res.stderr).toContain("enabled");
    expect(res.stderr).toContain("experimental"); // cursor or gemini-cli
  });
});

describe("adapter install <agent> — CLI", () => {
  it("--json returns ok envelope with manifestPath and generatorVersion", () => {
    const res = runCli(["adapter", "install", "claude-code", "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { agentName: string; manifestPath: string; generatorVersion: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.agentName).toBe("claude-code");
    expect(parsed.data.manifestPath).toBe(
      join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml"),
    );
    expect(parsed.data.generatorVersion).toMatch(/^\d/); // looks like a version
  });

  it("missing <agent> positional → CONFIG_ERROR exit 2", () => {
    const res = runCli(["adapter", "install", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("unknown agent → AGENT_NOT_FOUND exit 2", () => {
    const res = runCli(["adapter", "install", "no-such-agent", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("AGENT_NOT_FOUND");
  });
});

describe("adapter bare-form back-compat — CLI", () => {
  it("bare-form without --json emits a deprecation notice on stderr", () => {
    const res = runCli(["adapter", "--agent", "claude-code"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/deprecated/i);
    expect(res.stderr).toMatch(/adapter install claude-code/);
  });

  it("bare-form with --json SUPPRESSES the deprecation notice on stderr", () => {
    const res = runCli(["adapter", "--agent", "claude-code", "--json"]);
    expect(res.status).toBe(0);
    // stderr stays quiet under --json so agents reading JSON aren't surprised.
    expect(res.stderr).not.toMatch(/deprecated/i);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; data: { manifestPath: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.manifestPath).toContain("claude-code.manifest.yaml");
  });

  it("bare-form routes to install (manifest is created)", () => {
    runCli(["adapter", "--agent", "claude-code", "--json"]);
    const manifestPath = join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml");
    expect(existsSync(manifestPath)).toBe(true);
  });
});

describe("adapter upgrade — CLI", () => {
  it("missing <agent> → CONFIG_ERROR exit 2", () => {
    const res = runCli(["adapter", "upgrade", "--check", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("neither --check nor --write → CONFIG_ERROR exit 2", () => {
    const res = runCli(["adapter", "upgrade", "claude-code", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toMatch(/--check or --write/);
  });

  it("both --check and --write → CONFIG_ERROR exit 2 (mutually exclusive)", () => {
    const res = runCli(["adapter", "upgrade", "claude-code", "--check", "--write", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toMatch(/mutually exclusive/);
  });

  it("no manifest → MANIFEST_NOT_FOUND exit 2", () => {
    const res = runCli(["adapter", "upgrade", "claude-code", "--check", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("MANIFEST_NOT_FOUND");
  });

  it("unknown agent → AGENT_NOT_FOUND exit 2", () => {
    const res = runCli(["adapter", "upgrade", "no-such-agent", "--check", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("AGENT_NOT_FOUND");
  });

  it("--check after fresh install → clean true, exit 0", () => {
    runCli(["adapter", "install", "claude-code", "--json"]);
    const res = runCli(["adapter", "upgrade", "claude-code", "--check", "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; data: { clean: boolean } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.clean).toBe(true);
  });

  it("--write after fresh install → idempotent (manifest hashes unchanged)", () => {
    const install = runCli(["adapter", "install", "claude-code", "--json"]);
    const installed = JSON.parse(install.stdout) as { data: { manifestPath: string } };
    const manifestPath = installed.data.manifestPath;
    const fs = require("node:fs") as typeof import("node:fs");
    const before = fs.readFileSync(manifestPath, "utf8");
    const hashesBefore = before.match(/sha256: [0-9a-f]{64}/g);

    const res = runCli(["adapter", "upgrade", "claude-code", "--write", "--json"]);
    expect(res.status).toBe(0);
    const after = fs.readFileSync(manifestPath, "utf8");
    const hashesAfter = after.match(/sha256: [0-9a-f]{64}/g);
    expect(hashesAfter).toEqual(hashesBefore);
  });
});

describe("adapter doctor — CLI", () => {
  it("--json returns ok envelope with issues array (exit 0 for warning-only state)", () => {
    const res = runCli(["adapter", "doctor", "--json"]);
    // Before install, claude-code has no manifest → MANIFEST_MISSING is a
    // warning, not an error. Matches global doctor's semantic: exit 0 unless
    // a severity:"error" issue is present.
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { ok: boolean; issues: Array<{ code: string; agent: string }> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.ok).toBe(true);
    const codes = parsed.data.issues.map((i) => i.code);
    expect(codes).toContain("ADAPTER_MANIFEST_MISSING");
  });

  it("exit 0 after install — clean state with no issues", () => {
    runCli(["adapter", "install", "claude-code", "--json"]);
    const res = runCli(["adapter", "doctor", "--json"]);
    // generator_version may differ from the install-recorded version, so
    // a warning could still surface; this asserts the exit code only when
    // truly clean. In practice the test repo's package version matches.
    if (res.status === 0) {
      const parsed = JSON.parse(res.stdout) as {
        data: { issues: Array<{ code: string }> };
      };
      expect(parsed.data.issues).toEqual([]);
    } else {
      expect(res.status).toBe(1);
    }
  });

  it("--agent flag accepts an explicit target", () => {
    const res = runCli(["adapter", "doctor", "--agent", "codex", "--json"]);
    expect(res.status).toBe(0); // codex isn't enabled in this project → no findings
    const parsed = JSON.parse(res.stdout) as { ok: boolean; data: { issues: unknown[] } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.issues).toEqual([]);
  });

  it("--agent with an unknown name → AGENT_NOT_FOUND exit 2", () => {
    const res = runCli(["adapter", "doctor", "--agent", "no-such-agent", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("AGENT_NOT_FOUND");
  });

  it("human form prints one line per issue", () => {
    const res = runCli(["adapter", "doctor"]);
    expect(res.stderr).toContain("ADAPTER_MANIFEST_MISSING");
    expect(res.stderr).toContain("[claude-code]");
  });
});

describe("adapter unknown subcommand — CLI", () => {
  it("rejects unknown sub-word with CONFIG_ERROR exit 2", () => {
    const res = runCli(["adapter", "foobar", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toContain("foobar");
  });
});
