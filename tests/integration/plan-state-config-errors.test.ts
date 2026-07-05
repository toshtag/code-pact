import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonErr,
  type RunResult,
} from "../helpers/cli.ts";

beforeAll(() => ensureCliBuilt(), 60_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const STRICT_PLAN_STATE_COMMANDS: Array<{ name: string; args: string[] }> = [
  { name: "status", args: ["status", "--json"] },
  { name: "phase ls", args: ["phase", "ls", "--json"] },
  { name: "plan analyze", args: ["plan", "analyze", "--json"] },
  { name: "task runbook", args: ["task", "runbook", "P1-T1", "--json"] },
  { name: "phase runbook", args: ["phase", "runbook", "P1", "--json"] },
];

function expectConfigErrorExit2(res: RunResult, name: string, forbidden?: string): void {
  const env = expectJsonErr(res, "CONFIG_ERROR");
  expect(res.code, name).toBe(2);
  expect(env.error.message, name).not.toMatch(/INTERNAL_ERROR/i);
  expect(res.stdout + res.stderr, name).not.toMatch(/INTERNAL_ERROR/i);
  if (forbidden) expect(res.stdout + res.stderr, name).not.toContain(forbidden);
}

describe("strict plan-state commands — CONFIG_ERROR contract", () => {
  it("refuse an external-symlinked roadmap with exit 2 and no outside content leak", async () => {
    const p = await createTempProject({ prefix: "code-pact-plan-state-config-" });
    cleanups.push(p.cleanup);
    const outside = await mkdtemp(join(tmpdir(), "code-pact-outside-roadmap-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));

    const marker = "OUTSIDE_ROADMAP_MARKER_SHOULD_NOT_LEAK";
    await writeFile(join(outside, "roadmap.yaml"), `# ${marker}\nphases: []\n`, "utf8");
    await rm(join(p.dir, "design", "roadmap.yaml"));
    await symlink(join(outside, "roadmap.yaml"), join(p.dir, "design", "roadmap.yaml"));

    for (const command of STRICT_PLAN_STATE_COMMANDS) {
      expectConfigErrorExit2(p.run(command.args), command.name, marker);
    }
  });

  it("surface malformed roadmap as CONFIG_ERROR, never INTERNAL_ERROR", async () => {
    const p = await createTempProject({ prefix: "code-pact-plan-state-malformed-" });
    cleanups.push(p.cleanup);
    await mkdir(join(p.dir, "design"), { recursive: true });
    await writeFile(join(p.dir, "design", "roadmap.yaml"), ":\n  not: [valid", "utf8");

    for (const command of STRICT_PLAN_STATE_COMMANDS) {
      expectConfigErrorExit2(p.run(command.args), command.name);
    }
  });
});
