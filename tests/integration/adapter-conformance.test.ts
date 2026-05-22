import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { runInit } from "../../src/commands/init.ts";
import { runAdapterInstall } from "../../src/commands/adapter-install.ts";
import { readManifest } from "../../src/core/adapters/manifest.ts";
import { AdapterManifest } from "../../src/core/schemas/adapter-manifest.ts";
import { AgentProfile } from "../../src/core/schemas/agent-profile.ts";
import { adapterRegistry } from "../../src/core/adapters/index.ts";
import { assertSafeRelativePath } from "../../src/core/adapters/file-state.ts";

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

const REQUIRED_CLI_REFS = [
  "code-pact recommend",
  "code-pact task context",
  "code-pact task complete",
  "code-pact validate",
];

// v1.7 P16-T4: agent-contract conformance.
//
// The agent contract section's headings are English-locked across ALL
// locales per design/decisions/agent-contract-rfc.md. The conformance
// regex anchors on the verbatim heading strings below — drift in the
// heading text is a contract break.
const AGENT_CONTRACT_SECTION_HEADING = "## Agent contract";
const AGENT_CONTRACT_AXIS_HEADINGS = [
  "### When to invoke code-pact",
  "### What to verify first",
  "### How to handle failures",
];
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

async function installAdapter(agent: (typeof STABLE_AGENTS)[number]) {
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
    generatorVersionOverride: "0.9.0-alpha.0",
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
