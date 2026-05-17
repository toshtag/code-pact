// CLI integration suite — spawns the built CLI (`dist/cli.js`) via
// `spawnSync`. dist is rebuilt on every run so a stale build cannot mask
// real failures (this was the root cause of the BUG-001 RC dogfood
// failure on v0.1).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const cliPath = join(repoRoot, "dist", "cli.js");

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
  // Always rebuild — stale dist would mask real CLI regressions.
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
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("VERIFICATION_FAILED");

    const after = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
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
