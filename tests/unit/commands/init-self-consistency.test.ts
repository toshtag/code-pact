// PR3 (init self-consistency) regressions:
//   - init merges into an existing .gitignore instead of skipping it, adds
//     both /.local/ and /.context/, preserves existing lines, no duplicates.
//   - init returns suggested_next_steps (onboarding guidance).
//   - plan constitution may replace the pristine init placeholder without
//     --force, but protects a user-edited constitution (even one that still
//     contains the edit-hint marker).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import { runPlanConstitution } from "../../../src/commands/plan-constitution.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-init-self-consistency-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const gitignorePath = () => join(dir, ".gitignore");
const constitutionPath = () => join(dir, "design", "constitution.md");

describe("init — .gitignore merge", () => {
  it("creates .gitignore with /.local/ and /.context/ on a fresh project", async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
    const content = await readFile(gitignorePath(), "utf8");
    expect(content).toMatch(/^\/\.local\/$/m);
    expect(content).toMatch(/^\/\.context\/$/m);
  });

  it("merges into an existing .gitignore, preserving user lines and not duplicating", async () => {
    // Pre-existing .gitignore with custom lines and `.local/` (no leading slash).
    await writeFile(gitignorePath(), "node_modules/\ncustom-secret.txt\n.local/\n", "utf8");

    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });

    const content = await readFile(gitignorePath(), "utf8");
    // user lines preserved
    expect(content).toContain("node_modules/");
    expect(content).toContain("custom-secret.txt");
    // .context/ added
    expect(content).toMatch(/\.context\//);
    // .local/ NOT duplicated — the slash-insensitive match means the existing
    // `.local/` already satisfies `/.local/`, so no second entry is appended.
    const localCount = content.split("\n").filter((l) => l.trim().replace(/^\/+/, "").replace(/\/+$/, "") === ".local").length;
    expect(localCount).toBe(1);
  });

  it("re-running init --force does not duplicate or skip-record an already-complete .gitignore", async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
    const result = await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: true, json: false });

    // .gitignore already has both entries → not recorded as skipped (clean no-op).
    expect(result.skipped).toHaveLength(0);
    const content = await readFile(gitignorePath(), "utf8");
    const contextCount = content.split("\n").filter((l) => l.includes(".context")).length;
    expect(contextCount).toBe(1);
  });
});

describe("init — suggested_next_steps", () => {
  it("returns onboarding guidance pointing at the constitution", async () => {
    const result = await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
    expect(result.suggested_next_steps.length).toBeGreaterThan(0);
    expect(result.suggested_next_steps.join("\n")).toMatch(/constitution/i);
  });
});

describe("plan constitution — placeholder-aware replacement", () => {
  it("replaces the pristine init placeholder without --force", async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });

    const result = await runPlanConstitution({
      cwd: dir,
      locale: "en-US",
      force: false,
      answers: { description: "Ship reliable software.", principles: ["Keep it simple."] },
    });

    expect(result.skipped).toBe(false);
    const content = await readFile(constitutionPath(), "utf8");
    expect(content).toContain("Ship reliable software.");
  });

  it("protects a user-edited constitution without --force, even if the edit hint remains", async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });

    // Edit the body but leave the edit-hint marker line in place. Marker
    // presence alone must NOT make it look like the pristine placeholder.
    const placeholder = await readFile(constitutionPath(), "utf8");
    const edited = placeholder.replace(/^- .*/m, "- A principle the user actually wrote.");
    expect(edited).not.toBe(placeholder);
    await writeFile(constitutionPath(), edited, "utf8");

    const result = await runPlanConstitution({
      cwd: dir,
      locale: "en-US",
      force: false,
      answers: { description: "Should not be written.", principles: ["nope"] },
    });

    expect(result.skipped).toBe(true);
    const after = await readFile(constitutionPath(), "utf8");
    expect(after).toBe(edited);
    expect(after).not.toContain("Should not be written.");
  });

  it("overwrites a user-edited constitution when --force is given", async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
    await writeFile(constitutionPath(), "# Mine\n\n- Custom principle.\n", "utf8");

    const result = await runPlanConstitution({
      cwd: dir,
      locale: "en-US",
      force: true,
      answers: { description: "Forced replacement.", principles: ["P"] },
    });

    expect(result.skipped).toBe(false);
    const content = await readFile(constitutionPath(), "utf8");
    expect(content).toContain("Forced replacement.");
  });
});
