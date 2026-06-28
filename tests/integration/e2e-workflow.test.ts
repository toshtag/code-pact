// End-to-end workflow smoke test.
//
// v0.6-0.9 each shipped solid per-command integration tests. What was
// missing was a test that exercises the seams BETWEEN features: that
// init → adapter install → recommend → task context → task start →
// task complete → plan lint → adapter upgrade --check → doctor →
// validate all wire up against the same project state without a regression
// in one feature silently breaking another.
//
// Test policy (P8-T2):
//
// - Each scenario uses a single temp project; subsequent commands consume
//   the state the previous command produced.
// - Fixture verification.commands MUST be deterministic, cross-platform,
//   and independent of host project package scripts. We use `node --version`.
// - No wall-clock thresholds. The goal is seam regression coverage, not
//   performance benchmarking. CI flake on timing is unacceptable.
// - No network calls. No sleeps.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
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

// ---------------------------------------------------------------------------
// Scenario 1: full agent-facing loop, single happy-path workflow
// ---------------------------------------------------------------------------

describe("e2e: full agent-facing loop (init → adapter install → recommend → task → plan → doctor → validate)", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-e2e-full-" });
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("walks the full task lifecycle without breaking any seam", async () => {
    // Order note: design (phase + task) is set up BEFORE adapter install
    // so the install captures the final roadmap state. If install ran
    // first and phase add later, the adapter's dynamic skills (derived
    // from verification.commands across phases) would drift and
    // `adapter upgrade --check` at step 12 would correctly flag it.
    // The e2e smoke wants seam coverage of the happy path, not drift —
    // drift is exercised by the v0.9 adapter-cli test suite.

    // 1. phase add (deterministic verify command — see policy above).
    {
      const res = project.run([
        "phase",
        "add",
        "--id",
        "P1",
        "--name",
        "Foundation",
        "--objective",
        "Foundation phase for e2e smoke",
        "--weight",
        "10",
        "--verify-command",
        "node --version",
        "--json",
      ]);
      expectJsonOk(res);
    }

    // 2. Inject a single task into the phase YAML. `task add` is wizard-only
    //    (Stable (human-output)), so e2e must hand-edit the YAML the same
    //    way phase import / phase-wizard does for non-interactive flows.
    {
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
          description: "e2e smoke task",
        },
      ];
      await writeFile(phasePath, stringifyYaml(doc), "utf8");
    }

    // 3. adapter install — writes the per-agent manifest reflecting the
    //    final roadmap state.
    {
      const env = project.runJson<{
        agentName: string;
        manifestPath: string;
        files: { action: string }[];
      }>(["adapter", "install", "claude-code", "--json"]);
      expect(env.ok).toBe(true);
      if (env.ok) {
        expect(env.data.agentName).toBe("claude-code");
        expect(env.data.manifestPath).toContain(
          ".code-pact/adapters/claude-code.manifest.yaml",
        );
        expect(env.data.files.length).toBeGreaterThan(0);
      }
    }

    // 4. recommend — pure decision, no state mutation.
    {
      const env = project.runJson<{
        phaseId: string;
        taskId: string;
        tier: string;
        planningRequired: boolean;
        preflight: unknown[];
      }>(["recommend", "--phase", "P1", "--task", "P1-T1", "--json"]);
      expect(env.ok).toBe(true);
      if (env.ok) {
        expect(env.data.phaseId).toBe("P1");
        expect(env.data.taskId).toBe("P1-T1");
        // Don't pin tier value — different decision tables across versions
        // would make this test fragile. Just confirm a tier was chosen.
        expect(typeof env.data.tier).toBe("string");
        expect(Array.isArray(env.data.preflight)).toBe(true);
      }
    }

    // 5. task context — returns a markdown pack on stdout.
    {
      const res = project.run([
        "task",
        "context",
        "P1-T1",
        "--agent",
        "claude-code",
        "--json",
      ]);
      const env = expectJsonOk<{ markdown?: string; char_count?: number }>(res);
      // Be tolerant of the exact field name — pack shape has shifted historically.
      expect(res.code).toBe(0);
      expect(env.ok).toBe(true);
    }

    // 6. task start — appends started event.
    {
      const env = project.runJson<{ task_id: string }>([
        "task",
        "start",
        "P1-T1",
        "--agent",
        "claude-code",
        "--json",
      ]);
      expect(env.ok).toBe(true);
      if (env.ok) expect(env.data.task_id).toBe("P1-T1");
    }

    // 7. task status — derived current state must be "started".
    {
      const env = project.runJson<{ current: string; history: unknown[] }>([
        "task",
        "status",
        "P1-T1",
        "--json",
      ]);
      expect(env.ok).toBe(true);
      if (env.ok) {
        expect(env.data.current).toBe("started");
        expect(env.data.history.length).toBe(1);
      }
    }

    // 8. task complete — runs verify, appends done event.
    {
      const env = project.runJson<{
        task_id: string;
        event: { agent: string };
      }>(["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]);
      expect(env.ok).toBe(true);
      if (env.ok) {
        expect(env.data.task_id).toBe("P1-T1");
        expect(env.data.event.agent).toBe("claude-code");
      }
    }

    // 9. task status — derived state must be "done".
    {
      const env = project.runJson<{ current: string }>([
        "task",
        "status",
        "P1-T1",
        "--json",
      ]);
      expect(env.ok).toBe(true);
      if (env.ok) expect(env.data.current).toBe("done");
    }

    // 10. plan lint — design state must remain clean.
    {
      const env = project.runJson<{ errors: number; warnings: number }>([
        "plan",
        "lint",
        "--json",
      ]);
      expect(env.ok).toBe(true);
      if (env.ok) {
        expect(env.data.errors).toBe(0);
        expect(env.data.warnings).toBe(0);
      }
    }

    // 11. plan analyze — task P1-T1 has events now but design.status is
    //     still "planned", so plan analyze will surface a
    //     done-but-design-not-done STATUS_DRIFT warning (affects_exit:true
    //     for non-hidden warnings). That's a real seam: the e2e workflow
    //     records progress but does not flip design status. Document that
    //     by asserting the warning surfaces with the expected kind, rather
    //     than expecting clean.
    {
      const res = project.run(["plan", "analyze", "--json"]);
      // exit may be 0 (warnings-only) or 1 (strict mode promotes) — we
      // didn't pass --strict so default is 0 unless affects_exit warnings
      // are present, in which case analyze exits 1.
      const env = JSON.parse(res.stdout) as {
        ok: boolean;
        data: {
          issues: { code: string; details?: { kind?: string } }[];
        };
      };
      const driftKinds = env.data.issues
        .filter(i => i.code === "STATUS_DRIFT")
        .map(i => i.details?.kind);
      expect(driftKinds).toContain("done-but-design-not-done");
    }

    // 12. adapter upgrade --check — static files are clean, while the existing
    //     dynamic command skill is intentionally unverifiable in the shared
    //     namespace and must be refused without reading its bytes.
    {
      const env = project.runJson<{
        clean: boolean;
        plan: {
          relPath: string;
          action: string;
          reason?: string;
          local: string;
        }[];
      }>(["adapter", "upgrade", "claude-code", "--check", "--json"]);
      expect(env.ok).toBe(true);
      if (env.ok) {
        expect(env.data.clean).toBe(false);
        expect(
          env.data.plan.find(p => p.reason === "dynamic_file_unverifiable"),
        ).toMatchObject({
          local: "unverifiable",
          desired: "unverifiable",
          action: "warn",
          reason: "dynamic_file_unverifiable",
        });
      }
    }

    // 13. doctor --json — manifest is present, so manifest-aware checks
    //     run. No errors expected. (Gated warnings like BRIEF_MISSING /
    //     CONSTITUTION_PLACEHOLDER are acceptable once this project has a real
    //     phase; only errors are asserted against.)
    {
      const env = project.runJson<{
        ok: boolean;
        issues: { code: string; severity: string }[];
      }>(["doctor", "--json"]);
      expect(env.ok).toBe(true);
      if (env.ok) {
        const errors = env.data.issues.filter(i => i.severity === "error");
        expect(errors).toEqual([]);
      }
    }

    // 14. validate — exits 0 (no errors) and prints the success line.
    {
      const res = project.run(["validate"]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Project validation passed.");
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: pre-v0.9 migration path (no manifest → adapter install →
// manifest-aware doctor)
// ---------------------------------------------------------------------------

describe("e2e: pre-v0.9 migration path (no manifest → install → manifest-aware doctor)", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-e2e-migrate-" });
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("a freshly-init'd project without a manifest behaves like a v0.8 upgrade and recovers via adapter install", async () => {
    // Step 1 — before install, no manifest on disk. doctor should emit
    // the legacy v0.8-compatible ADAPTER_MISSING warning. Critically,
    // this must be a warning (exit 0), not an error.
    {
      const env = project.runJson<{
        ok: boolean;
        issues: { code: string; severity: string }[];
      }>(["doctor", "--json"]);
      expect(env.ok).toBe(true);
      if (env.ok) {
        const adapterMissing = env.data.issues.find(
          i => i.code === "ADAPTER_MISSING",
        );
        expect(adapterMissing).toBeDefined();
        expect(adapterMissing?.severity).toBe("warning");
        // No manifest-aware codes should appear yet — they're gated on
        // manifest presence.
        const manifestAware = env.data.issues.filter(i =>
          [
            "ADAPTER_FILE_MISSING",
            "ADAPTER_FILE_DRIFT",
            "ADAPTER_DESIRED_STALE",
            "ADAPTER_GENERATOR_STALE",
            "ADAPTER_SCHEMA_DRIFT",
            "ADAPTER_PROFILE_DRIFT",
            "ADAPTER_UNMANAGED_FILE",
            "ADAPTER_MANIFEST_MISSING",
          ].includes(i.code),
        );
        expect(manifestAware).toEqual([]);
      }
    }

    // Step 2 — adapter list reports manifestPresent: false.
    {
      const env = project.runJson<{
        agents: { name: string; manifestPresent: boolean }[];
      }>(["adapter", "list", "--json"]);
      expect(env.ok).toBe(true);
      if (env.ok) {
        const claude = env.data.agents.find(a => a.name === "claude-code");
        expect(claude).toBeDefined();
        expect(claude?.manifestPresent).toBe(false);
      }
    }

    // Step 3 — adapter upgrade --check before install must surface a
    // config-level error (no manifest to upgrade).
    {
      const res = project.run([
        "adapter",
        "upgrade",
        "claude-code",
        "--check",
        "--json",
      ]);
      expect(res.code).toBe(2);
      const env = expectJsonErr(res);
      expect(["MANIFEST_NOT_FOUND", "CONFIG_ERROR"]).toContain(env.error.code);
    }

    // Step 4 — adapter install creates the manifest.
    {
      const env = project.runJson<{
        manifestPath: string;
        files: { action: string }[];
      }>(["adapter", "install", "claude-code", "--json"]);
      expect(env.ok).toBe(true);
      if (env.ok) {
        expect(env.data.manifestPath).toContain(
          ".code-pact/adapters/claude-code.manifest.yaml",
        );
        expect(env.data.files.length).toBeGreaterThan(0);
      }
    }

    // Step 5 — doctor is now manifest-aware. The legacy ADAPTER_MISSING
    // must be GONE (no double-counting); errors must be empty.
    {
      const env = project.runJson<{
        ok: boolean;
        issues: { code: string; severity: string }[];
      }>(["doctor", "--json"]);
      expect(env.ok).toBe(true);
      if (env.ok) {
        const adapterMissing = env.data.issues.find(
          i => i.code === "ADAPTER_MISSING",
        );
        expect(adapterMissing).toBeUndefined();
        const errors = env.data.issues.filter(i => i.severity === "error");
        expect(errors).toEqual([]);
      }
    }

    // Step 6 — adapter upgrade --check after fresh install must be clean.
    {
      const env = project.runJson<{ clean: boolean }>([
        "adapter",
        "upgrade",
        "claude-code",
        "--check",
        "--json",
      ]);
      expect(env.ok).toBe(true);
      if (env.ok) expect(env.data.clean).toBe(true);
    }
  });
});
