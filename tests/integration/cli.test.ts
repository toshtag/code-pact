// CLI integration suite — spawns the built CLI (`dist/cli.js`) via
// `spawnSync`. The integration test script builds dist once before Vitest
// starts so files can run in parallel without racing tsup cleanup.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { cliPath, ensureCliBuilt } from "../helpers/cli.ts";

let tmpDir: string;

type RunResult = { code: number; stdout: string; stderr: string };

function run(args: string[], env?: NodeJS.ProcessEnv): RunResult {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: tmpDir,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

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

// ---------------------------------------------------------------------------
// BUG-002: phase add --verify-command must not silently truncate
// ---------------------------------------------------------------------------

describe("CLI: phase add --verify-command parsing (BUG-002)", () => {
  it("quoted multi-token --verify-command is preserved", () => {
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    const res = run([
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--objective",
      "Foundation",
      "--weight",
      "12",
      "--verify-command",
      "node --version",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    const show = run(["phase", "show", "P1", "--json"]);
    const showParsed = JSON.parse(show.stdout) as {
      ok: boolean;
      data: { verification: { commands: string[] } };
    };
    expect(showParsed.data.verification.commands).toContain("node --version");
  });

  it("unquoted --verify-command node --version fails loudly (--json before)", () => {
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    const res = run([
      "--json",
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--objective",
      "Foundation",
      "--weight",
      "12",
      "--verify-command",
      "node",
      "--version",
    ]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");

    // No phase file written.
    const ls = run(["--json", "phase", "ls"]);
    const lsParsed = JSON.parse(ls.stdout) as { ok: boolean; data: unknown[] };
    expect(lsParsed.data).toEqual([]);
  });

  it("unquoted --verify-command node --version fails loudly (--json after)", () => {
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    const res = run([
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--objective",
      "Foundation",
      "--weight",
      "12",
      "--verify-command",
      "node",
      "--version",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("subcommand --version inside phase add does not trigger top-level version", () => {
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    const res = run([
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--objective",
      "Foundation",
      "--weight",
      "12",
      "--verify-command",
      "node",
      "--version",
    ]);
    // Top-level version would exit 0 with just the version string.
    // BUG-002 fix makes this exit 2 with a CONFIG_ERROR instead.
    expect(res.code).toBe(2);
    expect(res.stdout).not.toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// RC dogfood regressions: init --non-interactive contract (BUG-003)
// ---------------------------------------------------------------------------

describe("CLI: init non-interactive contract (RC BUG-003)", () => {
  function expectJsonConfigError(res: RunResult) {
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  }

  it("init --non-interactive without flags fails with exit 2", () => {
    const res = run(["init", "--non-interactive"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/non-interactive\/CI mode requires/);
  });

  it("init --non-interactive --json without flags emits CONFIG_ERROR JSON", () => {
    const res = run(["init", "--non-interactive", "--json"]);
    expectJsonConfigError(res);
  });

  it("--json init --non-interactive (pre-command --json) also emits CONFIG_ERROR JSON", () => {
    const res = run(["--json", "init", "--non-interactive"]);
    expectJsonConfigError(res);
  });

  it("CI=true init without flags fails with exit 2", () => {
    const res = run(["init", "--json"], { CI: "true" });
    expectJsonConfigError(res);
  });

  it("init --non-interactive --locale en-US --agent claude-code succeeds", () => {
    const res = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("init --non-interactive with multi-agent stores first agent as default_agent", async () => {
    const res = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code,generic",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const projectYaml = await readFile(
      join(tmpDir, ".code-pact", "project.yaml"),
      "utf8",
    );
    const project = parseYaml(projectYaml) as {
      default_agent: string;
      agents: { name: string }[];
    };
    expect(project.default_agent).toBe("claude-code");
    expect(project.agents.map((a) => a.name)).toEqual(["claude-code", "generic"]);
  });
});

// ---------------------------------------------------------------------------
// RC dogfood regressions: AMBIGUOUS_TASK_ID via CLI (RC BUG-002)
// ---------------------------------------------------------------------------

describe("CLI: AMBIGUOUS_TASK_ID across phases (RC BUG-002)", () => {
  it("task context returns AMBIGUOUS_TASK_ID when duplicate task ids exist", async () => {
    // Use --locale/--agent so non-interactive contract is satisfied.
    const initRes = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(initRes.code).toBe(0);

    const phasePaths: string[] = [];
    for (const id of ["P1", "P2"]) {
      const addRes = run([
        "phase",
        "add",
        "--id",
        id,
        "--name",
        `Phase ${id}`,
        "--objective",
        `Phase ${id}`,
        "--weight",
        "10",
        "--json",
      ]);
      expect(addRes.code).toBe(0);
      const parsed = JSON.parse(addRes.stdout) as {
        data: { path: string };
      };
      phasePaths.push(parsed.data.path);
    }

    // Inject a duplicate task id into both phase YAMLs via parse/stringify
    // (NOT appendFile — that can produce invalid YAML).
    const dupTask = {
      id: "DUP-T1",
      type: "feature",
      ambiguity: "low",
      risk: "low",
      context_size: "small",
      write_surface: "medium",
      verification_strength: "strong",
      expected_duration: "short",
      status: "planned",
      description: "duplicate task fixture",
    };
    for (const rel of phasePaths) {
      const p = join(tmpDir, rel);
      const doc = parseYaml(await readFile(p, "utf8")) as {
        tasks?: unknown[];
      };
      doc.tasks = [...(doc.tasks ?? []), dupTask];
      await writeFile(p, stringifyYaml(doc), "utf8");
    }

    const res = run([
      "task",
      "context",
      "DUP-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("AMBIGUOUS_TASK_ID");
  });
});

// ---------------------------------------------------------------------------
// RC dogfood regressions: strict reject of unknown options (RC BUG-004)
// ---------------------------------------------------------------------------

describe("CLI: unknown options on phase ls / progress (RC BUG-004)", () => {
  function expectConfigJson(res: RunResult) {
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  }

  beforeEach(() => {
    const initRes = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(initRes.code).toBe(0);
  });

  it("phase ls --bogus --json fails with CONFIG_ERROR", () => {
    expectConfigJson(run(["phase", "ls", "--bogus", "--json"]));
  });

  it("--json phase ls --bogus also fails with CONFIG_ERROR", () => {
    expectConfigJson(run(["--json", "phase", "ls", "--bogus"]));
  });

  it("progress --bogus --json fails with CONFIG_ERROR", () => {
    expectConfigJson(run(["progress", "--bogus", "--json"]));
  });

  it("--json progress --bogus also fails with CONFIG_ERROR", () => {
    expectConfigJson(run(["--json", "progress", "--bogus"]));
  });

  it("phase ls --json (no unknown option) still succeeds", () => {
    const res = run(["phase", "ls", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("progress --json (no unknown option) still succeeds", () => {
    const res = run(["progress", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v0.2: task complete
// ---------------------------------------------------------------------------

describe("CLI: task complete (v0.2)", () => {
  // Replace P1's verification commands with `echo ok` (or `false` for the
  // failing variant) so the spawned CLI does not need pnpm in tmpDir.
  async function rewritePhaseCommands(failing: boolean): Promise<string> {
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<
      string,
      unknown
    >;
    doc.verification = {
      commands: failing ? ["false"] : ["echo ok"],
    };
    await writeFile(phasePath, stringifyYaml(doc), "utf8");
    return phasePath;
  }

  async function setupWithTask(): Promise<void> {
    const initRes = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(initRes.code).toBe(0);
    const addRes = run([
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
    expect(addRes.code).toBe(0);

    // Append a single task to P1 via YAML parse/stringify (safe, not appendFile).
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<
      string,
      unknown
    >;
    doc.tasks = [
      {
        id: "P1-T1",
        type: "feature",
        ambiguity: "low",
        risk: "low",
        context_size: "small",
        write_surface: "low",
        verification_strength: "weak",
        expected_duration: "short",
        status: "planned",
        description: "integration test task",
      },
    ];
    await writeFile(phasePath, stringifyYaml(doc), "utf8");
  }

  it("happy path: appends done event, idempotent on re-run", async () => {
    await setupWithTask();
    await rewritePhaseCommands(false);

    const first = run([
      "task",
      "complete",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(first.code).toBe(0);
    const firstParsed = JSON.parse(first.stdout) as {
      ok: boolean;
      data: { task_id: string; phase_id: string; agent: string; event: { agent: string } };
    };
    expect(firstParsed.ok).toBe(true);
    expect(firstParsed.data.task_id).toBe("P1-T1");
    expect(firstParsed.data.phase_id).toBe("P1");
    expect(firstParsed.data.agent).toBe("claude-code");
    expect(firstParsed.data.event.agent).toBe("claude-code");

    const progressYaml = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    const log = parseYaml(progressYaml) as { events: unknown[] };
    expect(log.events).toHaveLength(1);

    // Second run: already_done, byte-identical progress.yaml
    const before = progressYaml;
    const second = run([
      "task",
      "complete",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(second.code).toBe(0);
    const secondParsed = JSON.parse(second.stdout) as {
      ok: boolean;
      data: { already_done: boolean };
    };
    expect(secondParsed.ok).toBe(true);
    expect(secondParsed.data.already_done).toBe(true);

    const after = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("verify failure: exit 1, VERIFICATION_FAILED, progress.yaml unchanged", async () => {
    await setupWithTask();
    await rewritePhaseCommands(true);

    const before = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
      data: {
        verify: { ok: boolean; checks: { name: string }[] };
        failed_checks: string[];
        first_failure: { name: string; reason: string } | null;
        suggested_next_command: string | null;
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("VERIFICATION_FAILED");

    // P32: failure clarity — the root cause is surfaced near the top of data,
    // additive to the unchanged data.verify.checks.
    expect(parsed.data.verify.checks.length).toBeGreaterThan(0);
    expect(parsed.data.failed_checks).toContain("commands");
    expect(parsed.data.first_failure?.name).toBe("commands");
    expect(parsed.data.first_failure?.reason ?? "").toMatch(/exited with code/);
    expect(parsed.data.suggested_next_command).toBe(
      "code-pact task complete P1-T1",
    );

    const after = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("verify failure (--dry-run --json): still runs verification and surfaces the failure fields", async () => {
    await setupWithTask();
    await rewritePhaseCommands(true);

    const before = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    // --dry-run does NOT skip verification: verify runs before the dry-run
    // short-circuit, so a failing dry-run is still VERIFICATION_FAILED and
    // carries the same clarity fields.
    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--agent",
      "claude-code",
      "--dry-run",
      "--json",
    ]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
      data: {
        failed_checks: string[];
        first_failure: { name: string } | null;
        suggested_next_command: string | null;
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("VERIFICATION_FAILED");
    expect(parsed.data.failed_checks).toContain("commands");
    expect(parsed.data.first_failure?.name).toBe("commands");
    expect(parsed.data.suggested_next_command).toBe(
      "code-pact task complete P1-T1",
    );

    const after = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("verify failure (human): prints the cause and rerun-after-fixing lines to stderr", async () => {
    await setupWithTask();
    await rewritePhaseCommands(true);

    const res = run(["task", "complete", "P1-T1", "--agent", "claude-code"]);
    expect(res.code).toBe(1);
    // P39: the headline is now the actionable cause message (was the generic
    // "Verification failed for ..." string before P39).
    expect(res.stderr).toMatch(/P1-T1: a verification command failed/);
    // ...with the new clarity lines below it.
    expect(res.stderr).toMatch(/cause: commands —/);
    expect(res.stderr).toMatch(/rerun after fixing: code-pact task complete P1-T1/);
  });

  it("dry-run leaves progress.yaml byte-identical and returns would_append", async () => {
    await setupWithTask();
    await rewritePhaseCommands(false);

    const before = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--agent",
      "claude-code",
      "--dry-run",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: {
        dry_run: boolean;
        would_append: { task_id: string; agent: string };
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.dry_run).toBe(true);
    expect(parsed.data.would_append.task_id).toBe("P1-T1");
    expect(parsed.data.would_append.agent).toBe("claude-code");

    const after = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("unknown agent: AGENT_NOT_FOUND, progress.yaml unchanged", async () => {
    await setupWithTask();
    await rewritePhaseCommands(false);
    const before = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--agent",
      "nonexistent",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("AGENT_NOT_FOUND");

    const after = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("missing task id positional fails with CONFIG_ERROR", () => {
    const initRes = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(initRes.code).toBe(0);
    const res = run(["task", "complete", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("unknown option strictly rejected via shared strictParse helper", () => {
    const initRes = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(initRes.code).toBe(0);
    const res = run(["task", "complete", "P1-T1", "--bogus", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });
});

// ---------------------------------------------------------------------------
// v1.21: task record-done
// ---------------------------------------------------------------------------

describe("CLI: task record-done (v1.21)", () => {
  // Sets up P1-T1 with a FAILING verification command so we can prove
  // record-done ignores it. `requiresDecision` optionally marks the task.
  async function setupRecordDone(requiresDecision = false): Promise<void> {
    const initRes = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(initRes.code).toBe(0);
    const addRes = run([
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
    expect(addRes.code).toBe(0);

    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<
      string,
      unknown
    >;
    doc.verification = { commands: ["false"] }; // would fail under task complete
    doc.tasks = [
      {
        id: "P1-T1",
        type: "feature",
        ambiguity: "low",
        risk: "low",
        context_size: "small",
        write_surface: "low",
        verification_strength: "weak",
        expected_duration: "short",
        status: "planned",
        description: "record-done integration task",
        ...(requiresDecision ? { requires_decision: true } : {}),
      },
    ];
    await writeFile(phasePath, stringifyYaml(doc), "utf8");
  }

  it("happy path: appends external done event despite failing verify command; idempotent on re-run", async () => {
    await setupRecordDone();

    const first = run([
      "task",
      "record-done",
      "P1-T1",
      "--evidence",
      "PR #123",
      "--notes",
      "Already merged",
      "--json",
    ]);
    expect(first.code).toBe(0);
    const firstParsed = JSON.parse(first.stdout) as {
      ok: boolean;
      data: {
        task_id: string;
        phase_id: string;
        agent: string;
        event: { source: string; evidence: string[]; notes?: string };
      };
    };
    expect(firstParsed.ok).toBe(true);
    expect(firstParsed.data.task_id).toBe("P1-T1");
    expect(firstParsed.data.event.source).toBe("external");
    expect(firstParsed.data.event.evidence).toEqual(["PR #123"]);
    expect(firstParsed.data.event.notes).toBe("Already merged");

    const before = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    const second = run([
      "task",
      "record-done",
      "P1-T1",
      "--evidence",
      "PR #123",
      "--json",
    ]);
    expect(second.code).toBe(0);
    const secondParsed = JSON.parse(second.stdout) as {
      ok: boolean;
      data: { already_done: boolean };
    };
    expect(secondParsed.data.already_done).toBe(true);

    const after = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("DECISION_REQUIRED surfaces structured top-level data; progress unchanged", async () => {
    await setupRecordDone(true);
    const before = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    const res = run([
      "task",
      "record-done",
      "P1-T1",
      "--evidence",
      "PR #123",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
      data?: {
        task_id: string;
        current_resolution: string;
        expected_pattern: string;
        decision_check: { ok: boolean; reason?: string };
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("DECISION_REQUIRED");
    expect(parsed.data).toBeDefined();
    expect(parsed.data!.task_id).toBe("P1-T1");
    expect(parsed.data!.current_resolution).toBe("status-aware");
    expect(parsed.data!.expected_pattern).toBe("design/decisions/*P1-T1*.md");
    expect(parsed.data!.decision_check.ok).toBe(false);

    const after = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("missing --evidence fails with CONFIG_ERROR", async () => {
    await setupRecordDone();
    const res = run(["task", "record-done", "P1-T1", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("dry-run returns would_append and leaves progress.yaml byte-identical", async () => {
    await setupRecordDone();
    const before = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    const res = run([
      "task",
      "record-done",
      "P1-T1",
      "--evidence",
      "PR #123",
      "--dry-run",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { dry_run: boolean; would_append: { source: string } };
    };
    expect(parsed.data.dry_run).toBe(true);
    expect(parsed.data.would_append.source).toBe("external");
    const after = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("--help returns rich usage (exit 0) with flags and examples", () => {
    const res = run(["task", "record-done", "--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage: code-pact task record-done");
    expect(res.stdout).toContain("--evidence");
    expect(res.stdout).toContain("Examples:");
  });

  it("unknown-subcommand hint lists record-done", () => {
    // Global --json (before the command) routes the unknown-subcommand
    // envelope to stdout; otherwise the hint goes to stderr.
    const res = run(["--json", "task", "bogus-sub"]);
    expect(res.code).toBe(2);
    expect(res.stdout).toContain("record-done");
  });
});

// ---------------------------------------------------------------------------
// v0.6: task state machine (start / status / block / resume + complete)
// ---------------------------------------------------------------------------

describe("CLI: task state machine (v0.6)", () => {
  async function setupWithTask(): Promise<void> {
    const initRes = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(initRes.code).toBe(0);
    const addRes = run([
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
    expect(addRes.code).toBe(0);

    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<
      string,
      unknown
    >;
    doc.tasks = [
      {
        id: "P1-T1",
        type: "feature",
        ambiguity: "low",
        risk: "low",
        context_size: "small",
        write_surface: "low",
        verification_strength: "weak",
        expected_duration: "short",
        status: "planned",
        description: "integration test task",
      },
    ];
    doc.verification = { commands: ["echo ok"] };
    await writeFile(phasePath, stringifyYaml(doc), "utf8");
  }

  async function readProgress(): Promise<{ raw: string; events: unknown[] }> {
    const raw = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    const log = parseYaml(raw) as { events: unknown[] };
    return { raw, events: log.events };
  }

  it("full sequence: start → status → block → resume → complete", async () => {
    await setupWithTask();

    const startRes = run(["task", "start", "P1-T1", "--json"]);
    expect(startRes.code).toBe(0);
    const startParsed = JSON.parse(startRes.stdout) as {
      ok: boolean;
      data: { event: { status: string } };
    };
    expect(startParsed.ok).toBe(true);
    expect(startParsed.data.event.status).toBe("started");

    const statusRes = run(["task", "status", "P1-T1", "--json"]);
    expect(statusRes.code).toBe(0);
    const statusParsed = JSON.parse(statusRes.stdout) as {
      ok: boolean;
      data: { current: string };
    };
    expect(statusParsed.data.current).toBe("started");

    const blockRes = run([
      "task",
      "block",
      "P1-T1",
      "--reason",
      "waiting on review",
      "--json",
    ]);
    expect(blockRes.code).toBe(0);
    const blockParsed = JSON.parse(blockRes.stdout) as {
      ok: boolean;
      data: { event: { status: string; reason: string } };
    };
    expect(blockParsed.data.event.status).toBe("blocked");
    expect(blockParsed.data.event.reason).toBe("waiting on review");

    const resumeRes = run(["task", "resume", "P1-T1", "--json"]);
    expect(resumeRes.code).toBe(0);
    const resumeParsed = JSON.parse(resumeRes.stdout) as {
      ok: boolean;
      data: { event: { status: string } };
    };
    expect(resumeParsed.data.event.status).toBe("resumed");

    const completeRes = run([
      "task",
      "complete",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(completeRes.code).toBe(0);

    const { events } = await readProgress();
    expect(events).toHaveLength(4);
    expect((events as { status: string }[]).map((e) => e.status)).toEqual([
      "started",
      "blocked",
      "resumed",
      "done",
    ]);
    // Final state check via task status (pure read, no extra event)
    const finalStatus = run(["task", "status", "P1-T1", "--json"]);
    const finalParsed = JSON.parse(finalStatus.stdout) as {
      data: { current: string };
    };
    expect(finalParsed.data.current).toBe("done");
  });

  it("task block without --reason: exit 2 / CONFIG_ERROR", async () => {
    await setupWithTask();
    const res = run(["task", "block", "P1-T1", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("task start twice: returns already_started with byte-identical progress.yaml", async () => {
    await setupWithTask();

    const first = run(["task", "start", "P1-T1", "--json"]);
    expect(first.code).toBe(0);
    const before = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    const second = run(["task", "start", "P1-T1", "--json"]);
    expect(second.code).toBe(0);
    const secondParsed = JSON.parse(second.stdout) as {
      ok: boolean;
      data: { already_started: boolean };
    };
    expect(secondParsed.data.already_started).toBe(true);

    const after = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("blocked → complete: INVALID_TASK_TRANSITION with byte-identical progress.yaml", async () => {
    await setupWithTask();
    run(["task", "start", "P1-T1", "--json"]);
    run([
      "task",
      "block",
      "P1-T1",
      "--reason",
      "still blocked",
      "--json",
    ]);
    const before = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.error.code).toBe("INVALID_TASK_TRANSITION");

    const after = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("task status is agent-neutral (rejects --agent as unknown option)", async () => {
    await setupWithTask();
    const res = run([
      "task",
      "status",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    // strictParse rejects unknown options with CONFIG_ERROR exit 2.
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });
});

// ---------------------------------------------------------------------------
// v0.2: phase import
// ---------------------------------------------------------------------------

describe("CLI: phase import (v0.2)", () => {
  async function setupEmpty(): Promise<void> {
    const res = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(res.code).toBe(0);
  }

  async function writeDraft(name: string, contents: string): Promise<string> {
    const p = join(tmpDir, name);
    await writeFile(p, contents, "utf8");
    return name;
  }

  it("imports phases with tasks; task context resolves them immediately", async () => {
    await setupEmpty();
    const draftPath = await writeDraft(
      "draft.yaml",
      `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish foundation
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: medium
        verification_strength: strong
        expected_duration: short
        status: planned
        description: smoke import
  - id: P2
    name: Core
    weight: 18
    objective: Implement CLI commands
`,
    );

    const importRes = run(["phase", "import", draftPath, "--json"]);
    expect(importRes.code).toBe(0);
    const importParsed = JSON.parse(importRes.stdout) as {
      ok: boolean;
      data: {
        imported_phases: { id: string }[];
        imported_tasks: string[];
        skipped_phases: string[];
      };
    };
    expect(importParsed.ok).toBe(true);
    expect(importParsed.data.imported_phases.map((p) => p.id)).toEqual([
      "P1",
      "P2",
    ]);
    expect(importParsed.data.imported_tasks).toEqual(["P1-T1"]);
    expect(importParsed.data.skipped_phases).toEqual([]);

    // task context must succeed for the just-imported task — this is the
    // core "phase import closes the dogfood loop" guarantee.
    const ctxRes = run(["task", "context", "P1-T1", "--agent", "claude-code", "--json"]);
    expect(ctxRes.code).toBe(0);
    const ctxParsed = JSON.parse(ctxRes.stdout) as {
      ok: boolean;
      data: { task_id: string; phase_id: string };
    };
    expect(ctxParsed.ok).toBe(true);
    expect(ctxParsed.data.task_id).toBe("P1-T1");
    expect(ctxParsed.data.phase_id).toBe("P1");
  });

  it("duplicate phase id without --force fails with DUPLICATE_PHASE_ID, no writes", async () => {
    await setupEmpty();
    // Seed one phase via `phase add`, then try to import a draft that
    // collides on phase id.
    expect(
      run([
        "phase",
        "add",
        "--id",
        "P1",
        "--name",
        "Existing",
        "--objective",
        "existing",
        "--weight",
        "5",
        "--json",
      ]).code,
    ).toBe(0);

    const beforeRoadmap = await readFile(
      join(tmpDir, "design", "roadmap.yaml"),
      "utf8",
    );

    const draftPath = await writeDraft(
      "draft.yaml",
      `phases:
  - id: P1
    name: New
    weight: 10
    objective: collide
  - id: P2
    name: Brand new
    weight: 5
    objective: should not land either
`,
    );

    const res = run(["phase", "import", draftPath, "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("DUPLICATE_PHASE_ID");

    const after = await readFile(
      join(tmpDir, "design", "roadmap.yaml"),
      "utf8",
    );
    expect(after).toBe(beforeRoadmap);
  });

  it("malformed YAML fails with CONFIG_ERROR and JSON-only stdout", async () => {
    await setupEmpty();
    const draftPath = await writeDraft(
      "broken.yaml",
      `phases:
  - id: P1
    name: Foundation
    weight: not-a-number
    objective: malformed
`,
    );

    const res = run(["phase", "import", draftPath, "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("missing positional input path is a CONFIG_ERROR", async () => {
    await setupEmpty();
    const res = run(["phase", "import", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("--bogus is strictly rejected via strictParse", async () => {
    await setupEmpty();
    const res = run(["phase", "import", "draft.yaml", "--bogus", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });
});

// ---------------------------------------------------------------------------
// v1.22+: --scaffold-decisions (RFC §3-D)
// ---------------------------------------------------------------------------

describe("CLI: --scaffold-decisions (RFC §3-D)", () => {
  const DRAFT = `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish foundation
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
        description: needs a decision
        requires_decision: true
`;

  async function initEmpty(): Promise<void> {
    const res = run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    expect(res.code).toBe(0);
  }

  it("phase import --scaffold-decisions creates a proposed stub; record-done is then blocked; without the flag nothing is scaffolded", async () => {
    await initEmpty();
    await writeFile(join(tmpDir, "draft.yaml"), DRAFT, "utf8");

    // Without the flag: no scaffolding.
    const noFlag = run(["phase", "import", "draft.yaml", "--json"]);
    expect(noFlag.code).toBe(0);
    const noFlagData = JSON.parse(noFlag.stdout) as {
      data: { scaffolded_decisions: string[]; scaffold_skipped: unknown[] };
    };
    expect(noFlagData.data.scaffolded_decisions).toEqual([]);
    expect(noFlagData.data.scaffold_skipped).toEqual([]);

    // record-done is blocked (no accepted ADR).
    const blocked = run(["task", "record-done", "P1-T1", "--evidence", "PR #1", "--json"]);
    expect(blocked.code).toBe(2);
    expect((JSON.parse(blocked.stdout) as { error: { code: string } }).error.code).toBe(
      "DECISION_REQUIRED",
    );

    // With the flag, on a fresh project: stub scaffolded.
    tmpDir = await mkdtemp(join(tmpdir(), "code-pact-cli-test-"));
    await initEmpty();
    await writeFile(join(tmpDir, "draft.yaml"), DRAFT, "utf8");
    const withFlag = run(["phase", "import", "draft.yaml", "--scaffold-decisions", "--json"]);
    expect(withFlag.code).toBe(0);
    const withFlagData = JSON.parse(withFlag.stdout) as {
      data: { scaffolded_decisions: string[] };
    };
    expect(withFlagData.data.scaffolded_decisions).toEqual(["design/decisions/P1-T1.md"]);
    const stub = await readFile(join(tmpDir, "design", "decisions", "P1-T1.md"), "utf8");
    expect(stub).toContain("**Status:** proposed");

    // The proposed stub still blocks record-done (status-aware gate).
    const stillBlocked = run(["task", "record-done", "P1-T1", "--evidence", "PR #1", "--json"]);
    expect(stillBlocked.code).toBe(2);
    expect((JSON.parse(stillBlocked.stdout) as { error: { code: string } }).error.code).toBe(
      "DECISION_REQUIRED",
    );
  });

  it("plan adopt --write --scaffold-decisions scaffolds for a requires_decision task", async () => {
    await initEmpty();
    await writeFile(join(tmpDir, "plan.yaml"), DRAFT, "utf8");
    const res = run(["plan", "adopt", "plan.yaml", "--write", "--scaffold-decisions", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { import_result: { scaffolded_decisions: string[] } | null };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.import_result?.scaffolded_decisions).toEqual([
      "design/decisions/P1-T1.md",
    ]);
  });
});

// ---------------------------------------------------------------------------
// v0.2: cursor adapter (experimental)
// ---------------------------------------------------------------------------

describe("CLI: adapter --agent cursor (v0.2 experimental)", () => {
  it("init --agent cursor + adapter --agent cursor writes .cursor/rules/code-pact.mdc", async () => {
    const initRes = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "cursor",
      "--json",
    ]);
    expect(initRes.code).toBe(0);

    const adapterRes = run(["adapter", "install", "cursor", "--json"]);
    expect(adapterRes.code).toBe(0);
    const parsed = JSON.parse(adapterRes.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    const mdc = await readFile(
      join(tmpDir, ".cursor", "rules", "code-pact.mdc"),
      "utf8",
    );
    // Frontmatter must lead so Cursor recognises it as a rule.
    expect(mdc.startsWith("---\n")).toBe(true);
    expect(mdc).toContain("alwaysApply: true");
    expect(mdc).toContain("code-pact task complete");
    expect(mdc).toMatch(/experimental/i);
  });

  it("init --agent claude-code,cursor — cursor is selectable in a multi-agent setup", async () => {
    const initRes = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code,cursor",
      "--json",
    ]);
    expect(initRes.code).toBe(0);

    const projectYaml = await readFile(
      join(tmpDir, ".code-pact", "project.yaml"),
      "utf8",
    );
    const project = parseYaml(projectYaml) as {
      default_agent: string;
      agents: { name: string }[];
    };
    expect(project.default_agent).toBe("claude-code");
    expect(project.agents.map((a) => a.name).sort()).toEqual([
      "claude-code",
      "cursor",
    ]);
  });
});

// ---------------------------------------------------------------------------
// v0.2: gemini-cli adapter (experimental)
// ---------------------------------------------------------------------------

describe("CLI: adapter --agent gemini-cli (v0.2 experimental)", () => {
  it("init --agent gemini-cli + adapter --agent gemini-cli writes GEMINI.md at project root", async () => {
    const initRes = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "gemini-cli",
      "--json",
    ]);
    expect(initRes.code).toBe(0);

    const adapterRes = run(["adapter", "install", "gemini-cli", "--json"]);
    expect(adapterRes.code).toBe(0);
    const parsed = JSON.parse(adapterRes.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    const md = await readFile(join(tmpDir, "GEMINI.md"), "utf8");
    // Plain markdown; no YAML frontmatter for Gemini CLI.
    expect(md.startsWith("---\n")).toBe(false);
    expect(md).toContain("code-pact task complete");
    expect(md).toMatch(/experimental/i);
    expect(md).toContain("github.com/google-gemini/gemini-cli");
  });

  it("init --agent claude-code,gemini-cli — gemini-cli is selectable in a multi-agent setup", async () => {
    const initRes = run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code,gemini-cli",
      "--json",
    ]);
    expect(initRes.code).toBe(0);

    const projectYaml = await readFile(
      join(tmpDir, ".code-pact", "project.yaml"),
      "utf8",
    );
    const project = parseYaml(projectYaml) as {
      default_agent: string;
      agents: { name: string }[];
    };
    expect(project.default_agent).toBe("claude-code");
    expect(project.agents.map((a) => a.name).sort()).toEqual([
      "claude-code",
      "gemini-cli",
    ]);
  });
});

// ---------------------------------------------------------------------------
// v1.0 P8-T1: validate subprocess coverage
// ---------------------------------------------------------------------------
//
// `validate` is the CI-friendly variant of `doctor` (exit 1 on errors, 0 on
// warnings only; --strict promotes warnings to exit 1). It is part of the
// Stable (v1.0) public contract surface, so it needs subprocess-level
// coverage that asserts both the JSON envelope and the human-output paths.

describe("CLI: validate", () => {
  it("validate --json on a clean project returns {ok:true,data} and exit 0", () => {
    run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    const res = run(["validate", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; data: { ok: boolean; issues: unknown[] } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.ok).toBe(true);
    expect(Array.isArray(parsed.data.issues)).toBe(true);
  });

  it("validate (human output) on a clean project prints success and exits 0", () => {
    run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    const res = run(["validate"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Project validation passed.");
  });

  it("validate --strict --json on a project with warnings returns {ok:false,error:VALIDATE_FAILED} and exit 1", () => {
    // A fresh init project enables claude-code without a synced adapter
    // manifest/model_version → ADAPTER_MISSING + ADAPTER_STALE warnings.
    // (BRIEF_MISSING is gated on a real phase, so it does not fire here.)
    // Under --strict, any warning should trip exit 1.
    run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    const res = run(["validate", "--strict", "--json"]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
      data: { ok: boolean; issues: { severity: string }[] };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("VALIDATE_FAILED");
    expect(parsed.data.issues.length).toBeGreaterThan(0);
  });

  it("validate (non-JSON) on an uninitialized project still emits a single stderr line and exits non-zero", () => {
    // No `init` here — the project has no .code-pact/ at all.
    const res = run(["validate"]);
    expect([1, 2]).toContain(res.code);
    // Should not print success to stdout.
    expect(res.stdout).not.toContain("Project validation passed.");
  });
});

// ---------------------------------------------------------------------------
// v1.0 P8-T1: task add wizard-only (no-TTY) coverage
// ---------------------------------------------------------------------------
//
// task add is interactive-only (no flag-only path). In a subprocess where
// stdin/stdout are not TTYs, it must surface CONFIG_ERROR rather than
// silently hang. This is the contract for Stable (human-output) wizard
// commands documented in docs/cli-contract.md (v1.0).

describe("CLI: task add (no-TTY)", () => {
  it("task add <phase> --json in a non-TTY subprocess returns {ok:false,error:CONFIG_ERROR} exit 2", () => {
    run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    run([
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--objective",
      "Foundation phase",
      "--weight",
      "10",
      "--verify-command",
      "node --version",
      "--json",
    ]);

    const res = run(["task", "add", "P1", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message.toLowerCase()).toContain("tty");
  });

  it("task add without a phase id returns {ok:false,error:CONFIG_ERROR} exit 2", () => {
    run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    const res = run(["task", "add", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });
});
