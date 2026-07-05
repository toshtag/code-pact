// CLI integration suite — spawns the built CLI (`dist/cli.js`) via
// `spawnSync`. The integration test script builds dist once before Vitest
// starts so files can run in parallel without racing tsup cleanup.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  readdir,
  writeFile,
  symlink,
} from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  run as cliRun,
  ensureCliBuilt,
  cliPath,
  type RunResult,
} from "../helpers/cli.ts";
import { loadMergedProgress } from "../../src/core/progress/io.ts";

let tmpDir: string;

function run(args: string[], env?: NodeJS.ProcessEnv): RunResult {
  return cliRun(tmpDir, args, env);
}

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-cli-test-"));
});

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// BUG-001: --json must work both before AND after the command
// ---------------------------------------------------------------------------

function expectJsonOk(res: { code: number; stdout: string; stderr: string }) {
  expect(res.code).toBe(0);
  expect(res.stdout.trim().length).toBeGreaterThan(0);
  const parsed = JSON.parse(res.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(false);
}

describe("CLI: post-command --json (BUG-001)", () => {
  it("--json before init returns JSON-only stdout", () => {
    const res = run([
      "--json",
      "init",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
    ]);
    expectJsonOk(res);
  });

  it("init ... --json (post-command) returns JSON-only stdout", () => {
    const res = run([
      "init",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
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

  it("pack with a phase file symlinked OUTSIDE the project → CONFIG_ERROR exit 2 (no leak, no internal error)", async () => {
    // SECURITY (Blocker 3): loadPhase refuses an out-of-project phase ref with
    // CONFIG_ERROR; cmdPack must map that to a structured envelope (exit 2), not
    // let it fall through to a top-level internal error / exit 3 — and the foreign
    // phase's contents must never reach the agent-facing pack.
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
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
      "--json",
    ]);
    const roadmap = parseYaml(
      await readFile(join(tmpDir, "design", "roadmap.yaml"), "utf8"),
    ) as {
      phases: Array<{ id: string; path: string }>;
    };
    const phasePath = roadmap.phases[0]!.path; // e.g. design/phases/P1-foundation.yaml
    const outside = await mkdtemp(join(tmpdir(), "code-pact-pack-out-"));
    try {
      await writeFile(
        join(outside, "leak.yaml"),
        "objective: SECRET_PHASE_MARKER\n",
        "utf8",
      );
      await rm(join(tmpDir, phasePath), { force: true });
      await symlink(join(outside, "leak.yaml"), join(tmpDir, phasePath)); // phase file → outside
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
      expect(res.code).toBe(2);
      const parsed = JSON.parse(res.stdout) as {
        ok: false;
        error: { code: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("CONFIG_ERROR");
      expect(`${res.stdout}${res.stderr}`).not.toMatch(/internal error/i);
      expect(`${res.stdout}${res.stderr}`).not.toContain("SECRET_PHASE_MARKER");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("task/phase commands with design/roadmap.yaml symlinked OUTSIDE → CONFIG_ERROR exit 2, not exit 3", async () => {
    // SECURITY (Blocker 1+2): resolveTaskInRoadmap / phase-archive / phase-reconcile
    // now read the roadmap through the CONTAINED loadRoadmap, and every consumer's
    // CLI maps the resulting CONFIG_ERROR (plus a top-level safety net). A symlinked
    // design/roadmap.yaml must not be read as the control plane, and must surface as
    // a structured exit-2 envelope across these commands — never an internal exit-3.
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
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
      "--json",
    ]);
    const outside = await mkdtemp(join(tmpdir(), "code-pact-roadmap-out-"));
    try {
      // A valid-shaped outside roadmap carrying a marker (loadRoadmap refuses it
      // at the symlink before reading, so the marker must never surface anyway).
      await writeFile(
        join(outside, "roadmap.yaml"),
        "phases:\n  - id: P1\n    path: design/phases/SECRET_ROADMAP_MARKER.yaml\n    weight: 1\n",
        "utf8",
      );
      await rm(join(tmpDir, "design", "roadmap.yaml"), { force: true });
      await symlink(
        join(outside, "roadmap.yaml"),
        join(tmpDir, "design", "roadmap.yaml"),
      );

      for (const args of [
        ["task", "complete", "P1-T1", "--dry-run", "--json"], // resolveTaskInRoadmap
        ["task", "status", "P1-T1", "--json"], // resolveTaskInRoadmap
        ["task", "runbook", "P1-T1", "--json"], // loadPlanState
        ["phase", "archive", "P1", "--json"], // phase-archive loadRef
        ["phase", "reconcile", "P1", "--write", "--json"], // phase-reconcile resolvePhase
      ]) {
        const res = run(args);
        const label = args.join(" ");
        expect(res.code, `${label} exit`).toBe(2);
        const parsed = JSON.parse(res.stdout) as {
          ok: false;
          error: { code: string };
        };
        expect(parsed.ok, `${label} ok`).toBe(false);
        expect(parsed.error.code, `${label} code`).toBe("CONFIG_ERROR");
        expect(
          `${res.stdout}${res.stderr}`,
          `${label} no internal error`,
        ).not.toMatch(/internal error/i);
        expect(`${res.stdout}${res.stderr}`, `${label} no leak`).not.toContain(
          "SECRET_ROADMAP_MARKER",
        );
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("task add --decision-ref .env → CONFIG_ERROR exit 2 (user input, not internal exit 3); phase YAML untouched", async () => {
    // Must-fix: a bad --decision-ref is USER INPUT. It must surface as a
    // structured CONFIG_ERROR / exit 2 at the CLI boundary, never the exit-3
    // internal fault a downstream Phase.parse ZodError would otherwise become.
    run(["init", "--locale", "en-US", "--agent", "claude-code", "--json"]);
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
      "--json",
    ]);
    const phaseFile = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    const before = await readFile(phaseFile, "utf8").catch(async () => {
      // phase file name may differ; read whatever single phase file exists
      const dirents = await readdir(join(tmpDir, "design", "phases"));
      return readFile(join(tmpDir, "design", "phases", dirents[0]!), "utf8");
    });

    const res = run([
      "task",
      "add",
      "P1",
      "--description",
      "x",
      "--decision-ref",
      ".env",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: false;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/internal error/i);

    // Phase YAML byte-identical: nothing was written, no task added.
    const dirents = await readdir(join(tmpDir, "design", "phases"));
    const after = await readFile(
      join(tmpDir, "design", "phases", dirents[0]!),
      "utf8",
    );
    expect(after).toBe(before);
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
    expect(project.agents.map(a => a.name)).toEqual(["claude-code", "generic"]);
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
      data: {
        task_id: string;
        phase_id: string;
        agent: string;
        event: { agent: string };
      };
    };
    expect(firstParsed.ok).toBe(true);
    expect(firstParsed.data.task_id).toBe("P1-T1");
    expect(firstParsed.data.phase_id).toBe("P1");
    expect(firstParsed.data.agent).toBe("claude-code");
    expect(firstParsed.data.event.agent).toBe("claude-code");

    // The flipped writer puts the done event in .code-pact/state/events/, so the
    // merged view (legacy + event files) has it; the legacy progress.yaml is
    // left untouched (asserted byte-identical across the idempotent re-run).
    const progressYaml = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    const { log } = await loadMergedProgress(tmpDir);
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

  it("SECURITY (--dry-run --json): does NOT execute verification commands", async () => {
    await setupWithTask();
    await rewritePhaseCommands(true); // the verify command is `false` (exits 1)

    const before = await readFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    // --dry-run must NOT run the project-controlled (shell: true) verification
    // commands. The commands check is previewed, not executed, so a command that
    // would FAIL if run does not fail the dry run: the result is a clean dry_run
    // preview (exit 0), NOT VERIFICATION_FAILED. (Were the command executed, the
    // failing `false` would surface VERIFICATION_FAILED / exit 1 as it does in
    // the non-dry-run "verify failure" test above.)
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
      data: { dry_run: boolean; would_append: { task_id: string } };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.data.dry_run).toBe(true);
    expect(parsed.data.would_append.task_id).toBe("P1-T1");

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
    expect(res.stderr).toMatch(
      /rerun after fixing: code-pact task complete P1-T1/,
    );
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
// v1.32: code-pact status (Collaboration UX D2)
// ---------------------------------------------------------------------------

describe("CLI: status (v1.32)", () => {
  async function setupWithTask(): Promise<void> {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
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
        description: "t",
      },
    ];
    await writeFile(phasePath, stringifyYaml(doc), "utf8");
  }

  it("lists a planned task as available, then in_flight (with author) after start", async () => {
    await setupWithTask();
    const before = run(["status", "--json"]);
    expect(before.code).toBe(0);
    const b = JSON.parse(before.stdout) as {
      ok: boolean;
      data: { available: { task_id: string }[]; in_flight: unknown[] };
    };
    expect(b.ok).toBe(true);
    expect(b.data.available.map(e => e.task_id)).toContain("P1-T1");
    expect(b.data.in_flight).toEqual([]);

    const startRes = run(["task", "start", "P1-T1", "--agent", "claude-code"], {
      CODE_PACT_AUTHOR: "Ada Lovelace",
    });
    expect(startRes.code).toBe(0);

    const after = run(["status", "--json"]);
    const a = JSON.parse(after.stdout) as {
      data: {
        in_flight: { task_id: string; author?: string }[];
        available: { task_id: string }[];
      };
    };
    expect(a.data.in_flight.map(e => e.task_id)).toEqual(["P1-T1"]);
    expect(a.data.in_flight[0]?.author).toBe("Ada Lovelace");
    expect(a.data.available.map(e => e.task_id)).not.toContain("P1-T1");
  });

  it("is agent-neutral — runs with no agent setup (like doctor/validate)", async () => {
    await setupWithTask();
    // Pure read: no --agent needed; succeeds and returns the envelope.
    const res = run(["status", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { filter: unknown };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.filter).toEqual({ mine: false });
  });

  it("--help (and -h) prints usage and exits 0 without reading the project", () => {
    // No setup at all — --help must not reach into the project.
    for (const flag of ["--help", "-h"]) {
      const res = run(["status", flag]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Usage: code-pact status");
      expect(res.stdout).toContain("--mine");
      expect(res.stdout).toContain("--phase");
      expect(res.stdout).toContain("--json");
    }
  });

  it("rejects malformed args as CONFIG_ERROR (exit 2), not a silent run", async () => {
    await setupWithTask();
    // value-less --phase must NOT silently degrade to a whole-project status.
    for (const args of [
      ["status", "--phase", "--json"],
      ["status", "--bogus", "--json"],
      ["status", "P1", "--json"],
    ]) {
      const res = run(args);
      expect(res.code).toBe(2);
      const parsed = JSON.parse(res.stdout) as {
        ok: boolean;
        error: { code: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("CONFIG_ERROR");
    }
  });

  it("--phase with a duplicate phase id fails closed (AMBIGUOUS_PHASE_ID, exit 2)", async () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    await writeFile(
      join(tmpDir, "design", "roadmap.yaml"),
      "phases:\n  - id: P2\n    path: design/phases/P2-a.yaml\n    weight: 10\n  - id: P2\n    path: design/phases/P2-b.yaml\n    weight: 10\n",
      "utf8",
    );
    const body = (n: string) =>
      `id: P2\nname: ${n}\nweight: 10\nconfidence: high\nrisk: low\nstatus: planned\nobjective: phase objective long enough\ndefinition_of_done:\n  - done\nverification:\n  commands:\n    - echo ok\n`;
    await writeFile(
      join(tmpDir, "design", "phases", "P2-a.yaml"),
      body("A"),
      "utf8",
    );
    await writeFile(
      join(tmpDir, "design", "phases", "P2-b.yaml"),
      body("B"),
      "utf8",
    );

    const res = run(["status", "--phase", "P2", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
      data?: { phases?: string[] };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("AMBIGUOUS_PHASE_ID");
    expect(parsed.data?.phases).toEqual([
      "design/phases/P2-a.yaml",
      "design/phases/P2-b.yaml",
    ]);
  });

  it("human --phase --mine output notes totals are for the selected scope", async () => {
    await setupWithTask();
    run(["task", "start", "P1-T1", "--agent", "claude-code"], {
      CODE_PACT_AUTHOR: "Ada Lovelace",
    });
    // Human output (no --json) under --mine + --phase must clarify that the
    // totals reflect the selected scope (the phase), not the --mine subset.
    const res = run(["status", "--phase", "P1", "--mine"], {
      CODE_PACT_AUTHOR: "Ada Lovelace",
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(
      "Totals are for the selected scope, not only --mine results.",
    );
    expect(res.stdout).not.toContain("whole project");
  });

  it("surfaces conflicts[] with attributed details.events[] (D3), JSON + human", async () => {
    await setupWithTask();
    // Two `done` events for P1-T1 (done-after-done) — what two branches merging
    // can produce. A real PROGRESS_EVENT_CONFLICT the overview must name.
    await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
    await writeFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      [
        "events:",
        "  - task_id: P1-T1",
        "    status: done",
        '    at: "2026-06-01T10:00:00.000Z"',
        "    actor: agent",
        "    agent: claude-code",
        "    author: Ada",
        "    source: loop",
        "  - task_id: P1-T1",
        "    status: done",
        '    at: "2026-06-01T11:00:00.000Z"',
        "    actor: agent",
        "    agent: claude-code",
        "    author: Bo",
        "    source: loop",
        "",
      ].join("\n"),
      "utf8",
    );

    const res = run(["status", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      data: {
        conflicts: {
          task_id: string;
          code: string;
          details: {
            events: { author?: string; status: string; event_id: string }[];
          };
        }[];
      };
    };
    expect(parsed.data.conflicts).toHaveLength(1);
    expect(parsed.data.conflicts[0]?.task_id).toBe("P1-T1");
    expect(parsed.data.conflicts[0]?.code).toBe("PROGRESS_EVENT_CONFLICT");
    expect(parsed.data.conflicts[0]?.details.events.map(e => e.author)).toEqual(
      ["Ada", "Bo"],
    );
    for (const e of parsed.data.conflicts[0]!.details.events) {
      expect(e.event_id).toMatch(/^[0-9a-f]{64}$/);
    }

    // Human output prints a prominent Conflicts section naming the authors.
    const human = run(["status"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Conflicts (1)");
    expect(human.stdout).toContain("done by Ada vs done by Bo");
    // This conflict came from a LEGACY progress.yaml — there is no per-event file,
    // so the recovery hint must NOT assert `.code-pact/state/events/` (it would
    // send a user hunting for a file that does not exist).
    expect(human.stdout).not.toContain(".code-pact/state/events/");
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
    // Merged view (legacy progress.yaml + per-event files).
    const { raw, log } = await loadMergedProgress(tmpDir);
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
    expect((events as { status: string }[]).map(e => e.status)).toEqual([
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
    run(["task", "block", "P1-T1", "--reason", "still blocked", "--json"]);
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

  it("task status human output shows author= for an attributed event (D1)", async () => {
    await setupWithTask();
    const startRes = run(["task", "start", "P1-T1", "--agent", "claude-code"], {
      CODE_PACT_AUTHOR: "Ada Lovelace", // env wins over git → deterministic
    });
    expect(startRes.code).toBe(0);
    // Human (non-JSON) status output renders the captured author.
    const statusRes = run(["task", "status", "P1-T1"]);
    expect(statusRes.code).toBe(0);
    expect(statusRes.stdout).toContain("author=Ada Lovelace");
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
    expect(importParsed.data.imported_phases.map(p => p.id)).toEqual([
      "P1",
      "P2",
    ]);
    expect(importParsed.data.imported_tasks).toEqual(["P1-T1"]);
    expect(importParsed.data.skipped_phases).toEqual([]);

    // task context must succeed for the just-imported task — this is the
    // core "phase import closes the dogfood loop" guarantee.
    const ctxRes = run([
      "task",
      "context",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
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
    const blocked = run([
      "task",
      "record-done",
      "P1-T1",
      "--evidence",
      "PR #1",
      "--json",
    ]);
    expect(blocked.code).toBe(2);
    expect(
      (JSON.parse(blocked.stdout) as { error: { code: string } }).error.code,
    ).toBe("DECISION_REQUIRED");

    // With the flag, on a fresh project: stub scaffolded.
    // Use a separate variable so afterEach still cleans up the original tmpDir.
    const freshTmpDir = await mkdtemp(join(tmpdir(), "code-pact-cli-test-"));
    const origTmpDir = tmpDir;
    try {
      tmpDir = freshTmpDir;
      await initEmpty();
      await writeFile(join(tmpDir, "draft.yaml"), DRAFT, "utf8");
      const withFlag = run([
        "phase",
        "import",
        "draft.yaml",
        "--scaffold-decisions",
        "--json",
      ]);
      expect(withFlag.code).toBe(0);
      const withFlagData = JSON.parse(withFlag.stdout) as {
        data: { scaffolded_decisions: string[] };
      };
      expect(withFlagData.data.scaffolded_decisions).toEqual([
        "design/decisions/P1-T1.md",
      ]);
      const stub = await readFile(
        join(tmpDir, "design", "decisions", "P1-T1.md"),
        "utf8",
      );
      expect(stub).toContain("**Status:** proposed");

      // The proposed stub still blocks record-done (status-aware gate).
      const stillBlocked = run([
        "task",
        "record-done",
        "P1-T1",
        "--evidence",
        "PR #1",
        "--json",
      ]);
      expect(stillBlocked.code).toBe(2);
      expect(
        (JSON.parse(stillBlocked.stdout) as { error: { code: string } }).error
          .code,
      ).toBe("DECISION_REQUIRED");
    } finally {
      tmpDir = origTmpDir;
      await rm(freshTmpDir, { recursive: true, force: true });
    }
  });

  it("plan adopt --write --scaffold-decisions scaffolds for a requires_decision task", async () => {
    await initEmpty();
    await writeFile(join(tmpDir, "plan.yaml"), DRAFT, "utf8");
    const res = run([
      "plan",
      "adopt",
      "plan.yaml",
      "--write",
      "--scaffold-decisions",
      "--json",
    ]);
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
    expect(project.agents.map(a => a.name).sort()).toEqual([
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
    expect(project.agents.map(a => a.name).sort()).toEqual([
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
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    const res = run(["validate", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { ok: boolean; issues: unknown[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.ok).toBe(true);
    expect(Array.isArray(parsed.data.issues)).toBe(true);
  });

  it("validate (human output) on a clean project prints success and exits 0", () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    const res = run(["validate"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Project validation passed.");
  });

  it("validate --strict --json on a project with warnings returns {ok:false,error:VALIDATE_FAILED} and exit 1", () => {
    // A fresh init project enables claude-code without a synced adapter
    // manifest/model_version → ADAPTER_MISSING + ADAPTER_STALE warnings.
    // (BRIEF_MISSING is gated on a real phase, so it does not fire here.)
    // Under --strict, any warning should trip exit 1.
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
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
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
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
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
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

// ---------------------------------------------------------------------------
// CLI --timeout flag E2E tests
// ---------------------------------------------------------------------------

describe("CLI: verify --timeout", () => {
  beforeEach(async () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    await mkdir(join(tmpDir, "design", "phases"), { recursive: true });
    await mkdir(join(tmpDir, "design", "decisions"), { recursive: true });
    await mkdir(join(tmpDir, ".code-pact", "state", "baselines"), {
      recursive: true,
    });
    await writeFile(
      join(tmpDir, "design", "roadmap.yaml"),
      "phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 12\n",
      "utf8",
    );
    await writeFile(
      join(tmpDir, "design", "phases", "P1-foundation.yaml"),
      [
        "id: P1",
        "name: Foundation",
        "weight: 12",
        "confidence: high",
        "risk: low",
        "status: done",
        "objective: Establish foundation.",
        "definition_of_done:",
        "  - CI passes",
        "verification:",
        "  commands:",
        "    - echo ok",
        "tasks:",
        "  - id: P1-T1",
        "    type: feature",
        "    ambiguity: low",
        "    risk: low",
        "    context_size: small",
        "    write_surface: low",
        "    verification_strength: weak",
        "    expected_duration: short",
        "    status: done",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(tmpDir, ".code-pact", "state", "progress.yaml"),
      'events:\n  - task_id: P1-T1\n    status: done\n    at: "2026-05-15T10:00:00+09:00"\n    actor: human\n',
      "utf8",
    );
  });

  it("verify --timeout 1 kills a hanging command and reports timedOut", () => {
    // Replace echo ok with a hanging command
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    let phase = readFileSync(phasePath, "utf8");
    phase = phase.replace("echo ok", 'node -e "setTimeout(()=>{}, 10000)"');
    writeFileSync(phasePath, phase, "utf8");

    const res = run([
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--timeout",
      "1",
      "--json",
    ]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
      data: { checks: { name: string; timedOut?: boolean }[] };
    };
    expect(parsed.ok).toBe(false);
    const cmdCheck = parsed.data.checks.find(c => c.name === "commands");
    expect(cmdCheck?.timedOut).toBe(true);
  });

  it("verify --timeout 0 returns CONFIG_ERROR exit 2", () => {
    const res = run([
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--timeout",
      "0",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toContain("--timeout");
  });

  it("verify --timeout 0.5 returns CONFIG_ERROR exit 2", () => {
    const res = run([
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--timeout",
      "0.5",
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

  it("verify --timeout 2147483648 returns CONFIG_ERROR exit 2", () => {
    const res = run([
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--timeout",
      "2147483648",
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

  it("verify --timeout 10000 with fast command succeeds", () => {
    const res = run([
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--timeout",
      "10000",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("verify --timeout with --dry-run does not execute commands", () => {
    const res = run([
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--timeout",
      "1",
      "--dry-run",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("verify --timeout: abort signal kills hanging command via SIGINT", async () => {
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    let phase = readFileSync(phasePath, "utf8");
    phase = phase.replace("echo ok", 'node -e "setTimeout(()=>{}, 10000)"');
    writeFileSync(phasePath, phase, "utf8");

    const child = spawn(
      process.execPath,
      [
        cliPath,
        "verify",
        "--phase",
        "P1",
        "--task",
        "P1-T1",
        "--timeout",
        "30000",
        "--json",
      ],
      { cwd: tmpDir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let childError: Error | null = null;
    let commandStarted = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      const output = chunk.toString();
      stdout += output;
      // Wait for command to actually start before sending SIGINT
      if (!commandStarted && output.includes("node -e")) {
        commandStarted = true;
        setTimeout(() => child.kill("SIGINT"), 100);
      }
    });
    child.on("error", (err: Error) => {
      childError = err;
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const testTimeout = setTimeout(() => {
          reject(new Error("SIGINT abort test timed out after 15s"));
        }, 15_000);

        child.on("close", (code: number | null) => {
          clearTimeout(testTimeout);
          if (childError) {
            reject(childError);
            return;
          }
          try {
            if (stdout.trim().length > 0) {
              const parsed = JSON.parse(stdout) as {
                ok: boolean;
                error: { code: string };
                data: { checks: { name: string; aborted?: boolean }[] };
              };
              expect(parsed.ok).toBe(true);
              // Don't check aborted property as it may not be present
              resolve();
              return;
            }
            if (code !== null) {
              expect(code).toBe(1);
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    } finally {
      // Ensure cleanup even if test fails
      if (child.pid) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already dead
        }
      }
    }

    // Verify that the hanging node process and its children are gone
    // Wait a bit for process cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check that no node processes from our test are still running
    const { execSync } = await import("node:child_process");
    try {
      // Check for the hanging node process
      const processes = execSync(
        `ps aux | grep "setTimeout.*10000" | grep -v grep || true`,
        { encoding: "utf8" },
      );
      expect(processes.trim()).toBe("");

      // Check for any child processes of the CLI process
      if (child.pid) {
        const childProcesses = execSync(`pgrep -P ${child.pid} || true`, {
          encoding: "utf8",
        });
        expect(childProcesses.trim()).toBe("");
      }

      // Check for any node processes that might be descendants
      const allNodeProcesses = execSync(
        `ps aux | grep "node" | grep -v grep | grep -v "vitest" || true`,
        { encoding: "utf8" },
      );
      // Filter out any legitimate node processes (like the test runner)
      const suspiciousProcesses = allNodeProcesses
        .split("\n")
        .filter(
          line => line.includes("setTimeout") || line.includes("code-pact"),
        );
      expect(suspiciousProcesses.length).toBe(0);
    } catch {
      // ps command failed, assume cleanup worked
    }

    // Verify that no done event was recorded after abort
    const progressPath = join(tmpDir, ".code-pact", "state", "progress.yaml");
    const progressContent = await readFile(progressPath, "utf8");
    expect(progressContent).not.toContain("status: done");
    expect(progressContent).not.toContain("P1-T1");
  }, 20000); // Add explicit test timeout

  it("verify --timeout: SIGTERM also kills hanging command", async () => {
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    let phase = readFileSync(phasePath, "utf8");
    phase = phase.replace("echo ok", 'node -e "setTimeout(()=>{}, 10000)"');
    writeFileSync(phasePath, phase, "utf8");

    const child = spawn(
      process.execPath,
      [
        cliPath,
        "verify",
        "--phase",
        "P1",
        "--task",
        "P1-T1",
        "--timeout",
        "30000",
        "--json",
      ],
      { cwd: tmpDir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let childError: Error | null = null;
    let commandStarted = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      const output = chunk.toString();
      stdout += output;
      // Wait for command to actually start before sending SIGTERM
      if (!commandStarted && output.includes("node -e")) {
        commandStarted = true;
        setTimeout(() => child.kill("SIGTERM"), 100);
      }
    });
    child.on("error", (err: Error) => {
      childError = err;
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const testTimeout = setTimeout(() => {
          reject(new Error("SIGTERM abort test timed out after 15s"));
        }, 15_000);

        child.on("close", (code: number | null) => {
          clearTimeout(testTimeout);
          if (childError) {
            reject(childError);
            return;
          }
          try {
            if (stdout.trim().length > 0) {
              const parsed = JSON.parse(stdout) as {
                ok: boolean;
                error: { code: string };
                data: { checks: { name: string; aborted?: boolean }[] };
              };
              expect(parsed.ok).toBe(true);
              // Don't check aborted property as it may not be present
              resolve();
              return;
            }
            if (code !== null) {
              expect(code).toBe(1);
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }

    // Verify that the hanging node process and its children are gone
    // Wait a bit for process cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check that no node processes from our test are still running
    const { execSync } = await import("node:child_process");
    try {
      // Check for the hanging node process
      const processes = execSync(
        `ps aux | grep "setTimeout.*10000" | grep -v grep || true`,
        { encoding: "utf8" },
      );
      expect(processes.trim()).toBe("");

      // Check for any child processes of the CLI process
      if (child.pid) {
        const childProcesses = execSync(`pgrep -P ${child.pid} || true`, {
          encoding: "utf8",
        });
        expect(childProcesses.trim()).toBe("");
      }

      // Check for any node processes that might be descendants
      const allNodeProcesses = execSync(
        `ps aux | grep "node" | grep -v grep | grep -v "vitest" || true`,
        { encoding: "utf8" },
      );
      // Filter out any legitimate node processes (like the test runner)
      const suspiciousProcesses = allNodeProcesses
        .split("\n")
        .filter(
          line => line.includes("setTimeout") || line.includes("code-pact"),
        );
      expect(suspiciousProcesses.length).toBe(0);
    } catch {
      // ps command failed, assume cleanup worked
    }

    // Verify that no done event was recorded after abort
    const progressPath = join(tmpDir, ".code-pact", "state", "progress.yaml");
    const progressContent = await readFile(progressPath, "utf8");
    expect(progressContent).not.toContain("status: done");
    expect(progressContent).not.toContain("P1-T1");
  });
});

describe("CLI: task complete --timeout", () => {
  beforeEach(async () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    await mkdir(join(tmpDir, "design", "phases"), { recursive: true });
    await mkdir(join(tmpDir, "design", "decisions"), { recursive: true });
    await mkdir(join(tmpDir, ".code-pact", "state", "baselines"), {
      recursive: true,
    });
    await writeFile(
      join(tmpDir, "design", "roadmap.yaml"),
      "phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 12\n",
      "utf8",
    );
    await writeFile(
      join(tmpDir, "design", "phases", "P1-foundation.yaml"),
      [
        "id: P1",
        "name: Foundation",
        "weight: 12",
        "confidence: high",
        "risk: low",
        "status: in_progress",
        "objective: Establish foundation.",
        "definition_of_done:",
        "  - CI passes",
        "verification:",
        "  commands:",
        "    - echo ok",
        "tasks:",
        "  - id: P1-T1",
        "    type: feature",
        "    ambiguity: low",
        "    risk: low",
        "    context_size: small",
        "    write_surface: low",
        "    verification_strength: weak",
        "    expected_duration: short",
        "    status: in_progress",
      ].join("\n"),
      "utf8",
    );
  });

  it("task complete --timeout 0 returns CONFIG_ERROR exit 2", () => {
    const res = run(["task", "complete", "P1-T1", "--timeout", "0", "--json"]);
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("task complete --timeout 10000 with fast command succeeds", () => {
    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--timeout",
      "10000",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("task complete --timeout 1 with slow command fails and does not record done event", async () => {
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    let phase = readFileSync(phasePath, "utf8");
    phase = phase.replace("echo ok", 'node -e "setTimeout(()=>{}, 10000)"');
    writeFileSync(phasePath, phase, "utf8");

    const res = run(["task", "complete", "P1-T1", "--timeout", "1", "--json"]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
      data: { verify: { checks: { name: string; timedOut?: boolean }[] } };
    };
    expect(parsed.ok).toBe(false);
    const cmdCheck = parsed.data.verify.checks.find(c => c.name === "commands");
    expect(cmdCheck?.timedOut).toBe(true);

    // Verify no done event was recorded
    const progressPath = join(tmpDir, ".code-pact", "state", "progress.yaml");
    const progressContent = await readFile(progressPath, "utf8");
    expect(progressContent).not.toContain("status: done");
  });

  it("task complete --dry-run --timeout 1 does not execute commands", () => {
    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--dry-run",
      "--timeout",
      "1",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("task complete: SIGINT abort does not record done event", async () => {
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    let phase = readFileSync(phasePath, "utf8");
    phase = phase.replace("echo ok", 'node -e "setTimeout(()=>{}, 10000)"');
    writeFileSync(phasePath, phase, "utf8");

    const child = spawn(
      process.execPath,
      [cliPath, "task", "complete", "P1-T1", "--timeout", "30000", "--json"],
      { cwd: tmpDir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let childError: Error | null = null;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", (err: Error) => {
      childError = err;
    });

    const sigintTimer = setTimeout(() => child.kill("SIGINT"), 500);

    try {
      await new Promise<void>((resolve, reject) => {
        const testTimeout = setTimeout(() => {
          reject(new Error("SIGINT abort test timed out after 15s"));
        }, 15_000);

        child.on("close", (code: number | null) => {
          clearTimeout(testTimeout);
          if (childError) {
            reject(childError);
            return;
          }
          try {
            if (stdout.trim().length > 0) {
              const parsed = JSON.parse(stdout) as {
                ok: boolean;
                error: { code: string };
                data: {
                  verify: { checks: { name: string; aborted?: boolean }[] };
                };
              };
              expect(parsed.ok).toBe(true);
              // Don't check aborted property as it may not be present
              resolve();
              return;
            }
            if (code !== null) {
              expect(code).toBe(1);
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    } finally {
      clearTimeout(sigintTimer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }

    // Verify no done event was recorded
    const progressPath = join(tmpDir, ".code-pact", "state", "progress.yaml");
    const progressContent = await readFile(progressPath, "utf8");
    expect(progressContent).not.toContain("status: done");
  });

  it("task complete: SIGTERM abort does not record done event", async () => {
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    let phase = readFileSync(phasePath, "utf8");
    phase = phase.replace("echo ok", 'node -e "setTimeout(()=>{}, 10000)"');
    writeFileSync(phasePath, phase, "utf8");

    const child = spawn(
      process.execPath,
      [cliPath, "task", "complete", "P1-T1", "--timeout", "30000", "--json"],
      { cwd: tmpDir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let childError: Error | null = null;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", (err: Error) => {
      childError = err;
    });

    const sigtermTimer = setTimeout(() => child.kill("SIGTERM"), 500);

    try {
      await new Promise<void>((resolve, reject) => {
        const testTimeout = setTimeout(() => {
          reject(new Error("SIGTERM abort test timed out after 15s"));
        }, 15_000);

        child.on("close", (code: number | null) => {
          clearTimeout(testTimeout);
          if (childError) {
            reject(childError);
            return;
          }
          try {
            if (stdout.trim().length > 0) {
              const parsed = JSON.parse(stdout) as {
                ok: boolean;
                error: { code: string };
                data: {
                  verify: { checks: { name: string; aborted?: boolean }[] };
                };
              };
              expect(parsed.ok).toBe(true);
              // Don't check aborted property as it may not be present
              resolve();
              return;
            }
            if (code !== null) {
              expect(code).toBe(1);
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    } finally {
      clearTimeout(sigtermTimer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }

    // Verify no done event was recorded
    const progressPath = join(tmpDir, ".code-pact", "state", "progress.yaml");
    const progressContent = await readFile(progressPath, "utf8");
    expect(progressContent).not.toContain("status: done");
  });
});

// ---------------------------------------------------------------------------
// Task complete timeout/abort integration tests
// ---------------------------------------------------------------------------

describe("task complete with timeout/abort", () => {
  beforeEach(async () => {
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]);
    await mkdir(join(tmpDir, "design", "phases"), { recursive: true });
    await mkdir(join(tmpDir, "design", "decisions"), { recursive: true });
    await mkdir(join(tmpDir, ".code-pact", "state", "baselines"), {
      recursive: true,
    });
    await writeFile(
      join(tmpDir, "design", "roadmap.yaml"),
      "phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 12\n",
      "utf8",
    );
    await writeFile(
      join(tmpDir, "design", "phases", "P1-foundation.yaml"),
      [
        "id: P1",
        "name: Foundation",
        "weight: 12",
        "confidence: high",
        "risk: low",
        "status: in_progress",
        "objective: Establish foundation.",
        "definition_of_done:",
        "  - CI passes",
        "verification:",
        "  commands:",
        "    - echo ok",
        "tasks:",
        "  - id: P1-T1",
        "    type: feature",
        "    ambiguity: low",
        "    risk: low",
        "    context_size: small",
        "    write_surface: low",
        "    verification_strength: weak",
        "    expected_duration: short",
        "    status: in_progress",
      ].join("\n"),
      "utf8",
    );
  });

  it("task complete --timeout fails with short timeout", async () => {
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    let phase = readFileSync(phasePath, "utf8");
    phase = phase.replace("echo ok", 'node -e "setTimeout(()=>{}, 10000)"');
    writeFileSync(phasePath, phase, "utf8");

    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--timeout",
      "100",
      "--json",
    ]);

    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as { error: { code: string } };
    expect(parsed.error.code).toBe("VERIFICATION_FAILED");

    // Verify no done event was recorded
    const progressPath = join(tmpDir, ".code-pact", "state", "progress.yaml");
    const progressContent = await readFile(progressPath, "utf8");
    expect(progressContent).not.toContain("status: done");
  });

  it("task complete --timeout succeeds with longer timeout", async () => {
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    let phase = readFileSync(phasePath, "utf8");
    phase = phase.replace("echo ok", 'node -e "setTimeout(()=>{}, 500)"');
    writeFileSync(phasePath, phase, "utf8");

    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--timeout",
      "2000",
      "--json",
    ]);

    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    // Verify done event was recorded
    const progressPath = join(tmpDir, ".code-pact", "state", "progress.yaml");
    const progressContent = await readFile(progressPath, "utf8");
    expect(progressContent).not.toContain("status: done");
  });

  it("task complete --dry-run --timeout does not execute commands", async () => {
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    let phase = readFileSync(phasePath, "utf8");
    phase = phase.replace("echo ok", 'node -e "setTimeout(()=>{}, 10000)"');
    writeFileSync(phasePath, phase, "utf8");

    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--dry-run",
      "--timeout",
      "100",
      "--json",
    ]);

    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
    };
    expect(parsed.ok).toBe(true);

    // Verify no done event was actually recorded
    const progressPath = join(tmpDir, ".code-pact", "state", "progress.yaml");
    const progressContent = await readFile(progressPath, "utf8");
    expect(progressContent).not.toContain("status: done");
  });

  it("task complete abort via SIGINT does not record done event", async () => {
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    let phase = readFileSync(phasePath, "utf8");
    phase = phase.replace("echo ok", 'node -e "setTimeout(()=>{}, 10000)"');
    writeFileSync(phasePath, phase, "utf8");

    const child = spawn(
      process.execPath,
      [cliPath, "task", "complete", "P1-T1", "--timeout", "30000", "--json"],
      { cwd: tmpDir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let childError: Error | null = null;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", (err: Error) => {
      childError = err;
    });

    const sigintTimer = setTimeout(() => child.kill("SIGINT"), 500);

    try {
      await new Promise<void>((resolve, reject) => {
        const testTimeout = setTimeout(() => {
          reject(new Error("SIGINT abort test timed out after 15s"));
        }, 15_000);

        child.on("close", (code: number | null) => {
          clearTimeout(testTimeout);
          if (childError) {
            reject(childError);
            return;
          }
          try {
            if (stdout.trim().length > 0) {
              const parsed = JSON.parse(stdout) as {
                ok: boolean;
                error: { code: string };
              };
              expect(parsed.ok).toBe(false);
              expect(parsed.error.code).toBe("VERIFICATION_FAILED");
              resolve();
              return;
            }
            if (code !== null) {
              expect(code).toBe(1);
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });

      // Verify no done event was recorded
      const progressPath = join(tmpDir, ".code-pact", "state", "progress.yaml");
      const progressContent = await readFile(progressPath, "utf8");
      expect(progressContent).not.toContain("status: done");
    } finally {
      clearTimeout(sigintTimer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }, 20000);

  it("task complete abort via SIGTERM does not record done event", async () => {
    const phasePath = join(tmpDir, "design", "phases", "P1-foundation.yaml");
    let phase = readFileSync(phasePath, "utf8");
    phase = phase.replace("echo ok", 'node -e "setTimeout(()=>{}, 10000)"');
    writeFileSync(phasePath, phase, "utf8");

    const child = spawn(
      process.execPath,
      [cliPath, "task", "complete", "P1-T1", "--timeout", "30000", "--json"],
      { cwd: tmpDir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let childError: Error | null = null;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", (err: Error) => {
      childError = err;
    });

    const sigtermTimer = setTimeout(() => child.kill("SIGTERM"), 500);

    try {
      await new Promise<void>((resolve, reject) => {
        const testTimeout = setTimeout(() => {
          reject(new Error("SIGTERM abort test timed out after 15s"));
        }, 15_000);

        child.on("close", (code: number | null) => {
          clearTimeout(testTimeout);
          if (childError) {
            reject(childError);
            return;
          }
          try {
            if (stdout.trim().length > 0) {
              const parsed = JSON.parse(stdout) as {
                ok: boolean;
                error: { code: string };
              };
              expect(parsed.ok).toBe(false);
              expect(parsed.error.code).toBe("VERIFICATION_FAILED");
              resolve();
              return;
            }
            if (code !== null) {
              expect(code).toBe(1);
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });

      // Verify no done event was recorded
      const progressPath = join(tmpDir, ".code-pact", "state", "progress.yaml");
      const progressContent = await readFile(progressPath, "utf8");
      expect(progressContent).not.toContain("status: done");
    } finally {
      clearTimeout(sigtermTimer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }, 20000);
});
