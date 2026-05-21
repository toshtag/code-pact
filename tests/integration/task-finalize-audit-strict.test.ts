// `task finalize --audit-strict` integration tests — v1.6 P15-T6.
//
// Verifies:
//   * --audit-strict + clean audit → exit 0 + success envelope unchanged.
//   * --audit-strict + warnings → exit 1 + WRITES_AUDIT_STRICT_FAILED
//     envelope carrying the full write_audit + applied: false.
//   * --audit-strict + --write + warnings → exit 1 AND design YAML
//     stays byte-identical (no flip).
//   * --audit-strict without --json → CONFIG_ERROR exit 2 (silent
//     no-op prevention).
//   * Default behaviour (no --audit-strict) with the same warning
//     conditions still exits 0 (regression).

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  createTempProject,
  ensureCliBuilt,
  type JsonEnvelope,
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
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
}

async function projectWithFinalizableTask(
  prefix: string,
  opts: { declaredWrites?: string[]; initGit?: boolean } = {},
): Promise<Project> {
  const p = await createTempProject({
    prefix: `code-pact-task-finalize-audit-strict-${prefix}-`,
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
    "audit-strict fixture",
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
      description: "audit-strict fixture",
      ...(opts.declaredWrites !== undefined
        ? { writes: opts.declaredWrites }
        : {}),
    },
  ];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");

  p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);
  p.run(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]);

  if (opts.initGit ?? false) {
    git(p.dir, ["init", "--quiet", "--initial-branch=main"]);
    git(p.dir, ["add", "."]);
    git(p.dir, ["commit", "--quiet", "-m", "initial"]);
  }

  return p;
}

type StrictData = {
  task_id?: string;
  phase_id?: string;
  applied?: boolean;
  write_audit?: { warnings?: string[]; outside_declared?: string[] };
};

// ---------------------------------------------------------------------------
// CONFIG_ERROR: --audit-strict requires --json
// ---------------------------------------------------------------------------

describe("task finalize --audit-strict CONFIG_ERROR", () => {
  it("returns CONFIG_ERROR exit 2 when --audit-strict is passed without --json", async () => {
    const p = await projectWithFinalizableTask("no-json");
    const res = p.run(["task", "finalize", "P1-T1", "--audit-strict"]);
    expect(res.code).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("CONFIG_ERROR");
    expect(res.stderr).toContain("--audit-strict");
  });
});

// ---------------------------------------------------------------------------
// Clean audit → strict gate passes
// ---------------------------------------------------------------------------

describe("task finalize --audit-strict clean path", () => {
  it("non-git project (no audit possible) → exit 0 + would_finalize", async () => {
    // git_available: false → empty warnings → strict gate must not
    // fire. The audit envelope's field-presence-fixed shape still
    // appears on the success envelope.
    const p = await projectWithFinalizableTask("non-git-clean");
    const res = p.run([
      "task",
      "finalize",
      "P1-T1",
      "--audit-strict",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<{
      kind: string;
      write_audit: { git_available: boolean; warnings: string[] };
    }>;
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.kind).toBe("would_finalize");
      expect(env.data.write_audit.git_available).toBe(false);
      expect(env.data.write_audit.warnings).toEqual([]);
    }
  });

  it("git project with exact-match declared writes → exit 0", async () => {
    const p = await projectWithFinalizableTask("git-clean", {
      initGit: true,
      declaredWrites: ["src/x.ts"],
    });
    await mkdir(join(p.dir, "src"), { recursive: true });
    await writeFile(join(p.dir, "src/x.ts"), "// declared and touched\n", "utf8");
    const res = p.run([
      "task",
      "finalize",
      "P1-T1",
      "--audit-strict",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<{
      kind: string;
      write_audit: { warnings: string[] };
    }>;
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.write_audit.warnings).toEqual([]);
      expect(env.data.kind).toBe("would_finalize");
    }
  });
});

// ---------------------------------------------------------------------------
// Audit warnings → strict gate refuses (exit 1, no design YAML mutation)
// ---------------------------------------------------------------------------

describe("task finalize --audit-strict warning path", () => {
  it("warning fires → exit 1 + WRITES_AUDIT_STRICT_FAILED envelope", async () => {
    const p = await projectWithFinalizableTask("warn", {
      initGit: true,
      declaredWrites: ["src/declared/**"],
    });
    await mkdir(join(p.dir, "src/stray"), { recursive: true });
    await writeFile(
      join(p.dir, "src/stray/outside.ts"),
      "// outside declared writes\n",
      "utf8",
    );
    const res = p.run([
      "task",
      "finalize",
      "P1-T1",
      "--audit-strict",
      "--json",
    ]);
    expect(res.code).toBe(1);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("WRITES_AUDIT_STRICT_FAILED");
      expect(env.data?.task_id).toBe("P1-T1");
      expect(env.data?.phase_id).toBe("P1");
      expect(env.data?.applied).toBe(false);
      expect(env.data?.write_audit?.warnings).toContain(
        "TASK_WRITES_AUDIT_OUTSIDE_DECLARED",
      );
      expect(env.data?.write_audit?.outside_declared).toContain(
        "src/stray/outside.ts",
      );
    }
  });

  it("--write + warning + --audit-strict → exit 1 AND design YAML byte-identical (no flip)", async () => {
    const p = await projectWithFinalizableTask("write-blocked", {
      initGit: true,
      declaredWrites: ["src/declared/**"],
    });
    await mkdir(join(p.dir, "src/stray"), { recursive: true });
    await writeFile(
      join(p.dir, "src/stray/outside.ts"),
      "// outside\n",
      "utf8",
    );

    const phasePath = join(p.dir, "design/phases/P1-foundation.yaml");
    const before = await readFile(phasePath, "utf8");

    const res = p.run([
      "task",
      "finalize",
      "P1-T1",
      "--audit-strict",
      "--write",
      "--json",
    ]);
    expect(res.code).toBe(1);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("WRITES_AUDIT_STRICT_FAILED");
      expect(env.data?.applied).toBe(false);
    }

    // The critical contract: --write was set but the gate fired
    // before applyPlannedWrite. The phase YAML must be byte-identical.
    const after = await readFile(phasePath, "utf8");
    expect(after).toBe(before);
  });

  it("DECLARED_UNUSED-only path also trips the gate", async () => {
    // Declare writes that match nothing in the diff. No
    // OUTSIDE_DECLARED, only DECLARED_UNUSED → strict gate still
    // refuses (treats either warning as a failure).
    const p = await projectWithFinalizableTask("unused-only", {
      initGit: true,
      declaredWrites: ["src/declared/that/does/not/exist/**"],
    });
    const res = p.run([
      "task",
      "finalize",
      "P1-T1",
      "--audit-strict",
      "--json",
    ]);
    expect(res.code).toBe(1);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("WRITES_AUDIT_STRICT_FAILED");
      expect(env.data?.write_audit?.warnings).toContain(
        "TASK_WRITES_AUDIT_DECLARED_UNUSED",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Regression — default behaviour unchanged
// ---------------------------------------------------------------------------

describe("task finalize default (no --audit-strict) regression", () => {
  it("warning fires without --audit-strict → exit 0 + would_finalize (advisory only)", async () => {
    const p = await projectWithFinalizableTask("regression-no-strict", {
      initGit: true,
      declaredWrites: ["src/declared/**"],
    });
    await mkdir(join(p.dir, "src/stray"), { recursive: true });
    await writeFile(
      join(p.dir, "src/stray/outside.ts"),
      "// outside\n",
      "utf8",
    );
    const res = p.run(["task", "finalize", "P1-T1", "--json"]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<{
      kind: string;
      write_audit: { warnings: string[] };
    }>;
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.kind).toBe("would_finalize");
      // The advisory is still emitted — it just doesn't gate the exit.
      expect(env.data.write_audit.warnings.length).toBeGreaterThan(0);
    }
  });
});
