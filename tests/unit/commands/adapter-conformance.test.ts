import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveBoundedRepairSeverity,
  resolveStructuralProjectionSeverity,
  runAdapterConformance,
} from "../../../src/commands/adapter-conformance.ts";
import { runInit } from "../../../src/commands/init.ts";
import { runAdapterInstall } from "../../../src/commands/adapter-install.ts";
import { createPhase } from "../../../src/core/services/createPhase.ts";
import {
  computeContentHash,
  readManifest,
  writeManifest,
} from "../../../src/core/adapters/manifest.ts";
import {
  BOUNDED_REPAIR_GUIDANCE_FROM_VERSION,
  STRUCTURAL_PROJECTION_GUIDANCE_FROM_VERSION,
} from "../../../src/core/adapters/conformance-spec.ts";

const VALID_CONTRACT_BODY = `# Some Adapter

> Managed file.

## How to work on a task

Some workflow text.

## Agent contract

The canonical workflow.

### When to invoke code-pact

Per task:

\`\`\`sh
code-pact task prepare <task-id> --agent claude-code --json
code-pact task start    <task-id> --agent claude-code
code-pact task context <task-id> --agent claude-code
code-pact task complete <task-id> --agent claude-code
code-pact task finalize <task-id> --write --json
code-pact verify --phase <p> --task <task-id>
code-pact validate --json
\`\`\`

Activation rules:

- Run \`task finalize --write\` only after \`task complete\`.
- If \`next_action.type\` is \`wait_for_dependencies\`, do not implement.
- On \`CONTEXT_OVER_BUDGET\`, report rather than widen.

### What to verify first

- run verify
- check the audit
- After \`task prepare --json\`, read \`data.recommendation\`. After \`recommend --json\`, read \`data\`. Let \`lifecycleMode\` pick the loop. When the runtime cannot switch model, report the limitation.
- \`record_only\` is a lighter loop, not lighter verification — run verification, then \`task record-done\`.
- Budgeted context may contain deterministic structural projections. Use the projected form first. Retrieve an exact original section only when a specific missing detail blocks the task; do not retrieve every projected section by default.

### How to handle failures

- **blocked dependency** — wait or resume.
- **verification failure** — fix and re-run.
- **adapter drift** — re-upgrade.
- **missing context pack** — task prepare rebuilds it.
- After a failure, read \`data.recommendation.repairPolicy\` from \`task prepare --json\`, or \`data.repairPolicy\` from \`recommend --json\`. If \`mode\` is \`disabled\`, do not repair. If \`mode\` is \`bounded\`, use \`maxRepairAttempts\` for \`command_failed\` only.
- Keep \`same_model_same_effort_same_context\` and use \`failure_delta\`.
- Stop on \`stopOnRepeatedFingerprint\`; after exhaustion follow \`use_allowed_escalation\`.
- When \`afterExhaustion\` is \`use_allowed_escalation\`, read \`data.recommendation.allowedEscalation\` from \`task prepare --json\`, or \`data.allowedEscalation\` from \`recommend --json\`.
- Nonretryable kinds: \`timed_out\`, \`aborted\`, \`decision_required\`, \`unsafe_write\`, \`invalid_state\`, \`unknown\`.
`;

const LEGACY_CONTRACT_WITHOUT_REPAIR = `# Some Adapter

> Managed file.

## How to work on a task

Some workflow text.

## Agent contract

The canonical workflow.

### When to invoke code-pact

Per task:

\`\`\`sh
code-pact task prepare <task-id> --agent claude-code --json
code-pact task start    <task-id> --agent claude-code
code-pact task context <task-id> --agent claude-code
code-pact task complete <task-id> --agent claude-code
code-pact task finalize <task-id> --write --json
code-pact verify --phase <p> --task <task-id>
code-pact validate --json
\`\`\`

Activation rules:

- Run \`task finalize --write\` only after \`task complete\`.
- If \`next_action.type\` is \`wait_for_dependencies\`, do not implement.
- On \`CONTEXT_OVER_BUDGET\`, report rather than widen.

### What to verify first

- run verify
- check the audit
- After \`task prepare --json\`, read \`data.recommendation\`. After \`recommend --json\`, read \`data\`. Let \`lifecycleMode\` pick the loop. When the runtime cannot switch model, report the limitation.
- \`record_only\` is a lighter loop, not lighter verification — run verification, then \`task record-done\`.

### How to handle failures

- **blocked dependency** — wait or resume.
- **verification failure** — fix and re-run.
- **adapter drift** — re-upgrade.
- **missing context pack** — task prepare rebuilds it.
`;

function sha256(content: string): string {
  return createHash("sha256")
    .update(content.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

async function setupAdapter(
  dir: string,
  opts: { instructionContent?: string; generatorVersion?: string } = {},
): Promise<void> {
  const instructionContent = opts.instructionContent ?? VALID_CONTRACT_BODY;
  const generatorVersion = opts.generatorVersion ?? "1.11.0";
  await mkdir(join(dir, ".code-pact", "adapters"), { recursive: true });
  await writeFile(join(dir, "CLAUDE.md"), instructionContent, "utf8");
  const manifest = {
    schema_version: 1,
    agent_name: "claude-code",
    generator_version: generatorVersion,
    adapter_schema_version: 1,
    generated_at: "2026-05-22T00:00:00+00:00",
    profile_fingerprint: {
      instruction_filename: "CLAUDE.md",
      context_dir: ".context/claude-code",
    },
    files: [
      {
        path: "CLAUDE.md",
        sha256: sha256(instructionContent),
        managed: true,
        role: "instruction",
      },
    ],
  };
  // Render as YAML manually (tests/setup.ts may not enable the YAML write lib).
  const yaml = [
    `schema_version: 1`,
    `agent_name: claude-code`,
    `generator_version: ${generatorVersion}`,
    `adapter_schema_version: 1`,
    `generated_at: "${manifest.generated_at}"`,
    `profile_fingerprint:`,
    `  instruction_filename: CLAUDE.md`,
    `  context_dir: .context/claude-code`,
    `files:`,
    `  - path: CLAUDE.md`,
    `    sha256: ${manifest.files[0]!.sha256}`,
    `    managed: true`,
    `    role: instruction`,
    ``,
  ].join("\n");
  await writeFile(
    join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml"),
    yaml,
    "utf8",
  );
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-adapter-conformance-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("runAdapterConformance — happy path", () => {
  it("returns compliant: true when the contract surface is complete", async () => {
    await setupAdapter(dir);
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    expect(result.compliant).toBe(true);
    expect(result.agent).toBe("claude-code");
    expect(result.checks.every(c => c.status === "pass")).toBe(true);
  });

  it("emits both manifest_present and instruction_file_present checks", async () => {
    await setupAdapter(dir);
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    const ids = result.checks.map(c => c.id);
    expect(ids).toContain("manifest_present");
    expect(ids).toContain("instruction_file_present");
  });

  it("emits a file_checksum_match per manifest file", async () => {
    await setupAdapter(dir);
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    const checksumChecks = result.checks.filter(
      c => c.id === "file_checksum_match",
    );
    // One file in the manifest.
    expect(checksumChecks).toHaveLength(1);
    expect(checksumChecks[0]!.status).toBe("pass");
  });
});

describe("runAdapterConformance — missing manifest", () => {
  it("returns compliant: false and an explanatory check when manifest is absent", async () => {
    // dir is empty — no manifest, no instruction file.
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    expect(result.compliant).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.id).toBe("manifest_present");
    expect(result.checks[0]!.status).toBe("fail");
  });
});

describe("runAdapterConformance — dynamic handoff advisories", () => {
  async function initAndInstallWithDynamicSkill(): Promise<string> {
    await runInit({
      cwd: dir,
      locale: "en-US",
      agents: ["claude-code"],
      force: false,
      json: false,
    });
    const phase = await createPhase({
      cwd: dir,
      id: "P1",
      name: "Deploy",
      weight: 1,
      objective: "Exercise dynamic conformance checks.",
      confidence: "high",
      risk: "low",
      verifyCommands: ["pnpm deploy"],
    });
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    return phase.path;
  }

  it("surfaces a handed-off dynamic orphan as advisory without reading existing bytes", async () => {
    await runInit({
      cwd: dir,
      locale: "en-US",
      agents: ["claude-code"],
      force: false,
      json: false,
    });
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    const dynamic = ".claude/skills/code-pact-private.md";
    const secret = "API_TOKEN=conformance-orphan-marker\n";
    await mkdir(join(dir, ".claude", "skills"), { recursive: true });
    await writeFile(join(dir, dynamic), secret, "utf8");
    const manifest = await readManifest(dir, "claude-code");
    if (manifest === null) throw new Error("manifest expected");
    manifest.files.push({
      path: dynamic,
      sha256: computeContentHash(secret),
      managed: true,
      role: "skill",
      ownership: "handed_off",
    });
    await writeManifest(dir, "claude-code", manifest);

    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    const advisory = result.checks.find(
      c => c.id === "dynamic_handoff_orphan_unverified" && c.file === dynamic,
    );
    expect(advisory).toMatchObject({
      status: "fail",
      severity: "advisory",
    });
    expect(result.compliant).toBe(true);
    expect(JSON.stringify(result)).not.toContain("conformance-orphan-marker");
  });

  it("surfaces handed-off dynamic desired-hash drift as advisory without reading existing bytes", async () => {
    const phasePath = await initAndInstallWithDynamicSkill();
    const dynamic = ".claude/skills/code-pact-deploy.md";
    await writeFile(
      join(dir, dynamic),
      "API_TOKEN=conformance-drift-marker\n",
      "utf8",
    );
    const phaseAbs = join(dir, phasePath);
    const raw = await readFile(phaseAbs, "utf8");
    await writeFile(phaseAbs, raw.replace("pnpm deploy", "npm deploy"), "utf8");

    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    const advisory = result.checks.find(
      c => c.id === "dynamic_handoff_manifest_stale" && c.file === dynamic,
    );
    expect(advisory).toMatchObject({
      status: "fail",
      severity: "advisory",
    });
    expect(result.compliant).toBe(true);
    expect(JSON.stringify(result)).not.toContain("conformance-drift-marker");
  });
});

describe("runAdapterConformance — required CLI surface mentions", () => {
  it("fails when a lifecycle surface is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(/code-pact task prepare.*\n/g, "");
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    const surfaceCheck = result.checks.find(
      c => c.id === "required_cli_surface_mentions",
    );
    expect(surfaceCheck?.status).toBe("fail");
    expect(
      (surfaceCheck?.details?.missing_lifecycle as string[]) ?? [],
    ).toContain("code-pact task prepare");
  });

  it("fails when a diagnostic surface is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(/code-pact validate.*\n/g, "");
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    const surfaceCheck = result.checks.find(
      c => c.id === "required_cli_surface_mentions",
    );
    expect(surfaceCheck?.status).toBe("fail");
    expect(
      (surfaceCheck?.details?.missing_diagnostic as string[]) ?? [],
    ).toContain("code-pact validate");
  });
});

describe("runAdapterConformance — required failure guidance", () => {
  it("fails when a required failure keyword is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      /blocked dependency/g,
      "blocked deps",
    );
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    const guidanceCheck = result.checks.find(
      c => c.id === "required_failure_guidance",
    );
    expect(guidanceCheck?.status).toBe("fail");
    expect((guidanceCheck?.details?.missing as string[]) ?? []).toContain(
      "blocked dependency",
    );
  });
});

describe("runAdapterConformance — bounded repair recommendation guidance", () => {
  it("passes when every new bounded repair anchor set is present", async () => {
    await setupAdapter(dir);
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    for (const id of [
      "repair_policy_guidance_present",
      "bounded_repair_runtime_constraints_present",
      "bounded_repair_stop_guidance_present",
      "bounded_repair_nonretryable_guidance_present",
    ]) {
      const check = result.checks.find(c => c.id === id);
      expect(check, `${id} present`).toBeDefined();
      expect(check?.status, `${id} status`).toBe("pass");
    }
  });

  it("fails the matching check when one bounded repair anchor is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      "same_model_same_effort_same_context",
      "same runtime profile",
    );
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    const check = result.checks.find(
      c => c.id === "bounded_repair_runtime_constraints_present",
    );
    expect(check?.status).toBe("fail");
    expect((check?.details?.missing as string[]) ?? []).toContain(
      "same_model_same_effort_same_context",
    );
  });

  it("fails when the recommend repairPolicy JSON path is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      "data.repairPolicy",
      "data.repair_policy",
    );
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    const check = result.checks.find(
      c => c.id === "repair_policy_json_paths_present",
    );
    expect(check?.status).toBe("fail");
    expect((check?.details?.missing as string[]) ?? []).toContain(
      "data.repairPolicy",
    );
  });

  it("fails when the task prepare repairPolicy JSON path is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      "data.recommendation.repairPolicy",
      "data.recommendation.repair_policy",
    );
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    const check = result.checks.find(
      c => c.id === "repair_policy_json_paths_present",
    );
    expect(check?.status).toBe("fail");
    expect((check?.details?.missing as string[]) ?? []).toContain(
      "data.recommendation.repairPolicy",
    );
  });

  it("fails when the recommend allowedEscalation JSON path is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      "data.allowedEscalation",
      "data.allowed_escalation",
    );
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    const check = result.checks.find(
      c => c.id === "repair_policy_json_paths_present",
    );
    expect(check?.status).toBe("fail");
    expect((check?.details?.missing as string[]) ?? []).toContain(
      "data.allowedEscalation",
    );
  });

  it("keeps repair guidance advisory for a pre-P51 2.1.0 adapter", async () => {
    await setupAdapter(dir, {
      instructionContent: LEGACY_CONTRACT_WITHOUT_REPAIR,
      generatorVersion: "2.1.0",
    });

    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    for (const id of [
      "repair_policy_guidance_present",
      "repair_policy_json_paths_present",
      "bounded_repair_runtime_constraints_present",
      "bounded_repair_stop_guidance_present",
      "bounded_repair_nonretryable_guidance_present",
    ]) {
      const check = result.checks.find(c => c.id === id);
      expect(check?.status, `${id} status`).toBe("fail");
      expect(check?.severity, `${id} severity`).toBe("advisory");
    }
    expect(result.compliant).toBe(true);
  });

  it("requires repair guidance at the P51 release threshold", async () => {
    await setupAdapter(dir, {
      instructionContent: LEGACY_CONTRACT_WITHOUT_REPAIR,
      generatorVersion: BOUNDED_REPAIR_GUIDANCE_FROM_VERSION,
    });

    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    const check = result.checks.find(
      c => c.id === "repair_policy_guidance_present",
    );
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("required");
    expect(result.compliant).toBe(false);
  });

  it("gates bounded repair guidance on its own threshold", () => {
    expect(resolveBoundedRepairSeverity("2.1.0")).toBe("advisory");
    expect(resolveBoundedRepairSeverity("2.2.0")).toBe("required");
  });
});

describe("runAdapterConformance — structural projection guidance", () => {
  it("passes when projection guidance anchors are present", async () => {
    await setupAdapter(dir);
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    const check = result.checks.find(
      c => c.id === "structural_projection_guidance_present",
    );
    expect(check?.status).toBe("pass");
  });

  it("fails the projection guidance check when an anchor is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      "projected form first",
      "compact form first",
    );
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    const check = result.checks.find(
      c => c.id === "structural_projection_guidance_present",
    );
    expect(check?.status).toBe("fail");
    expect((check?.details?.missing as string[]) ?? []).toContain(
      "projected form first",
    );
  });

  it("keeps projection guidance advisory before the projection threshold", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      "- Budgeted context may contain deterministic structural projections. Use the projected form first. Retrieve an exact original section only when a specific missing detail blocks the task; do not retrieve every projected section by default.\n",
      "",
    );
    await setupAdapter(dir, {
      instructionContent: body,
      generatorVersion: "2.4.0",
    });

    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    const check = result.checks.find(
      c => c.id === "structural_projection_guidance_present",
    );
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("advisory");
    expect(result.compliant).toBe(true);
  });

  it("requires projection guidance at its own release threshold", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      "- Budgeted context may contain deterministic structural projections. Use the projected form first. Retrieve an exact original section only when a specific missing detail blocks the task; do not retrieve every projected section by default.\n",
      "",
    );
    await setupAdapter(dir, {
      instructionContent: body,
      generatorVersion: STRUCTURAL_PROJECTION_GUIDANCE_FROM_VERSION,
    });

    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    const check = result.checks.find(
      c => c.id === "structural_projection_guidance_present",
    );
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("required");
    expect(result.compliant).toBe(false);
  });

  it("gates projection guidance on its own threshold", () => {
    expect(resolveStructuralProjectionSeverity("2.4.0")).toBe("advisory");
    expect(resolveStructuralProjectionSeverity("2.5.0")).toBe("required");
  });
});

describe("runAdapterConformance — agent contract section + axes", () => {
  it("fails when the `## Agent contract` heading is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      "## Agent contract",
      "## DRIFTED contract",
    );
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    expect(result.compliant).toBe(false);
    const sectionCheck = result.checks.find(
      c => c.id === "contract_section_present",
    );
    expect(sectionCheck?.status).toBe("fail");
  });

  it("fails when an axis sub-heading is missing", async () => {
    const body = VALID_CONTRACT_BODY.replace(
      "### How to handle failures",
      "### Different failure heading",
    );
    await setupAdapter(dir, { instructionContent: body });
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    expect(result.compliant).toBe(false);
    const axisCheck = result.checks.find(c => c.id === "axis_how_to_handle");
    expect(axisCheck?.status).toBe("fail");
  });
});

describe("runAdapterConformance — checksum drift", () => {
  it("fails the per-file checksum check when on-disk content diverges", async () => {
    await setupAdapter(dir);
    // Append bytes after setup, leaving manifest's recorded sha256
    // pointing at the original content.
    await writeFile(
      join(dir, "CLAUDE.md"),
      VALID_CONTRACT_BODY + "\n<!-- tampered -->\n",
      "utf8",
    );
    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });
    expect(result.compliant).toBe(false);
    const checksumCheck = result.checks.find(
      c => c.id === "file_checksum_match",
    );
    expect(checksumCheck?.status).toBe("fail");
    const details = checksumCheck?.details as
      | { expected_sha256?: string; actual_sha256?: string }
      | undefined;
    expect(details?.expected_sha256).toBeDefined();
    expect(details?.actual_sha256).toBeDefined();
    expect(details?.expected_sha256).not.toBe(details?.actual_sha256);
  });
});

describe("runAdapterConformance — role swap security", () => {
  it("rejects CLAUDE.md with role: skill (no instruction entry → early fail, no read)", async () => {
    // Forged manifest: CLAUDE.md is owned as role: instruction, but the
    // manifest declares role: skill. findInstructionFile returns null
    // (no file with role: instruction), so conformance fails early with
    // instruction_file_present — no heading/substring inspection occurs.
    await mkdir(join(dir, ".code-pact", "adapters"), { recursive: true });
    await writeFile(join(dir, "CLAUDE.md"), VALID_CONTRACT_BODY, "utf8");
    const yaml = [
      `schema_version: 1`,
      `agent_name: claude-code`,
      `generator_version: 1.11.0`,
      `adapter_schema_version: 1`,
      `generated_at: "2026-05-22T00:00:00+00:00"`,
      `profile_fingerprint:`,
      `  instruction_filename: CLAUDE.md`,
      `  context_dir: .context/claude-code`,
      `files:`,
      `  - path: CLAUDE.md`,
      `    sha256: ${sha256(VALID_CONTRACT_BODY)}`,
      `    managed: true`,
      `    role: skill`,
      ``,
    ].join("\n");
    await writeFile(
      join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml"),
      yaml,
      "utf8",
    );

    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    // Conformance must be false — no instruction file found.
    expect(result.compliant).toBe(false);

    // The instruction_file_present check must fail.
    const instrCheck = result.checks.find(
      c => c.id === "instruction_file_present",
    );
    expect(instrCheck).toBeDefined();
    expect(instrCheck?.status).toBe("fail");

    // No contract section / axis / surface checks should have run —
    // the instruction read was never attempted.
    const contractCheck = result.checks.find(
      c => c.id === "contract_section_present",
    );
    expect(contractCheck).toBeUndefined();

    // No checksum check should have run for CLAUDE.md.
    const checksumCheck = result.checks.find(
      c => c.id === "file_checksum_match" && c.file === "CLAUDE.md",
    );
    expect(checksumCheck).toBeUndefined();
  });

  it("rejects .claude/skills/context.md with role: instruction (role mismatch → unowned)", async () => {
    // Forged manifest: .claude/skills/context.md is owned as role: skill,
    // but the manifest declares role: instruction. Must be `unowned`.
    await mkdir(join(dir, ".code-pact", "adapters"), { recursive: true });
    await mkdir(join(dir, ".claude", "skills"), { recursive: true });
    const skillContent = "# Context Skill\n\nManaged file.\n";
    await writeFile(
      join(dir, ".claude", "skills", "context.md"),
      skillContent,
      "utf8",
    );
    // Also need a valid instruction file for conformance to proceed past the
    // instruction check.
    await writeFile(join(dir, "CLAUDE.md"), VALID_CONTRACT_BODY, "utf8");
    const yaml = [
      `schema_version: 1`,
      `agent_name: claude-code`,
      `generator_version: 1.11.0`,
      `adapter_schema_version: 1`,
      `generated_at: "2026-05-22T00:00:00+00:00"`,
      `profile_fingerprint:`,
      `  instruction_filename: CLAUDE.md`,
      `  context_dir: .context/claude-code`,
      `files:`,
      `  - path: CLAUDE.md`,
      `    sha256: ${sha256(VALID_CONTRACT_BODY)}`,
      `    managed: true`,
      `    role: instruction`,
      `  - path: .claude/skills/context.md`,
      `    sha256: ${sha256(skillContent)}`,
      `    managed: true`,
      `    role: instruction`,
      ``,
    ].join("\n");
    await writeFile(
      join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml"),
      yaml,
      "utf8",
    );

    const result = await runAdapterConformance({
      cwd: dir,
      agentName: "claude-code",
    });

    expect(result.compliant).toBe(false);

    // The skill file with wrong role must be flagged as unowned.
    const unownedCheck = result.checks.find(
      c =>
        c.id === "adapter_file_path_unowned" &&
        c.file === ".claude/skills/context.md",
    );
    expect(unownedCheck).toBeDefined();
    expect(unownedCheck?.status).toBe("fail");

    // No checksum check should have run for the role-swapped skill.
    const checksumCheck = result.checks.find(
      c =>
        c.id === "file_checksum_match" &&
        c.file === ".claude/skills/context.md",
    );
    expect(checksumCheck).toBeUndefined();
  });
});
