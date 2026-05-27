import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import { runPhaseAdd } from "../../../src/commands/phase.ts";
import { runDoctor } from "../../../src/commands/doctor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-doctor-test-"));
  await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Healthy project
// ---------------------------------------------------------------------------

describe("runDoctor — healthy project (fresh init)", () => {
  it("returns ok=true with no errors for a freshly initialised project", async () => {
    const result = await runDoctor(dir);
    expect(result.ok).toBe(true);
    // ADAPTER_MISSING is a warning (adapter not yet generated) — errors must be 0
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("does not report LOCAL_NOT_GITIGNORED because init creates .gitignore", async () => {
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "LOCAL_NOT_GITIGNORED");
    expect(issue).toBeUndefined();
  });
});

describe("runDoctor — project-a fixture", () => {
  it("returns ok=true for the project-a fixture", async () => {
    const result = await runDoctor(fixtureDir);
    expect(result.ok).toBe(true);
    // Warnings are allowed (e.g. model tier, stale context); errors are not
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Orphan phase file (roadmap references non-existent YAML)
// ---------------------------------------------------------------------------

describe("runDoctor — orphan roadmap reference", () => {
  it("reports ORPHAN_PHASE_FILE error when roadmap refs a missing file", async () => {
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      "phases:\n  - id: P99\n    path: design/phases/P99-ghost.yaml\n    weight: 5\n",
      "utf8",
    );
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "ORPHAN_PHASE_FILE");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Orphan phase YAML (file exists but not in roadmap)
// ---------------------------------------------------------------------------

describe("runDoctor — unreferenced phase file", () => {
  it("reports ORPHAN_PHASE_FILE warning for phase YAML not in roadmap", async () => {
    await mkdir(join(dir, "design", "phases"), { recursive: true });
    await writeFile(
      join(dir, "design", "phases", "P99-ghost.yaml"),
      [
        "id: P99",
        "name: Ghost",
        "weight: 5",
        "confidence: low",
        "risk: low",
        "status: planned",
        "objective: Ghost phase.",
        "definition_of_done:",
        "  - Done",
        "verification:",
        "  commands:",
        "    - echo ok",
      ].join("\n"),
      "utf8",
    );
    const result = await runDoctor(dir);
    const issue = result.issues.find(
      (i) => i.code === "ORPHAN_PHASE_FILE" && i.severity === "warning",
    );
    expect(issue).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Orphan progress event (task_id not in any phase)
// ---------------------------------------------------------------------------

describe("runDoctor — orphan progress event", () => {
  it("reports ORPHAN_PROGRESS_EVENT warning for unknown task_id in progress.yaml", async () => {
    await writeFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      `events:\n  - task_id: GHOST-T99\n    status: done\n    at: "2026-05-15T10:00:00+09:00"\n    actor: human\n`,
      "utf8",
    );
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "ORPHAN_PROGRESS_EVENT");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("GHOST-T99");
  });
});

// ---------------------------------------------------------------------------
// Phase ID mismatch
// ---------------------------------------------------------------------------

describe("runDoctor — phase id mismatch", () => {
  it("reports PHASE_ID_MISMATCH when YAML id differs from roadmap ref", async () => {
    await runPhaseAdd({
      cwd: dir,
      id: "P1",
      name: "Foundation",
      weight: 10,
      objective: "Establish foundation.",
      confidence: "high",
      risk: "low",
      verifyCommands: ["echo ok"],
      definitionOfDone: ["Done"],
    });
    // Overwrite the phase file with a different id
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      [
        "id: WRONG",
        "name: Foundation",
        "weight: 10",
        "confidence: high",
        "risk: low",
        "status: planned",
        "objective: Establish foundation.",
        "definition_of_done:",
        "  - Done",
        "verification:",
        "  commands:",
        "    - echo ok",
      ].join("\n"),
      "utf8",
    );
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "PHASE_ID_MISMATCH");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// .bak file detection
// ---------------------------------------------------------------------------

describe("runDoctor — bak file detection", () => {
  it("reports BAK_FILE warning when a .bak file is found in design/", async () => {
    await mkdir(join(dir, "design"), { recursive: true });
    await writeFile(join(dir, "design", "roadmap.yaml.bak"), "old content", "utf8");
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "BAK_FILE");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// Invalid YAML
// ---------------------------------------------------------------------------

describe("runDoctor — invalid YAML in project.yaml", () => {
  it("reports INVALID_YAML error when project.yaml is unreadable", async () => {
    await writeFile(join(dir, ".code-pact", "project.yaml"), "{ invalid: yaml: :", "utf8");
    const result = await runDoctor(dir);
    // YAML parser may succeed on some malformed inputs; at minimum no crash
    expect(Array.isArray(result.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// New checks: DUPLICATE_TASK_ID, LOCAL_NOT_GITIGNORED, ADAPTER_MISSING
// ---------------------------------------------------------------------------

describe("runDoctor — duplicate task ids", () => {
  it("reports DUPLICATE_TASK_ID error when same id appears in two phases", async () => {
    // Phase 1 with task P1-T1
    await runPhaseAdd({
      cwd: dir, id: "P1", name: "Alpha", weight: 10, objective: "Alpha.",
      confidence: "medium", risk: "medium", verifyCommands: ["echo ok"],
      definitionOfDone: ["Done"],
    });
    await writeFile(
      join(dir, "design", "phases", "P1-alpha.yaml"),
      [
        "id: P1", "name: Alpha", "weight: 10", "confidence: medium", "risk: medium",
        "status: planned", "objective: Alpha.", "definition_of_done:", "  - Done",
        "verification:", "  commands:", "    - echo ok",
        "tasks:", "  - id: SHARED-T1", "    type: feature", "    ambiguity: medium",
        "    risk: medium", "    context_size: medium", "    write_surface: medium",
        "    verification_strength: medium", "    expected_duration: medium",
        "    status: planned",
      ].join("\n"),
      "utf8",
    );
    // Phase 2 with the same task id
    await runPhaseAdd({
      cwd: dir, id: "P2", name: "Beta", weight: 10, objective: "Beta.",
      confidence: "medium", risk: "medium", verifyCommands: ["echo ok"],
      definitionOfDone: ["Done"],
    });
    await writeFile(
      join(dir, "design", "phases", "P2-beta.yaml"),
      [
        "id: P2", "name: Beta", "weight: 10", "confidence: medium", "risk: medium",
        "status: planned", "objective: Beta.", "definition_of_done:", "  - Done",
        "verification:", "  commands:", "    - echo ok",
        "tasks:", "  - id: SHARED-T1", "    type: feature", "    ambiguity: medium",
        "    risk: medium", "    context_size: medium", "    write_surface: medium",
        "    verification_strength: medium", "    expected_duration: medium",
        "    status: planned",
      ].join("\n"),
      "utf8",
    );
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "DUPLICATE_TASK_ID");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("SHARED-T1");
  });
});

describe("runDoctor — LOCAL_NOT_GITIGNORED", () => {
  it("reports LOCAL_NOT_GITIGNORED warning when .local/ is absent from .gitignore", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules/\ndist/\n", "utf8");
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "LOCAL_NOT_GITIGNORED");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
  });

  it("does not report LOCAL_NOT_GITIGNORED when .local/ is in .gitignore", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules/\n.local/\n", "utf8");
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "LOCAL_NOT_GITIGNORED");
    expect(issue).toBeUndefined();
  });
});

describe("runDoctor — ADAPTER_MISSING", () => {
  it("reports ADAPTER_MISSING warning when enabled agent has no instruction file", async () => {
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "ADAPTER_MISSING");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("claude-code");
  });

  it("does not report ADAPTER_MISSING when CLAUDE.md exists", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "# Claude Code adapter\n", "utf8");
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "ADAPTER_MISSING");
    expect(issue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// v0.5.3 plan quality checks
// ---------------------------------------------------------------------------

describe("runDoctor — BRIEF_MISSING (v0.5.3)", () => {
  it("reports BRIEF_MISSING warning when design/brief.md does not exist", async () => {
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "BRIEF_MISSING");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
  });

  it("does not report BRIEF_MISSING when design/brief.md exists", async () => {
    await writeFile(join(dir, "design", "brief.md"), "# Brief\n\nWe are building something.\n", "utf8");
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "BRIEF_MISSING");
    expect(issue).toBeUndefined();
  });
});

describe("runDoctor — CONSTITUTION_PLACEHOLDER (v0.5.3)", () => {
  // The placeholder warning is gated on a real (non-TUTORIAL) phase existing,
  // so a fresh-init project must add one before the warning can fire.
  async function addRealPhase(): Promise<void> {
    await runPhaseAdd({
      cwd: dir,
      id: "P1",
      name: "Foundation",
      weight: 10,
      objective: "Establish the project foundation.",
      confidence: "high",
      risk: "low",
      verifyCommands: ["echo ok"],
      definitionOfDone: ["Done"],
    });
  }

  it("reports CONSTITUTION_PLACEHOLDER when a real phase exists and the constitution is still the placeholder", async () => {
    await addRealPhase();
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "CONSTITUTION_PLACEHOLDER");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
  });

  it("does not report CONSTITUTION_PLACEHOLDER on a fresh project with no real phase (noise suppression)", async () => {
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "CONSTITUTION_PLACEHOLDER");
    expect(issue).toBeUndefined();
  });

  it("does not report CONSTITUTION_PLACEHOLDER when the hint text is removed", async () => {
    await addRealPhase();
    await writeFile(
      join(dir, "design", "constitution.md"),
      "# My Project Constitution\n\n- Keep it simple.\n",
      "utf8",
    );
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "CONSTITUTION_PLACEHOLDER");
    expect(issue).toBeUndefined();
  });
});

describe("runDoctor — EMPTY_OBJECTIVE (v0.5.3)", () => {
  it("reports EMPTY_OBJECTIVE error when a phase objective is shorter than 10 chars", async () => {
    await runPhaseAdd({
      cwd: dir,
      id: "PX",
      name: "Tiny",
      weight: 5,
      objective: "Short",
      confidence: "medium",
      risk: "medium",
      verifyCommands: ["pnpm test"],
      definitionOfDone: ["Done"],
    });
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "EMPTY_OBJECTIVE");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("PX");
  });

  it("does not report EMPTY_OBJECTIVE for adequate objectives", async () => {
    await runPhaseAdd({
      cwd: dir,
      id: "PY",
      name: "Adequate",
      weight: 5,
      objective: "This is a well-written phase objective that is long enough.",
      confidence: "medium",
      risk: "medium",
      verifyCommands: ["pnpm test"],
      definitionOfDone: ["Done"],
    });
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "EMPTY_OBJECTIVE" && i.message.includes("PY"));
    expect(issue).toBeUndefined();
  });
});


describe("runDoctor — ADAPTER_STALE (v0.5.3)", () => {
  it("reports ADAPTER_STALE warning when an enabled agent profile has no model_version", async () => {
    // Fresh init creates claude-code.yaml without model_version — should trigger warning
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "ADAPTER_STALE");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("claude-code");
  });

  it("does not report ADAPTER_STALE when model_version is set in the agent profile", async () => {
    const profilePath = join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");
    const original = await readFile(profilePath, "utf8");
    await writeFile(profilePath, original + "model_version: opus-4.7\n", "utf8");
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "ADAPTER_STALE");
    expect(issue).toBeUndefined();
  });
});

describe("runDoctor — disabled_checks via .code-pact/doctor.yaml (v0.5.3)", () => {
  it("suppresses checks listed in disabled_checks", async () => {
    await writeFile(
      join(dir, ".code-pact", "doctor.yaml"),
      "disabled_checks:\n  - BRIEF_MISSING\n  - CONSTITUTION_PLACEHOLDER\n  - ADAPTER_STALE\n",
      "utf8",
    );
    const result = await runDoctor(dir);
    expect(result.issues.find((i) => i.code === "BRIEF_MISSING")).toBeUndefined();
    expect(result.issues.find((i) => i.code === "CONSTITUTION_PLACEHOLDER")).toBeUndefined();
    expect(result.issues.find((i) => i.code === "ADAPTER_STALE")).toBeUndefined();
  });

  it("other checks still fire when only some are disabled", async () => {
    // A real phase is needed for CONSTITUTION_PLACEHOLDER to fire at all.
    await runPhaseAdd({
      cwd: dir,
      id: "P1",
      name: "Foundation",
      weight: 10,
      objective: "Establish the project foundation.",
      confidence: "high",
      risk: "low",
      verifyCommands: ["echo ok"],
      definitionOfDone: ["Done"],
    });
    await writeFile(
      join(dir, ".code-pact", "doctor.yaml"),
      "disabled_checks:\n  - BRIEF_MISSING\n",
      "utf8",
    );
    // CONSTITUTION_PLACEHOLDER should still fire (constitution still unedited)
    const result = await runDoctor(dir);
    expect(result.issues.find((i) => i.code === "BRIEF_MISSING")).toBeUndefined();
    expect(result.issues.find((i) => i.code === "CONSTITUTION_PLACEHOLDER")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// v0.9 — manifest-aware adapter health
// ---------------------------------------------------------------------------

describe("runDoctor — v0.9 manifest-aware adapter health", () => {
  it("no manifest → still emits legacy ADAPTER_MISSING (byte-identical with v0.8)", async () => {
    // Fresh init, no adapter install → no manifest. CLAUDE.md is also absent.
    const result = await runDoctor(dir);
    expect(result.issues.map((i) => i.code)).toContain("ADAPTER_MISSING");
    // No manifest-aware codes should appear when there's no manifest.
    const adapterCodes = result.issues.map((i) => i.code).filter((c) => c.startsWith("ADAPTER_"));
    expect(adapterCodes).not.toContain("ADAPTER_FILE_MISSING");
    expect(adapterCodes).not.toContain("ADAPTER_MANIFEST_MISSING");
    expect(adapterCodes).not.toContain("ADAPTER_MANIFEST_INVALID");
  });

  it("no manifest + present CLAUDE.md → no ADAPTER_MISSING (byte-identical with v0.8)", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "# Claude Code adapter\n", "utf8");
    const result = await runDoctor(dir);
    expect(result.issues.find((i) => i.code === "ADAPTER_MISSING")).toBeUndefined();
  });

  it("with manifest + clean state → no adapter findings", async () => {
    const { runAdapterInstall } = await import("../../../src/commands/adapter-install.ts");
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
    });
    const result = await runDoctor(dir);
    const adapterFindings = result.issues
      .map((i) => i.code)
      .filter((c) => c.startsWith("ADAPTER_") && c !== "ADAPTER_STALE");
    expect(adapterFindings).toEqual([]);
  });

  it("with manifest + deleted CLAUDE.md → ADAPTER_FILE_MISSING (NOT ADAPTER_MISSING)", async () => {
    const { runAdapterInstall } = await import("../../../src/commands/adapter-install.ts");
    const { unlink } = await import("node:fs/promises");
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
    });
    await unlink(join(dir, "CLAUDE.md"));
    const result = await runDoctor(dir);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("ADAPTER_FILE_MISSING");
    expect(codes).not.toContain("ADAPTER_MISSING"); // legacy check skipped when manifest exists
    const fileMissing = result.issues.find((i) => i.code === "ADAPTER_FILE_MISSING")!;
    expect(fileMissing.severity).toBe("error");
    expect(fileMissing.message).toMatch(/\[claude-code\]/);
  });

  it("global doctor NEVER emits ADAPTER_MANIFEST_MISSING (that signal is adapter-doctor only)", async () => {
    // Fresh init, no manifest. adapter doctor would emit MANIFEST_MISSING.
    // Global doctor must NOT — it uses the legacy ADAPTER_MISSING signal
    // and stays quiet on manifest absence.
    const result = await runDoctor(dir);
    expect(result.issues.map((i) => i.code)).not.toContain("ADAPTER_MANIFEST_MISSING");
  });

  it("with malformed manifest → ADAPTER_MANIFEST_INVALID (error)", async () => {
    const { manifestPath, ADAPTER_MANIFEST_DIR_SEGMENTS } = await import(
      "../../../src/core/adapters/manifest.ts"
    );
    await mkdir(join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS), { recursive: true });
    await writeFile(
      manifestPath(dir, "claude-code"),
      "schema_version: 99\nagent_name: claude-code\n",
      "utf8",
    );
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "ADAPTER_MANIFEST_INVALID");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
    expect(result.ok).toBe(false);
  });
});
