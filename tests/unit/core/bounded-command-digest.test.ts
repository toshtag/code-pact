import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_COMMAND_OUTPUT_BYTES,
  runBoundedCommandDigest,
} from "../../../src/core/process/bounded-command.ts";

describe("runBoundedCommandDigest", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-bounded-digest-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("digests stdout that exceeds the generic capture limit", async () => {
    const line = "abcdefghij".repeat(8);
    const repeats = Math.ceil((MAX_COMMAND_OUTPUT_BYTES * 2) / (line.length + 1));
    const script = `process.stdout.write("${line}\\n".repeat(${repeats}))`;
    const expected = createHash("sha256")
      .update(`${line}\n`.repeat(repeats))
      .digest("hex");

    const result = await runBoundedCommandDigest({
      executable: process.execPath,
      args: ["-e", script],
      cwd: dir,
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes).toBeGreaterThan(MAX_COMMAND_OUTPUT_BYTES);
    expect(result.stdoutSha256).toBe(expected);
  });

  it("distinguishes outputs that differ only past the capture limit", async () => {
    const padding = Math.ceil(MAX_COMMAND_OUTPUT_BYTES / 10) + 1;
    const run = async (tail: string): Promise<string> => {
      const result = await runBoundedCommandDigest({
        executable: process.execPath,
        args: [
          "-e",
          `process.stdout.write("0123456789".repeat(${padding}) + "${tail}")`,
        ],
        cwd: dir,
        timeoutMs: 30_000,
      });
      return result.stdoutSha256;
    };

    expect(await run("first")).not.toBe(await run("second"));
  });

  it("reports a nonzero exit code without a shell", async () => {
    const result = await runBoundedCommandDigest({
      executable: process.execPath,
      args: ["-e", "process.exit(3)"],
      cwd: dir,
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it("times out and reports no exit code for an incomplete run", async () => {
    const result = await runBoundedCommandDigest({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: dir,
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("aborts on signal and reports no exit code", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await runBoundedCommandDigest({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: dir,
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
  });

  it("returns aborted without spawning when the signal is already aborted", async () => {
    const result = await runBoundedCommandDigest({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('unreachable')"],
      cwd: dir,
      timeoutMs: 30_000,
      signal: AbortSignal.abort(),
    });

    expect(result.aborted).toBe(true);
    expect(result.stdoutBytes).toBe(0);
  });

  it("streams chunks to the sink without buffering the whole output", async () => {
    const repeats = Math.ceil(MAX_COMMAND_OUTPUT_BYTES / 10) + 1;
    let seen = 0;

    const result = await runBoundedCommandDigest({
      executable: process.execPath,
      args: ["-e", `process.stdout.write("0123456789".repeat(${repeats}))`],
      cwd: dir,
      timeoutMs: 30_000,
      onStdoutChunk: chunk => {
        seen += chunk.byteLength;
      },
    });

    expect(seen).toBe(result.stdoutBytes);
    expect(result.stdoutBytes).toBeGreaterThan(MAX_COMMAND_OUTPUT_BYTES);
  });

  it("fails the run when the stdout sink throws", async () => {
    const result = await runBoundedCommandDigest({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('payload')"],
      cwd: dir,
      timeoutMs: 30_000,
      onStdoutChunk: () => {
        throw new Error("sink rejected the chunk");
      },
    });

    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("sink rejected the chunk");
  });
});
