// JSON-stdout contract net.
//
// v1.0 P8-T3. For every command classified `Stable (v1.0)` in
// docs/cli-contract.md, when invoked with --json the entire stdout must
// be a single valid JSON document. Non-JSON logs belong on stderr.
//
// This test exists to CATCH ACCIDENTS, not to replace per-command
// integration tests:
//
// - cli.test.ts, adapter-cli.test.ts, plan-*.test.ts, recommend-v2.test.ts,
//   and e2e-workflow.test.ts each exercise specific behaviour and data
//   shape.
// - json-stdout.test.ts only asserts `JSON.parse(stdout)` succeeds. If a
//   contributor sneaks a console.log into a code path under --json, this
//   test fails fast with a useful diagnostic regardless of which command
//   broke.
//
// Each test bootstraps its own minimal project state via the helpers
// below. The shared helper covers init / phase / task / adapter install
// fan-out so individual tests stay readable.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  createTempProject,
  ensureCliBuilt,
  type RunResult,
} from "../helpers/cli.ts";

type Project = Awaited<ReturnType<typeof createTempProject>>;

let cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

async function freshProject(prefix: string): Promise<Project> {
  const p = await createTempProject({ prefix: `code-pact-json-stdout-${prefix}-` });
  cleanups.push(p.cleanup);
  return p;
}

async function projectWithPhase(prefix: string): Promise<Project> {
  const p = await freshProject(prefix);
  const res = p.run([
    "phase",
    "add",
    "--id",
    "P1",
    "--name",
    "Foundation",
    "--objective",
    "Foundation phase for json-stdout test",
    "--weight",
    "10",
    "--verify-command",
    "node --version",
    "--json",
  ]);
  expect(res.code).toBe(0);
  return p;
}

async function projectWithTask(prefix: string): Promise<Project> {
  const p = await projectWithPhase(prefix);
  const phasePath = join(p.dir, "design", "phases", "P1-foundation.yaml");
  const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<string, unknown>;
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
      description: "json-stdout test task",
    },
  ];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");
  return p;
}

async function projectWithAdapter(prefix: string): Promise<Project> {
  const p = await projectWithTask(prefix);
  const res = p.run(["adapter", "install", "claude-code", "--json"]);
  expect(res.code).toBe(0);
  return p;
}

/**
 * The contract assertion. The command's stdout MUST be parseable as a
 * single JSON document with no leading or trailing non-JSON content.
 * Exit code is intentionally NOT asserted here — different commands
 * legitimately exit non-zero under --json (validate --strict, etc.).
 */
function expectStdoutIsJson(res: RunResult, label: string): void {
  if (res.stdout.trim().length === 0) {
    throw new Error(
      `${label}: stdout is empty (exit ${res.code})\nstderr:\n${res.stderr}`,
    );
  }
  try {
    JSON.parse(res.stdout);
  } catch (err) {
    throw new Error(
      `${label}: stdout is not valid JSON: ${(err as Error).message}\n` +
        `stdout (first 500 chars):\n${res.stdout.slice(0, 500)}\n` +
        `stderr:\n${res.stderr}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Read-only Stable (v1.0) commands
// ---------------------------------------------------------------------------

describe("json-stdout contract: read-only Stable (v1.0) commands", () => {
  it("--version --json", async () => {
    const p = await freshProject("version");
    expectStdoutIsJson(p.run(["--version", "--json"]), "--version");
  });

  it("doctor --json", async () => {
    const p = await freshProject("doctor");
    expectStdoutIsJson(p.run(["doctor", "--json"]), "doctor");
  });

  it("validate --json", async () => {
    const p = await freshProject("validate");
    expectStdoutIsJson(p.run(["validate", "--json"]), "validate");
  });

  it("plan lint --json", async () => {
    const p = await freshProject("plan-lint");
    expectStdoutIsJson(p.run(["plan", "lint", "--json"]), "plan lint");
  });

  it("plan normalize --check --json", async () => {
    const p = await freshProject("plan-normalize");
    expectStdoutIsJson(p.run(["plan", "normalize", "--check", "--json"]), "plan normalize");
  });

  it("plan analyze --json", async () => {
    const p = await freshProject("plan-analyze");
    expectStdoutIsJson(p.run(["plan", "analyze", "--json"]), "plan analyze");
  });

  it("plan prompt --json", async () => {
    const p = await freshProject("plan-prompt");
    expectStdoutIsJson(p.run(["plan", "prompt", "--json"]), "plan prompt");
  });

  it("phase ls --json (uninitialized phases)", async () => {
    const p = await freshProject("phase-ls");
    expectStdoutIsJson(p.run(["phase", "ls", "--json"]), "phase ls");
  });

  it("phase ls --json (with phases)", async () => {
    const p = await projectWithPhase("phase-ls2");
    expectStdoutIsJson(p.run(["phase", "ls", "--json"]), "phase ls");
  });

  it("phase show P1 --json", async () => {
    const p = await projectWithPhase("phase-show");
    expectStdoutIsJson(p.run(["phase", "show", "P1", "--json"]), "phase show");
  });

  it("recommend --phase P1 --task P1-T1 --json", async () => {
    const p = await projectWithTask("recommend");
    expectStdoutIsJson(
      p.run(["recommend", "--phase", "P1", "--task", "P1-T1", "--json"]),
      "recommend",
    );
  });

  it("task context P1-T1 --json", async () => {
    const p = await projectWithTask("task-context");
    expectStdoutIsJson(
      p.run(["task", "context", "P1-T1", "--agent", "claude-code", "--json"]),
      "task context",
    );
  });

  it("task status P1-T1 --json", async () => {
    const p = await projectWithTask("task-status");
    expectStdoutIsJson(p.run(["task", "status", "P1-T1", "--json"]), "task status");
  });

  it("pack --phase P1 --task P1-T1 --agent claude-code --json", async () => {
    const p = await projectWithTask("pack");
    expectStdoutIsJson(
      p.run(["pack", "--phase", "P1", "--task", "P1-T1", "--agent", "claude-code", "--json"]),
      "pack",
    );
  });

  it("verify --phase P1 --task P1-T1 --json", async () => {
    const p = await projectWithTask("verify");
    expectStdoutIsJson(
      p.run(["verify", "--phase", "P1", "--task", "P1-T1", "--json"]),
      "verify",
    );
  });

  it("adapter list --json (no manifest)", async () => {
    const p = await freshProject("adapter-list");
    expectStdoutIsJson(p.run(["adapter", "list", "--json"]), "adapter list");
  });

  it("adapter list --json (with manifest)", async () => {
    const p = await projectWithAdapter("adapter-list2");
    expectStdoutIsJson(p.run(["adapter", "list", "--json"]), "adapter list");
  });

  it("adapter doctor --json (with manifest)", async () => {
    const p = await projectWithAdapter("adapter-doctor");
    expectStdoutIsJson(p.run(["adapter", "doctor", "--json"]), "adapter doctor");
  });

  it("adapter upgrade <agent> --check --json (with manifest)", async () => {
    const p = await projectWithAdapter("adapter-upgrade");
    expectStdoutIsJson(
      p.run(["adapter", "upgrade", "claude-code", "--check", "--json"]),
      "adapter upgrade --check",
    );
  });
});

// ---------------------------------------------------------------------------
// State-mutating Stable (v1.0) commands
// ---------------------------------------------------------------------------

describe("json-stdout contract: state-mutating Stable (v1.0) commands", () => {
  it("init --non-interactive --json", async () => {
    // freshProject already does init --json — re-running in a sub-dir
    // covers the case where init is the first command (cold-start).
    const p = await createTempProject({
      init: false,
      prefix: "code-pact-json-stdout-init-",
    });
    cleanups.push(p.cleanup);
    expectStdoutIsJson(
      p.run([
        "init",
        "--non-interactive",
        "--agent",
        "claude-code",
        "--locale",
        "en-US",
        "--json",
      ]),
      "init",
    );
  });

  it("init --non-interactive --sample-phase --json (P13 tutorial bootstrap)", async () => {
    const p = await createTempProject({
      init: false,
      prefix: "code-pact-json-stdout-init-sample-",
    });
    cleanups.push(p.cleanup);
    expectStdoutIsJson(
      p.run([
        "init",
        "--non-interactive",
        "--agent",
        "claude-code",
        "--locale",
        "en-US",
        "--sample-phase",
        "--json",
      ]),
      "init --sample-phase",
    );
  });

  it("task add <phase> --description --type --json (P13 non-interactive)", async () => {
    const p = await createTempProject({
      init: false,
      prefix: "code-pact-json-stdout-task-add-noni-",
    });
    cleanups.push(p.cleanup);
    p.run([
      "init",
      "--non-interactive",
      "--agent",
      "claude-code",
      "--locale",
      "en-US",
      "--sample-phase",
      "--json",
    ]);
    expectStdoutIsJson(
      p.run([
        "task",
        "add",
        "TUTORIAL",
        "--description",
        "json-stdout regression",
        "--type",
        "docs",
        "--json",
      ]),
      "task add non-interactive",
    );
  });

  it("task add <phase> --type without --description --json (P13 partial-flags CONFIG_ERROR)", async () => {
    const p = await createTempProject({
      init: false,
      prefix: "code-pact-json-stdout-task-add-partial-",
    });
    cleanups.push(p.cleanup);
    p.run([
      "init",
      "--non-interactive",
      "--agent",
      "claude-code",
      "--locale",
      "en-US",
      "--sample-phase",
      "--json",
    ]);
    expectStdoutIsJson(
      p.run([
        "task",
        "add",
        "TUTORIAL",
        "--type",
        "docs",
        "--json",
      ]),
      "task add partial-flags CONFIG_ERROR",
    );
  });

  it("phase add --json", async () => {
    const p = await freshProject("phase-add");
    expectStdoutIsJson(
      p.run([
        "phase",
        "add",
        "--id",
        "P1",
        "--name",
        "Foundation",
        "--objective",
        "Phase add stdout test",
        "--weight",
        "10",
        "--verify-command",
        "node --version",
        "--json",
      ]),
      "phase add",
    );
  });

  it("phase import --json", async () => {
    const p = await freshProject("phase-import");
    const importPath = join(p.dir, "draft.yaml");
    await writeFile(
      importPath,
      stringifyYaml({
        phases: [
          {
            id: "P1",
            name: "Foundation",
            weight: 10,
            objective: "phase import stdout test",
            tasks: [{ id: "P1-T1" }],
          },
        ],
      }),
      "utf8",
    );
    expectStdoutIsJson(p.run(["phase", "import", importPath, "--json"]), "phase import");
  });

  // P14 governance: reserved-id (TUTORIAL) creation-time block — both
  // `phase add` and `phase import` reject the entire operation with
  // CONFIG_ERROR (exit 2). Roadmap stays byte-identical on failure.
  it("phase add --id TUTORIAL --json (P14 reserved-id CONFIG_ERROR)", async () => {
    const p = await freshProject("phase-add-tutorial-reserved");
    const roadmapPath = join(p.dir, "design", "roadmap.yaml");
    const before = await readFile(roadmapPath, "utf8");
    const res = p.run([
      "phase",
      "add",
      "--id",
      "TUTORIAL",
      "--name",
      "Impostor",
      "--objective",
      "Should be rejected by P14 reserved-id block",
      "--weight",
      "1",
      "--verify-command",
      "node --version",
      "--json",
    ]);
    expectStdoutIsJson(res, "phase add TUTORIAL reserved-id CONFIG_ERROR");
    expect(res.code).toBe(2);
    const envelope = JSON.parse(res.stdout) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("CONFIG_ERROR");
    expect(envelope.error?.message).toContain("TUTORIAL");
    expect(envelope.error?.message).toContain("init --sample-phase");
    const after = await readFile(roadmapPath, "utf8");
    expect(after).toBe(before);
  });

  // P14 advisory write lock: LOCK_HELD JSON envelope. Pre-populates
  // the lock file to simulate another process holding the lock, then
  // runs a design-mutating command with the test-escape env var
  // cleared (empty string, not "1") so the real acquisition path
  // fires and returns LOCK_HELD instead of short-circuiting.
  it("phase reconcile --write --json with existing lock (P14 LOCK_HELD envelope)", async () => {
    const p = await freshProject("phase-reconcile-lock-held");
    // Seed a fake lock holder. The CLI will fail to acquire and
    // return the diagnostic envelope.
    const lockPath = join(p.dir, ".code-pact", "locks", "write.lock");
    await mkdir(dirname(lockPath), { recursive: true });
    const fakeHolder = {
      pid: 99999,
      hostname: "phantom.local",
      cmd: "task finalize P1-T1 --write",
      created_at: "2026-05-21T03:00:00.000Z",
    };
    await writeFile(lockPath, JSON.stringify(fakeHolder), "utf8");

    // Need a phase to target. Seed via direct file writes (a `phase
    // add` CLI invocation would also fail with LOCK_HELD).
    const phasePath = join(p.dir, "design", "phases", "P1-foundation.yaml");
    await writeFile(
      phasePath,
      stringifyYaml({
        id: "P1",
        name: "Foundation",
        weight: 10,
        confidence: "medium",
        risk: "low",
        status: "planned",
        // ≥10 chars to satisfy the EMPTY_OBJECTIVE doctor check
        // (so the read-only `validate` assertion below isn't
        // confounded by an unrelated schema warning).
        objective: "lock-held envelope test phase",
        definition_of_done: ["pass"],
        verification: { commands: ["node --version"] },
      }),
      "utf8",
    );
    const roadmapPath = join(p.dir, "design", "roadmap.yaml");
    const roadmap = parseYaml(await readFile(roadmapPath, "utf8")) as {
      phases: { id: string; path: string; weight: number }[];
    };
    roadmap.phases.push({
      id: "P1",
      path: "design/phases/P1-foundation.yaml",
      weight: 10,
    });
    await writeFile(roadmapPath, stringifyYaml(roadmap), "utf8");

    // Empty string (not "1") = locks active even with the
    // setup-file escape inherited from the vitest parent env.
    const res = p.run(["phase", "reconcile", "P1", "--write", "--json"], {
      CODE_PACT_DISABLE_LOCKS: "",
    });
    expectStdoutIsJson(res, "phase reconcile --write LOCK_HELD");
    expect(res.code).toBe(2);
    const envelope = JSON.parse(res.stdout) as {
      ok: boolean;
      error?: { code: string; message: string };
      data?: { lock_holder?: typeof fakeHolder; lock_path?: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("LOCK_HELD");
    expect(envelope.data?.lock_holder).toEqual(fakeHolder);
    // macOS `mkdtemp` returns `/var/folders/...` but the spawned
    // CLI resolves cwd via realpath to `/private/var/folders/...`,
    // so compare by suffix rather than the raw path.
    expect(envelope.data?.lock_path).toMatch(
      /\.code-pact\/locks\/write\.lock$/,
    );
    expect(envelope.error?.message).toContain(fakeHolder.cmd);
    expect(envelope.error?.message).toContain(String(fakeHolder.pid));

    // Read-only command must NOT acquire the lock — the same project
    // can still be observed while a mutation is pending.
    const observe = p.run(["validate", "--json"], {
      CODE_PACT_DISABLE_LOCKS: "",
    });
    expectStdoutIsJson(observe, "validate --json (read-only, no lock)");
    expect(observe.code).toBe(0);
  });

  it("phase import containing TUTORIAL --json (P14 preflight CONFIG_ERROR)", async () => {
    const p = await freshProject("phase-import-tutorial-reserved");
    const roadmapPath = join(p.dir, "design", "roadmap.yaml");
    const before = await readFile(roadmapPath, "utf8");
    const importPath = join(p.dir, "draft.yaml");
    await writeFile(
      importPath,
      stringifyYaml({
        // Mix of safe + reserved-id phases: preflight must reject the
        // whole input, leaving roadmap byte-identical (no partial write).
        phases: [
          {
            id: "P1",
            name: "Foundation",
            weight: 10,
            objective: "Would be safe in isolation",
            tasks: [{ id: "P1-T1" }],
          },
          {
            id: "TUTORIAL",
            name: "Impostor",
            weight: 1,
            objective: "Triggers preflight CONFIG_ERROR",
            tasks: [{ id: "TUTORIAL-T1" }],
          },
        ],
      }),
      "utf8",
    );
    const res = p.run(["phase", "import", importPath, "--json"]);
    expectStdoutIsJson(res, "phase import TUTORIAL preflight CONFIG_ERROR");
    expect(res.code).toBe(2);
    const envelope = JSON.parse(res.stdout) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("CONFIG_ERROR");
    expect(envelope.error?.message).toContain("TUTORIAL");
    expect(envelope.error?.message).toContain("init --sample-phase");
    const after = await readFile(roadmapPath, "utf8");
    expect(after).toBe(before);
  });

  it("adapter install --json", async () => {
    const p = await projectWithTask("adapter-install");
    expectStdoutIsJson(
      p.run(["adapter", "install", "claude-code", "--json"]),
      "adapter install",
    );
  });

  it("task start P1-T1 --json", async () => {
    const p = await projectWithTask("task-start");
    expectStdoutIsJson(
      p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]),
      "task start",
    );
  });

  it("task block P1-T1 --reason ... --json", async () => {
    const p = await projectWithTask("task-block");
    p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);
    expectStdoutIsJson(
      p.run([
        "task",
        "block",
        "P1-T1",
        "--reason",
        "json-stdout test",
        "--agent",
        "claude-code",
        "--json",
      ]),
      "task block",
    );
  });

  it("task resume P1-T1 --json", async () => {
    const p = await projectWithTask("task-resume");
    p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);
    p.run([
      "task",
      "block",
      "P1-T1",
      "--reason",
      "test",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expectStdoutIsJson(
      p.run(["task", "resume", "P1-T1", "--agent", "claude-code", "--json"]),
      "task resume",
    );
  });

  it("task complete P1-T1 --json", async () => {
    const p = await projectWithTask("task-complete");
    p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);
    expectStdoutIsJson(
      p.run(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]),
      "task complete",
    );
  });

  it("task finalize P1-T1 --json (would_finalize after task complete)", async () => {
    // After task complete, the derived state is done but design YAML
    // still says planned — task finalize default-mode (dry-run) emits
    // `kind: "would_finalize"` and exits 0.
    const p = await projectWithTask("task-finalize-dryrun");
    p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);
    p.run(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]);
    expectStdoutIsJson(
      p.run(["task", "finalize", "P1-T1", "--json"]),
      "task finalize dry-run",
    );
  });

  it("task finalize P1-T1 --write --json (finalized after task complete)", async () => {
    const p = await projectWithTask("task-finalize-write");
    p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);
    p.run(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]);
    expectStdoutIsJson(
      p.run(["task", "finalize", "P1-T1", "--write", "--json"]),
      "task finalize --write",
    );
  });

  it("phase reconcile P1 --json (no_eligible_tasks before any task complete)", async () => {
    const p = await projectWithTask("phase-reconcile-noop");
    expectStdoutIsJson(
      p.run(["phase", "reconcile", "P1", "--json"]),
      "phase reconcile dry-run noop",
    );
  });

  it("phase reconcile P1 --json (would_reconcile after task complete)", async () => {
    const p = await projectWithTask("phase-reconcile-dryrun");
    p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);
    p.run(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]);
    expectStdoutIsJson(
      p.run(["phase", "reconcile", "P1", "--json"]),
      "phase reconcile dry-run",
    );
  });

  it("phase reconcile P1 --write --json (reconciled after task complete)", async () => {
    const p = await projectWithTask("phase-reconcile-write");
    p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);
    p.run(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]);
    expectStdoutIsJson(
      p.run(["phase", "reconcile", "P1", "--write", "--json"]),
      "phase reconcile --write",
    );
  });

  it("task runbook P1-T1 --json (planned + no events → primary loop)", async () => {
    const p = await projectWithTask("task-runbook-planned");
    expectStdoutIsJson(
      p.run(["task", "runbook", "P1-T1", "--json"]),
      "task runbook planned",
    );
  });

  it("task runbook P1-T1 --json (after task complete → finalize step)", async () => {
    const p = await projectWithTask("task-runbook-done");
    p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);
    p.run(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]);
    expectStdoutIsJson(
      p.run(["task", "runbook", "P1-T1", "--json"]),
      "task runbook done-but-design-not-done",
    );
  });

  it("phase runbook P1 --json (planned phase with no events)", async () => {
    const p = await projectWithTask("phase-runbook-planned");
    expectStdoutIsJson(
      p.run(["phase", "runbook", "P1", "--json"]),
      "phase runbook planned",
    );
  });

  it("phase runbook P1 --json (after task complete → reconcile batch step)", async () => {
    const p = await projectWithTask("phase-runbook-done");
    p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);
    p.run(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]);
    expectStdoutIsJson(
      p.run(["phase", "runbook", "P1", "--json"]),
      "phase runbook done-but-design-not-done",
    );
  });
});

// ---------------------------------------------------------------------------
// Error-path Stable (v1.0) commands — non-JSON stderr, JSON-only stdout
// ---------------------------------------------------------------------------
//
// When an --json command rejects bad input, the error envelope must still
// be valid JSON on stdout. This is the "no half-broken JSON" guarantee
// agents rely on when parsing CLI output regardless of success/failure.

describe("json-stdout contract: error envelopes are valid JSON", () => {
  it("phase show <unknown> --json → PHASE_NOT_FOUND", async () => {
    const p = await freshProject("phase-show-unknown");
    expectStdoutIsJson(
      p.run(["phase", "show", "P999", "--json"]),
      "phase show unknown",
    );
  });

  it("task status <unknown> --json → TASK_NOT_FOUND", async () => {
    const p = await freshProject("task-status-unknown");
    expectStdoutIsJson(
      p.run(["task", "status", "P999-T999", "--json"]),
      "task status unknown",
    );
  });

  it("adapter upgrade <agent> --check --json without manifest", async () => {
    // Documented MANIFEST_NOT_FOUND / CONFIG_ERROR path — must still emit
    // a valid JSON envelope on stdout.
    const p = await freshProject("adapter-upgrade-no-manifest");
    expectStdoutIsJson(
      p.run(["adapter", "upgrade", "claude-code", "--check", "--json"]),
      "adapter upgrade no manifest",
    );
  });

  it("recommend --phase P1 --task P1-T1 --json against an uninitialized project", async () => {
    const p = await freshProject("recommend-unknown");
    expectStdoutIsJson(
      p.run(["recommend", "--phase", "P1", "--task", "P1-T1", "--json"]),
      "recommend unknown",
    );
  });
});
