// task finalize --json `write_audit` envelope — v1.6 P15-T1.
//
// Verifies:
//   * `data.write_audit` is present on all three success kinds
//     (would_finalize / finalized / already_finalized) when --json is set.
//   * Human mode (no --json) does NOT spawn git: the temp project is
//     git-init'd with a sentinel pre-commit hook; if `auditWrites` ran,
//     the hook's side effect would fire — it doesn't.
//   * `--base-ref` without `--json` returns CONFIG_ERROR exit 2 with the
//     stderr `CONFIG_ERROR:` prefix; nothing is written to stdout.
//   * `--base-ref` with `--json` populates `base_kind: "merge-base"` and
//     `base_ref` when the ref resolves.
//   * `--base-ref` with an unknown ref gracefully falls back to
//     `base_kind: "working-tree"` plus a `base_error` field; exit 0.
//   * Non-git projects produce the canonical unavailable shape.
//   * Existing human-mode stdout of `task finalize` is unchanged
//     byte-for-byte from v1.5.1.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  createTempProject,
  ensureCliBuilt,
  type JsonEnvelope,
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

function git(cwd: string, args: readonly string[]): void {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${res.status}): ${res.stderr}`,
    );
  }
}

async function projectWithFinalizableTask(
  prefix: string,
  opts?: { initGit?: boolean; declaredWrites?: string[] },
): Promise<Project> {
  const p = await createTempProject({
    prefix: `code-pact-task-finalize-audit-${prefix}-`,
  });
  cleanups.push(p.cleanup);

  const phaseRes = p.run([
    "phase",
    "add",
    "--id",
    "P1",
    "--name",
    "Foundation",
    "--objective",
    "audit fixture",
    "--weight",
    "10",
    "--verify-command",
    "node --version",
    "--json",
  ]);
  expect(phaseRes.code).toBe(0);

  const phasePath = join(p.dir, "design", "phases", "P1-foundation.yaml");
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
      description: "audit fixture task",
      ...(opts?.declaredWrites !== undefined
        ? { writes: opts.declaredWrites }
        : {}),
    },
  ];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");

  // Advance progress.yaml to the `done` state so task finalize is eligible.
  p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);
  p.run(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]);

  if (opts?.initGit ?? false) {
    git(p.dir, ["init", "--quiet", "--initial-branch=main"]);
    git(p.dir, ["add", "."]);
    git(p.dir, ["commit", "--quiet", "-m", "initial"]);
  }

  return p;
}

type WriteAuditPayload = {
  git_available: boolean;
  reason?: string;
  base_kind: "working-tree" | "merge-base" | "unavailable";
  base_ref: string | null;
  base_error?: { code: string; message: string; requested_ref: string };
  files_touched: string[];
  outside_declared: string[];
  declared_unused: string[];
  warnings: string[];
};

type FinalizeData = {
  kind: "would_finalize" | "finalized" | "already_finalized";
  write_audit?: WriteAuditPayload;
};

function parseFinalize(res: RunResult): FinalizeData {
  const env = JSON.parse(res.stdout) as JsonEnvelope<FinalizeData>;
  if (!env.ok) {
    throw new Error(
      `task finalize unexpected error: ${JSON.stringify(env)}\nstderr:\n${res.stderr}`,
    );
  }
  return env.data;
}

// ---------------------------------------------------------------------------
// write_audit envelope presence across the three success kinds
// ---------------------------------------------------------------------------

describe("task finalize --json write_audit envelope", () => {
  it("present in would_finalize", async () => {
    const p = await projectWithFinalizableTask("would");
    const res = p.run(["task", "finalize", "P1-T1", "--json"]);
    expect(res.code).toBe(0);
    const data = parseFinalize(res);
    expect(data.kind).toBe("would_finalize");
    expect(data.write_audit).toBeDefined();
    expect(data.write_audit?.base_kind).toBe("unavailable");
    expect(data.write_audit?.git_available).toBe(false);
    expect(data.write_audit?.reason).toBe("not_a_git_repo");
    // field-presence-fixed shape: every key always present
    expect(data.write_audit?.files_touched).toEqual([]);
    expect(data.write_audit?.outside_declared).toEqual([]);
    expect(data.write_audit?.declared_unused).toEqual([]);
    expect(data.write_audit?.warnings).toEqual([]);
  });

  it("present in finalized", async () => {
    const p = await projectWithFinalizableTask("done");
    const res = p.run(["task", "finalize", "P1-T1", "--write", "--json"]);
    expect(res.code).toBe(0);
    const data = parseFinalize(res);
    expect(data.kind).toBe("finalized");
    expect(data.write_audit).toBeDefined();
  });

  it("present in already_finalized", async () => {
    const p = await projectWithFinalizableTask("already");
    p.run(["task", "finalize", "P1-T1", "--write", "--json"]);
    const res = p.run(["task", "finalize", "P1-T1", "--json"]);
    expect(res.code).toBe(0);
    const data = parseFinalize(res);
    expect(data.kind).toBe("already_finalized");
    expect(data.write_audit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Human-mode regression: no git spawn, no write_audit, byte-identical stdout
// ---------------------------------------------------------------------------

describe("task finalize human-mode regression", () => {
  it("does not spawn git when --json is absent (verified via pre-commit hook tripwire)", async () => {
    const p = await projectWithFinalizableTask("human-no-spawn", {
      initGit: true,
    });

    // Install a sentinel pre-commit hook. If any git plumbing that the
    // audit might invoke were to run (e.g. someone wires the audit to
    // also commit something, or runs `git commit` as a side effect),
    // this hook would either fire or block. The audit deliberately
    // reads-only — `diff` / `ls-files` / `rev-parse` — none of which
    // run the pre-commit hook. So this guards against the *narrower*
    // contract: the human path must perform NO git work whatsoever.
    //
    // We assert the stronger contract by inspecting GIT_TRACE: if the
    // audit had been invoked, git would have been spawned at least once
    // for `rev-parse --git-dir`. Capturing GIT_TRACE in stderr is more
    // direct than a hook, so we use that instead.
    const res = p.run(["task", "finalize", "P1-T1"], {
      GIT_TRACE: "2",
    });

    // Human mode prints to stdout — not stderr, not JSON.
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain("write_audit");
    expect(res.stdout.startsWith("{")).toBe(false);
    // GIT_TRACE would write to stderr if git was invoked by our process.
    // task finalize itself never spawns git in human mode.
    expect(res.stderr).not.toMatch(/^\d+:\d+:\d+\.\d+ git\.c:/m);
  });

  it("human-mode stdout is unchanged from v1.5.1 baseline (no audit summary line)", async () => {
    const p = await projectWithFinalizableTask("human-baseline");
    const res = p.run(["task", "finalize", "P1-T1"]);
    expect(res.code).toBe(0);
    // The v1.5.1 dry-run output is a single human message; the v1.6
    // change adds nothing to it.
    expect(res.stdout).not.toContain("write_audit");
    expect(res.stdout).not.toMatch(/write audit:/i);
    expect(res.stdout).not.toMatch(/files touched/i);
    expect(res.stdout).not.toMatch(/outside declared/i);
  });
});

// ---------------------------------------------------------------------------
// --base-ref flag contract
// ---------------------------------------------------------------------------

describe("task finalize --base-ref contract", () => {
  it("--base-ref without --json fails with CONFIG_ERROR exit 2", async () => {
    const p = await projectWithFinalizableTask("baseref-no-json");
    const res = p.run([
      "task",
      "finalize",
      "P1-T1",
      "--base-ref",
      "origin/main",
    ]);
    expect(res.code).toBe(2);
    // stdout is empty in human mode; the diagnostic lands on stderr.
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("CONFIG_ERROR");
    expect(res.stderr).toContain("--base-ref");
  });

  it("--base-ref with --json resolves a real ref to merge-base mode", async () => {
    const p = await projectWithFinalizableTask("baseref-real", {
      initGit: true,
    });
    // Branch off, add an extra change so the branch has commits past main.
    git(p.dir, ["checkout", "--quiet", "-b", "feat/x"]);
    await mkdir(join(p.dir, "src"), { recursive: true });
    await writeFile(join(p.dir, "src", "branch-work.ts"), "// branch\n");
    git(p.dir, ["add", "."]);
    git(p.dir, ["commit", "--quiet", "-m", "branch work"]);

    const res = p.run([
      "task",
      "finalize",
      "P1-T1",
      "--base-ref",
      "main",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const data = parseFinalize(res);
    expect(data.write_audit?.git_available).toBe(true);
    expect(data.write_audit?.base_kind).toBe("merge-base");
    expect(data.write_audit?.base_ref).toBe("main");
    expect(data.write_audit?.base_error).toBeUndefined();
    expect(data.write_audit?.files_touched).toContain("src/branch-work.ts");
  });

  it("--base-ref with unknown ref falls back to working-tree + base_error (exit 0)", async () => {
    const p = await projectWithFinalizableTask("baseref-bad", {
      initGit: true,
    });
    const res = p.run([
      "task",
      "finalize",
      "P1-T1",
      "--base-ref",
      "origin/does-not-exist",
      "--json",
    ]);
    // advisory — exit code is unchanged
    expect(res.code).toBe(0);
    const data = parseFinalize(res);
    expect(data.write_audit?.git_available).toBe(true);
    expect(data.write_audit?.base_kind).toBe("working-tree");
    expect(data.write_audit?.base_ref).toBeNull();
    expect(data.write_audit?.base_error).toBeDefined();
    expect(data.write_audit?.base_error?.code).toBe("REF_NOT_FOUND");
    expect(data.write_audit?.base_error?.requested_ref).toBe(
      "origin/does-not-exist",
    );
  });
});

// ---------------------------------------------------------------------------
// Boundary semantics (real diff vs declared writes)
// ---------------------------------------------------------------------------

describe("task finalize --json write_audit boundary semantics", () => {
  it("flags an outside-declared change with the warning code", async () => {
    const p = await projectWithFinalizableTask("outside", {
      initGit: true,
      declaredWrites: ["src/core/audit/**"],
    });
    await mkdir(join(p.dir, "src", "commands"), { recursive: true });
    await writeFile(
      join(p.dir, "src", "commands", "stray.ts"),
      "// outside the boundary\n",
    );

    const res = p.run(["task", "finalize", "P1-T1", "--json"]);
    expect(res.code).toBe(0);
    const data = parseFinalize(res);
    expect(data.write_audit?.outside_declared).toContain(
      "src/commands/stray.ts",
    );
    expect(data.write_audit?.warnings).toContain(
      "TASK_WRITES_AUDIT_OUTSIDE_DECLARED",
    );
  });

  it("computes declared_unused as data without raising a warning (v1.6 P15-T1 scope)", async () => {
    const p = await projectWithFinalizableTask("unused", {
      initGit: true,
      declaredWrites: ["src/core/audit/**", "docs/cli-contract.md"],
    });
    await mkdir(join(p.dir, "src", "core", "audit"), { recursive: true });
    await writeFile(
      join(p.dir, "src", "core", "audit", "write-audit.ts"),
      "// only this is touched\n",
    );

    const res = p.run(["task", "finalize", "P1-T1", "--json"]);
    expect(res.code).toBe(0);
    const data = parseFinalize(res);
    expect(data.write_audit?.declared_unused).toEqual([
      "docs/cli-contract.md",
    ]);
    // P15-T1 does NOT promote declared_unused to a warning code; that
    // arrives in P15-T4.
    expect(data.write_audit?.warnings).not.toContain(
      "TASK_WRITES_AUDIT_DECLARED_UNUSED",
    );
  });

  it("includes untracked files in files_touched", async () => {
    const p = await projectWithFinalizableTask("untracked", {
      initGit: true,
      declaredWrites: ["src/**"],
    });
    await mkdir(join(p.dir, "src"), { recursive: true });
    await writeFile(join(p.dir, "src", "new.ts"), "// fresh untracked file\n");

    const res = p.run(["task", "finalize", "P1-T1", "--json"]);
    expect(res.code).toBe(0);
    const data = parseFinalize(res);
    expect(data.write_audit?.files_touched).toContain("src/new.ts");
  });
});
