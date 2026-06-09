import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDecisionRetention, resolveRetention } from "../../../../src/core/decisions/retention.ts";
import { Project } from "../../../../src/core/schemas/project.ts";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-retention-"));
  await mkdir(join(cwd, ".code-pact"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function writeProject(body: string): Promise<void> {
  await writeFile(join(cwd, ".code-pact", "project.yaml"), body, "utf8");
}

const BASE = `name: x\nversion: 0.1.0\nlocale: en-US\ndefault_agent: claude-code\nagents:\n  - name: claude-code\n    profile: agent-profiles/claude-code.yaml\n`;

describe("readDecisionRetention", () => {
  it("reads an explicit policy as source 'project'", async () => {
    await writeProject(`${BASE}decision_retention: prune-on-ship\n`);
    expect(await readDecisionRetention(cwd)).toEqual({ policy: "prune-on-ship", source: "project" });
  });

  it("defaults to keep-full / 'default' when the field is absent", async () => {
    await writeProject(BASE);
    expect(await readDecisionRetention(cwd)).toEqual({ policy: "keep-full", source: "default" });
  });

  it("is tolerant: a missing project.yaml → keep-full / 'default' (never throws)", async () => {
    expect(await readDecisionRetention(cwd)).toEqual({ policy: "keep-full", source: "default" });
  });

  it("a PRESENT but out-of-enum value → keep-full / 'invalid_project' (honest, not silent default)", async () => {
    await writeProject(`${BASE}decision_retention: prun-on-ship\n`); // typo
    expect(await readDecisionRetention(cwd)).toEqual({ policy: "keep-full", source: "invalid_project" });
  });

  it("a PRESENT but EMPTY field (`decision_retention:` → null) is 'invalid_project', not 'default'", async () => {
    await writeProject(`${BASE}decision_retention:\n`);
    expect(await readDecisionRetention(cwd)).toEqual({ policy: "keep-full", source: "invalid_project" });
  });

  it("an explicit `decision_retention: null` is 'invalid_project' (present, not absent)", async () => {
    await writeProject(`${BASE}decision_retention: null\n`);
    expect(await readDecisionRetention(cwd)).toEqual({ policy: "keep-full", source: "invalid_project" });
  });

  it("is tolerant: unparseable YAML → keep-full / 'default'", async () => {
    await writeProject(":\n  not: [valid");
    expect(await readDecisionRetention(cwd)).toEqual({ policy: "keep-full", source: "default" });
  });
});

describe("resolveRetention", () => {
  it("a --policy override wins over the project value, source 'override'", async () => {
    await writeProject(`${BASE}decision_retention: prune-on-ship\n`);
    expect(await resolveRetention(cwd, "keep-full")).toEqual({ policy: "keep-full", source: "override" });
  });

  it("no override → falls back to the project/default reader", async () => {
    await writeProject(`${BASE}decision_retention: compress-on-ship\n`);
    expect(await resolveRetention(cwd)).toEqual({ policy: "compress-on-ship", source: "project" });
  });
});

describe("Project schema — decision_retention (what validate / doctor enforce)", () => {
  const valid = {
    name: "x",
    version: "0.1.0",
    locale: "en-US",
    default_agent: "claude-code",
    agents: [{ name: "claude-code", profile: "agent-profiles/claude-code.yaml" }],
  };

  it("accepts the three policy values", () => {
    for (const v of ["keep-full", "compress-on-ship", "prune-on-ship"]) {
      expect(Project.safeParse({ ...valid, decision_retention: v }).success).toBe(true);
    }
  });

  it("accepts absence (backward-compatible)", () => {
    expect(Project.safeParse(valid).success).toBe(true);
  });

  it("REJECTS an out-of-enum value (so validate/doctor flag a typo)", () => {
    expect(Project.safeParse({ ...valid, decision_retention: "prune" }).success).toBe(false);
  });

  it("REJECTS null (a present-but-empty `decision_retention:` is a SCHEMA_ERROR, not absence)", () => {
    expect(Project.safeParse({ ...valid, decision_retention: null }).success).toBe(false);
  });
});
