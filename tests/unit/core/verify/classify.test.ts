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

  it("accepts a single-character argument", () => {
    // `["node", "-e", "1"]` is a legitimate argv. The bug was multi-character
    // arguments being SPLIT, not short arguments existing.
    expect(VerificationCommand.parse(["node", "-e", "1"])).toEqual([
      "node",
      "-e",
      "1",
    ]);
  });

  it("rejects an empty command", () => {
    expect(VerificationCommand.safeParse([]).success).toBe(false);
  });

  it("rejects an empty program", () => {
    expect(VerificationCommand.safeParse([""]).success).toBe(false);
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
  /** The scope the real script emits, field for field. */
  const scope = {
    changedFiles: ["src/core/verify/classify.ts"],
    docs: false,
    standard: true,
    toolchain: false,
    processControl: false,
    generic: true,
    workflow: false,
    releaseScript: false,
    sharedTestInfra: false,
    unknown: false,
    highRisk: false,
    fallbackFull: false,
    fallbackReason: null,
    mode: "focused",
    reason: "standard",
    mergeBase: "fc783aba1d01d050aff88d83e13ba4dc426fec9e",
  };

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
    expect(parsed.scope.mode).toBe("focused");
  });

  it("accepts a scope carrying a field the consumer does not model", () => {
    // The producer must be able to grow without a lockstep consumer release.
    const parsed = VerificationScopeOutput.parse({
      scope: { ...scope, someFutureFlag: true },
      commands: [["pnpm", "typecheck"]],
      failSafe: false,
    });
    expect(parsed.scope.reason).toBe("standard");
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

  it("refuses a scope whose changedFiles is not an array", () => {
    const result = VerificationScopeOutput.safeParse({
      scope: { ...scope, changedFiles: 123 },
      commands: [["pnpm", "typecheck"]],
      failSafe: false,
    });
    expect(result.success).toBe(false);
  });

  it("refuses a scope whose docs flag is not a boolean", () => {
    const result = VerificationScopeOutput.safeParse({
      scope: { ...scope, docs: "yes" },
      commands: [["pnpm", "typecheck"]],
      failSafe: false,
    });
    expect(result.success).toBe(false);
  });

  it("refuses a scope that is missing reason", () => {
    const { reason: _dropped, ...withoutReason } = scope;
    const result = VerificationScopeOutput.safeParse({
      scope: withoutReason,
      commands: [["pnpm", "typecheck"]],
      failSafe: false,
    });
    expect(result.success).toBe(false);
  });

  it("refuses a scope whose mode is not focused or full", () => {
    const result = VerificationScopeOutput.safeParse({
      scope: { ...scope, mode: "partial" },
      commands: [["pnpm", "typecheck"]],
      failSafe: false,
    });
    expect(result.success).toBe(false);
  });

  it("requires the producer failSafe flag rather than defaulting it", () => {
    // Defaulting a missing failSafe to false would silently narrow
    // verification on a producer that stopped emitting it.
    const result = VerificationScopeOutput.safeParse({
      scope,
      commands: [["pnpm", "typecheck"]],
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
    // Parsing is the assertion: the envelope schema is fail-closed, so a
    // producer that drops failSafe or changes a scope field throws here.
    const parsed = VerificationScopeOutput.parse(JSON.parse(stdout));
    expect(parsed.failSafe).toBe(true);
    expect(parsed.scope.mode).toBe("full");
    expect(parsed.commands.length).toBeGreaterThan(0);
  }, 60_000);

  it("classifyVerification returns runnable commands for the real script", async () => {
    const classification = await classifyVerification(
      process.cwd(),
      UNRESOLVABLE_BASE,
    );
    expect(classification.commands.length).toBeGreaterThan(0);
    // The break was a multi-character argument arriving as separate argv
    // entries, so pin a known multi-token command from the real producer. A
    // blanket "no single-character argument" rule would be wrong: `-e` and `1`
    // are legitimate argv entries.
    expect(
      classification.commands.some(
        ([program, subcommand, tool, action]) =>
          program === "pnpm" &&
          subcommand === "exec" &&
          tool === "vitest" &&
          action === "run",
      ),
    ).toBe(true);
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
