import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { runInit } from "../../../src/commands/init.ts";
import {
  Project,
  Roadmap,
  AgentProfile,
  ModelProfile,
  ProgressLog,
  BaselineSnapshot,
} from "../../../src/core/schemas/index.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-init-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readYaml(rel: string): Promise<unknown> {
  const raw = await readFile(join(dir, rel), "utf8");
  return parseYaml(raw);
}

async function readJson(rel: string): Promise<unknown> {
  const raw = await readFile(join(dir, rel), "utf8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runInit — default options (claude-code, ja-JP)", () => {
  it("returns a created list with no skipped files", async () => {
    const result = await runInit({
      cwd: dir,
      locale: "ja-JP",
      agents: ["claude-code"],
      force: false,
      json: false,
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.created.length).toBeGreaterThan(0);
  });

  it("generates a valid project.yaml", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    const data = await readYaml(".code-pact/project.yaml");
    const project = Project.parse(data);
    expect(project.locale).toBe("ja-JP");
    expect(project.default_agent).toBe("claude-code");
    expect(project.agents).toHaveLength(1);
  });

  it("generates a valid roadmap.yaml with empty phases", async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
    const data = await readYaml("design/roadmap.yaml");
    const roadmap = Roadmap.parse(data);
    expect(roadmap.phases).toHaveLength(0);
  });

  it("generates a valid claude-code agent profile", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    const data = await readYaml(".code-pact/agent-profiles/claude-code.yaml");
    const profile = AgentProfile.parse(data);
    expect(profile.name).toBe("claude-code");
    expect(profile.model_map.highest_reasoning).toBe("claude-opus-4-8");
  });

  it("generates all three model profiles", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    for (const tierFile of ["highest-reasoning.yaml", "balanced-coding.yaml", "cheap-mechanical.yaml"]) {
      const data = await readYaml(`.code-pact/model-profiles/${tierFile}`);
      expect(() => ModelProfile.parse(data)).not.toThrow();
    }
  });

  it("generates a valid empty progress.yaml", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    const data = await readYaml(".code-pact/state/progress.yaml");
    const log = ProgressLog.parse(data);
    expect(log.events).toHaveLength(0);
  });

  it("generates a valid initial baseline snapshot", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    const data = await readJson(".code-pact/state/baselines/initial.json");
    const snap = BaselineSnapshot.parse(data);
    expect(snap.name).toBe("initial");
    expect(snap.total_weight).toBe(0);
    expect(snap.phases).toHaveLength(0);
  });

  it("generates constitution.md and rules/coding-style.md", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    const constitution = await readFile(join(dir, "design", "constitution.md"), "utf8");
    expect(constitution).toContain("Constitution");
    const codingStyle = await readFile(join(dir, "design", "rules", "coding-style.md"), "utf8");
    expect(codingStyle).toContain("tags:");
  });
});

describe("runInit — multiple agents (claude-code + codex)", () => {
  it("generates both agent profiles", async () => {
    await runInit({
      cwd: dir,
      locale: "en-US",
      agents: ["claude-code", "codex"],
      force: false,
      json: false,
    });
    const claude = AgentProfile.parse(await readYaml(".code-pact/agent-profiles/claude-code.yaml"));
    expect(claude.name).toBe("claude-code");
    const codex = AgentProfile.parse(await readYaml(".code-pact/agent-profiles/codex.yaml"));
    expect(codex.name).toBe("codex");
  });

  it("sets default_agent to the first listed agent", async () => {
    await runInit({
      cwd: dir,
      locale: "en-US",
      agents: ["codex", "claude-code"],
      force: false,
      json: false,
    });
    const project = Project.parse(await readYaml(".code-pact/project.yaml"));
    expect(project.default_agent).toBe("codex");
  });
});

describe("runInit — double init (no --force)", () => {
  it("throws ALREADY_INITIALIZED on second run", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    await expect(
      runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false }),
    ).rejects.toMatchObject({ code: "ALREADY_INITIALIZED" });
  });
});

describe("runInit — --force overwrites", () => {
  it("overwrites existing files when force is true", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    const result = await runInit({
      cwd: dir,
      locale: "en-US",
      agents: ["claude-code"],
      force: true,
      json: false,
    });
    // All files should be in created (overwritten), not skipped
    expect(result.skipped).toHaveLength(0);
    // locale should now be en-US
    const project = Project.parse(await readYaml(".code-pact/project.yaml"));
    expect(project.locale).toBe("en-US");
  });
});

describe("runInit — blanket /.code-pact/ ignore advisory (v1.32)", () => {
  function git(cwd: string, args: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("git", args, {
        cwd,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@e.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@e.com",
        },
      });
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} (${code})`)),
      );
      proc.on("error", reject);
    });
  }

  const run = () =>
    runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });

  // --- Outside a git repo: text heuristic, softened to a possibility ---

  it("warns (softened) when not yet a git repo and the .gitignore blanket-ignores .code-pact/", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules/\n/.code-pact/\n", "utf8");
    const result = await run();
    expect(result.warnings.length).toBeGreaterThan(0);
    const w = result.warnings.join("\n");
    expect(w).toContain("/.code-pact/");
    expect(w).toContain("CONTROL_PLANE_GITIGNORED");
    expect(w).toContain("may"); // possibility, not a verdict, before `git init`
    // Non-destructive: the user's blanket line is preserved verbatim.
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("/.code-pact/");
  });

  it("also warns (softened, no repo) for the wildcard blanket form .code-pact/**", async () => {
    await writeFile(join(dir, ".gitignore"), ".code-pact/**\n", "utf8");
    expect((await run()).warnings.length).toBeGreaterThan(0);
  });

  it("does not warn for a fresh project (init writes only the narrow ignore)", async () => {
    expect((await run()).warnings).toHaveLength(0);
  });

  it("does not warn for a scoped (non-blanket) .code-pact rule like .code-pact/*.log", async () => {
    await writeFile(join(dir, ".gitignore"), "/.code-pact/*.log\n", "utf8");
    expect((await run()).warnings).toHaveLength(0);
  });

  // --- Inside a git repo: authoritative via `git check-ignore` ---

  it("warns (verdict: WILL NOT reach git) when a git repo blanket-ignores .code-pact/", async () => {
    await git(dir, ["init", "--quiet", "--initial-branch=main"]);
    await writeFile(join(dir, ".gitignore"), "/.code-pact/\n", "utf8");
    const result = await run();
    expect(result.warnings.length).toBeGreaterThan(0);
    const w = result.warnings.join("\n");
    expect(w).toContain("will NOT reach git");
    expect(w).toContain("CONTROL_PLANE_GITIGNORED");
  });

  it("warns (verdict) on a file-scoped ledger ignore in a git repo (events/*.yaml)", async () => {
    await git(dir, ["init", "--quiet", "--initial-branch=main"]);
    await writeFile(join(dir, ".gitignore"), "/.code-pact/state/events/*.yaml\n", "utf8");
    expect((await run()).warnings.length).toBeGreaterThan(0);
  });

  it("warns when only the ledger is re-included but shared config stays ignored", async () => {
    // The whole control plane must reach git, not just the ledger.
    await git(dir, ["init", "--quiet", "--initial-branch=main"]);
    await writeFile(
      join(dir, ".gitignore"),
      "/.code-pact/*\n!/.code-pact/state\n/.code-pact/state/*\n!/.code-pact/state/events\n",
      "utf8",
    );
    expect((await run()).warnings.length).toBeGreaterThan(0);
  });

  it("does not warn when a git repo has only the narrow entries (whole plane committable)", async () => {
    await git(dir, ["init", "--quiet", "--initial-branch=main"]);
    await writeFile(
      join(dir, ".gitignore"),
      "/.code-pact/locks/\n/.code-pact/cache/\n/.local/\n/.context/\n",
      "utf8",
    );
    expect((await run()).warnings).toHaveLength(0);
  });

  it("config-only ignore: warns, but does NOT unconditionally claim the branch-drift gate skips", async () => {
    // Only project.yaml is ignored; the ledger (state/events/) is NOT. The
    // problem is a clean checkout missing project config — the branch-drift CI
    // gate skip happens ONLY when the LEDGER is ignored, so the warning must
    // state that as a condition, not unconditionally (Gap1 accuracy).
    await git(dir, ["init", "--quiet", "--initial-branch=main"]);
    await writeFile(join(dir, ".gitignore"), "/.code-pact/project.yaml\n", "utf8");
    const result = await run();
    expect(result.warnings.length).toBeGreaterThan(0);
    const w = result.warnings.join("\n");
    expect(w).toContain("CONTROL_PLANE_GITIGNORED");
    expect(w).toContain("project.yaml"); // the ignored area is named
    // Conditional phrasing present; the old unconditional coupling is gone.
    expect(w).toContain("If the ledger itself is ignored");
    expect(w).not.toContain("the branch-drift CI gate silently skips");
  });
});
