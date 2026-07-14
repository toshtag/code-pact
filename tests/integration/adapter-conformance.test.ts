import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { runInit } from "../../src/commands/init.ts";
import { runAdapterInstall } from "../../src/commands/adapter-install.ts";
import { runAdapterConformance } from "../../src/commands/adapter-conformance.ts";
import { readManifest } from "../../src/core/adapters/manifest.ts";
import { AdapterManifest } from "../../src/core/schemas/adapter-manifest.ts";
import { AgentProfile } from "../../src/core/schemas/agent-profile.ts";
import { adapterRegistry } from "../../src/core/adapters/index.ts";
import { assertSafeRelativePath } from "../../src/core/adapters/file-state.ts";
// P21-T5: single source of truth for the agent contract surface.
// `adapter doctor`'s contract drift check and the `adapter conformance`
// command both import the same constants from this module.
import {
  AGENT_CONTRACT_AXIS_HEADINGS as SHARED_AXIS_HEADINGS,
  AGENT_CONTRACT_SECTION_HEADING as SHARED_SECTION_HEADING,
  BOUNDED_REPAIR_GUIDANCE_ANCHORS,
  BOUNDED_REPAIR_GUIDANCE_FROM_VERSION,
  DIAGNOSTIC_REQUIRED_SURFACES,
  LIFECYCLE_REQUIRED_SURFACES,
  RECOMMENDATION_CONSUMPTION_ANCHORS,
  REQUIRED_FAILURE_GUIDANCE,
  STRUCTURAL_PROJECTION_GUIDANCE_ANCHORS,
  STRUCTURAL_PROJECTION_GUIDANCE_FROM_VERSION,
} from "../../src/core/adapters/conformance-spec.ts";

// ---------------------------------------------------------------------------
// Stable adapters covered by conformance.
//
// cursor and gemini-cli remain in EXPERIMENTAL_AGENTS in src/core/agents.ts
// and are intentionally excluded — their target tools' instruction-file
// conventions may shift across releases (`.cursor/rules/*.mdc` for Cursor,
// `GEMINI.md` for Gemini CLI). Adding them to this conformance suite would
// generate false-failure churn whenever those formats change upstream.
// ---------------------------------------------------------------------------

const STABLE_AGENTS = ["claude-code", "codex", "generic"] as const;

// v1.6 audit surface mentions kept as a local constant — these are
// not part of the v1.11+ conformance spec but the existing
// `agent contract section references every v1.6 audit surface` test
// still locks them.
const REQUIRED_CLI_REFS = [
  "code-pact recommend",
  "code-pact task context",
  "code-pact task complete",
  "code-pact validate",
];

// v1.7 P16-T4 / v1.11+ P21-T5: heading constants imported from the
// shared `src/core/adapters/conformance-spec.ts`. The aliases here keep
// the existing test assertions readable while making the single-source
// invariant explicit.
const AGENT_CONTRACT_SECTION_HEADING = SHARED_SECTION_HEADING;
const AGENT_CONTRACT_AXIS_HEADINGS = SHARED_AXIS_HEADINGS;
// Every stable adapter's instruction file MUST mention every v1.6
// audit surface at least once in the agent-contract body. These are
// the surfaces the agent must learn about on day one:
//   - `--audit-strict` (P15-T6) — opt-in audit gate
//   - `--from-file`    (P17-T1/T4) — non-interactive plan brief/constitution
//   - `--stdin`        (P17-T2/T4) — same family
//   - `write_audit`    (P15-T1)    — the envelope field the audit produces
const AGENT_CONTRACT_V16_SURFACES = [
  "--audit-strict",
  "--from-file",
  "--stdin",
  "write_audit",
];

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const fixturesRoot = join(repoRoot, "tests", "fixtures", "adapters");

let dir: string;

beforeEach(async () => {
  // realpath up front: macOS /var/folders/... is a symlink to /private/...
  // and we compare paths against `dir` directly throughout.
  dir = await realpath(await mkdtemp(join(tmpdir(), "code-pact-conformance-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sha256(content: string): string {
  return createHash("sha256")
    .update(content.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

async function installAdapter(
  agent: (typeof STABLE_AGENTS)[number],
  generatorVersionOverride = "0.9.0-alpha.0",
) {
  await runInit({
    cwd: dir,
    locale: "en-US",
    agents: [agent],
    force: false,
    json: false,
  });
  await runAdapterInstall({
    cwd: dir,
    agentName: agent,
    force: false,
    locale: "en-US",
    generatorVersionOverride,
  });
}

async function loadAgentProfile(
  agent: (typeof STABLE_AGENTS)[number],
): Promise<AgentProfile> {
  const raw = await readFile(
    join(dir, ".code-pact", "agent-profiles", `${agent}.yaml`),
    "utf8",
  );
  return AgentProfile.parse(parseYaml(raw) as unknown);
}

async function readExpectedFiles(agent: string): Promise<string[]> {
  const raw = await readFile(
    join(fixturesRoot, agent, "expected-files.txt"),
    "utf8",
  );
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

// describe.each lets us share the same suite across every stable adapter.
describe.each(STABLE_AGENTS)("adapter conformance — %s", (agent) => {
  it("manifest file list matches the snapshot fixture (sorted)", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    expect(manifest).not.toBeNull();
    const actual = manifest!.files.map((f) => f.path).sort();
    const expected = await readExpectedFiles(agent);
    expect(actual).toEqual(expected);
  });

  it("instruction file mentions every required CLI command", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    expect(instruction).toBeDefined();
    const content = await readFile(join(dir, instruction!.path), "utf8");
    for (const ref of REQUIRED_CLI_REFS) {
      expect(content).toContain(ref);
    }
  });

  it("instruction file mentions --json so agents discover the JSON mode", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const content = await readFile(join(dir, instruction!.path), "utf8");
    expect(content).toContain("--json");
  });

  it("second install is idempotent — manifest sha256 entries byte-equal", async () => {
    await installAdapter(agent);
    const first = await readManifest(dir, agent);
    const firstSig = first!.files
      .map((f) => `${f.path}=${f.sha256}`)
      .sort();

    await runAdapterInstall({
      cwd: dir,
      agentName: agent,
      force: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    const second = await readManifest(dir, agent);
    const secondSig = second!.files
      .map((f) => `${f.path}=${f.sha256}`)
      .sort();

    expect(secondSig).toEqual(firstSig);
  });

  it("manifest round-trips through AdapterManifest zod (schema_version === 1)", async () => {
    await installAdapter(agent);
    const raw = await readFile(
      join(dir, ".code-pact", "adapters", `${agent}.manifest.yaml`),
      "utf8",
    );
    const parsed = AdapterManifest.parse(parseYaml(raw) as unknown);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.agent_name).toBe(agent);
  });

  it("generateDesiredFiles emits only safe project-relative POSIX paths", async () => {
    await installAdapter(agent);
    const profile = await loadAgentProfile(agent);
    const descriptor = adapterRegistry[agent];
    const desired = await descriptor.generateDesiredFiles({
      cwd: dir,
      profile,
      modelProfiles: [],
      locale: "en-US",
    });
    expect(desired.length).toBeGreaterThan(0);
    for (const f of desired) {
      // assertSafeRelativePath throws on `..`, leading `/` / `~`, `\`,
      // Windows drive letters, empty segments, etc.
      expect(() => assertSafeRelativePath(f.path)).not.toThrow();
      expect(f.path.startsWith("/")).toBe(false);
      expect(f.path).not.toMatch(/(^|\/)\.\.($|\/)/);
    }
  });

  // ---------------------------------------------------------------------
  // v1.7 P16-T4: agent contract section
  // ---------------------------------------------------------------------

  it("instruction file contains the verbatim `## Agent contract` heading", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    expect(instruction).toBeDefined();
    const content = await readFile(join(dir, instruction!.path), "utf8");
    expect(content).toContain(AGENT_CONTRACT_SECTION_HEADING);
  });

  it("instruction file contains all three agent-contract axis headings (verbatim, English-locked)", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const content = await readFile(join(dir, instruction!.path), "utf8");
    for (const heading of AGENT_CONTRACT_AXIS_HEADINGS) {
      expect(content).toContain(heading);
    }
  });

  it("agent contract section references every v1.6 audit surface", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const content = await readFile(join(dir, instruction!.path), "utf8");
    // Slice the body between the section heading and the next H2 so a
    // surface mention elsewhere in the file (e.g. an unrelated example
    // block) cannot satisfy this assertion.
    const sectionStart = content.indexOf(AGENT_CONTRACT_SECTION_HEADING);
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    const nextH2 = content.indexOf("\n## ", sectionStart + AGENT_CONTRACT_SECTION_HEADING.length);
    const sectionBody =
      nextH2 === -1 ? content.slice(sectionStart) : content.slice(sectionStart, nextH2);
    for (const surface of AGENT_CONTRACT_V16_SURFACES) {
      expect(
        sectionBody,
        `expected v1.6 surface "${surface}" inside the agent-contract section of ${agent}'s instruction file, got body:\n${sectionBody}`,
      ).toContain(surface);
    }
  });

  it("agent contract heading appears AFTER the per-task workflow header (placement check)", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const content = await readFile(join(dir, instruction!.path), "utf8");
    const sectionStart = content.indexOf(AGENT_CONTRACT_SECTION_HEADING);
    // The workflow header is the localised string for
    // `templates.adapterCommon.workflowHeader`. Both en-US ("How to
    // work on a task") and ja-JP ("タスクの進め方") emit an `## …`
    // line; we install in en-US for conformance so we can match that
    // text directly.
    const workflowHeader = content.indexOf("## How to work on a task");
    expect(workflowHeader).toBeGreaterThanOrEqual(0);
    expect(sectionStart).toBeGreaterThan(workflowHeader);
  });

  // ---------------------------------------------------------------------
  // v1.11+ P21-T5: `code-pact adapter conformance <agent>` command
  // ---------------------------------------------------------------------

  it("instruction file mentions every lifecycle_required surface (v1.11+)", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const content = await readFile(join(dir, instruction!.path), "utf8");
    for (const surface of LIFECYCLE_REQUIRED_SURFACES) {
      expect(content).toContain(surface);
    }
  });

  it("instruction file mentions every diagnostic_required surface (v1.11+)", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const content = await readFile(join(dir, instruction!.path), "utf8");
    for (const surface of DIAGNOSTIC_REQUIRED_SURFACES) {
      expect(content).toContain(surface);
    }
  });

  it("instruction file mentions every required_failure_guidance keyword (v1.11+)", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const content = await readFile(join(dir, instruction!.path), "utf8");
    for (const keyword of REQUIRED_FAILURE_GUIDANCE) {
      expect(content).toContain(keyword);
    }
  });

  it("runAdapterConformance returns compliant: true on a fresh install", async () => {
    await installAdapter(agent);
    const result = await runAdapterConformance({ cwd: dir, agentName: agent });
    expect(result.agent).toBe(agent);
    expect(result.compliant).toBe(true);
    // Every check should pass on a fresh install.
    const failed = result.checks.filter((c) => c.status === "fail");
    expect(failed).toEqual([]);
  });

  it("fresh instruction contains every recommendation consumption anchor", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const content = await readFile(join(dir, instruction!.path), "utf8");

    for (const check of RECOMMENDATION_CONSUMPTION_ANCHORS) {
      for (const anchor of check.anchors) {
        expect(content, `${agent} ${check.id} missing ${anchor}`).toContain(anchor);
      }
    }
  });

  it("fresh instruction contains every bounded repair guidance anchor", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const content = await readFile(join(dir, instruction!.path), "utf8");

    for (const check of BOUNDED_REPAIR_GUIDANCE_ANCHORS) {
      for (const anchor of check.anchors) {
        expect(content, `${agent} ${check.id} missing ${anchor}`).toContain(anchor);
      }
    }
  });

  it("fresh instruction contains every structural projection guidance anchor", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const content = await readFile(join(dir, instruction!.path), "utf8");

    for (const check of STRUCTURAL_PROJECTION_GUIDANCE_ANCHORS) {
      for (const anchor of check.anchors) {
        expect(content, `${agent} ${check.id} missing ${anchor}`).toContain(anchor);
      }
    }
  });

  it("fails the bounded repair runtime check when its anchor is tampered", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const path = join(dir, instruction!.path);
    const original = await readFile(path, "utf8");
    const tampered = original.replace(
      "same_model_same_effort_same_context",
      "same_runtime_profile",
    );
    expect(tampered).not.toBe(original);
    await writeFile(path, tampered, "utf8");

    const result = await runAdapterConformance({ cwd: dir, agentName: agent });
    const check = result.checks.find(
      (c) => c.id === "bounded_repair_runtime_constraints_present",
    );
    expect(check?.status).toBe("fail");
    expect((check?.details?.missing as string[]) ?? []).toContain(
      "same_model_same_effort_same_context",
    );
  });

  it("requires bounded repair JSON paths at the P51 release threshold", async () => {
    await installAdapter(agent, BOUNDED_REPAIR_GUIDANCE_FROM_VERSION);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const path = join(dir, instruction!.path);
    const original = await readFile(path, "utf8");
    const tampered = original.replace("data.repairPolicy", "data.repair_policy");
    expect(tampered).not.toBe(original);
    await writeFile(path, tampered, "utf8");

    const manifestPath = join(dir, ".code-pact", "adapters", `${agent}.manifest.yaml`);
    const rawManifest = await readFile(manifestPath, "utf8");
    const updatedManifest = rawManifest.replace(instruction!.sha256, sha256(tampered));
    expect(updatedManifest).not.toBe(rawManifest);
    await writeFile(manifestPath, updatedManifest, "utf8");

    const result = await runAdapterConformance({ cwd: dir, agentName: agent });
    const check = result.checks.find(
      (c) => c.id === "repair_policy_json_paths_present",
    );
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("required");
    expect((check?.details?.missing as string[]) ?? []).toContain(
      "data.repairPolicy",
    );
    expect(result.compliant).toBe(false);
  });

  it("requires structural projection guidance at the P54 release threshold", async () => {
    await installAdapter(agent, STRUCTURAL_PROJECTION_GUIDANCE_FROM_VERSION);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const path = join(dir, instruction!.path);
    const original = await readFile(path, "utf8");
    const tampered = original.replace("projected form first", "compact form first");
    expect(tampered).not.toBe(original);
    await writeFile(path, tampered, "utf8");

    const manifestPath = join(dir, ".code-pact", "adapters", `${agent}.manifest.yaml`);
    const rawManifest = await readFile(manifestPath, "utf8");
    const updatedManifest = rawManifest.replace(instruction!.sha256, sha256(tampered));
    expect(updatedManifest).not.toBe(rawManifest);
    await writeFile(manifestPath, updatedManifest, "utf8");

    const result = await runAdapterConformance({ cwd: dir, agentName: agent });
    const check = result.checks.find(
      (c) => c.id === "structural_projection_guidance_present",
    );
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("required");
    expect((check?.details?.missing as string[]) ?? []).toContain(
      "projected form first",
    );
    expect(result.compliant).toBe(false);
  });

  it("runAdapterConformance returns compliant: false when the agent contract section is removed", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const path = join(dir, instruction!.path);
    const original = await readFile(path, "utf8");
    // Tamper: replace the exact `## Agent contract` heading text with a
    // distinct heading. The substring match anchors on the verbatim
    // string, so swapping the prefix word is enough to fail.
    const tampered = original.replace(
      "## Agent contract",
      "## DRIFTED contract",
    );
    expect(tampered).not.toBe(original);
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path, tampered, "utf8"),
    );

    const result = await runAdapterConformance({ cwd: dir, agentName: agent });
    expect(result.compliant).toBe(false);
    const sectionCheck = result.checks.find(
      (c) => c.id === "contract_section_present",
    );
    expect(sectionCheck?.status).toBe("fail");
  });

  it("runAdapterConformance returns compliant: false on file checksum mismatch", async () => {
    await installAdapter(agent);
    const manifest = await readManifest(dir, agent);
    const instruction = manifest!.files.find((f) => f.role === "instruction");
    const path = join(dir, instruction!.path);
    const original = await readFile(path, "utf8");
    // Append a single line so the sha256 mismatches the manifest but
    // the contract heading + surfaces remain intact.
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path, original + "\n<!-- tampered -->\n", "utf8"),
    );

    const result = await runAdapterConformance({ cwd: dir, agentName: agent });
    expect(result.compliant).toBe(false);
    const checksumChecks = result.checks.filter(
      (c) => c.id === "file_checksum_match",
    );
    expect(checksumChecks.some((c) => c.status === "fail")).toBe(true);
  });

  // ----- P30: adapter contract hardening -----

  it("the P30 hardening checks pass on a fresh install (template is P29-aligned)", async () => {
    await installAdapter(agent);
    const result = await runAdapterConformance({ cwd: dir, agentName: agent });
    for (const id of [
      "task_prepare_is_primary",
      "no_contract_antipatterns",
      "activation_rules_documented",
    ]) {
      const c = result.checks.find((x) => x.id === id);
      expect(c, `${id} present`).toBeDefined();
      expect(c!.status, `${id} passes`).toBe("pass");
    }
  });

  it("P30 checks are advisory below the hardening version and required at/above it", async () => {
    // Default install records generator_version 0.9.0-alpha.0 → advisory.
    await installAdapter(agent);
    const below = await runAdapterConformance({ cwd: dir, agentName: agent });
    expect(
      below.checks.find((c) => c.id === "task_prepare_is_primary")?.severity,
    ).toBe("advisory");

    // Re-install at the hardening threshold → required. Templates are
    // unchanged (content does not depend on generator_version), so the
    // checks still pass and the adapter stays compliant.
    await runAdapterInstall({
      cwd: dir,
      agentName: agent,
      force: true,
      locale: "en-US",
      generatorVersionOverride: "1.14.0",
    });
    const at = await runAdapterConformance({ cwd: dir, agentName: agent });
    expect(
      at.checks.find((c) => c.id === "task_prepare_is_primary")?.severity,
    ).toBe("required");
    expect(at.compliant).toBe(true);
  });
});

// P30: end-to-end severity behavior of a *violating* instruction. The
// per-adapter suite above only exercises conformant templates (the checks
// pass) and the severity *assignment*; the unit suite covers the pure
// predicates. This block closes the gap the P30 DoD calls for — the join
// of manifest generator_version + violating content + remediation +
// compliant — through runAdapterConformance. claude-code only is enough.
describe("adapter conformance — P30 violating fixture severity (claude-code)", () => {
  const agent = "claude-code" as const;

  // Inject the P29 anti-pattern (`task finalize ... --agent`) WITHOUT
  // removing any required content, so `no_contract_antipatterns` is the
  // only check that fails. The manifest sha256 is re-synced to the
  // tampered content so `file_checksum_match` (a required check) does not
  // mask the hardening-check behavior under test.
  async function injectAntipatternKeepingChecksumValid(): Promise<{
    originalSha: string;
  }> {
    const manifest = await readManifest(dir, agent);
    const instr = manifest!.files.find((f) => f.role === "instruction")!;
    const instrPath = join(dir, instr.path);
    const original = await readFile(instrPath, "utf8");
    const tampered =
      original +
      "\n\nExample (DO NOT FOLLOW): code-pact task finalize <id> --agent claude-code\n";
    await writeFile(instrPath, tampered, "utf8");

    const newSha = createHash("sha256")
      .update(tampered.replace(/\r\n/g, "\n"), "utf8")
      .digest("hex");
    const manifestPath = join(dir, ".code-pact", "adapters", `${agent}.manifest.yaml`);
    const raw = await readFile(manifestPath, "utf8");
    const updated = raw.replace(instr.sha256, newSha);
    expect(updated).not.toBe(raw); // the instruction sha was present and swapped
    await writeFile(manifestPath, updated, "utf8");
    return { originalSha: instr.sha256 };
  }

  async function setGeneratorVersion(version: string): Promise<void> {
    const manifestPath = join(dir, ".code-pact", "adapters", `${agent}.manifest.yaml`);
    const raw = await readFile(manifestPath, "utf8");
    const updated = raw.replace(/generator_version: .*/, `generator_version: ${version}`);
    expect(updated).not.toBe(raw);
    await writeFile(manifestPath, updated, "utf8");
  }

  it("below threshold: the anti-pattern is an advisory failure — compliant stays true, with remediation", async () => {
    await installAdapter(agent); // generator_version 0.9.0-alpha.0 < 1.14.0
    await injectAntipatternKeepingChecksumValid();

    const result = await runAdapterConformance({ cwd: dir, agentName: agent });
    const check = result.checks.find((c) => c.id === "no_contract_antipatterns")!;
    expect(check.status).toBe("fail");
    expect(check.severity).toBe("advisory");
    expect(result.compliant).toBe(true);
    expect(check.details?.remediation).toBe(`adapter upgrade ${agent} --write`);
    // The sha re-sync must hold so checksum failure does not mask the behavior.
    expect(
      result.checks.find(
        (c) => c.id === "file_checksum_match" && c.status === "fail",
      ),
    ).toBeUndefined();
  });

  it("at the threshold: the same anti-pattern is a required failure — compliant becomes false", async () => {
    await installAdapter(agent);
    await injectAntipatternKeepingChecksumValid();
    await setGeneratorVersion("1.14.0");

    const result = await runAdapterConformance({ cwd: dir, agentName: agent });
    const check = result.checks.find((c) => c.id === "no_contract_antipatterns")!;
    expect(check.status).toBe("fail");
    expect(check.severity).toBe("required");
    expect(result.compliant).toBe(false);
  });
});

// claude-code-only: skill files follow the .claude/skills/<verb>.md slash
// command convention. codex / generic have no skill role, so the suite-wide
// test would have nothing to assert there.
describe("adapter conformance — claude-code skill content", () => {
  it("every skill file mentions code-pact and a matching slash verb", async () => {
    await installAdapter("claude-code");
    const manifest = await readManifest(dir, "claude-code");
    const skills = manifest!.files.filter((f) => f.role === "skill");
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      const content = await readFile(join(dir, skill.path), "utf8");
      expect(content).toContain("code-pact");
      const verb = skill.path.split("/").pop()!.replace(/\.md$/, "");
      expect(content).toContain(`/${verb}`);
    }
  });
});
