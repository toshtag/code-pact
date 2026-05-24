// Subprocess integration coverage for `code-pact tutorial` (v1.15+).
//
// The tutorial command runs the per-task loop end to end inside a
// throwaway sandbox and then deletes it. These tests assert the real
// built CLI: the JSON contract, the human narration, and that nothing is
// left on disk.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCliBuilt, run } from "../helpers/cli.ts";

let cwd: string;

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("code-pact tutorial (integration)", () => {
  it("--json emits a single envelope with seven steps and cleans up", async () => {
    cwd = await mkdtemp(join(tmpdir(), "code-pact-tutorial-itest-"));
    const res = run(cwd, ["tutorial", "--json"]);

    expect(res.code).toBe(0);
    const envelope = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { sandbox: string; kept: boolean; steps: { command: string }[] };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.kept).toBe(false);
    expect(envelope.data.steps).toHaveLength(7);
    expect(envelope.data.steps[0]!.command).toBe("init --sample-phase");
    // The sandbox the run reported must be gone.
    expect(existsSync(envelope.data.sandbox)).toBe(false);
  });

  it("human mode narrates the loop to stdout and writes nothing to cwd", async () => {
    cwd = await mkdtemp(join(tmpdir(), "code-pact-tutorial-itest-"));
    const res = run(cwd, ["tutorial"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("code-pact tutorial");
    expect(res.stdout).toContain("task finalize TUTORIAL-T1 --write");
    expect(res.stdout).toContain("nothing was written to your project");
    // The command must not initialize the cwd it was invoked from.
    expect(existsSync(join(cwd, ".code-pact"))).toBe(false);
    expect(existsSync(join(cwd, "design"))).toBe(false);
  });
});
