// CLI integration suite for the beginner-friendly command aliases. The live alias
// contract is docs/cli-contract.md (§ Command aliases); the rationale was recorded in
// the now-retired design/decisions/cli-alias-ux-rfc.md decision record:
//
//   task next <id>      → task runbook <id>
//   phase next <id>     → phase runbook <id>
//   task reconcile <id> → task finalize <id>
//   plan import <yaml>  → phase import <yaml>
//
// Two things are verified:
//  1. Dispatch equivalence — an alias and its canonical command produce the
//     same machine result (exit code, ok, error.code, and — for success and
//     semantic errors that carry no command name — byte-identical stdout).
//  2. Alias-facing UX — when an alias is *misused* (missing argument or parse
//     error), the human-facing message names the alias, not the canonical
//     command.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  run as cliRun,
  ensureCliBuilt,
  type RunResult,
} from "../helpers/cli.ts";

let tmpDir: string;

function run(args: string[]): RunResult {
  return cliRun(tmpDir, args);
}

function envelope(stdout: string): {
  ok?: boolean;
  error?: { code?: string };
  data?: Record<string, unknown>;
} {
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-cli-aliases-test-"));
  run([
    "init",
    "--non-interactive",
    "--agent",
    "claude-code",
    "--locale",
    "en-US",
    "--sample-phase",
    "--json",
  ]);
});

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("aliases dispatch to the canonical command", () => {
  it("`task next` === `task runbook` (read-only success → identical)", () => {
    const alias = run(["task", "next", "TUTORIAL-T1", "--json"]);
    const canonical = run(["task", "runbook", "TUTORIAL-T1", "--json"]);
    expect(alias.code).toBe(0);
    expect(alias.stdout).toBe(canonical.stdout);
  });

  it("`phase next` === `phase runbook` (read-only success → identical)", () => {
    const alias = run(["phase", "next", "TUTORIAL", "--json"]);
    const canonical = run(["phase", "runbook", "TUTORIAL", "--json"]);
    expect(alias.code).toBe(0);
    expect(alias.stdout).toBe(canonical.stdout);
  });

  it("`task reconcile` matches `task finalize` on the not-eligible error", () => {
    const alias = run(["task", "reconcile", "TUTORIAL-T1", "--json"]);
    const canonical = run(["task", "finalize", "TUTORIAL-T1", "--json"]);
    expect(alias.code).toBe(canonical.code);
    expect(envelope(alias.stdout).error?.code).toBe(
      "TASK_FINALIZE_NOT_ELIGIBLE",
    );
    expect(envelope(alias.stdout).error?.code).toBe(
      envelope(canonical.stdout).error?.code,
    );
  });

  it("`plan import` matches `phase import` on a missing input file", () => {
    const alias = run(["plan", "import", "does-not-exist.yaml", "--json"]);
    const canonical = run(["phase", "import", "does-not-exist.yaml", "--json"]);
    expect(alias.code).toBe(canonical.code);
    expect(alias.code).not.toBe(0);
    expect(envelope(alias.stdout).error?.code).toBe(
      envelope(canonical.stdout).error?.code,
    );
  });

  it("`plan import` actually ingests a roadmap (positive path)", async () => {
    await writeFile(
      join(tmpDir, "roadmap.yaml"),
      [
        "phases:",
        "  - id: PY",
        '    name: "Imported phase"',
        "    weight: 10",
        '    objective: "Prove plan import writes phases"',
        "    tasks:",
        "      - id: PY-T1",
        "        type: feature",
        '        description: "First imported task"',
        "",
      ].join("\n"),
    );
    const res = run(["plan", "import", "roadmap.yaml", "--json"]);
    expect(res.code).toBe(0);
    expect(envelope(res.stdout).ok).toBe(true);
    expect(run(["phase", "show", "PY", "--json"]).stdout).toContain("PY-T1");
  });
});

describe("misused aliases name the alias, not the canonical command", () => {
  it("`task next` (no id) names the alias + canonical", () => {
    const { code, stdout } = run(["task", "next", "--json"]);
    expect(code).toBe(2);
    const env = envelope(stdout);
    expect(env.error?.code).toBe("CONFIG_ERROR");
    expect(stdout).toContain("task next requires a task id");
    expect(stdout).toContain("alias for `task runbook`");
  });

  it("`task reconcile` (no id) names the alias + canonical", () => {
    const { code, stdout } = run(["task", "reconcile", "--json"]);
    expect(code).toBe(2);
    expect(stdout).toContain("task reconcile requires a task id");
    expect(stdout).toContain("alias for `task finalize`");
  });

  it("`phase next` (no id) names the alias + canonical", () => {
    const { code, stdout } = run(["phase", "next", "--json"]);
    expect(code).toBe(2);
    expect(stdout).toContain("phase next requires a phase id");
    expect(stdout).toContain("alias for `phase runbook`");
  });

  it("`plan import` (no path) names the alias + canonical", () => {
    const { code, stdout } = run(["plan", "import", "--json"]);
    expect(code).toBe(2);
    expect(stdout).toContain("plan import requires an input YAML path");
    expect(stdout).toContain("alias for `phase import`");
  });

  it("`task next --bogus` (unknown flag) is alias-aware", () => {
    const { code, stdout } = run(["task", "next", "--bogus", "--json"]);
    expect(code).toBe(2);
    expect(envelope(stdout).error?.code).toBe("CONFIG_ERROR");
    expect(stdout).toContain("task next");
    expect(stdout).toContain("alias for `task runbook`");
  });

  it("`phase next --bogus` (unknown flag) is alias-aware", () => {
    const { code, stdout } = run(["phase", "next", "--bogus", "--json"]);
    expect(code).toBe(2);
    expect(envelope(stdout).error?.code).toBe("CONFIG_ERROR");
    expect(stdout).toContain("phase next");
    expect(stdout).toContain("alias for `phase runbook`");
  });

  it("`task reconcile --bogus` (unknown flag) is alias-aware", () => {
    const { code, stdout } = run(["task", "reconcile", "--bogus", "--json"]);
    expect(code).toBe(2);
    expect(envelope(stdout).error?.code).toBe("CONFIG_ERROR");
    expect(stdout).toContain("task reconcile");
    expect(stdout).toContain("alias for `task finalize`");
  });

  it("`plan import --bogus` (unknown flag) is alias-aware", () => {
    const { code, stdout } = run(["plan", "import", "--bogus", "--json"]);
    expect(code).toBe(2);
    expect(envelope(stdout).error?.code).toBe("CONFIG_ERROR");
    expect(stdout).toContain("plan import");
    expect(stdout).toContain("alias for `phase import`");
  });

  it("canonical commands never emit an `alias for` note", () => {
    for (const args of [
      ["task", "runbook", "--json"],
      ["phase", "runbook", "--json"],
      ["task", "finalize", "--json"],
      ["phase", "import", "--json"],
      ["task", "runbook", "--bogus", "--json"],
      ["phase", "import", "--bogus", "--json"],
    ]) {
      expect(run(args).stdout).not.toContain("alias for");
    }
  });
});

describe("`task reconcile --write` finalizes like `task finalize --write`", () => {
  beforeEach(() => {
    // A phase whose verify command (`node --version`) passes, so the task can
    // reach `done` and become finalize-eligible. (phase add sets the verify
    // command reliably; lenient `phase import` would default it to `pnpm test`.)
    run([
      "phase",
      "add",
      "--id",
      "PX",
      "--name",
      "Reconcile fixture",
      "--weight",
      "10",
      "--objective",
      "Exercise the reconcile alias write path",
      "--verify-command",
      "node --version",
      "--json",
    ]);
    run([
      "task",
      "add",
      "PX",
      "--description",
      "Task to finalize via the reconcile alias",
      "--type",
      "feature",
      "--json",
    ]);

    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.email test@example.com", {
      cwd: tmpDir,
      stdio: "ignore",
    });
    execSync("git config user.name Test", { cwd: tmpDir, stdio: "ignore" });
    execSync("git add .", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit -m init", { cwd: tmpDir, stdio: "ignore" });

    run(["task", "start", "PX-T1", "--agent", "claude-code"]);
    run(["task", "complete", "PX-T1", "--agent", "claude-code", "--json"]);
  });

  it("dry-run previews, --write applies, status becomes done", () => {
    const preview = run(["task", "reconcile", "PX-T1", "--json"]);
    expect(preview.code).toBe(0);
    expect(envelope(preview.stdout).ok).toBe(true);

    const applied = run(["task", "reconcile", "PX-T1", "--write", "--json"]);
    expect(applied.code).toBe(0);
    expect(envelope(applied.stdout).ok).toBe(true);

    // The design status is now `done` — the same effect as `task finalize`.
    const show = run(["phase", "show", "PX", "--json"]);
    expect(show.stdout).toContain('"status":"done"');

    // Re-running is idempotent (already finalized), proving it hit the same
    // finalize state machine.
    const again = run(["task", "finalize", "PX-T1", "--json"]);
    expect(again.code).toBe(0);
  });
});

describe("unknown subcommands are still rejected", () => {
  it("`task bogus` exits 2", () => {
    const res = run(["task", "bogus"]);
    expect(res.code).toBe(2);
    expect(`${res.stdout}${res.stderr}`).toContain(
      'unknown subcommand "bogus"',
    );
  });
});
