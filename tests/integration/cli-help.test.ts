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

  // Rich leaf help for the lifecycle verbs agents actually drive. Each must
  // exit 0, print a full Usage line, name a representative flag, and carry an
  // Examples section — never the generic two-line stub. Runs from a neutral
  // cwd, so help must not read any project files.
  const RICH_LEAF_HELP: Array<[string[], RegExp, RegExp]> = [
    [["task", "prepare", "--help"], /Usage: code-pact task prepare/, /--budget-bytes/],
    [["task", "complete", "--help"], /Usage: code-pact task complete/, /--dry-run/],
    [["task", "record-done", "--help"], /Usage: code-pact task record-done/, /--evidence/],
    [["task", "finalize", "--help"], /Usage: code-pact task finalize/, /--audit-strict/],
    [["plan", "prompt", "--help"], /Usage: code-pact plan prompt/, /--schema-only/],
    [["phase", "import", "--help"], /Usage: code-pact phase import/, /--strict/],
  ];
  for (const [argv, usageRe, flagRe] of RICH_LEAF_HELP) {
    it(`\`${argv.slice(0, -1).join(" ")} --help\` → rich usage with flags and examples, exit 0`, () => {
      const res = runCli(argv);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(usageRe);
      expect(res.stdout).toMatch(flagRe);
      expect(res.stdout).toMatch(/Examples:/);
    });
  }

  it("an actual unknown subcommand is still CONFIG_ERROR exit 2", () => {
    // Global --json (before the command) so the unknown-subcommand handler
    // emits the JSON envelope on stdout.
    const res = runCli(["--json", "plan", "definitely-not-a-subcommand"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });
});
