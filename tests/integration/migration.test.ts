// Migration / upgrade safety smoke.
//
// v1.0 P8-T4. Every prior alpha (v0.6, v0.7, v0.8, v0.9) produced
// projects with subtly different on-disk state. v1.0 must accept all of
// them without erroring. This test fixes each historical shape and
// asserts the recovery path.
//
// Why dynamic, not static fixtures
// --------------------------------
// The plan originally called for `tests/fixtures/migration/v06-project/`
// etc. as committed snapshots. We chose dynamic construction (init +
// targeted state mutation) instead because:
//
// 1. A static "v0.6-era project" committed at v1.0 time is really a
//    "v0.6-shape as v1.0 remembers it" — there is no source of truth to
//    diff it against.
// 2. The maintenance overhead of keeping the snapshot in sync with init
//    output across releases gives no behavioural payoff. What we want to
//    assert is **behaviour on shape X**, not "this exact byte sequence
//    still parses".
// 3. Dynamic construction makes the test read top-to-bottom as a story:
//    "given a project that has Y but not Z, when we run W, then ...".
//
// Known limit (intentional): the v1.0 `init` is used as the base layer
// for every fixture below. That gives us the project skeleton
// (.code-pact/, agent profiles, model profiles, .gitignore) without
// having to mirror it by hand in this test, and the historical state
// being exercised — empty progress.yaml, hand-edited phase YAML, stale
// adapter manifest — is layered on top. A consequence is that if init's
// own output drifts across a future release, this test exercises the
// new init output's compatibility, not the literal historical bytes.
// We accept that trade because:
//   - The historical behaviour we care about (no progress events / no
//     manifest / stale generator_version) is encoded explicitly in
//     the helpers below — those mutations are the contract.
//   - Re-grounding init across releases is desirable: it ensures the
//     test moves with the project rather than fossilizing.
//   - A fully literal historical fixture (hand-written project.yaml,
//     model-profiles, etc.) is a future refinement, not a v1.0 gate.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { createTempProject, ensureCliBuilt } from "../helpers/cli.ts";

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
  const p = await createTempProject({ prefix: `code-pact-migration-${prefix}-` });
  cleanups.push(p.cleanup);
  return p;
}

/** Add a phase with the same shape across all migration scenarios. */
function addPhase(p: Project, opts: { id: string; verifyCommand: string }): void {
  const res = p.run([
    "phase",
    "add",
    "--id",
    opts.id,
    "--name",
    `Phase ${opts.id}`,
    "--objective",
    `Phase ${opts.id} for migration test`,
    "--weight",
    "10",
    "--verify-command",
    opts.verifyCommand,
    "--json",
  ]);
  expect(res.code).toBe(0);
}

/** Inject a list of tasks into a phase YAML. Used to simulate historical
 *  task states that today's CLI would only produce through the wizard. */
async function injectTasks(
  p: Project,
  phaseFile: string,
  tasks: Array<Record<string, unknown>>,
): Promise<void> {
  const path = join(p.dir, "design", "phases", phaseFile);
  const doc = parseYaml(await readFile(path, "utf8")) as Record<string, unknown>;
  doc.tasks = tasks;
  await writeFile(path, stringifyYaml(doc), "utf8");
}

// ---------------------------------------------------------------------------
// v0.6-era shape: design tasks marked done, no progress events recorded
// ---------------------------------------------------------------------------
//
// Before v0.6 introduced task start / block / resume / complete, projects
// would mark tasks done by editing the design YAML directly. Their
// progress.yaml is empty (or absent). v1.0 must NOT treat this as drift
// in default `plan analyze` — it's exactly the case `done-historical`
// (hidden_by_default: true) exists to handle.

describe("migration: v0.6-era project (design done, no progress events)", () => {
  async function buildV06Project(prefix: string): Promise<Project> {
    const p = await freshProject(prefix);
    addPhase(p, { id: "P1", verifyCommand: "node --version" });
    await injectTasks(p, "P1-phase-p1.yaml", [
      {
        id: "P1-T1",
        type: "feature",
        ambiguity: "low",
        risk: "low",
        context_size: "small",
        write_surface: "low",
        verification_strength: "weak",
        expected_duration: "short",
        status: "done",
        description: "historical task — done in design, no progress events",
      },
    ]);
    return p;
  }

  it("doctor --json: legacy ADAPTER_MISSING fires, no manifest-aware codes", async () => {
    const p = await buildV06Project("v06-doctor");
    const env = p.runJson<{
      ok: boolean;
      issues: { code: string; severity: string }[];
    }>(["doctor", "--json"]);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const errors = env.data.issues.filter((i) => i.severity === "error");
      expect(errors).toEqual([]);
      const codes = env.data.issues.map((i) => i.code);
      // Legacy v0.8 path: ADAPTER_MISSING must fire when no manifest exists.
      expect(codes).toContain("ADAPTER_MISSING");
      // None of the manifest-aware codes may fire before adapter install.
      const manifestAware = [
        "ADAPTER_FILE_MISSING",
        "ADAPTER_FILE_DRIFT",
        "ADAPTER_DESIRED_STALE",
        "ADAPTER_GENERATOR_STALE",
        "ADAPTER_SCHEMA_DRIFT",
        "ADAPTER_PROFILE_DRIFT",
        "ADAPTER_UNMANAGED_FILE",
        "ADAPTER_MANIFEST_MISSING",
      ];
      for (const c of manifestAware) {
        expect(codes).not.toContain(c);
      }
    }
  });

  it("validate exits 0 (warnings allowed)", async () => {
    const p = await buildV06Project("v06-validate");
    const res = p.run(["validate"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Project validation passed.");
  });

  it("plan analyze hides the done-historical task by default", async () => {
    const p = await buildV06Project("v06-analyze");
    const env = p.runJson<{
      summary: { errors: number; warnings: number; hidden: number };
      issues: { code: string; details?: { kind?: string } }[];
    }>(["plan", "analyze", "--json"]);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.summary.errors).toBe(0);
      expect(env.data.summary.warnings).toBe(0);
      expect(env.data.summary.hidden).toBeGreaterThanOrEqual(1);
      // No visible issues — the historical task is suppressed.
      expect(env.data.issues).toEqual([]);
    }
  });

  it("plan analyze --include-historical surfaces the done-historical drift without affecting exit", async () => {
    const p = await buildV06Project("v06-analyze-hist");
    const res = p.run(["plan", "analyze", "--include-historical", "--json"]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as {
      data: { issues: { code: string; details?: { kind?: string } }[] };
    };
    const kinds = env.data.issues
      .filter((i) => i.code === "STATUS_DRIFT")
      .map((i) => i.details?.kind);
    expect(kinds).toContain("done-historical");
  });

  it("adapter upgrade --check refuses before adapter install (no manifest yet)", async () => {
    const p = await buildV06Project("v06-upgrade");
    const res = p.run(["adapter", "upgrade", "claude-code", "--check", "--json"]);
    expect(res.code).toBe(2);
    const env = JSON.parse(res.stdout) as { ok: boolean; error: { code: string } };
    expect(env.ok).toBe(false);
    expect(["MANIFEST_NOT_FOUND", "CONFIG_ERROR"]).toContain(env.error.code);
  });
});

// ---------------------------------------------------------------------------
// v0.8-era shape: progress events exist alongside a still-historical task
// ---------------------------------------------------------------------------
//
// v0.7 brought plan integrity; v0.8 brought budgeted recommend. Projects
// at that era had a working progress log AND historical leftovers from
// pre-v0.6 task editing. v1.0 must handle the mix.

describe("migration: v0.8-era project (mixed events + historical tasks)", () => {
  async function buildV08Project(prefix: string): Promise<Project> {
    const p = await freshProject(prefix);
    addPhase(p, { id: "P1", verifyCommand: "node --version" });
    await injectTasks(p, "P1-phase-p1.yaml", [
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
        description: "task we will mark started + done via events",
      },
      {
        id: "P1-T2",
        type: "feature",
        ambiguity: "low",
        risk: "low",
        context_size: "small",
        write_surface: "low",
        verification_strength: "weak",
        expected_duration: "short",
        status: "done",
        description: "historical task — design says done, no events ever fired",
      },
    ]);
    // Generate real progress events for P1-T1.
    p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);
    p.run(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]);
    return p;
  }

  it("doctor --json: legacy ADAPTER_MISSING fires, no manifest-aware codes", async () => {
    const p = await buildV08Project("v08-doctor");
    const env = p.runJson<{
      ok: boolean;
      issues: { code: string; severity: string }[];
    }>(["doctor", "--json"]);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const errors = env.data.issues.filter((i) => i.severity === "error");
      expect(errors).toEqual([]);
      const codes = env.data.issues.map((i) => i.code);
      expect(codes).toContain("ADAPTER_MISSING");
      const manifestAware = [
        "ADAPTER_FILE_MISSING",
        "ADAPTER_FILE_DRIFT",
        "ADAPTER_DESIRED_STALE",
        "ADAPTER_GENERATOR_STALE",
        "ADAPTER_SCHEMA_DRIFT",
        "ADAPTER_PROFILE_DRIFT",
        "ADAPTER_UNMANAGED_FILE",
        "ADAPTER_MANIFEST_MISSING",
      ];
      for (const c of manifestAware) {
        expect(codes).not.toContain(c);
      }
    }
  });

  it("plan analyze: P1-T1 shows the expected done-but-design-not-done warning; P1-T2 stays hidden as done-historical", async () => {
    const p = await buildV08Project("v08-analyze");
    const env = p.runJson<{
      summary: { errors: number; warnings: number; hidden: number };
      issues: { code: string; task_id?: string; details?: { kind?: string } }[];
    }>(["plan", "analyze", "--json"]);
    // task complete does NOT auto-flip design.status, so a real v0.8
    // project that recorded events without editing design YAML will see
    // this drift exactly the way the e2e test does. The point of this
    // assertion is to lock that contract: the warning is the expected
    // signal, not a regression.
    if (env.ok) {
      expect(env.data.summary.errors).toBe(0);
      const t1Drift = env.data.issues.find(
        (i) => i.code === "STATUS_DRIFT" && i.task_id === "P1-T1",
      );
      expect(t1Drift?.details?.kind).toBe("done-but-design-not-done");
      // P1-T2 is the historical one. With --include-historical it would
      // surface; in default mode it's hidden.
      const t2DriftVisible = env.data.issues.find(
        (i) => i.code === "STATUS_DRIFT" && i.task_id === "P1-T2",
      );
      expect(t2DriftVisible).toBeUndefined();
      expect(env.data.summary.hidden).toBeGreaterThanOrEqual(1);
    }
  });

  it("progress events for P1-T1 are readable via task status", async () => {
    const p = await buildV08Project("v08-status");
    const env = p.runJson<{
      current: string;
      history: { status: string }[];
    }>(["task", "status", "P1-T1", "--json"]);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.current).toBe("done");
      expect(env.data.history.map((h) => h.status)).toEqual(["started", "done"]);
    }
  });
});

// ---------------------------------------------------------------------------
// v0.9-era shape: manifest exists, generator_version is stale
// ---------------------------------------------------------------------------
//
// After upgrading from v0.9.x to v1.0.0, every existing manifest on disk
// will carry a generator_version like "0.9.0-alpha.0" while the running
// package is "1.0.0". This must surface as ADAPTER_GENERATOR_STALE
// (warning) — not as an error, not silently.

describe("migration: v0.9-era project (manifest with stale generator_version)", () => {
  async function buildV09StaleProject(prefix: string): Promise<{
    project: Project;
    manifestPath: string;
    originalVersion: string;
  }> {
    const p = await freshProject(prefix);
    addPhase(p, { id: "P1", verifyCommand: "node --version" });
    await injectTasks(p, "P1-phase-p1.yaml", [
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
        description: "v0.9 manifest test",
      },
    ]);
    const installRes = p.runJson<{ generatorVersion: string }>([
      "adapter",
      "install",
      "claude-code",
      "--json",
    ]);
    expect(installRes.ok).toBe(true);
    const manifestPath = join(p.dir, ".code-pact", "adapters", "claude-code.manifest.yaml");

    // Patch the manifest to simulate a pre-v1.0 generator_version.
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = parseYaml(manifestText) as Record<string, unknown>;
    const originalVersion = manifest.generator_version as string;
    manifest.generator_version = "0.8.0-alpha.0";
    await writeFile(manifestPath, stringifyYaml(manifest), "utf8");

    return { project: p, manifestPath, originalVersion };
  }

  it("adapter doctor surfaces ADAPTER_GENERATOR_STALE without erroring", async () => {
    const { project: p } = await buildV09StaleProject("v09-adapter-doctor");
    const env = p.runJson<{
      ok: boolean;
      issues: { code: string; severity: string }[];
    }>(["adapter", "doctor", "--json"]);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const errors = env.data.issues.filter((i) => i.severity === "error");
      expect(errors).toEqual([]);
      const codes = env.data.issues.map((i) => i.code);
      expect(codes).toContain("ADAPTER_GENERATOR_STALE");
    }
  });

  it("global doctor is manifest-aware: legacy ADAPTER_MISSING is gone, ADAPTER_GENERATOR_STALE surfaces", async () => {
    const { project: p } = await buildV09StaleProject("v09-global-doctor");
    const env = p.runJson<{
      ok: boolean;
      issues: { code: string; severity: string }[];
    }>(["doctor", "--json"]);
    expect(env.ok).toBe(true);
    if (env.ok) {
      const errors = env.data.issues.filter((i) => i.severity === "error");
      expect(errors).toEqual([]);
      const codes = env.data.issues.map((i) => i.code);
      expect(codes).not.toContain("ADAPTER_MISSING");
      expect(codes).toContain("ADAPTER_GENERATOR_STALE");
    }
  });

  it("adapter upgrade --write refreshes the manifest's generator_version", async () => {
    const { project: p, manifestPath, originalVersion } = await buildV09StaleProject("v09-upgrade");

    // Confirm the patch is in place before the upgrade.
    const beforeYaml = parseYaml(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    expect(beforeYaml.generator_version).toBe("0.8.0-alpha.0");

    const env = p.runJson(["adapter", "upgrade", "claude-code", "--write", "--json"]);
    expect(env.ok).toBe(true);

    const afterYaml = parseYaml(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    expect(afterYaml.generator_version).toBe(originalVersion);
    expect(afterYaml.generator_version).not.toBe("0.8.0-alpha.0");

    // After upgrade, adapter doctor should be clean (no STALE warning).
    const after = p.runJson<{
      ok: boolean;
      issues: { code: string }[];
    }>(["adapter", "doctor", "--json"]);
    expect(after.ok).toBe(true);
    if (after.ok) {
      const codes = after.data.issues.map((i) => i.code);
      expect(codes).not.toContain("ADAPTER_GENERATOR_STALE");
    }
  });

  it("validate exits 0 — STALE is a warning, not an error", async () => {
    const { project: p } = await buildV09StaleProject("v09-validate");
    const res = p.run(["validate"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Project validation passed.");
  });
});
