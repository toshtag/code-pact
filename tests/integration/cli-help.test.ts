// PR4: subcommand clusters answer --help with usage (exit 0) instead of
// CONFIG_ERROR. plan / task / phase also treat a bare cluster invocation as a
// help request; adapter is intentionally excluded (bare adapter is an error —
// see adapter-cli.test.ts).

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { cliPath, ensureCliBuilt } from "../helpers/cli.ts";

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

function runCli(args: string[]) {
  // Help needs no project on disk; run from a neutral cwd.
  return spawnSync("node", [cliPath, ...args], {
    cwd: tmpdir(),
    encoding: "utf8",
    stdio: "pipe",
  });
}

describe("cluster --help → usage, exit 0", () => {
  for (const cluster of ["plan", "task", "phase"]) {
    it(`\`${cluster} --help\` prints usage on stdout, exit 0`, () => {
      const res = runCli([cluster, "--help"]);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/Subcommands:/);
    });

    it(`bare \`${cluster}\` (no subcommand) also prints usage, exit 0`, () => {
      const res = runCli([cluster]);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/Subcommands:/);
    });

    it(`\`${cluster} help\` and \`${cluster} -h\` print usage, exit 0`, () => {
      for (const variant of [[cluster, "help"], [cluster, "-h"]]) {
        const res = runCli(variant);
        expect(res.status).toBe(0);
        expect(res.stdout).toMatch(/Subcommands:/);
      }
    });
  }

  it("`plan lint --help` → per-subcommand usage, exit 0 (no lint run)", () => {
    const res = runCli(["plan", "lint", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/code-pact plan lint/);
  });

  it("`task record-done --help` → rich usage with flags and examples, exit 0", () => {
    const res = runCli(["task", "record-done", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Usage: code-pact task record-done/);
    expect(res.stdout).toMatch(/--evidence/);
    expect(res.stdout).toMatch(/Examples:/);
  });

  it("an actual unknown subcommand is still CONFIG_ERROR exit 2", () => {
    // Global --json (before the command) so the unknown-subcommand handler
    // emits the JSON envelope on stdout.
    const res = runCli(["--json", "plan", "definitely-not-a-subcommand"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });
});
