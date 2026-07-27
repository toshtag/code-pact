import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  VerificationCommand,
  VerificationScopeOutput,
  classifyVerification,
  runVerificationCommands,
} from "../../../../src/core/verify/classify.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// The producer (`scripts/verification-scope.mjs`) and this consumer disagreed
// on the shape of a verification command. The script emits a flat argv array;
// the consumer declared `[program, string[]]` and spread the second element,
// turning "exec" into "e" "x" "e" "c". Every classifier command failed, so
// `task review-bundle` and `ci-parity` refused with a VERIFICATION_FAILED that
// named a command nobody wrote.
//
// The tests below pin both ends: the schema rejects the shapes that caused the
// break, and the real script's output is fed through the real parser.
// ---------------------------------------------------------------------------

describe("VerificationCommand — the [program, ...args] contract", () => {
  it("accepts a flat argv array", () => {
    expect(
      VerificationCommand.parse(["pnpm", "exec", "vitest", "run"]),
    ).toEqual(["pnpm", "exec", "vitest", "run"]);
  });

  it("accepts a program with no arguments", () => {
    expect(VerificationCommand.parse(["pnpm"])).toEqual(["pnpm"]);
  });

  it("rejects an empty command", () => {
    expect(VerificationCommand.safeParse([]).success).toBe(false);
  });

  it("rejects the legacy nested pair that produced the split argv", () => {
    expect(
      VerificationCommand.safeParse(["pnpm", ["exec", "vitest"]]).success,
    ).toBe(false);
  });

  it("rejects a non-string argument", () => {
    expect(VerificationCommand.safeParse(["pnpm", 7]).success).toBe(false);
  });
});

describe("VerificationScopeOutput — the parse boundary", () => {
  const scope = { mergeBase: null, failSafe: false };

  it("accepts the shape the scope script emits", () => {
    const parsed = VerificationScopeOutput.parse({
      scope,
      commands: [["pnpm", "typecheck"], ["pnpm", "check:docs"]],
      failSafe: false,
    });
    expect(parsed.commands).toEqual([
      ["pnpm", "typecheck"],
      ["pnpm", "check:docs"],
    ]);
  });

  it("refuses output that carries a legacy nested command", () => {
    const result = VerificationScopeOutput.safeParse({
      scope,
      commands: [["pnpm", ["exec", "vitest"]]],
      failSafe: false,
    });
    expect(result.success).toBe(false);
  });

  it("refuses output whose commands are not an array", () => {
    const result = VerificationScopeOutput.safeParse({
      scope,
      commands: "pnpm typecheck",
      failSafe: false,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contract test against the real producer. If the script ever changes the
// shape it emits, this fails here rather than in a review bundle nobody can
// generate.
// ---------------------------------------------------------------------------

describe("scripts/verification-scope.mjs — real output honours the contract", () => {
  // An unresolvable base drives the script's fail-safe branch, which emits the
  // full command set. That makes the assertion independent of what this
  // checkout happens to contain — a base with no changed files legitimately
  // emits zero commands and would prove nothing.
  const UNRESOLVABLE_BASE = "0".repeat(40);

  it("emits commands this module can parse", async () => {
    const { stdout } = await execFileAsync(
      "node",
      [
        "scripts/verification-scope.mjs",
        "--base",
        UNRESOLVABLE_BASE,
        "--commands",
        "--format",
        "json",
      ],
      { cwd: process.cwd(), encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const parsed = VerificationScopeOutput.parse(JSON.parse(stdout));
    expect(parsed.commands.length).toBeGreaterThan(0);
    for (const command of parsed.commands) {
      expect(command.length).toBeGreaterThan(0);
      for (const arg of command) expect(typeof arg).toBe("string");
    }
  }, 60_000);

  it("classifyVerification returns runnable commands for the real script", async () => {
    const classification = await classifyVerification(
      process.cwd(),
      UNRESOLVABLE_BASE,
    );
    expect(classification.commands.length).toBeGreaterThan(0);
    // The break was multi-character arguments arriving as separate argv
    // entries. Any command that starts a subcommand must still carry it whole.
    for (const [program, ...args] of classification.commands) {
      expect(program.length).toBeGreaterThan(1);
      for (const arg of args) {
        expect(arg).not.toMatch(/^.$/);
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// End to end through the runner: the command line handed to the bounded
// process must be the argv the classifier chose, not its characters.
// ---------------------------------------------------------------------------

describe("runVerificationCommands", () => {
  it("keeps multi-character arguments whole", async () => {
    const { results } = await runVerificationCommands(process.cwd(), [
      ["node", "--version"],
    ]);
    expect(results[0]?.command).toBe('"node" "--version"');
    expect(results[0]?.exit_code).toBe(0);
  });

  it("does not split a subcommand into single characters", async () => {
    const { results } = await runVerificationCommands(process.cwd(), [
      ["node", "-e", "process.stdout.write('ok')"],
    ]);
    expect(results[0]?.command).not.toContain('"e" "x" "e" "c"');
    expect(results[0]?.command).toBe(
      '"node" "-e" "process.stdout.write(\'ok\')"',
    );
    expect(results[0]?.exit_code).toBe(0);
    expect(results[0]?.stdout_excerpt).toContain("ok");
  });

  it("stops at the first failing command and reports it", async () => {
    const { ok, results } = await runVerificationCommands(process.cwd(), [
      ["node", "-e", "process.exit(3)"],
      ["node", "--version"],
    ]);
    expect(ok).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0]?.exit_code).toBe(3);
  });
});
