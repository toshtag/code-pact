// CLI integration suite for the beginner-friendly command aliases added per
// design/decisions/cli-alias-ux-rfc.md:
//
//   task next <id>      → task runbook <id>
//   phase next <id>     → phase runbook <id>
//   task reconcile <id> → task finalize <id>
//   plan import <yaml>  → phase import <yaml>
//
// Each alias must dispatch to the *exact same* handler as its canonical
// command — these tests assert byte-identical output for the same arguments,
// so the aliases can never silently diverge from the commands they shadow.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cliPath, ensureCliBuilt } from "../helpers/cli.ts";

let tmpDir: string;

type RunResult = { code: number; stdout: string; stderr: string };

function run(args: string[]): RunResult {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: tmpDir,
    encoding: "utf8",
    env: process.env,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-cli-aliases-test-"));
  // Sample phase gives us a real TUTORIAL phase + TUTORIAL-T1 task.
  run(["init", "--non-interactive", "--agent", "claude-code", "--locale", "en-US", "--sample-phase", "--json"]);
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("CLI aliases dispatch to the canonical command", () => {
  it("`task next` === `task runbook` (read-only)", () => {
    const alias = run(["task", "next", "TUTORIAL-T1", "--json"]);
    const canonical = run(["task", "runbook", "TUTORIAL-T1", "--json"]);
    expect(alias.code).toBe(0);
    expect(alias.stdout).toBe(canonical.stdout);
  });

  it("`phase next` === `phase runbook` (read-only)", () => {
    const alias = run(["phase", "next", "TUTORIAL", "--json"]);
    const canonical = run(["phase", "runbook", "TUTORIAL", "--json"]);
    expect(alias.code).toBe(0);
    expect(alias.stdout).toBe(canonical.stdout);
  });

  it("`task reconcile` === `task finalize` (dry-run, non-eligible task)", () => {
    // TUTORIAL-T1 has no `done` event, so finalize is not eligible. Dry-run
    // does not mutate, so both invocations produce the same error envelope.
    const alias = run(["task", "reconcile", "TUTORIAL-T1", "--json"]);
    const canonical = run(["task", "finalize", "TUTORIAL-T1", "--json"]);
    expect(alias.stdout).toBe(canonical.stdout);
    expect(alias.stdout).toContain("TASK_FINALIZE_NOT_ELIGIBLE");
  });

  it("`plan import` === `phase import` on a missing file", () => {
    const alias = run(["plan", "import", "does-not-exist.yaml", "--json"]);
    const canonical = run(["phase", "import", "does-not-exist.yaml", "--json"]);
    expect(alias.code).not.toBe(0);
    expect(alias.stdout).toBe(canonical.stdout);
  });

  it("`plan import` actually imports a roadmap (positive path)", async () => {
    await writeFile(
      join(tmpDir, "roadmap.yaml"),
      [
        "phases:",
        "  - id: PX",
        '    name: "Imported phase"',
        "    weight: 10",
        '    objective: "Prove plan import works"',
        '    verification: { commands: ["node --version"] }',
        "    tasks:",
        "      - id: PX-T1",
        "        type: feature",
        '        description: "First imported task"',
        "",
      ].join("\n"),
    );
    const res = run(["plan", "import", "roadmap.yaml", "--json"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('"ok":true');
    // The phase is now resolvable, proving the import wrote it.
    const show = run(["phase", "show", "PX", "--json"]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("PX-T1");
  });

  it("genuinely unknown subcommands are still rejected", () => {
    const res = run(["task", "bogus"]);
    expect(res.code).toBe(2);
    expect(`${res.stdout}${res.stderr}`).toContain('unknown subcommand "bogus"');
  });
});
