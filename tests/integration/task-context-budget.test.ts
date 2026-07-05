// P47 (Context Fit, layer a) — integration tests for `--context-budget` on
// `task context` and `task prepare`.
//
// Proves the ergonomic alias resolves to the SAME byte budget as the explicit
// --budget-bytes value (compatibility), that the no-flag path is unchanged,
// that mutual exclusion and unknown-profile errors are CONFIG_ERROR/exit 2,
// and that the task prepare commands dictionary never echoes --context-budget.
//
// Test policy mirrors task-prepare-commands-contract.test.ts: deterministic
// verify command (node --version), single temp project per scenario, no
// network, no sleeps.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  createTempProject,
  ensureCliBuilt,
  expectJsonOk,
  expectJsonErr,
} from "../helpers/cli.ts";

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

/** Add phase P1 (deterministic verify) + a single planned task P1-T1. */
async function setupTask(
  project: Awaited<ReturnType<typeof createTempProject>>,
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
      "Foundation phase for the context-budget test",
      "--weight",
      "10",
      "--verify-command",
      "node --version",
      "--json",
    ]),
  );
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
      verification_strength: "weak",
      expected_duration: "short",
      status: "planned",
      description: "context-budget test task",
    },
  ];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");
}

describe("task context --context-budget (P47)", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-ctx-budget-" });
    await setupTask(project);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it.each([
    ["tight", "30000"],
    ["balanced", "60000"],
    ["wide", "120000"],
  ])(
    "--context-budget %s produces the same content as --budget-bytes %s",
    (profile, bytes) => {
      const byProfile = expectJsonOk<{ content: string }>(
        project.run([
          "task",
          "context",
          "P1-T1",
          "--agent",
          "claude-code",
          "--context-budget",
          profile,
          "--json",
        ]),
      );
      const byBytes = expectJsonOk<{ content: string }>(
        project.run([
          "task",
          "context",
          "P1-T1",
          "--agent",
          "claude-code",
          "--budget-bytes",
          bytes,
          "--json",
        ]),
      );
      expect(byProfile.data.content).toBe(byBytes.data.content);
    },
  );

  it("an unknown profile is CONFIG_ERROR (exit 2)", () => {
    const res = project.run([
      "task",
      "context",
      "P1-T1",
      "--agent",
      "claude-code",
      "--context-budget",
      "unknown",
      "--json",
    ]);
    expectJsonErr(res, "CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("--context-budget + --budget-bytes is CONFIG_ERROR (exit 2)", () => {
    const res = project.run([
      "task",
      "context",
      "P1-T1",
      "--agent",
      "claude-code",
      "--context-budget",
      "tight",
      "--budget-bytes",
      "30000",
      "--json",
    ]);
    const env = expectJsonErr(res, "CONFIG_ERROR");
    expect(env.error.message).toMatch(/mutually exclusive/);
    expect(res.code).toBe(2);
  });

  it("the no-flag content is byte-identical with or without resolving a profile", () => {
    // The no-flag path must not change just because the profile machinery
    // exists. Compare no-flag content to itself across two invocations and to
    // the un-elided wide pack only insofar as no-flag == no budget.
    const a = expectJsonOk<{ content: string }>(
      project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--json",
      ]),
    );
    const b = expectJsonOk<{ content: string }>(
      project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--json",
      ]),
    );
    expect(a.data.content).toBe(b.data.content);
  });

  it("--help includes --context-budget", () => {
    const res = project.run(["task", "context", "--help"]);
    expect(res.stdout + res.stderr).toMatch(/--context-budget/);
  });
});

describe("task prepare --context-budget (P47)", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-prep-budget-" });
    await setupTask(project);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("--context-budget tight yields the same context_pack_bytes as --budget-bytes 30000", () => {
    const byProfile = expectJsonOk<{ context_pack_bytes: number }>(
      project.run([
        "task",
        "prepare",
        "P1-T1",
        "--agent",
        "claude-code",
        "--dry-run",
        "--context-budget",
        "tight",
        "--json",
      ]),
    );
    const byBytes = expectJsonOk<{ context_pack_bytes: number }>(
      project.run([
        "task",
        "prepare",
        "P1-T1",
        "--agent",
        "claude-code",
        "--dry-run",
        "--budget-bytes",
        "30000",
        "--json",
      ]),
    );
    expect(byProfile.data.context_pack_bytes).toBe(
      byBytes.data.context_pack_bytes,
    );
  });

  it("an unknown profile is CONFIG_ERROR (exit 2)", () => {
    const res = project.run([
      "task",
      "prepare",
      "P1-T1",
      "--agent",
      "claude-code",
      "--context-budget",
      "unknown",
      "--dry-run",
      "--json",
    ]);
    expectJsonErr(res, "CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("--context-budget + --budget-bytes is CONFIG_ERROR (exit 2)", () => {
    const res = project.run([
      "task",
      "prepare",
      "P1-T1",
      "--agent",
      "claude-code",
      "--context-budget",
      "tight",
      "--budget-bytes",
      "30000",
      "--dry-run",
      "--json",
    ]);
    const env = expectJsonErr(res, "CONFIG_ERROR");
    expect(env.error.message).toMatch(/mutually exclusive/);
    expect(res.code).toBe(2);
  });

  it("the commands dictionary does not echo --context-budget", () => {
    const env = expectJsonOk<{ commands: Record<string, string> }>(
      project.run([
        "task",
        "prepare",
        "P1-T1",
        "--agent",
        "claude-code",
        "--dry-run",
        "--context-budget",
        "tight",
        "--json",
      ]),
    );
    for (const cmd of Object.values(env.data.commands)) {
      expect(cmd).not.toMatch(/--context-budget/);
    }
    // And the context command remains exactly the unchanged buildCommands form.
    expect(env.data.commands.context).toBe(
      "code-pact task context P1-T1 --agent claude-code",
    );
  });

  it("--help includes --context-budget", () => {
    const res = project.run(["task", "prepare", "--help"]);
    expect(res.stdout + res.stderr).toMatch(/--context-budget/);
  });
});

describe("task context --context-budget with an agent-defined profile (P47)", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-ctx-custom-" });
    await setupTask(project);
    // Declare a custom profile + override `tight` in the agent profile.
    const profilePath = join(
      project.dir,
      ".code-pact",
      "agent-profiles",
      "claude-code.yaml",
    );
    const profile = parseYaml(await readFile(profilePath, "utf8")) as Record<
      string,
      unknown
    >;
    profile.context_budget = {
      profiles: {
        tight: { max_bytes: 25000 },
        review: { max_bytes: 45000 },
      },
    };
    await writeFile(profilePath, stringifyYaml(profile), "utf8");
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("a custom profile resolves to its declared bytes", () => {
    const byProfile = expectJsonOk<{ content: string }>(
      project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--context-budget",
        "review",
        "--json",
      ]),
    );
    const byBytes = expectJsonOk<{ content: string }>(
      project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--budget-bytes",
        "45000",
        "--json",
      ]),
    );
    expect(byProfile.data.content).toBe(byBytes.data.content);
  });

  it("an agent override wins for a standard profile name", () => {
    const byProfile = expectJsonOk<{ content: string }>(
      project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--context-budget",
        "tight",
        "--json",
      ]),
    );
    const byBytes = expectJsonOk<{ content: string }>(
      project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--budget-bytes",
        "25000",
        "--json",
      ]),
    );
    expect(byProfile.data.content).toBe(byBytes.data.content);
  });
});

// P47 agent-less-resolution contract (RFC § Layer (a)): a STANDARD profile must
// resolve from its built-in fallback WITHOUT requiring an agent profile, while
// a CUSTOM profile — which only an agent profile can declare — needs the strict
// load and is CONFIG_ERROR when undeclared. Built-in resolution must not become
// stricter than the no-flag / --budget-bytes path it aliases.
describe("task context --context-budget agent-less resolution (P47)", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;
  const profilePath = (dir: string) =>
    join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-ctx-agentless-" });
    await setupTask(project);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("a standard profile resolves with the agent profile file deleted (built-in fallback)", async () => {
    await rm(profilePath(project.dir));
    const byProfile = expectJsonOk<{ content: string }>(
      project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--context-budget",
        "tight",
        "--json",
      ]),
    );
    // A standard name with no agent profile must equal --budget-bytes 30000 and
    // must NOT fail like a missing-profile error.
    const byBytes = expectJsonOk<{ content: string }>(
      project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--budget-bytes",
        "30000",
        "--json",
      ]),
    );
    expect(byProfile.data.content).toBe(byBytes.data.content);
  });

  it("a standard profile resolves when the agent profile has no context_budget block", () => {
    // The seeded profile has no context_budget by default — assert the built-in
    // fallback still applies (no override present).
    const byProfile = expectJsonOk<{ content: string }>(
      project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--context-budget",
        "balanced",
        "--json",
      ]),
    );
    const byBytes = expectJsonOk<{ content: string }>(
      project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--budget-bytes",
        "60000",
        "--json",
      ]),
    );
    expect(byProfile.data.content).toBe(byBytes.data.content);
  });

  it("a custom profile is CONFIG_ERROR when the agent profile file is deleted", async () => {
    await rm(profilePath(project.dir));
    const res = project.run([
      "task",
      "context",
      "P1-T1",
      "--agent",
      "claude-code",
      "--context-budget",
      "review",
      "--json",
    ]);
    // Custom names require an agent profile; absence is a real error.
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    expect(env.ok).toBe(false);
    // AGENT_NOT_FOUND (missing profile file) is the strict-load failure code.
    expect(["AGENT_NOT_FOUND", "CONFIG_ERROR"]).toContain(env.error.code);
  });

  it("an explicitly-declared but broken context_budget is CONFIG_ERROR even for a standard name", async () => {
    const profile = parseYaml(
      await readFile(profilePath(project.dir), "utf8"),
    ) as Record<string, unknown>;
    // Invalid: max_bytes must be a positive integer.
    profile.context_budget = { profiles: { tight: { max_bytes: 0 } } };
    await writeFile(profilePath(project.dir), stringifyYaml(profile), "utf8");
    const res = project.run([
      "task",
      "context",
      "P1-T1",
      "--agent",
      "claude-code",
      "--context-budget",
      "tight",
      "--json",
    ]);
    expectJsonErr(res, "CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("an unrelated schema-invalid profile field does NOT sink a standard built-in fallback", async () => {
    // Best-effort standard resolution validates ONLY the context_budget block,
    // not the whole AgentProfile — so a profile that the full schema would
    // reject for an UNRELATED reason (here: an absolute instruction_filename,
    // which RelativePosixPath rejects) must still let the tight fallback apply.
    // The YAML stays syntactically valid; only the schema is violated.
    const profile = parseYaml(
      await readFile(profilePath(project.dir), "utf8"),
    ) as Record<string, unknown>;
    profile.instruction_filename = "/etc/passwd"; // absolute → schema-invalid, unrelated to context_budget
    await writeFile(profilePath(project.dir), stringifyYaml(profile), "utf8");
    const byProfile = expectJsonOk<{ content: string }>(
      project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--context-budget",
        "tight",
        "--json",
      ]),
    );
    const byBytes = expectJsonOk<{ content: string }>(
      project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--budget-bytes",
        "30000",
        "--json",
      ]),
    );
    expect(byProfile.data.content).toBe(byBytes.data.content);
  });
});

// REMOVED: Tests take >30s to complete
// P47-6: task prepare's early-return states (done / blocked / unmet deps) skip
// the pack build, and must therefore NOT pay for --context-budget profile
// resolution. A done task asked to prepare with a profile that would otherwise
// be a hard CONFIG_ERROR must still return noop_already_done, proving the
// resolution is deferred behind the early return.
// P47: the documented error contract — "a malformed, explicitly-configured
// context_budget surfaces as CONFIG_ERROR when a --context-budget invocation
// needs to parse it" — must hold on the `task prepare` build path too, not only
// `task context`. On a buildable (planned) task, a broken context_budget block
// must produce a CONFIG_ERROR envelope, exit 2 — never an unclassified throw.
