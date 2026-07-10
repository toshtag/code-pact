import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { excerptText } from "../../../src/core/evidence/excerpt.ts";
import {
  loadEvidenceArtifact,
  storeEvidenceArtifact,
} from "../../../src/core/evidence/evidence-store.ts";
import { parseEvidenceRef } from "../../../src/core/evidence/evidence-ref.ts";
import { fingerprintFailure } from "../../../src/core/evidence/failure-fingerprint.ts";
import {
  projectVerifyForAgent,
  projectVerifySummaryForAgent,
} from "../../../src/core/evidence/failure-capsule.ts";
import type { VerifyResult } from "../../../src/commands/verify.ts";
import { __setAtomicWriteFailAfterOpenForTests } from "../../../src/io/atomic-text.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-evidence-"));
  await mkdir(join(dir, ".code-pact"), { recursive: true });
});

afterEach(async () => {
  __setAtomicWriteFailAfterOpenForTests(null);
  await rm(dir, { recursive: true, force: true });
});

describe("evidence refs and store", () => {
  it("stores and reloads the bounded command output by content digest", async () => {
    const artifact = {
      schema_version: 1 as const,
      command: "pnpm test",
      exit_code: 1,
      timed_out: false,
      aborted: false,
      elapsed_ms: 123,
      stdout: "out",
      stderr: "err",
      stdout_capture_truncated: false,
      stderr_capture_truncated: false,
    };

    const first = await storeEvidenceArtifact(dir, artifact);
    const second = await storeEvidenceArtifact(dir, artifact);
    expect(first.ref).toBe(second.ref);
    expect(parseEvidenceRef(first.ref)).toMatch(/^[0-9a-f]{64}$/);

    const loaded = await loadEvidenceArtifact(dir, first.ref);
    expect(loaded.artifact).toEqual(artifact);
  });

  it("rejects invalid evidence refs before resolving a path", async () => {
    await expect(loadEvidenceArtifact(dir, "evidence:sha256:../x")).rejects.toMatchObject({
      code: "INVALID_EVIDENCE_REF",
    });
  });

  it("rejects malformed evidence files with a stable error code", async () => {
    const digest = "a".repeat(64);
    await mkdir(join(dir, ".code-pact", "cache", "evidence"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "cache", "evidence", `${digest}.json`),
      "{not-json",
      "utf8",
    );

    await expect(loadEvidenceArtifact(dir, `evidence:sha256:${digest}`)).rejects.toMatchObject({
      code: "EVIDENCE_INVALID",
    });
  });

  it("rejects schema-invalid evidence files with a stable error code", async () => {
    const digest = "b".repeat(64);
    await mkdir(join(dir, ".code-pact", "cache", "evidence"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "cache", "evidence", `${digest}.json`),
      JSON.stringify({ schema_version: 1, stdout: "missing required fields" }),
      "utf8",
    );

    await expect(loadEvidenceArtifact(dir, `evidence:sha256:${digest}`)).rejects.toMatchObject({
      code: "EVIDENCE_INVALID",
    });
  });

  it("rejects evidence cache symlinks before writing outside the project", async () => {
    const outside = await mkdtemp(join(tmpdir(), "code-pact-evidence-outside-"));
    await mkdir(join(dir, ".code-pact"), { recursive: true });
    await symlink(outside, join(dir, ".code-pact", "cache"));
    try {
      await expect(
        storeEvidenceArtifact(dir, {
          schema_version: 1,
          command: "pnpm test",
          exit_code: 1,
          timed_out: false,
          aborted: false,
          elapsed_ms: 1,
          stdout: "out",
          stderr: "err",
          stdout_capture_truncated: false,
          stderr_capture_truncated: false,
        }),
      ).rejects.toMatchObject({ code: "PATH_NOT_OWNED" });
      await expect(readdir(outside)).resolves.toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("excerpt policy", () => {
  it("does not duplicate small output across head and tail", () => {
    const excerpt = excerptText("small output", { headBytes: 20, tailBytes: 20 });
    expect(excerpt).toEqual({
      head: "small output",
      tail: "",
      captured_bytes: Buffer.byteLength("small output"),
      omitted_bytes: 0,
      truncated: false,
    });
  });

  it("does not split UTF-8 multibyte characters", () => {
    const text = `${"あ".repeat(20)}middle${"界".repeat(20)}`;
    const excerpt = excerptText(text, { headBytes: 10, tailBytes: 10 });
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.head).not.toContain("\uFFFD");
    expect(excerpt.tail).not.toContain("\uFFFD");
  });
});

describe("failure projection", () => {
  it("stores raw output once and returns compact agent data", async () => {
    const stdout = "x".repeat(1024 * 64);
    const stderr = "y".repeat(1024 * 64);
    const result: VerifyResult = {
      ok: false,
      checks: [
        {
          name: "commands",
          ok: false,
          reason: "\"pnpm test\" exited with code 1",
          command: "pnpm test",
          stdout,
          stderr,
          exitCode: 1,
          timedOut: false,
          aborted: false,
          elapsedMs: 50,
          commands: [
            {
              command: "pnpm typecheck",
              ok: true,
              exitCode: 0,
              timedOut: false,
              aborted: false,
              elapsedMs: 10,
              stdout: "success output should not be projected",
              stderr: "",
            },
            {
              command: "pnpm test",
              ok: false,
              exitCode: 1,
              timedOut: false,
              aborted: false,
              elapsedMs: 40,
              stdout,
              stderr,
            },
          ],
        },
      ],
    };

    const projected = await projectVerifyForAgent(dir, result);
    expect(projected.failure.kind).toBe("command_failed");
    expect(projected.failure.evidence_ref).toMatch(/^evidence:sha256:[0-9a-f]{64}$/);
    expect(projected.failure.stdout_excerpt?.captured_bytes).toBe(stdout.length);
    expect(projected.verify.successful_commands).toEqual([
      { command: "pnpm typecheck", exit_code: 0, elapsed_ms: 10 },
    ]);

    const encoded = JSON.stringify(projected);
    expect(encoded).not.toContain(stdout);
    expect(encoded).not.toContain(stderr);
    expect(encoded).not.toContain("success output should not be projected");
    expect(Buffer.byteLength(encoded)).toBeLessThan(24 * 1024);

    const loaded = await loadEvidenceArtifact(dir, projected.failure.evidence_ref!);
    expect(loaded.artifact.stdout).toBe(stdout);
    expect(loaded.artifact.stderr).toBe(stderr);
  });

  it("keeps the serialized agent projection bounded for JSON-escaping worst cases", async () => {
    const noisy = `${"\0".repeat(2048)}${"\\\"".repeat(2048)}${"\b\f\n\r\t".repeat(2048)}${"𠮷".repeat(2048)}`;
    const result: VerifyResult = {
      ok: false,
      checks: [
        {
          name: "commands",
          ok: false,
          reason: `failure reason ${noisy}`,
          command: `node -e ${JSON.stringify(noisy)}`,
          stdout: noisy.repeat(12),
          stderr: noisy.repeat(12),
          exitCode: 1,
          timedOut: false,
          aborted: false,
          elapsedMs: 75,
          commands: [
            ...Array.from({ length: 20 }, (_, index) => ({
              command: `pnpm ok-${index} ${noisy}`,
              ok: true,
              exitCode: 0,
              timedOut: false,
              aborted: false,
              elapsedMs: index,
              stdout: noisy,
              stderr: noisy,
            })),
            {
              command: `node -e ${JSON.stringify(noisy)}`,
              ok: false,
              exitCode: 1,
              timedOut: false,
              aborted: false,
              elapsedMs: 75,
              stdout: noisy.repeat(12),
              stderr: noisy.repeat(12),
            },
          ],
        },
        ...Array.from({ length: 20 }, (_, index) => ({
          name: `extra-${index}`,
          ok: true,
          reason: noisy,
        })),
      ],
    };

    const projected = await projectVerifyForAgent(dir, result);
    const encoded = JSON.stringify(projected);

    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(24 * 1024);
    expect(projected.failure.projection_truncated).toBe(true);
    expect(projected.verify.successful_commands.length).toBeLessThanOrEqual(8);
    expect(projected.verify.checks.length).toBeLessThanOrEqual(8);
    expect(projected.failure.evidence_ref).toMatch(/^evidence:sha256:[0-9a-f]{64}$/);
  });

  it("preserves the failure projection when evidence persistence fails", async () => {
    const writeError = new Error("disk full while writing evidence");
    (writeError as NodeJS.ErrnoException).code = "ENOSPC";
    __setAtomicWriteFailAfterOpenForTests(() => writeError);

    const result: VerifyResult = {
      ok: false,
      checks: [
        {
          name: "commands",
          ok: false,
          reason: "\"pnpm test\" exited with code 1",
          command: "pnpm test",
          stdout: "out",
          stderr: "err",
          exitCode: 1,
          timedOut: false,
          aborted: false,
          elapsedMs: 50,
        },
      ],
    };

    const projected = await projectVerifyForAgent(dir, result);
    expect(projected.failure.kind).toBe("command_failed");
    expect(projected.failure.evidence_available).toBe(false);
    expect(projected.failure.evidence_error).toMatchObject({
      code: "EVIDENCE_UNAVAILABLE",
      cause_code: "EVIDENCE_WRITE_FAILED",
      system_code: "ENOSPC",
      message: "disk full while writing evidence",
    });
    expect(projected.failure.evidence_ref).toBeUndefined();
    await expect(readdir(join(dir, ".code-pact", "cache", "evidence"))).resolves.toEqual([]);
  });

  it("keeps successful agent summaries bounded after JSON serialization", () => {
    const noisy = `${"\0".repeat(2048)}${"\\\"".repeat(2048)}${"\b\f\n\r\t".repeat(2048)}`;
    const result: VerifyResult = {
      ok: true,
      checks: Array.from({ length: 20 }, (_, index) => ({
        name: `check-${index}`,
        ok: true,
        reason: noisy,
        commands: [
          {
            command: `pnpm ok-${index} ${noisy}`,
            ok: true,
            exitCode: 0,
            timedOut: false,
            aborted: false,
            elapsedMs: index,
            stdout: noisy,
            stderr: "",
          },
        ],
      })),
    };

    const summary = projectVerifySummaryForAgent(result);
    const encoded = JSON.stringify({ verify: summary });

    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(24 * 1024);
    expect(summary.projection_truncated).toBe(true);
    expect(summary.successful_commands.length).toBeLessThanOrEqual(8);
    expect(summary.checks.length).toBeLessThanOrEqual(8);
  });

  it("preserves the real stderr tail when projection shrinking is required", async () => {
    const sentinel = "FINAL_ASSERTION_SENTINEL";
    const noisy = "\0".repeat(1024 * 32);
    const stderr = `${"prefix\n".repeat(1024)}${noisy}\n${sentinel}`;
    const result: VerifyResult = {
      ok: false,
      checks: [
        {
          name: "commands",
          ok: false,
          reason: "command failed",
          command: "pnpm test",
          stdout: "",
          stderr,
          exitCode: 1,
          timedOut: false,
          aborted: false,
          elapsedMs: 50,
        },
      ],
    };

    const projected = await projectVerifyForAgent(dir, result);
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThan(24 * 1024);
    expect(projected.failure.stderr_excerpt?.tail).toContain(sentinel);
  });

  it("projects timeout, abort, and decision-only failures without evidence files", async () => {
    const timeout = await projectVerifyForAgent(dir, {
      ok: false,
      checks: [
        {
          name: "commands",
          ok: false,
          command: "sleep 10",
          stdout: "",
          stderr: "",
          timedOut: true,
          aborted: false,
          exitCode: null,
          elapsedMs: 100,
        },
      ],
    });
    expect(timeout.failure.kind).toBe("timed_out");
    expect(timeout.failure.evidence_ref).toMatch(/^evidence:sha256:[0-9a-f]{64}$/);

    const abort = await projectVerifyForAgent(dir, {
      ok: false,
      checks: [
        {
          name: "commands",
          ok: false,
          command: "sleep 10",
          stdout: "",
          stderr: "",
          timedOut: false,
          aborted: true,
          exitCode: null,
          elapsedMs: 100,
        },
      ],
    });
    expect(abort.failure.kind).toBe("aborted");
    expect(abort.failure.evidence_ref).toMatch(/^evidence:sha256:[0-9a-f]{64}$/);

    const decision = await projectVerifyForAgent(dir, {
      ok: false,
      checks: [
        { name: "commands", ok: true },
        { name: "decision", ok: false, reason: "accepted ADR required" },
      ],
    });
    expect(decision.failure.kind).toBe("decision_required");
    expect(decision.failure.evidence_ref).toBeUndefined();
  });
});

describe("failure fingerprint", () => {
  const base = {
    command: "pnpm test",
    exitCode: 1,
    timedOut: false,
    aborted: false,
    stdout: "",
  };

  it("normalizes repository absolute paths but preserves different messages", () => {
    const a = fingerprintFailure(
      { ...base, stderr: `${dir}/src/a.ts failed at 2026-07-10T00:00:00.000Z` },
      dir,
    );
    const b = fingerprintFailure(
      { ...base, stderr: `${dir}/src/a.ts failed at 2026-07-11T00:00:00.000Z` },
      dir,
    );
    const c = fingerprintFailure(
      { ...base, stderr: `${dir}/src/b.ts different failure` },
      dir,
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("does not collapse different durations or backslash-sensitive output", () => {
    const fast = fingerprintFailure({ ...base, stderr: "timed out after 100 ms" }, dir);
    const slow = fingerprintFailure({ ...base, stderr: "timed out after 5000 ms" }, dir);
    const escaped = fingerprintFailure({ ...base, stderr: "expected \\\\ but received /" }, dir);
    const slash = fingerprintFailure({ ...base, stderr: "expected / but received \\\\" }, dir);

    expect(fast).not.toBe(slow);
    expect(escaped).not.toBe(slash);
  });

  it("normalizes clearly volatile timestamps, pid tokens, and path root variants", () => {
    const timestampA = fingerprintFailure(
      { ...base, stderr: `${dir}\\src\\a.ts failed at 2026-07-10T00:00:00.000Z pid=123` },
      dir,
    );
    const timestampB = fingerprintFailure(
      { ...base, stderr: `${dir}/src/a.ts failed at 2026-07-11T00:00:00.000Z pid=456` },
      dir,
    );
    const windowsA = fingerprintFailure(
      { ...base, stderr: "C:\\repo\\src\\a.ts failed" },
      "C:\\repo",
    );
    const windowsB = fingerprintFailure(
      { ...base, stderr: "C:/repo/src/a.ts failed" },
      "C:\\repo",
    );

    expect(timestampA).toBe(timestampB);
    expect(windowsA).toBe(windowsB);
  });

  it("does not change when only the omitted middle output length changes", () => {
    const head = "HEAD".repeat(1024);
    const tail = "TAIL".repeat(4096);
    const a = fingerprintFailure(
      { ...base, stderr: `${head}${"progress".repeat(1024)}${tail}` },
      dir,
    );
    const b = fingerprintFailure(
      { ...base, stderr: `${head}${"progress".repeat(8192)}${tail}` },
      dir,
    );
    const c = fingerprintFailure(
      { ...base, stderr: `${head}${"progress".repeat(8192)}${"TAIL".repeat(4095)}DIFFERENT` },
      dir,
    );

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
