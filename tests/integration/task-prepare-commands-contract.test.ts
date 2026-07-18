// P29-T2: contract regression for the `task prepare` commands dictionary.
//
// The v1.11+ single per-task entry point `task prepare` returns a
// `commands` dictionary the agent is meant to run verbatim. A v1.13.3
// review found `commands.finalize` was emitted as
// `code-pact task finalize <id> --agent <agent>`, which the finalize
// parser rejects with CONFIG_ERROR "Unknown option '--agent'". The bug
// survived because the only test pinned the broken string as expected
// and nothing ran the emitted commands through the parser.
//
// This test closes that gap with two layers:
//
//   1. parser contract — every command `task prepare --json` emits is
//      run verbatim through the built CLI; none may produce an
//      "Unknown option" failure (the strict parseArgs message, emitted
//      in both JSON and human mode). This layer fails on the --agent bug.
//   2. lifecycle — the emitted commands actually drive
//      start → complete → finalize, and the finalize command reaches a
//      finalize outcome rather than CONFIG_ERROR.
//
// Test policy mirrors e2e-workflow.test.ts: deterministic verify command
// (`node --version`), single temp project per scenario, no network, no
// sleeps.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  createTempProject,
  ensureCliBuilt,
  expectJsonOk,
} from "../helpers/cli.ts";

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

/** Turn a `code-pact <args...>` command string into argv for the built CLI. */
function toArgv(command: string): string[] {
  const parts = command.trim().split(/\s+/);
  if (parts[0] === "code-pact") parts.shift();
  return parts;
}

/** Add phase P1 (deterministic verify) + a single planned task P1-T1. */
async function setupTask(
  project: Awaited<ReturnType<typeof createTempProject>>,
): Promise<void> {
  const add = project.run([
    "phase",
    "add",
    "--id",
    "P1",
    "--name",
    "Foundation",
    "--objective",
    "Foundation phase for the prepare-commands contract test",
    "--weight",
    "10",
    "--verify-command",
    "node --version",
    "--json",
  ]);
  expectJsonOk(add);

  const phasePath = join(project.dir, "design", "phases", "P1-foundation.yaml");
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
      verification_strength: "strong",
      expected_duration: "short",
      status: "planned",
      description: "prepare-commands contract test task",
    },
  ];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");
}

type Commands = {
  context: string;
  start: string;
  verify: string;
  complete: string;
  finalize: string;
  "record-done": string;
};

const BOUNDED_POLICY = {
  mode: "bounded",
  maxRepairAttempts: 1,
  retryableFailureKinds: ["command_failed"],
  nonRetryableFailureKinds: [
    "timed_out",
    "aborted",
    "decision_required",
    "unsafe_write",
    "invalid_state",
    "unknown",
  ],
  retryContext: "failure_delta",
  firstRetry: "same_model_same_effort_same_context",
  stopOnRepeatedFingerprint: true,
  afterExhaustion: "use_allowed_escalation",
} as const;

function prepareCommands(
  project: Awaited<ReturnType<typeof createTempProject>>,
): Commands {
  const res = project.run([
    "task",
    "prepare",
    "P1-T1",
    "--agent",
    "claude-code",
    "--detail",
    "full",
    "--json",
  ]);
  const env = expectJsonOk<{ commands: Commands }>(res);
  return env.data.commands;
}

describe("task prepare — emitted commands are accepted by the CLI parser", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-prepare-cmd-" });
    await setupTask(project);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("no emitted command uses an unsupported flag (regression: finalize --agent)", () => {
    const commands = prepareCommands(project);

    for (const [name, command] of Object.entries(commands)) {
      const res = project.run(toArgv(command));
      const combined = `${res.stdout}\n${res.stderr}`;
      // "Unknown option" is Node's strict parseArgs message, emitted in
      // both JSON envelopes and human stderr. State-dependent failures
      // (TASK_FINALIZE_NOT_ELIGIBLE, VERIFICATION_FAILED, ...) are fine —
      // we only fail on an unsupported flag.
      expect(
        combined.includes("Unknown option"),
        `commands.${name} ("${command}") was rejected by the parser:\n${combined}`,
      ).toBe(false);
    }
  });

  it("commands.finalize carries no --agent flag (finalize takes none)", () => {
    const commands = prepareCommands(project);
    expect(commands.finalize).not.toContain("--agent");
  });

  it("P48 — no emitted command echoes --context-budget (per-invocation policy)", () => {
    const commands = prepareCommands(project);
    for (const command of Object.values(commands)) {
      expect(command).not.toContain("--context-budget");
    }
  });

  it("P48 — the --json envelope surfaces recommendation.contextFit (suggestion only)", () => {
    const res = project.run([
      "task",
      "prepare",
      "P1-T1",
      "--agent",
      "claude-code",
      "--detail",
      "full",
      "--json",
    ]);
    const env = expectJsonOk<{
      recommendation: {
        contextFit?: {
          recommendedProfile: string;
          recommendedBudgetBytes: number;
          reason: string;
        };
      } | null;
    }>(res);
    // P1-T1: context_size=small, ambiguity=low, write_surface=low -> tight.
    expect(env.data.recommendation).not.toBeNull();
    expect(env.data.recommendation!.contextFit).toBeDefined();
    expect(env.data.recommendation!.contextFit!.recommendedProfile).toBe(
      "tight",
    );
    expect(env.data.recommendation!.contextFit!.recommendedBudgetBytes).toBe(
      30000,
    );
  });

  it("P51 — recommendation carries repairPolicy and commands stay unchanged", () => {
    const res = project.run([
      "task",
      "prepare",
      "P1-T1",
      "--agent",
      "claude-code",
      "--detail",
      "full",
      "--json",
    ]);
    const env = expectJsonOk<{
      recommendation: { repairPolicy: unknown } | null;
      commands: Commands;
    }>(res);

    expect(env.data.recommendation).not.toBeNull();
    expect(env.data.recommendation!.repairPolicy).toEqual(BOUNDED_POLICY);
    expect(env.data.commands).toEqual({
      context: "code-pact task context P1-T1 --agent claude-code",
      start: "code-pact task start P1-T1 --agent claude-code",
      verify: "code-pact verify --phase P1 --task P1-T1 --json --detail agent",
      complete:
        "code-pact task complete P1-T1 --agent claude-code --json --detail agent",
      finalize: "code-pact task finalize P1-T1 --write --json",
      "record-done":
        'code-pact task record-done P1-T1 --agent claude-code --evidence "<verification you ran>"',
    });
    for (const [name, command] of Object.entries(env.data.commands)) {
      expect(name).not.toMatch(/repair|retry/i);
      expect(command).not.toMatch(/repair|retry/i);
    }
    expect(env.data.commands.verify).toContain("--json --detail agent");
    expect(env.data.commands.complete).toContain("--json --detail agent");
  });

  it('commands["record-done"] is a correct template (P40): task record-done + --evidence placeholder', () => {
    const commands = prepareCommands(project);
    const rd = commands["record-done"];
    // The one non-runnable entry: --evidence is agent-supplied, so it is a
    // template with an angle-bracket token. Pin the template surface, not just
    // "no Unknown option" (the parser loop above already covers that).
    expect(rd).toContain("task record-done");
    expect(rd).toContain("--evidence");
    expect(rd).toContain('"<verification you ran>"');
  });

  it("emitted commands drive start → complete → finalize end-to-end", () => {
    const commands = prepareCommands(project);

    expectJsonOk(project.run([...toArgv(commands.start), "--json"]));
    expectJsonOk(project.run([...toArgv(commands.complete), "--json"]));

    // commands.finalize already includes --write --json.
    const fin = project.run(toArgv(commands.finalize));
    const env = expectJsonOk<{ kind: string }>(fin);
    expect(["would_finalize", "finalized", "already_finalized"]).toContain(
      env.data.kind,
    );
  });
});

// Codex pre-release audit (Finding 1): the CONTEXT_OVER_BUDGET envelope must
// expose its budget fields under a TOP-LEVEL `data` — the documented
// convention and what the cli-contract recovery prose tells agents to read
// (`data.minimum_achievable_bytes`). A prior build nested them under
// `error.data`, so an agent following the docs found nothing. This locks the
// shape for both `task context` and `task prepare`.
describe("CONTEXT_OVER_BUDGET envelope — budget detail is top-level data", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-budget-env-" });
    await setupTask(project);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it.each([
    [
      "task context",
      [
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--budget-bytes",
        "1",
        "--json",
      ],
    ],
    [
      "task prepare",
      [
        "task",
        "prepare",
        "P1-T1",
        "--agent",
        "claude-code",
        "--budget-bytes",
        "1",
        "--json",
      ],
    ],
  ])(
    "%s emits budget fields under top-level data, not error.data",
    (_label, argv) => {
      const res = project.run(argv);
      const env = JSON.parse(res.stdout.trim()) as {
        ok: boolean;
        error: { code: string; data?: unknown };
        data?: {
          budget_bytes?: number;
          minimum_achievable_bytes?: number;
          unelidable_sections?: unknown;
        };
      };
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe("CONTEXT_OVER_BUDGET");
      expect(env.error.data).toBeUndefined();
      expect(env.data?.budget_bytes).toBe(1);
      expect(typeof env.data?.minimum_achievable_bytes).toBe("number");
      expect(Array.isArray(env.data?.unelidable_sections)).toBe(true);
      expect(res.code).toBe(2);
    },
  );
});

// P43: task prepare surfaces an accepted gating ADR's `## Implementation
// commitments` as an additive `decision_commitments` field. Advisory context,
// never a gate; field-presence parity (gated tasks only).
describe("task prepare — decision_commitments (P43)", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-prepare-commit-" });
  });

  afterEach(async () => {
    await project.cleanup();
  });

  type Envelope = {
    ok: boolean;
    data: {
      decision_commitments?: {
        adr: string;
        has_section: boolean;
        items: { text: string; done: boolean }[];
      }[];
    };
  };

  /** Add phase P1 + a single task, optionally requires_decision, optionally with extra task fields. */
  async function writeTask(
    opts: {
      requiresDecision?: boolean;
      phaseRequiresDecision?: boolean;
      decisionRefs?: string[];
    } = {},
  ): Promise<void> {
    expectJsonOk(
      project.run([
        "phase",
        "add",
        "--id",
        "P1",
        "--name",
        "Foundation",
        "--objective",
        "Foundation phase for the decision_commitments test",
        "--weight",
        "10",
        "--verify-command",
        "node --version",
        "--json",
      ]),
    );
    const phasePath = join(
      project.dir,
      "design",
      "phases",
      "P1-foundation.yaml",
    );
    const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<
      string,
      unknown
    >;
    if (opts.phaseRequiresDecision) doc.requires_decision = true;
    const task: Record<string, unknown> = {
      id: "P1-T1",
      type: "feature",
      ambiguity: "low",
      risk: "low",
      context_size: "small",
      write_surface: "low",
      verification_strength: "weak",
      expected_duration: "short",
      status: "planned",
      description: "decision_commitments test task",
    };
    if (opts.requiresDecision) task.requires_decision = true;
    if (opts.decisionRefs) task.decision_refs = opts.decisionRefs;
    doc.tasks = [task];
    await writeFile(phasePath, stringifyYaml(doc), "utf8");
  }

  async function writeAdr(filename: string, body: string): Promise<void> {
    const path = join(project.dir, "design", "decisions", filename);
    await writeFile(path, body, "utf8");
  }

  function prepare(): Envelope {
    const res = project.run([
      "task",
      "prepare",
      "P1-T1",
      "--agent",
      "claude-code",
      "--detail",
      "full",
      "--json",
    ]);
    return JSON.parse(res.stdout.trim()) as Envelope;
  }

  it("gated task + accepted ADR with a commitments list → items surfaced, has_section true", async () => {
    await writeTask({ requiresDecision: true });
    await writeAdr(
      "P1-T1-rfc.md",
      "**Status:** accepted\n\n## Implementation commitments\n\n- [ ] Wire the thing\n- [x] Update docs\n",
    );
    const env = prepare();
    expect(env.ok).toBe(true);
    expect(env.data.decision_commitments).toEqual([
      {
        adr: "design/decisions/P1-T1-rfc.md",
        has_section: true,
        items: [
          { text: "Wire the thing", done: false },
          { text: "Update docs", done: true },
        ],
      },
    ]);
  });

  it("gated task + accepted ADR with no commitments section → has_section false, items []", async () => {
    await writeTask({ requiresDecision: true });
    await writeAdr(
      "P1-T1-rfc.md",
      "**Status:** accepted\n\n## Decision\n\nChose X.\n",
    );
    const env = prepare();
    expect(env.data.decision_commitments).toEqual([
      { adr: "design/decisions/P1-T1-rfc.md", has_section: false, items: [] },
    ]);
  });

  it("gated task + accepted ADR with an empty section → has_section true, items []", async () => {
    await writeTask({ requiresDecision: true });
    await writeAdr(
      "P1-T1-rfc.md",
      "**Status:** accepted\n\n## Implementation commitments\n\nTBD.\n",
    );
    const env = prepare();
    expect(env.data.decision_commitments).toEqual([
      { adr: "design/decisions/P1-T1-rfc.md", has_section: true, items: [] },
    ]);
  });

  it("gated task with no accepted ADR → decision_commitments is present as []", async () => {
    await writeTask({ requiresDecision: true });
    await writeAdr(
      "P1-T1-rfc.md",
      "**Status:** proposed\n\n## Implementation commitments\n\n- [ ] x\n",
    );
    const env = prepare();
    expect(env.data.decision_commitments).toEqual([]);
  });

  it("non-gated task → decision_commitments omitted entirely", async () => {
    await writeTask({ requiresDecision: false });
    await writeAdr(
      "P1-T1-rfc.md",
      "**Status:** accepted\n\n## Implementation commitments\n\n- [ ] x\n",
    );
    const env = prepare();
    expect(env.data.decision_commitments).toBeUndefined();
  });

  it("phase-level requires_decision also surfaces commitments", async () => {
    await writeTask({ phaseRequiresDecision: true });
    await writeAdr(
      "P1-T1-rfc.md",
      "**Status:** accepted\n\n## Implementation commitments\n\n- [x] done\n",
    );
    const env = prepare();
    expect(env.data.decision_commitments).toEqual([
      {
        adr: "design/decisions/P1-T1-rfc.md",
        has_section: true,
        items: [{ text: "done", done: true }],
      },
    ]);
  });

  it("explicit decision_refs with two accepted ADRs → both surfaced in considered[] order", async () => {
    await writeTask({
      requiresDecision: true,
      decisionRefs: ["design/decisions/a-rfc.md", "design/decisions/b-rfc.md"],
    });
    await writeAdr(
      "a-rfc.md",
      "**Status:** accepted\n\n## Implementation commitments\n\n- [ ] from a\n",
    );
    await writeAdr(
      "b-rfc.md",
      "**Status:** accepted\n\n## Implementation commitments\n\n- [ ] from b\n",
    );
    const env = prepare();
    expect(env.data.decision_commitments?.map(c => c.adr)).toEqual([
      "design/decisions/a-rfc.md",
      "design/decisions/b-rfc.md",
    ]);
    expect(env.data.decision_commitments?.[0]?.items).toEqual([
      { text: "from a", done: false },
    ]);
    expect(env.data.decision_commitments?.[1]?.items).toEqual([
      { text: "from b", done: false },
    ]);
  });
});
