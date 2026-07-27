import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedArgv } from "../../../src/core/process/bounded-command.ts";
import { runVerificationCommands } from "../../../src/core/verify/classify.ts";

// ---------------------------------------------------------------------------
// The verification classifier holds a validated argv and used to run it by
// rendering a shell line with `JSON.stringify` and spawning that with
// `shell: true`. JSON quoting is not shell quoting: inside double quotes a
// shell still expands `$(...)`, `` ` ``, and `$VAR`. A changed-file path or an
// argument carrying shell syntax was therefore re-interpreted instead of
// reaching the child.
//
// `runBoundedArgv` spawns with `shell: false`, so every element is one
// argument. These tests pin that, and pin that the bounded guarantees the
// shell path provides survive on the argv path.
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-bounded-argv-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Prints the child's own arguments as JSON so the test can compare exactly. */
const ECHO_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

describe("runBoundedArgv — arguments are not interpreted by a shell", () => {
  it("passes command substitution syntax literally and does not run it", async () => {
    const marker = join(dir, "must-not-exist");

    const result = await runBoundedArgv(
      process.execPath,
      ["-e", ECHO_ARGV, `$(touch ${marker})`],
      dir,
      10_000,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([`$(touch ${marker})`]);
    expect(existsSync(marker)).toBe(false);
  });

  it("passes backtick substitution literally and does not run it", async () => {
    const marker = join(dir, "backtick-must-not-exist");

    const result = await runBoundedArgv(
      process.execPath,
      ["-e", ECHO_ARGV, `\`touch ${marker}\``],
      dir,
      10_000,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([`\`touch ${marker}\``]);
    expect(existsSync(marker)).toBe(false);
  });

  it("preserves every argument byte for byte", async () => {
    const argv = [
      "",
      "a b",
      "*",
      "$HOME",
      ";",
      '"quoted"',
      "'single'",
      "line\nbreak",
      "tests/unit/it's a file.test.ts",
    ];

    const result = await runBoundedArgv(
      process.execPath,
      ["-e", ECHO_ARGV, ...argv],
      dir,
      10_000,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(argv);
  });

  it("refuses an empty program instead of spawning one", async () => {
    const result = await runBoundedArgv("", [], dir, 10_000);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("empty verification command program");
    expect(result.elapsedMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The bounded guarantees are shared with the shell path through one supervisor,
// so these check that the argv entry point is wired into it — not that the
// supervisor works, which the existing bounded-command suite already covers.
// ---------------------------------------------------------------------------

describe("runBoundedArgv — bounded guarantees", () => {
  it("reports a timeout rather than hanging", async () => {
    const result = await runBoundedArgv(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60_000)"],
      dir,
      500,
    );

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  }, 30_000);

  it("reports an abort delivered before start", async () => {
    const result = await runBoundedArgv(
      process.execPath,
      ["--version"],
      dir,
      10_000,
      AbortSignal.abort(),
    );

    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("captures stderr and the child's exit code", async () => {
    const result = await runBoundedArgv(
      process.execPath,
      ["-e", "process.stderr.write('boom'); process.exit(3)"],
      dir,
      10_000,
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
  });
});

// ---------------------------------------------------------------------------
// Every command the classifier emits starts with `pnpm`. On POSIX that is an
// executable; on Windows it is normally the batch shim `pnpm.cmd`, which a
// shell-free spawn cannot start at all. These run the real launch path on
// whatever host executes them, so Windows CI proves the Windows branch rather
// than a Linux run standing in for it.
// ---------------------------------------------------------------------------

describe("the package manager launches on this platform", () => {
  it("runs pnpm through the classifier path", async () => {
    const { ok, results } = await runVerificationCommands(process.cwd(), [
      ["pnpm", "--version"],
    ]);

    expect(results[0]?.stderr_excerpt ?? "").not.toContain(
      "could not be resolved safely",
    );
    expect(results[0]?.exit_code).toBe(0);
    expect(results[0]?.stdout_excerpt.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(ok).toBe(true);
  }, 60_000);

  it("keeps a hostile argument literal through the classifier path", async () => {
    const marker = join(dir, "classifier-must-not-exist");

    const { results } = await runVerificationCommands(process.cwd(), [
      [
        process.execPath,
        "-e",
        ECHO_ARGV,
        `$(touch ${marker})`,
        "%PATH%",
        "!VALUE!",
        "a b",
      ],
    ]);

    expect(results[0]?.exit_code).toBe(0);
    expect(JSON.parse(results[0]!.stdout_excerpt)).toEqual([
      `$(touch ${marker})`,
      "%PATH%",
      "!VALUE!",
      "a b",
    ]);
    expect(existsSync(marker)).toBe(false);
  }, 60_000);
});
