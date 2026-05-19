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

describe("adapter upgrade / doctor stubs — CLI", () => {
  it("upgrade → NOT_IMPLEMENTED exit 2", () => {
    const res = runCli(["adapter", "upgrade", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("doctor → NOT_IMPLEMENTED exit 2", () => {
    const res = runCli(["adapter", "doctor", "--json"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("NOT_IMPLEMENTED");
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
