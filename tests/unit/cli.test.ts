import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const cliPath = join(repoRoot, "dist", "cli.js");

let tmpDir: string;

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

beforeAll(() => {
  if (!existsSync(cliPath)) {
    throw new Error(`CLI not built. Expected: ${cliPath}. Run \`pnpm build\` first.`);
  }
});

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-cli-test-"));
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// BUG-001: --json must work both before AND after the command
// ---------------------------------------------------------------------------

function expectJsonOk(res: { code: number; stdout: string; stderr: string }) {
  expect(res.code).toBe(0);
  expect(res.stdout.trim().length).toBeGreaterThan(0);
  const parsed = JSON.parse(res.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(true);
}

describe("CLI: post-command --json (BUG-001)", () => {
  it("--json before init returns JSON-only stdout", () => {
    const res = run(["--json", "init", "--locale", "en-US", "--agent", "claude-code"]);
    expectJsonOk(res);
  });

  it("init ... --json (post-command) returns JSON-only stdout", () => {
    const res = run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    expectJsonOk(res);
  });

  it("phase ls --json returns JSON-only stdout", () => {
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    const res = run(["phase", "ls", "--json"]);
    expectJsonOk(res);
  });

  it("--json phase ls also returns JSON-only stdout", () => {
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    const res = run(["--json", "phase", "ls"]);
    expectJsonOk(res);
  });

  it("phase show <id> --json returns JSON-only stdout", () => {
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    run([
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--objective",
      "Foundation",
      "--weight",
      "10",
      "--json",
    ]);
    const res = run(["phase", "show", "P1", "--json"]);
    expectJsonOk(res);
  });

  it("progress --json returns JSON-only stdout", () => {
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    const res = run(["progress", "--json"]);
    expectJsonOk(res);
  });

  it("pack ... --json returns JSON-only stdout", () => {
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    run([
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--objective",
      "Foundation",
      "--weight",
      "10",
      "--json",
    ]);
    const res = run([
      "pack",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    // pack may fail with TASK_NOT_FOUND (no task added in this test),
    // but the point is that --json produces JSON-only stdout.
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(typeof parsed.ok).toBe("boolean");
  });

  it("verify ... --json (post-command) produces JSON-only stdout", () => {
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    run([
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--objective",
      "Foundation",
      "--weight",
      "10",
      "--json",
    ]);
    const res = run(["verify", "--phase", "P1", "--task", "P1-T1", "--json"]);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(typeof parsed.ok).toBe("boolean");
  });

  it("doctor --json returns JSON-only stdout", () => {
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    const res = run(["doctor", "--json"]);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });

  it("--version --json returns JSON shape", () => {
    const res = run(["--version", "--json"]);
    expectJsonOk(res);
  });
});
