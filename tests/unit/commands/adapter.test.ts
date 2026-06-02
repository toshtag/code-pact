import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import { runInitCore } from "../../../src/commands/init.ts";
import { runGenerateAdapter } from "../../../src/commands/adapter.ts";
import { deriveSkillName, deriveSkillNameVariants } from "../../../src/core/adapters/claude.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-adapter-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// claude-code adapter
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — claude-code", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
  });

  it("returns created list with CLAUDE.md and skill files", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    expect(result.agentName).toBe("claude-code");
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.includes("CLAUDE.md"))).toBe(true);
    expect(names.some((n) => n.includes("context.md"))).toBe(true);
    expect(names.some((n) => n.includes("verify.md"))).toBe(true);
    expect(names.some((n) => n.includes("progress.md"))).toBe(true);
  });

  it("CLAUDE.md contains model tier entries", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("highest_reasoning");
    expect(content).toContain("claude-opus-4-8");
    expect(content).toContain("balanced_coding");
    expect(content).toContain("cheap_mechanical");
  });

  it("CLAUDE.md instructs the agent to use task context + task complete", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("code-pact task context");
    expect(content).toContain("code-pact task complete");
  });

  it("CLAUDE.md does NOT reference unimplemented `progress --add-event`", async () => {
    // task complete (v0.2) writes progress.yaml on the agent's behalf,
    // so the file is now mentioned descriptively, but the unsupported
    // `progress --add-event` form must still never appear.
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).not.toContain("--add-event");
  });

  it("skips existing files when force is false", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const second = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    expect(second.created).toHaveLength(0);
    expect(second.skipped.length).toBeGreaterThan(0);
  });

  it("second install with --force is idempotent for managed-clean files (v0.9 --force narrowing)", async () => {
    // v0.9: --force is unmanaged-adoption only. After the first install
    // every file is managed-clean × current, so --force has nothing to do.
    // To destructively overwrite a managed-modified file, callers must use
    // `adapter upgrade --write --accept-modified` (P7-T5).
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const second = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: true, locale: "en-US" });
    expect(second.created).toHaveLength(0);
    expect(second.skipped.length).toBeGreaterThan(0);
  });

  it("first install writes a manifest at .code-pact/adapters/<agent>.manifest.yaml", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    expect(result.manifestPath).toBe(
      join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml"),
    );
    const raw = await readFile(result.manifestPath, "utf8");
    expect(raw).toContain("agent_name: claude-code");
    expect(raw).toContain("schema_version: 1");
    expect(raw).toContain("files:");
  });

  it("manifest files[] entries record sha256, role, managed=true", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const raw = await readFile(result.manifestPath, "utf8");
    // Every recorded file should be managed=true with a 64-hex sha256.
    const sha256Matches = raw.match(/sha256: [0-9a-f]{64}/g) ?? [];
    const roleMatches = raw.match(/role: (instruction|skill|hook|rule)/g) ?? [];
    expect(sha256Matches.length).toBeGreaterThan(0);
    expect(roleMatches.length).toBeGreaterThan(0);
    expect(raw).toContain("managed: true");
  });

  it("install is fully idempotent — second run produces identical manifest hashes", async () => {
    const first = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const firstYaml = await readFile(first.manifestPath, "utf8");
    const firstHashes = firstYaml.match(/sha256: [0-9a-f]{64}/g) ?? [];

    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const secondYaml = await readFile(first.manifestPath, "utf8");
    const secondHashes = secondYaml.match(/sha256: [0-9a-f]{64}/g) ?? [];

    expect(secondHashes).toEqual(firstHashes);
  });

  it("--force on first run adopts a pre-existing file matching desired content", async () => {
    // Pre-create CLAUDE.md by running install once, capture content, then
    // delete the manifest to simulate an unmanaged-but-matching disk state.
    const first = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const desiredContent = await readFile(join(dir, "CLAUDE.md"), "utf8");
    const { rm } = await import("node:fs/promises");
    await rm(first.manifestPath);

    // Now re-run with --force — CLAUDE.md is unmanaged × current → adopt.
    const second = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: true, locale: "en-US" });
    const claude = second.files.find((f) => f.relPath === "CLAUDE.md");
    expect(claude?.action).toBe("adopt");
    expect(second.adopted.some((p) => p.endsWith("/CLAUDE.md"))).toBe(true);
    // File content is unchanged after adopt.
    const after = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(after).toBe(desiredContent);
  });

  it("--force on first run replaces an unmanaged file with differing content (replace_unmanaged)", async () => {
    // Pre-create CLAUDE.md with stale content (no manifest).
    await writeFile(join(dir, "CLAUDE.md"), "STALE", "utf8");
    const result = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: true, locale: "en-US" });
    const claude = result.files.find((f) => f.relPath === "CLAUDE.md");
    expect(claude?.action).toBe("replace_unmanaged");
    const after = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(after).not.toBe("STALE");
    expect(after).toContain("Claude Code");
  });

  it("install does NOT overwrite a user-modified managed file (managed-modified × stale → skip)", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    await writeFile(join(dir, "CLAUDE.md"), "USER MODS", "utf8");
    // Even with --force, install is hands-off for managed-modified files.
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: true, locale: "en-US" });
    const after = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(after).toBe("USER MODS");
  });
});

// ---------------------------------------------------------------------------
// codex adapter
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — codex", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["codex"], force: false, json: false });
  });

  it("creates AGENTS.md", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "codex", force: false, locale: "en-US" });
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.includes("AGENTS.md"))).toBe(true);
  });

  it("AGENTS.md contains model tier entries", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "codex", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(content).toContain("highest_reasoning");
    expect(content).toContain("gpt-5.5");
    expect(content).toContain("balanced_coding");
    expect(content).toContain("cheap_mechanical");
  });
});

// ---------------------------------------------------------------------------
// generic adapter
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — generic", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["generic"], force: false, json: false });
  });

  it("writes docs/code-pact/agent-instructions.md", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "generic", force: false, locale: "en-US" });
    expect(result.agentName).toBe("generic");
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.includes("docs/code-pact/agent-instructions.md"))).toBe(true);
  });

  it("agent-instructions.md instructs the agent to use task context + verify", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "generic", force: false, locale: "en-US" });
    const content = await readFile(
      join(dir, "docs", "code-pact", "agent-instructions.md"),
      "utf8",
    );
    expect(content).toContain("code-pact task context");
    expect(content).toContain("code-pact task complete");
  });

  it("agent-instructions.md does NOT reference unimplemented commands or npx", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "generic", force: false, locale: "en-US" });
    const content = await readFile(
      join(dir, "docs", "code-pact", "agent-instructions.md"),
      "utf8",
    );
    // `progress --add-event` never existed and must never be advertised.
    expect(content).not.toContain("--add-event");
    // Generic adapter is for the contributor-distributed binary, not npx.
    expect(content).not.toContain("npx code-pact");
  });

  it("creates .context/generic/ directory for context packs", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "generic", force: false, locale: "en-US" });
    // Directory existence is implied by mkdir recursive; verify by reading.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(dir, ".context"));
    expect(entries).toContain("generic");
  });
});

// ---------------------------------------------------------------------------
// cursor adapter (experimental, v0.2)
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — cursor", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["cursor"], force: false, json: false });
  });

  it("writes .cursor/rules/code-pact.mdc", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "cursor", force: false, locale: "en-US" });
    expect(result.agentName).toBe("cursor");
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.includes(".cursor/rules/code-pact.mdc"))).toBe(
      true,
    );
  });

  it("emits a Cursor-format mdc with frontmatter and alwaysApply: true", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "cursor", force: false, locale: "en-US" });
    const content = await readFile(
      join(dir, ".cursor", "rules", "code-pact.mdc"),
      "utf8",
    );
    // Frontmatter must be the very first thing in the file so Cursor
    // recognises it as a rule. The .mdc format is documented at
    // https://cursor.com/docs/context/rules.
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("alwaysApply: true");
    // Empty globs is intentional: the rule applies project-wide.
    expect(content).toContain("globs: []");
    expect(content).toMatch(/description:\s/);
  });

  it("instructs the agent to use task context + task complete", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "cursor", force: false, locale: "en-US" });
    const content = await readFile(
      join(dir, ".cursor", "rules", "code-pact.mdc"),
      "utf8",
    );
    expect(content).toContain("code-pact task context");
    expect(content).toContain("code-pact task complete");
  });

  it("flags itself as experimental in the file body", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "cursor", force: false, locale: "en-US" });
    const content = await readFile(
      join(dir, ".cursor", "rules", "code-pact.mdc"),
      "utf8",
    );
    expect(content).toMatch(/experimental/i);
  });

  it("does NOT write the deprecated `.cursorrules` legacy file", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "cursor", force: false, locale: "en-US" });
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, ".cursorrules"))).toBe(false);
  });

  it("creates .context/cursor/ directory for context packs", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "cursor", force: false, locale: "en-US" });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(dir, ".context"));
    expect(entries).toContain("cursor");
  });
});

// ---------------------------------------------------------------------------
// gemini-cli adapter (experimental, v0.2)
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — gemini-cli", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["gemini-cli"], force: false, json: false });
  });

  it("writes GEMINI.md at project root", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "gemini-cli", force: false, locale: "en-US" });
    expect(result.agentName).toBe("gemini-cli");
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.endsWith("/GEMINI.md"))).toBe(true);
  });

  it("GEMINI.md instructs the agent to use task context + task complete", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "gemini-cli", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "GEMINI.md"), "utf8");
    expect(content).toContain("code-pact task context");
    expect(content).toContain("code-pact task complete");
  });

  it("flags itself as experimental and links the official source", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "gemini-cli", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "GEMINI.md"), "utf8");
    expect(content).toMatch(/experimental/i);
    expect(content).toContain("github.com/google-gemini/gemini-cli");
  });

  it("does NOT emit YAML frontmatter (Gemini CLI expects plain markdown)", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "gemini-cli", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "GEMINI.md"), "utf8");
    expect(content.startsWith("---\n")).toBe(false);
  });

  it("creates .context/gemini-cli/ directory for context packs", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "gemini-cli", force: false, locale: "en-US" });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(dir, ".context"));
    expect(entries).toContain("gemini-cli");
  });
});

// ---------------------------------------------------------------------------
// Model-aware adapter (v0.5)
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — claude-code model-aware (v0.5)", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
  });

  it("--model opus-4.7: CLAUDE.md includes effort guidance with high/medium/low", async () => {
    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
      modelVersion: "opus-4.7",
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("Model guidance (opus-4.7)");
    expect(content).toContain("`high`");
    expect(content).toContain("`medium`");
    expect(content).toContain("`low`");
    // Opus 4.7 uses adaptive thinking (extended thinking is not supported).
    expect(content).toContain("Adaptive thinking");
    expect(content).not.toContain("Extended thinking is supported");
  });

  it("--model opus-4.6: includes effort guidance with high/medium/low", async () => {
    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
      modelVersion: "opus-4.6",
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("Model guidance (opus-4.6)");
    expect(content).toContain("`high`");
  });

  it("--model sonnet-4.6: notes that effort:high is NOT supported", async () => {
    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
      modelVersion: "sonnet-4.6",
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("Model guidance (sonnet-4.6)");
    expect(content).toContain("not supported");
    expect(content).toContain("highest_reasoning");
  });

  it("no --model: CLAUDE.md does not include Model guidance section", async () => {
    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).not.toContain("Model guidance");
  });

  it("unknown model string: rejects with CONFIG_ERROR before any mutation", async () => {
    await expect(
      runGenerateAdapter({
        cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
        modelVersion: "future-model-99",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    // Validation runs before any filesystem write: the profile is not pinned
    // and no instruction file was produced.
    const profile = await readFile(
      join(dir, ".code-pact", "agent-profiles", "claude-code.yaml"),
      "utf8",
    );
    expect(profile).not.toContain("model_version");
    await expect(readFile(join(dir, "CLAUDE.md"), "utf8")).rejects.toThrow();
  });

  it("model_version from profile.yaml is used when no CLI override", async () => {
    // Write model_version into the agent profile yaml
    const { writeFile: wf } = await import("node:fs/promises");
    const profilePath = join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");
    const original = await readFile(profilePath, "utf8");
    await wf(profilePath, original + "model_version: opus-4.7\n", "utf8");

    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("Model guidance (opus-4.7)");
  });

  it("normalizes a vendor-id model_version from the profile before rendering guidance", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    const profilePath = join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");
    const original = await readFile(profilePath, "utf8");
    // A vendor-id alias is a valid model_version (doctor accepts it via
    // normalizeModelVersion); generation must canonicalize it, not fall back to
    // the generic "no guidance" block keyed on the short canonical id.
    await wf(profilePath, original + "model_version: claude-opus-4-8\n", "utf8");

    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("Model guidance (opus-4.8)");
    expect(content).not.toContain("No model-specific guidance available");
  });

  it("CLI modelVersion overrides model_version from profile.yaml", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    const profilePath = join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");
    const original = await readFile(profilePath, "utf8");
    await wf(profilePath, original + "model_version: opus-4.7\n", "utf8");

    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
      modelVersion: "sonnet-4.6",  // CLI override wins
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("Model guidance (sonnet-4.6)");
    expect(content).not.toContain("Model guidance (opus-4.7)");
  });
});

// ---------------------------------------------------------------------------
// Error: unknown agent
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — unknown agent", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
  });

  it("throws AGENT_NOT_FOUND for unrecognised agent name", async () => {
    await expect(
      runGenerateAdapter({ cwd: dir, agentName: "gemini", force: false, locale: "en-US" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// deriveSkillName unit tests (v0.5.2)
// ---------------------------------------------------------------------------

describe("deriveSkillName", () => {
  // Single-word package-manager tasks: the runner prefix (pnpm/npm/yarn/bun,
  // and an optional `run`) is stripped; the task name is the skill name.
  it("pnpm test → test", () => expect(deriveSkillName("pnpm test")).toBe("test"));
  it("pnpm typecheck → typecheck", () => expect(deriveSkillName("pnpm typecheck")).toBe("typecheck"));
  it("pnpm build → build", () => expect(deriveSkillName("pnpm build")).toBe("build"));
  it("npm run lint → lint", () => expect(deriveSkillName("npm run lint")).toBe("lint"));
  it("yarn dev → dev", () => expect(deriveSkillName("yarn dev")).toBe("dev"));
  it("bun run test:unit → test-unit", () => expect(deriveSkillName("bun run test:unit")).toBe("test-unit"));

  // `make` is NOT a recognised runner: it is a distinct build tool whose
  // subcommand carries meaning (`make build` vs `make test`). The name keeps
  // the full invocation so the two never collapse to the same skill — the
  // self-describing behaviour this helper exists to provide.
  it("make build → make-build", () => expect(deriveSkillName("make build")).toBe("make-build"));

  // Multi-word subcommands keep every word, joined with `-`, so the skill name
  // describes the command instead of reducing to its last token.
  it("code-pact adapter doctor → adapter-doctor", () =>
    expect(deriveSkillName("code-pact adapter doctor")).toBe("adapter-doctor"));
  it("code-pact plan lint → plan-lint", () =>
    expect(deriveSkillName("code-pact plan lint")).toBe("plan-lint"));
  it("node dist/cli.js validate → validate", () =>
    expect(deriveSkillName("node dist/cli.js validate")).toBe("validate"));

  // A space-separated flag value must not leak into the name (the v1.19
  // `claude-code` collision bug): `--agent claude-code` is dropped entirely.
  it("drops a space-separated flag value (adapter doctor --agent claude-code)", () =>
    expect(deriveSkillName("code-pact adapter doctor --agent claude-code")).toBe("adapter-doctor"));
  it("drops a --flag=value form (validate --json)", () =>
    expect(deriveSkillName("node dist/cli.js validate --json")).toBe("validate"));

  // No words at all → fall back to the first flag name.
  it("flag-only command falls back to the first flag (--json → json)", () =>
    expect(deriveSkillName("pnpm --json")).toBe("json"));

  // A flag as the LAST token (no following value) must not crash and must not
  // pull a non-existent value into the name.
  it("trailing flag with no value (adapter doctor --agent)", () =>
    expect(deriveSkillName("code-pact adapter doctor --agent")).toBe("adapter-doctor"));

  // The first flag is the word/flag boundary: a bare token AFTER a flag is a
  // value or positional and is NOT a naming word, so a (boolean) flag placed
  // before a word never eats that word in a way that changes the name set.
  // `code-pact plan lint` and `code-pact plan lint --json` share the base
  // `plan-lint`; flags only EXTEND the ladder, never replace the base.
  it("a flag does not consume a following word for naming (plan lint --strict extra)", () =>
    expect(deriveSkillName("code-pact plan lint --strict extra")).toBe("plan-lint"));
});

// ---------------------------------------------------------------------------
// deriveSkillNameVariants — the self-describing candidate ladder
// ---------------------------------------------------------------------------

describe("deriveSkillNameVariants", () => {
  it("a plain command yields just its base name", () => {
    expect(deriveSkillNameVariants("pnpm test")).toEqual(["test"]);
  });

  it("walks base → flag-qualified forms in order", () => {
    expect(deriveSkillNameVariants("code-pact adapter upgrade --check --json")).toEqual([
      "adapter-upgrade",
      "adapter-upgrade-check",
      "adapter-upgrade-check-json",
    ]);
  });

  it("ignores flag values when qualifying (only flag names extend the ladder)", () => {
    expect(deriveSkillNameVariants("code-pact adapter doctor --agent claude-code --json")).toEqual([
      "adapter-doctor",
      "adapter-doctor-agent",
      "adapter-doctor-agent-json",
    ]);
  });

  it("is deterministic: same command → same ladder", () => {
    const cmd = "node dist/cli.js plan lint --include-quality --strict --json";
    expect(deriveSkillNameVariants(cmd)).toEqual(deriveSkillNameVariants(cmd));
  });

  it("the base name is always the first candidate", () => {
    const variants = deriveSkillNameVariants("code-pact plan lint --strict");
    expect(variants[0]).toBe("plan-lint");
  });
});

// ---------------------------------------------------------------------------
// Skill generation from verification commands (v0.5.2)
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — v0.5.2 skill generation", () => {
  beforeEach(async () => {
    await runInitCore({
      cwd: dir,
      locale: "en-US",
      agents: ["claude-code"],
      force: false,
      json: false,
      createSamplePhase: true,
      verifyCommand: "pnpm test",
    });
  });

  it("generates test.md skill from verification command pnpm test", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const skillContent = await readFile(join(dir, ".claude", "skills", "test.md"), "utf8");
    expect(skillContent).toContain("/test");
    expect(skillContent).toContain("pnpm test");
  });

  it("generated skill is listed in created result", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.includes("test.md"))).toBe(true);
  });

  it("re-run without force skips existing skill files", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const second = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    expect(second.skipped.some((p) => p.includes("test.md"))).toBe(true);
  });

  it("--regen-skills does NOT overwrite a user-modified skill file (v0.9 safety invariant)", async () => {
    // v0.9 narrowing: --regen-skills is a role-scoped force, but force is
    // unmanaged-adoption only and cannot touch managed-modified files.
    // Destructive overwrite requires `adapter upgrade --write --accept-modified`.
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    await writeFile(join(dir, "CLAUDE.md"), "SENTINEL", "utf8");
    await writeFile(join(dir, ".claude", "skills", "test.md"), "OLD", "utf8");

    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US", regenSkills: true });

    // Both managed-modified files are preserved.
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe("SENTINEL");
    expect(await readFile(join(dir, ".claude", "skills", "test.md"), "utf8")).toBe("OLD");
  });

  it("--regen-skills adopts a pre-existing unmanaged skill (role-scoped force)", async () => {
    // Pre-create a stale test.md (unmanaged — no manifest yet).
    await mkdir(join(dir, ".claude", "skills"), { recursive: true });
    await writeFile(join(dir, ".claude", "skills", "test.md"), "STALE", "utf8");
    // Pre-create an unmanaged CLAUDE.md too — it should be left alone since
    // --regen-skills only scopes to skill role.
    await writeFile(join(dir, "CLAUDE.md"), "USER CLAUDE", "utf8");

    const result = await runGenerateAdapter({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      regenSkills: true,
    });

    // test.md was unmanaged × stale → replace_unmanaged (regenSkills scopes force to skills)
    const testFile = result.files.find((f) => f.relPath.endsWith("test.md"));
    expect(testFile?.action).toBe("replace_unmanaged");
    expect(await readFile(join(dir, ".claude", "skills", "test.md"), "utf8")).toContain("pnpm test");

    // CLAUDE.md (role=instruction) is NOT touched by --regen-skills.
    const claude = result.files.find((f) => f.relPath === "CLAUDE.md");
    expect(claude?.action).toBe("skip");
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe("USER CLAUDE");
  });

  it("no roadmap → no crash, only fixed skills are created", async () => {
    // Remove roadmap to simulate project without phases
    const { rm: fsRm } = await import("node:fs/promises");
    await fsRm(join(dir, "design", "roadmap.yaml"));

    const result = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: true, locale: "en-US" });
    const names = result.created.map((p) => p.replace(dir, ""));
    // Fixed skills must exist
    expect(names.some((n) => n.includes("context.md"))).toBe(true);
    expect(names.some((n) => n.includes("verify.md"))).toBe(true);
    expect(names.some((n) => n.includes("progress.md"))).toBe(true);
    // No dynamic skill from roadmap
    expect(names.some((n) => n.includes("test.md"))).toBe(false);
  });

  it("multiple phases with the same command produce one skill file", async () => {
    // Add a second phase with the same verification command
    const roadmapContent = await readFile(join(dir, "design", "roadmap.yaml"), "utf8");
    await mkdir(join(dir, "design", "phases"), { recursive: true });
    await writeFile(
      join(dir, "design", "phases", "P2-extra.yaml"),
      [
        "id: P2", "name: Extra", "weight: 5", "confidence: high", "risk: low",
        "status: planned", "objective: Extra phase.", "definition_of_done:", "  - Done",
        "verification:", "  commands:", "    - pnpm test",
        "tasks: []",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      roadmapContent + "  - id: P2\n    path: design/phases/P2-extra.yaml\n    weight: 5\n",
      "utf8",
    );

    const result = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: true, locale: "en-US" });
    const skillFiles = result.created.filter((p) => p.includes("test.md"));
    expect(skillFiles).toHaveLength(1);
  });
});
