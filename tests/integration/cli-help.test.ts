// PR4: subcommand clusters answer --help with usage (exit 0) instead of
// CONFIG_ERROR. plan / task / phase / decision / state / spec also treat a bare cluster invocation as a
// help request; adapter is intentionally excluded (bare adapter is an error —
// see adapter-cli.test.ts).

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { cliPath, ensureCliBuilt } from "../helpers/cli.ts";
import { PHASE_SPEC_ORDER } from "../../src/cli/spec/phase.ts";
import { PLAN_SPEC_ORDER } from "../../src/cli/spec/plan.ts";
import { STATE_SPEC_ORDER } from "../../src/cli/spec/state.ts";
import { CONTEXT_SPEC_ORDER } from "../../src/cli/spec/context.ts";

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
  for (const cluster of ["plan", "task", "phase", "decision", "state", "spec", "context"]) {
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
    // P41 — the 7 task lifecycle verbs brought to parity.
    [["task", "add", "--help"], /Usage: code-pact task add/, /--description/],
    [["task", "context", "--help"], /Usage: code-pact task context/, /--budget-bytes/],
    [["task", "start", "--help"], /Usage: code-pact task start/, /--agent/],
    [["task", "status", "--help"], /Usage: code-pact task status/, /--json/],
    [["task", "block", "--help"], /Usage: code-pact task block/, /--reason/],
    [["task", "resume", "--help"], /Usage: code-pact task resume/, /--agent/],
    [["task", "runbook", "--help"], /Usage: code-pact task runbook/, /--json/],
    [["plan", "prompt", "--help"], /Usage: code-pact plan prompt/, /--schema-only/],
    [["phase", "import", "--help"], /Usage: code-pact phase import/, /--strict/],
    // P52 step 2 — the 9 mutating / JSON-emitting non-task commands brought
    // from stub to rich help.
    [["plan", "brief", "--help"], /Usage: code-pact plan brief/, /--from-file/],
    [["plan", "constitution", "--help"], /Usage: code-pact plan constitution/, /--principle/],
    [["plan", "adopt", "--help"], /Usage: code-pact plan adopt/, /--write/],
    [["plan", "lint", "--help"], /Usage: code-pact plan lint/, /--include-quality/],
    [["plan", "normalize", "--help"], /Usage: code-pact plan normalize/, /--check/],
    [["plan", "analyze", "--help"], /Usage: code-pact plan analyze/, /--include-historical/],
    [["plan", "sync-paths", "--help"], /Usage: code-pact plan sync-paths/, /--rename/],
    [["plan", "migrate", "--help"], /Usage: code-pact plan migrate/, /--write/],
    [["phase", "add", "--help"], /Usage: code-pact phase add/, /--objective/],
    [["phase", "new", "--help"], /Usage: code-pact phase new/, /[Ii]nteractive/],
    [["phase", "ls", "--help"], /Usage: code-pact phase ls/, /--status/],
    [["phase", "show", "--help"], /Usage: code-pact phase show/, /--json/],
    [["phase", "reconcile", "--help"], /Usage: code-pact phase reconcile/, /--write/],
    [["phase", "archive", "--help"], /Usage: code-pact phase archive/, /--write/],
    [["phase", "runbook", "--help"], /Usage: code-pact phase runbook/, /--across-phases/],
    [["phase", "next", "--help"], /Usage: code-pact phase next/, /--across-phases/],
    [["adapter", "list", "--help"], /Usage: code-pact adapter list/, /--json/],
    [["adapter", "install", "--help"], /Usage: code-pact adapter install/, /--force/],
    [["adapter", "upgrade", "--help"], /Usage: code-pact adapter upgrade/, /--accept-modified/],
    [["adapter", "doctor", "--help"], /Usage: code-pact adapter doctor/, /--agent/],
    [["adapter", "conformance", "--help"], /Usage: code-pact adapter conformance/, /--json/],
    [["decision", "prune", "--help"], /Usage: code-pact decision prune/, /--policy/],
    [["decision", "retire", "--help"], /Usage: code-pact decision retire/, /--write/],
    [["state", "compact", "--help"], /Usage: code-pact state compact/, /--write/],
    [["state", "compact-archive", "--help"], /Usage: code-pact state compact-archive/, /decision_record/],
    [["state", "archive-retention", "--help"], /Usage: code-pact state archive-retention/, /--keep-latest/],
    [["state", "archive-maintain", "--help"], /Usage: code-pact state archive-maintain/, /--keep-latest/],
    [["spec", "import", "--help"], /Usage: code-pact spec import/, /--suggest-from/],
    [["context", "show", "--help"], /Usage: code-pact context show/, /--section/],
    // `plan import` is an alias for `phase import`; its --help routes to the
    // same rich entry (cmdPlan dispatch), so it must not be a stub.
    [["plan", "import", "--help"], /Usage: code-pact phase import/, /--scaffold-decisions/],
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

  it("`phase import --help` documents --scaffold-decisions and the skip (not overwrite) semantics of --force", () => {
    const res = runCli(["phase", "import", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/--scaffold-decisions/);
    // --force skips colliding phases; it must not claim to overwrite them.
    expect(res.stdout).toMatch(/--force\s[\s\S]*Skip phases whose ids already exist/);
    expect(res.stdout).not.toMatch(/Overwrite phases whose ids already exist/);
  });

  it("`phase --help` lists the archive subcommand", () => {
    const res = runCli(["phase", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/\barchive\b/);
  });

  it("`phase archive --help` documents --write, --attest, and the dry-run default", () => {
    const res = runCli(["phase", "archive", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/--write/);
    expect(res.stdout).toMatch(/--attest <task-id>=<reason>/);
    expect(res.stdout).toMatch(/[Dd]ry-run is the default/);
  });

  it("an actual unknown subcommand is still CONFIG_ERROR exit 2", () => {
    // Global --json (before the command) so the unknown-subcommand handler
    // emits the JSON envelope on stdout.
    const res = runCli(["--json", "plan", "definitely-not-a-subcommand"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it.each([
    ["state", STATE_SPEC_ORDER],
    ["context", CONTEXT_SPEC_ORDER],
  ] as const)("%s unknown subcommand guidance lists valid subcommands from the spec order", (cluster, subcommands) => {
    const res = runCli(["--json", cluster, "nope"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.message).toContain("nope");
    for (const subcommand of subcommands) {
      expect(parsed.error.message).toContain(subcommand);
    }
  });

  it("plan and phase unknown subcommand guidance lists valid subcommands from the spec order", () => {
    const cases: Array<["plan" | "phase", readonly string[]]> = [
      ["plan", PLAN_SPEC_ORDER],
      ["phase", PHASE_SPEC_ORDER],
    ];

    for (const [cluster, subcommands] of cases) {
      const res = runCli(["--json", cluster, "nope"]);
      expect(res.status).toBe(2);
      const parsed = JSON.parse(res.stdout) as {
        ok: false;
        error: { code: string; message: string };
      };
      expect(parsed.error.code).toBe("CONFIG_ERROR");
      expect(parsed.error.message).toContain("nope");
      for (const subcommand of subcommands) {
        expect(parsed.error.message).toContain(subcommand);
      }
    }
  });
});
