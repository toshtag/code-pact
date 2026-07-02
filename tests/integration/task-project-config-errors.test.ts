import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonErr,
} from "../helpers/cli.ts";

beforeAll(() => ensureCliBuilt(), 60_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("task commands — malformed project.yaml error contract", () => {
  it.each([
    ["task context", ["task", "context", "P1-T1", "--json"]],
    ["task prepare", ["task", "prepare", "P1-T1", "--json"]],
    ["task start", ["task", "start", "P1-T1", "--agent", "claude-code", "--json"]],
    ["task complete", ["task", "complete", "P1-T1", "--agent", "claude-code", "--json"]],
  ])("%s returns CONFIG_ERROR / exit 2", async (_label, args) => {
    const p = await createTempProject({ prefix: "code-pact-task-project-error-" });
    cleanups.push(p.cleanup);
    await writeFile(
      join(p.dir, ".code-pact", "project.yaml"),
      "agents: {unclosed",
      "utf8",
    );

    const res = p.run(args);

    expect(res.code).toBe(2);
    expectJsonErr(res, "CONFIG_ERROR");
    expect(`${res.stdout}\n${res.stderr}`).not.toContain("INTERNAL_ERROR");
  });
});
