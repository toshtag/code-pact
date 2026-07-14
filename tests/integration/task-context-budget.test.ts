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
import { access, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  createTempProject,
  ensureCliBuilt,
  expectJsonOk,
  expectJsonErr,
} from "../helpers/cli.ts";
import { runTaskContext } from "../../src/commands/task-context.ts";

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

/** Add phase P1 (deterministic verify) + a single planned task P1-T1. */
async function setupTask(
  project: Awaited<ReturnType<typeof createTempProject>>,
): Promise<void> {
  expectJsonOk(
    project.run([
      "phase", "add",
      "--id", "P1",
      "--name", "Foundation",
      "--objective", "Foundation phase for the context-budget test",
      "--weight", "10",
      "--verify-command", "node --version",
      "--json",
    ]),
  );
  const phasePath = join(project.dir, "design", "phases", "P1-foundation.yaml");
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
      description: "context-budget test task",
    },
  ];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");
}

const FORCING_READ_MARKER = "p53-forcing-read-marker";

async function forceTaskBudgetDeferral(
  project: Awaited<ReturnType<typeof createTempProject>>,
): Promise<void> {
  const phasePath = join(project.dir, "design", "phases", "P1-foundation.yaml");
  const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<string, unknown>;
  const tasks = doc.tasks as Array<Record<string, unknown>>;
  tasks[0] = {
    ...tasks[0],
    context_size: "medium",
    write_surface: "medium",
    reads: [`docs/${FORCING_READ_MARKER}/**`],
  };
  await writeFile(phasePath, stringifyYaml(doc), "utf8");
  const readDir = join(project.dir, "docs", FORCING_READ_MARKER);
  await mkdir(readDir, { recursive: true });
  for (let index = 0; index < 850; index += 1) {
    await writeFile(
      join(readDir, `entry-${String(index).padStart(4, "0")}-${FORCING_READ_MARKER}.md`),
      "deterministic fixture\n",
      "utf8",
    );
  }
  for (const args of [
    ["init"],
    ["add", "docs"],
  ]) {
    const res = spawnSync("git", args, {
      cwd: project.dir,
      encoding: "utf8",
    });
    if (res.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
      );
    }
  }
}

function commandArgs(command: string): string[] {
  const parts = command.split(" ");
  expect(parts[0]).toBe("code-pact");
  return parts.slice(1);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
          "task", "context", "P1-T1", "--agent", "claude-code",
          "--context-budget", profile, "--json",
        ]),
      );
      const byBytes = expectJsonOk<{ content: string }>(
        project.run([
          "task", "context", "P1-T1", "--agent", "claude-code",
          "--budget-bytes", bytes, "--json",
        ]),
      );
      expect(byProfile.data.content).toBe(byBytes.data.content);
    },
  );

  it("an unknown profile is CONFIG_ERROR (exit 2)", () => {
    const res = project.run([
      "task", "context", "P1-T1", "--agent", "claude-code",
      "--context-budget", "unknown", "--json",
    ]);
    expectJsonErr(res, "CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("--context-budget + --budget-bytes is CONFIG_ERROR (exit 2)", () => {
    const res = project.run([
      "task", "context", "P1-T1", "--agent", "claude-code",
      "--context-budget", "tight", "--budget-bytes", "30000", "--json",
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
      project.run(["task", "context", "P1-T1", "--agent", "claude-code", "--json"]),
    );
    const b = expectJsonOk<{ content: string }>(
      project.run(["task", "context", "P1-T1", "--agent", "claude-code", "--json"]),
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
        "task", "prepare", "P1-T1", "--agent", "claude-code", "--dry-run",
        "--context-budget", "tight", "--json",
      ]),
    );
    const byBytes = expectJsonOk<{ context_pack_bytes: number }>(
      project.run([
        "task", "prepare", "P1-T1", "--agent", "claude-code", "--dry-run",
        "--budget-bytes", "30000", "--json",
      ]),
    );
    expect(byProfile.data.context_pack_bytes).toBe(byBytes.data.context_pack_bytes);
  });

  it("an unknown profile is CONFIG_ERROR (exit 2)", () => {
    const res = project.run([
      "task", "prepare", "P1-T1", "--agent", "claude-code",
      "--context-budget", "unknown", "--dry-run", "--json",
    ]);
    expectJsonErr(res, "CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("--context-budget + --budget-bytes is CONFIG_ERROR (exit 2)", () => {
    const res = project.run([
      "task", "prepare", "P1-T1", "--agent", "claude-code",
      "--context-budget", "tight", "--budget-bytes", "30000", "--dry-run", "--json",
    ]);
    const env = expectJsonErr(res, "CONFIG_ERROR");
    expect(env.error.message).toMatch(/mutually exclusive/);
    expect(res.code).toBe(2);
  });

  it("the commands dictionary uses resolved --budget-bytes, not --context-budget", () => {
    const env = expectJsonOk<{ commands: Record<string, string> }>(
      project.run([
        "task", "prepare", "P1-T1", "--agent", "claude-code", "--dry-run",
        "--context-budget", "tight", "--json",
      ]),
    );
    for (const cmd of Object.values(env.data.commands)) {
      expect(cmd).not.toMatch(/--context-budget/);
    }
    expect(env.data.commands.context).toBe(
      "code-pact task context P1-T1 --agent claude-code --budget-bytes 30000",
    );
  });

  it("--recommended-context-budget emits a command that reproduces the written pack", async () => {
    await forceTaskBudgetDeferral(project);
    const env = expectJsonOk<{
      recommendation: {
        contextFit: {
          recommendedProfile: string;
          recommendedBudgetBytes: number;
        };
      };
      applied_context_budget: {
        source: string;
        profile: string;
        budget_bytes: number;
      };
      context_pack_path: string;
      context_pack_bytes: number;
      deferred_context: { manifest_ref: string; persisted: boolean };
      commands: Record<string, string>;
    }>(
      project.run([
        "task", "prepare", "P1-T1", "--agent", "claude-code",
        "--recommended-context-budget", "--json",
      ]),
    );
    expect(env.data.applied_context_budget).toEqual({
      source: "recommended_cli",
      profile: env.data.recommendation.contextFit.recommendedProfile,
      budget_bytes: env.data.recommendation.contextFit.recommendedBudgetBytes,
    });
    expect(env.data.commands.context).toBe(
      `code-pact task context P1-T1 --agent claude-code --budget-bytes ${env.data.recommendation.contextFit.recommendedBudgetBytes}`,
    );
    expect(env.data.commands.context).not.toContain("--recommended-context-budget");
    expect(env.data.commands.context).not.toContain("--context-budget");
    expect(env.data.recommendation.contextFit.recommendedProfile).toBe("balanced");
    expect(env.data.context_pack_bytes).toBeLessThanOrEqual(
      env.data.recommendation.contextFit.recommendedBudgetBytes,
    );
    expect(env.data.deferred_context).toMatchObject({ persisted: true });

    const preparedContent = await readFile(env.data.context_pack_path, "utf8");
    expect(preparedContent).toContain(`- \`docs/${FORCING_READ_MARKER}/**\``);
    expect(preparedContent).toContain("matches across 1 directory");
    expect(preparedContent).not.toContain(`entry-0000-${FORCING_READ_MARKER}.md`);
    expect(preparedContent).toContain(env.data.deferred_context.manifest_ref);

    const listed = expectJsonOk<{
      sections: Array<{ name: string; bytes: number; content_sha256: string }>;
    }>(
      project.run([
        "context", "show", env.data.deferred_context.manifest_ref,
        "--list", "--json",
      ]),
    );
    expect(listed.data.sections.map(section => section.name)).toContain("reads");
    const originalReads = project.run([
      "context", "show", env.data.deferred_context.manifest_ref,
      "--section", "reads",
    ]);
    expect(originalReads.code).toBe(0);
    expect(originalReads.stdout).toContain(`entry-0000-${FORCING_READ_MARKER}.md`);
    expect(originalReads.stdout).not.toContain("matches across 1 directory");

    const contextCommand = env.data.commands.context;
    expect(contextCommand).toBeDefined();
    const rerun = expectJsonOk<{
      content: string;
      deferred_context: { manifest_ref: string; persisted: boolean };
    }>(project.run([...commandArgs(contextCommand!), "--json"]));
    expect(rerun.data.content).toBe(preparedContent);
    expect(rerun.data.deferred_context).toMatchObject({
      manifest_ref: env.data.deferred_context.manifest_ref,
      persisted: false,
    });
  });

  it("budgeted explain reports projected read byte details", async () => {
    await forceTaskBudgetDeferral(project);
    const env = expectJsonOk<{
      content: string;
      deferred_context: { manifest_ref: string; persisted: boolean };
      sections: Array<{ name: string; bytes: number; details?: Record<string, unknown> }>;
      deferred_bytes: number;
      elided_sections: Array<{ name: string; bytes: number }>;
    }>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--budget-bytes", "60000", "--explain", "--json",
      ]),
    );

    expect(env.data.content).toContain("matches across 1 directory");
    expect(env.data.content).not.toContain(`entry-0000-${FORCING_READ_MARKER}.md`);
    expect(env.data.deferred_context).toMatchObject({ persisted: false });
    const reads = env.data.sections.find(section => section.name === "reads");
    expect(reads?.details).toMatchObject({
      projection_kind: "read_directory_counts",
      glob_count: 1,
      match_count: 850,
      directory_count: 1,
    });
    expect(reads?.details?.saved_bytes).toBe(
      Number(reads?.details?.original_bytes) -
        Number(reads?.details?.projected_bytes),
    );
    expect(reads?.bytes).toBe(reads?.details?.projected_bytes);
    expect(env.data.elided_sections.map(section => section.name)).not.toContain("reads");
    expect(env.data.deferred_bytes).toBe(Number(reads?.details?.original_bytes));
  });

  it.each([
    ["--budget-bytes + --context-budget", ["--budget-bytes", "30000", "--context-budget", "tight"]],
    ["--budget-bytes + --recommended-context-budget", ["--budget-bytes", "30000", "--recommended-context-budget"]],
    ["--context-budget + --recommended-context-budget", ["--context-budget", "tight", "--recommended-context-budget"]],
    ["all three budget modes", ["--budget-bytes", "30000", "--context-budget", "tight", "--recommended-context-budget"]],
  ])("%s is CONFIG_ERROR (exit 2)", (_label, flags) => {
    const res = project.run([
      "task", "prepare", "P1-T1", "--agent", "claude-code",
      ...flags, "--dry-run", "--json",
    ]);
    const env = expectJsonErr(res, "CONFIG_ERROR");
    expect(env.error.message).toMatch(/mutually exclusive/);
    expect(res.code).toBe(2);
  });

  it("task context rejects --recommended-context-budget as an unknown flag", () => {
    const res = project.run([
      "task", "context", "P1-T1", "--agent", "claude-code",
      "--recommended-context-budget", "--json",
    ]);
    expectJsonErr(res, "CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it.each([
    ["recommend", ["recommend", "--phase", "P1", "--task", "P1-T1", "--agent", "claude-code"]],
    ["pack", ["pack", "--phase", "P1", "--task", "P1-T1", "--agent", "claude-code"]],
  ])("%s rejects --recommended-context-budget variants before writing context", async (_label, baseArgs) => {
    for (const flag of ["--recommended-context-budget", "--recommended-context-budget=false"]) {
      const res = project.run([...baseArgs, flag, "--json"]);
      const env = expectJsonErr(res, "CONFIG_ERROR");
      expect(env.error.message).toMatch(/only supported by task prepare/);
      expect(res.code).toBe(2);
    }
    expect(await fileExists(join(project.dir, ".context"))).toBe(false);
  });

  it.each([
    ["task context", ["task", "context", "P1-T1", "--agent", "claude-code"]],
    ["verify", ["verify", "--phase", "P1", "--task", "P1-T1"]],
    ["task complete", ["task", "complete", "P1-T1", "--agent", "claude-code"]],
  ])("%s keeps rejecting --recommended-context-budget", (_label, baseArgs) => {
    const res = project.run([...baseArgs, "--recommended-context-budget", "--json"]);
    expectJsonErr(res, "CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("--help includes both prepare budget flags", () => {
    const res = project.run(["task", "prepare", "--help"]);
    expect(res.stdout + res.stderr).toMatch(/--context-budget/);
    expect(res.stdout + res.stderr).toMatch(/--recommended-context-budget/);
  });
});

describe("task context --context-budget with an agent-defined profile (P47)", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-ctx-custom-" });
    await setupTask(project);
    // Declare a custom profile + override `tight` in the agent profile.
    const profilePath = join(
      project.dir, ".code-pact", "agent-profiles", "claude-code.yaml",
    );
    const profile = parseYaml(await readFile(profilePath, "utf8")) as Record<string, unknown>;
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
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--context-budget", "review", "--json",
      ]),
    );
    const byBytes = expectJsonOk<{ content: string }>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--budget-bytes", "45000", "--json",
      ]),
    );
    expect(byProfile.data.content).toBe(byBytes.data.content);
  });

  it("an agent override wins for a standard profile name", () => {
    const byProfile = expectJsonOk<{ content: string }>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--context-budget", "tight", "--json",
      ]),
    );
    const byBytes = expectJsonOk<{ content: string }>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--budget-bytes", "25000", "--json",
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
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--context-budget", "tight", "--json",
      ]),
    );
    // A standard name with no agent profile must equal --budget-bytes 30000 and
    // must NOT fail like a missing-profile error.
    const byBytes = expectJsonOk<{ content: string }>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--budget-bytes", "30000", "--json",
      ]),
    );
    expect(byProfile.data.content).toBe(byBytes.data.content);
  });

  it("a standard profile resolves when the agent profile has no context_budget block", () => {
    // The seeded profile has no context_budget by default — assert the built-in
    // fallback still applies (no override present).
    const byProfile = expectJsonOk<{ content: string }>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--context-budget", "balanced", "--json",
      ]),
    );
    const byBytes = expectJsonOk<{ content: string }>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--budget-bytes", "60000", "--json",
      ]),
    );
    expect(byProfile.data.content).toBe(byBytes.data.content);
  });

  it("a custom profile is CONFIG_ERROR when the agent profile file is deleted", async () => {
    await rm(profilePath(project.dir));
    const res = project.run([
      "task", "context", "P1-T1", "--agent", "claude-code",
      "--context-budget", "review", "--json",
    ]);
    // Custom names require an agent profile; absence is a real error.
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as { ok: boolean; error: { code: string } };
    expect(env.ok).toBe(false);
    // AGENT_NOT_FOUND (missing profile file) is the strict-load failure code.
    expect(["AGENT_NOT_FOUND", "CONFIG_ERROR"]).toContain(env.error.code);
  });

  it("an explicitly-declared but broken context_budget is CONFIG_ERROR even for a standard name", async () => {
    const profile = parseYaml(await readFile(profilePath(project.dir), "utf8")) as Record<string, unknown>;
    // Invalid: max_bytes must be a positive integer.
    profile.context_budget = { profiles: { tight: { max_bytes: 0 } } };
    await writeFile(profilePath(project.dir), stringifyYaml(profile), "utf8");
    const res = project.run([
      "task", "context", "P1-T1", "--agent", "claude-code",
      "--context-budget", "tight", "--json",
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
    const profile = parseYaml(await readFile(profilePath(project.dir), "utf8")) as Record<string, unknown>;
    profile.instruction_filename = "/etc/passwd"; // absolute → schema-invalid, unrelated to context_budget
    await writeFile(profilePath(project.dir), stringifyYaml(profile), "utf8");
    const byProfile = expectJsonOk<{ content: string }>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--context-budget", "tight", "--json",
      ]),
    );
    const byBytes = expectJsonOk<{ content: string }>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--budget-bytes", "30000", "--json",
      ]),
    );
    expect(byProfile.data.content).toBe(byBytes.data.content);
  });
});

// P47-6: task prepare's early-return states (done / blocked / unmet deps) skip
// the pack build, and must therefore NOT pay for --context-budget profile
// resolution. A done task asked to prepare with a profile that would otherwise
// be a hard CONFIG_ERROR must still return noop_already_done, proving the
// resolution is deferred behind the early return.
describe("task prepare --context-budget skips resolution on early-return states (P47)", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-prep-early-" });
    await setupTask(project);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("a done task returns noop_already_done even with an unknown --context-budget profile", () => {
    // Drive the task to done via the real lifecycle (node --version verify).
    expectJsonOk(project.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]));
    expectJsonOk(project.run(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]));

    // An UNKNOWN profile would be CONFIG_ERROR on the build path; on a done
    // task it must be skipped entirely.
    const env = expectJsonOk<{
      current_state: string;
      next_action: { type: string };
      context_pack_bytes: number;
      context_pack_path: string | null;
      applied_context_budget?: unknown;
      commands: { context: string };
    }>(
      project.run([
        "task", "prepare", "P1-T1", "--agent", "claude-code",
        "--context-budget", "definitely-not-a-profile", "--json",
      ]),
    );
    expect(env.data.current_state).toBe("done");
    expect(env.data.next_action.type).toBe("noop_already_done");
    expect(env.data.context_pack_bytes).toBe(0);
    expect(env.data.context_pack_path).toBeNull();
    expect(env.data.applied_context_budget).toBeUndefined();
    expect(env.data.commands.context).toBe(
      "code-pact task context P1-T1 --agent claude-code",
    );
  });

  it("a done task omits applied_context_budget even with --recommended-context-budget", () => {
    expectJsonOk(project.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]));
    expectJsonOk(project.run(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]));

    const env = expectJsonOk<{
      recommendation: null;
      applied_context_budget?: unknown;
      commands: { context: string };
      context_pack_bytes: number;
    }>(
      project.run([
        "task", "prepare", "P1-T1", "--agent", "claude-code",
        "--recommended-context-budget", "--json",
      ]),
    );
    expect(env.data.recommendation).toBeNull();
    expect(env.data.applied_context_budget).toBeUndefined();
    expect(env.data.context_pack_bytes).toBe(0);
    expect(env.data.commands.context).toBe(
      "code-pact task context P1-T1 --agent claude-code",
    );
  });
});

// P47: the documented error contract — "a malformed, explicitly-configured
// context_budget surfaces as CONFIG_ERROR when a --context-budget invocation
// needs to parse it" — must hold on the `task prepare` build path too, not only
// `task context`. On a buildable (planned) task, a broken context_budget block
// must produce a CONFIG_ERROR envelope, exit 2 — never an unclassified throw.
describe("task prepare --context-budget broken context_budget is CONFIG_ERROR (P47)", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;
  const profilePath = (dir: string) =>
    join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-prep-broken-" });
    await setupTask(project);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  async function writeBrokenContextBudget(): Promise<void> {
    const profile = parseYaml(await readFile(profilePath(project.dir), "utf8")) as Record<string, unknown>;
    // Invalid: max_bytes must be a positive integer.
    profile.context_budget = { profiles: { tight: { max_bytes: 0 } } };
    await writeFile(profilePath(project.dir), stringifyYaml(profile), "utf8");
  }

  it("a standard profile against a broken context_budget is CONFIG_ERROR / exit 2", async () => {
    await writeBrokenContextBudget();
    const res = project.run([
      "task", "prepare", "P1-T1", "--agent", "claude-code",
      "--context-budget", "tight", "--dry-run", "--json",
    ]);
    expectJsonErr(res, "CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("a custom profile against a broken context_budget is CONFIG_ERROR / exit 2", async () => {
    await writeBrokenContextBudget();
    const res = project.run([
      "task", "prepare", "P1-T1", "--agent", "claude-code",
      "--context-budget", "review", "--dry-run", "--json",
    ]);
    expectJsonErr(res, "CONFIG_ERROR");
    expect(res.code).toBe(2);
  });
});

describe("task prepare agent-profile recommended application mode (P53)", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;
  const profilePath = (dir: string) =>
    join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-prep-recommended-" });
    await setupTask(project);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  async function setContextBudget(contextBudget: Record<string, unknown>): Promise<void> {
    const profile = parseYaml(await readFile(profilePath(project.dir), "utf8")) as Record<string, unknown>;
    profile.context_budget = contextBudget;
    await writeFile(profilePath(project.dir), stringifyYaml(profile), "utf8");
  }

  it("no-flag task prepare applies profile opt-in and emits resolved bytes", async () => {
    await setContextBudget({ application_mode: "recommended" });
    const env = expectJsonOk<{
      recommendation: {
        contextFit: { recommendedProfile: string; recommendedBudgetBytes: number };
      };
      applied_context_budget: { source: string; profile: string; budget_bytes: number };
      commands: { context: string };
    }>(
      project.run([
        "task", "prepare", "P1-T1", "--agent", "claude-code",
        "--dry-run", "--json",
      ]),
    );
    expect(env.data.applied_context_budget).toEqual({
      source: "recommended_agent_profile",
      profile: env.data.recommendation.contextFit.recommendedProfile,
      budget_bytes: env.data.recommendation.contextFit.recommendedBudgetBytes,
    });
    expect(env.data.commands.context).toBe(
      `code-pact task context P1-T1 --agent claude-code --budget-bytes ${env.data.recommendation.contextFit.recommendedBudgetBytes}`,
    );
  });

  it("manual mode keeps no-flag task prepare unbudgeted", async () => {
    await setContextBudget({
      application_mode: "manual",
      profiles: { tight: { max_bytes: 28000 } },
    });
    const env = expectJsonOk<{
      applied_context_budget: { source: string };
      commands: { context: string };
    }>(
      project.run([
        "task", "prepare", "P1-T1", "--agent", "claude-code",
        "--dry-run", "--json",
      ]),
    );
    expect(env.data.applied_context_budget).toEqual({ source: "none" });
    expect(env.data.commands.context).toBe(
      "code-pact task context P1-T1 --agent claude-code",
    );
  });

  it("direct task context ignores profile recommended mode", async () => {
    await forceTaskBudgetDeferral(project);
    await setContextBudget({ application_mode: "recommended" });
    const direct = await runTaskContext({
      cwd: project.dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    const manualProfile = parseYaml(await readFile(profilePath(project.dir), "utf8")) as Record<string, unknown>;
    manualProfile.context_budget = {
      application_mode: "manual",
      profiles: { tight: { max_bytes: 30000 } },
    };
    await writeFile(profilePath(project.dir), stringifyYaml(manualProfile), "utf8");
    const manualDirect = await runTaskContext({
      cwd: project.dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });

    await setContextBudget({ application_mode: "recommended" });
    const explicit = expectJsonOk<{
      content: string;
      deferred_context: { manifest_ref: string; persisted: boolean };
    }>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--budget-bytes", "60000", "--json",
      ]),
    );
    const prepared = expectJsonOk<{
      applied_context_budget: { source: string; profile: string; budget_bytes: number };
      deferred_context: { persisted: boolean };
    }>(
      project.run([
        "task", "prepare", "P1-T1", "--agent", "claude-code",
        "--dry-run", "--json",
      ]),
    );

    expect(direct.content).toContain(FORCING_READ_MARKER);
    expect(direct.deferredContext).toBeUndefined();
    expect(manualDirect.content).toBe(direct.content);
    expect(manualDirect.deferredContext).toBeUndefined();
    expect(explicit.data.deferred_context).toMatchObject({ persisted: false });
    expect(explicit.data.content).toContain(`- \`docs/${FORCING_READ_MARKER}/**\``);
    expect(explicit.data.content).not.toContain(`entry-0000-${FORCING_READ_MARKER}.md`);
    expect(explicit.data.content).not.toBe(direct.content);
    expect(prepared.data.applied_context_budget).toEqual({
      source: "recommended_agent_profile",
      profile: "balanced",
      budget_bytes: 60000,
    });
    expect(prepared.data.deferred_context).toMatchObject({ persisted: false });
  });
});
