import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson } from "../../../src/core/evidence/canonical-json.ts";
import { excerptText } from "../../../src/core/evidence/excerpt.ts";
import {
  artifactDigest,
  __setReadEvidenceArtifactFailureForTests,
  loadEvidenceArtifact,
  storeEvidenceArtifact,
} from "../../../src/core/evidence/evidence-store.ts";
import { parseEvidenceRef } from "../../../src/core/evidence/evidence-ref.ts";
import {
  fingerprintFailure,
  normalizeFailureText,
} from "../../../src/core/evidence/failure-fingerprint.ts";
import {
  MAX_AGENT_JSON_BYTES,
  projectVerifyForAgent,
  projectVerifySummaryForAgent,
  stringifyBoundedAgentEnvelope,
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
  __setReadEvidenceArtifactFailureForTests(null);
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

  it("rejects evidence files with unknown fields before digest validation", async () => {
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
    const digest = artifactDigest(artifact);
    await mkdir(join(dir, ".code-pact", "cache", "evidence"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "cache", "evidence", `${digest}.json`),
      canonicalJson({ ...artifact, unexpected_field: "modified" }),
      "utf8",
    );

    await expect(loadEvidenceArtifact(dir, `evidence:sha256:${digest}`)).rejects.toMatchObject({
      code: "EVIDENCE_INVALID",
    });
  });

  it("rejects unknown fields passed to storeEvidenceArtifact", async () => {
    await expect(
      storeEvidenceArtifact(dir, {
        schema_version: 1,
        command: "pnpm test",
        exit_code: 1,
        timed_out: false,
        aborted: false,
        elapsed_ms: 123,
        stdout: "out",
        stderr: "err",
        stdout_capture_truncated: false,
        stderr_capture_truncated: false,
        unexpected_field: "modified",
      } as Parameters<typeof storeEvidenceArtifact>[1]),
    ).rejects.toThrow();
  });

  it("rejects digest mismatches when evidence content does not match the ref", async () => {
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
    const digest = artifactDigest({ ...artifact, stderr: "different" });
    await mkdir(join(dir, ".code-pact", "cache", "evidence"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "cache", "evidence", `${digest}.json`),
      JSON.stringify(artifact),
      "utf8",
    );

    await expect(loadEvidenceArtifact(dir, `evidence:sha256:${digest}`)).rejects.toMatchObject({
      code: "EVIDENCE_DIGEST_MISMATCH",
    });
  });

  it("rejects .code-pact cache root symlinks before writing outside the project", async () => {
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

  it("rejects the evidence directory symlink before writing outside the project", async () => {
    const outside = await mkdtemp(join(tmpdir(), "code-pact-evidence-dir-outside-"));
    await mkdir(join(dir, ".code-pact", "cache"), { recursive: true });
    await symlink(outside, join(dir, ".code-pact", "cache", "evidence"));
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

  it("rejects final evidence artifact symlinks before reading outside the project", async () => {
    const digest = "c".repeat(64);
    const outside = await mkdtemp(join(tmpdir(), "code-pact-evidence-file-outside-"));
    await mkdir(join(dir, ".code-pact", "cache", "evidence"), { recursive: true });
    await writeFile(join(outside, "artifact.json"), "{}", "utf8");
    await symlink(
      join(outside, "artifact.json"),
      join(dir, ".code-pact", "cache", "evidence", `${digest}.json`),
    );
    try {
      await expect(loadEvidenceArtifact(dir, `evidence:sha256:${digest}`)).rejects.toMatchObject({
        code: "PATH_NOT_OWNED",
      });
      await expect(readFile(join(outside, "artifact.json"), "utf8")).resolves.toBe("{}");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reports evidence conflicts when an existing digest path has different content", async () => {
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
    const digest = artifactDigest(artifact);
    await mkdir(join(dir, ".code-pact", "cache", "evidence"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "cache", "evidence", `${digest}.json`),
      "{}",
      "utf8",
    );

    await expect(storeEvidenceArtifact(dir, artifact)).rejects.toMatchObject({
      code: "EVIDENCE_CONFLICT",
    });
  });

  it("surfaces read permission failures from evidence files", async () => {
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
    const stored = await storeEvidenceArtifact(dir, artifact);
    const error = new Error("permission denied");
    (error as NodeJS.ErrnoException).code = "EACCES";
    __setReadEvidenceArtifactFailureForTests(() => error);

    await expect(loadEvidenceArtifact(dir, stored.ref)).rejects.toMatchObject({
      code: "EACCES",
    });
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
  function envelopeWithLineBytes(targetBytes: number) {
    const envelope = {
      ok: true as const,
      data: {
        already_done: true,
        task_id: "P1-",
        phase_id: "P1",
        agent: "claude-code",
      },
    };
    const baseBytes = Buffer.byteLength(`${JSON.stringify(envelope)}\n`, "utf8");
    envelope.data.task_id = `P1-${"X".repeat(targetBytes - baseBytes)}`;
    expect(Buffer.byteLength(`${JSON.stringify(envelope)}\n`, "utf8")).toBe(targetBytes);
    return envelope;
  }

  it("keeps agent JSON envelopes strictly below 24 KiB", () => {
    const belowLimit = envelopeWithLineBytes(MAX_AGENT_JSON_BYTES - 1);
    const belowLine = `${JSON.stringify(belowLimit)}\n`;
    expect(stringifyBoundedAgentEnvelope(belowLimit)).toBe(belowLine);

    const atLimit = envelopeWithLineBytes(MAX_AGENT_JSON_BYTES);
    const line = stringifyBoundedAgentEnvelope(atLimit);
    const envelope = JSON.parse(line) as {
      data: {
        task_id?: string;
        projection_truncated?: boolean;
        omitted_fields?: string[];
      };
    };

    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(MAX_AGENT_JSON_BYTES);
    expect(envelope.data.projection_truncated).toBe(true);
    expect(envelope.data.omitted_fields).toContain("task_id");
    expect(envelope.data.task_id).toBeUndefined();

    const aboveLimit = stringifyBoundedAgentEnvelope(
      envelopeWithLineBytes(MAX_AGENT_JSON_BYTES + 1),
    );
    expect(Buffer.byteLength(aboveLimit, "utf8")).toBeLessThan(MAX_AGENT_JSON_BYTES);
  });

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

  it("marks failed verify summaries truncated when checks, reasons, or successful commands are capped", async () => {
    const longReason = "r".repeat(1024);
    const result: VerifyResult = {
      ok: false,
      checks: [
        {
          name: "commands",
          ok: false,
          reason: longReason,
          command: "pnpm test",
          stdout: "out",
          stderr: "err",
          exitCode: 1,
          timedOut: false,
          aborted: false,
          elapsedMs: 50,
          commands: [
            ...Array.from({ length: 9 }, (_, index) => ({
              command: `pnpm ok-${index}`,
              ok: true,
              exitCode: 0,
              timedOut: false,
              aborted: false,
              elapsedMs: index,
              stdout: "",
              stderr: "",
            })),
            {
              command: "pnpm test",
              ok: false,
              exitCode: 1,
              timedOut: false,
              aborted: false,
              elapsedMs: 50,
              stdout: "out",
              stderr: "err",
            },
          ],
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          name: `extra-${index}`,
          ok: true,
          reason: `ok-${index}`,
        })),
      ],
    };

    const projected = await projectVerifyForAgent(dir, result);

    expect(projected.verify.successful_commands).toHaveLength(8);
    expect(projected.verify.checks).toHaveLength(8);
    expect(projected.verify.checks[0]?.reason).toBe("r".repeat(512));
    expect(projected.verify.projection_truncated).toBe(true);
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

  it("marks outer envelope omissions without returning partial suggested commands", () => {
    const suggested = `code-pact task complete P1-T1 ${"x".repeat(40_000)}`;
    const line = stringifyBoundedAgentEnvelope({
      ok: false,
      error: {
        code: "VERIFICATION_FAILED",
        cause_code: "ABORTED",
        message: "Verification aborted",
      },
      data: {
        task_id: `P1-${"T".repeat(40_000)}`,
        aborted: true,
        suggested_next_command: suggested,
      },
    });
    const envelope = JSON.parse(line) as {
      data: {
        projection_truncated?: boolean;
        omitted_fields?: string[];
        suggested_next_command?: string;
      };
    };

    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(24 * 1024);
    expect(envelope.data.projection_truncated).toBe(true);
    expect(envelope.data.omitted_fields).toEqual(expect.arrayContaining([
      "suggested_next_command",
      "task_id",
    ]));
    expect(envelope.data.suggested_next_command).toBeUndefined();
    expect(line).not.toContain("x".repeat(1024));
  });

  it("omits oversized outer fields before shrinking failure diagnostics", () => {
    const line = stringifyBoundedAgentEnvelope({
      ok: false,
      error: {
        code: "VERIFICATION_FAILED",
        cause_code: "COMMANDS_FAILED",
        message: "Verification failed",
      },
      data: {
        task_id: `P1-${"T".repeat(30_000)}`,
        suggested_next_command: `code-pact task complete P1-T1 ${"x".repeat(30_000)}`,
        failure: {
          schema_version: 1,
          kind: "command_failed",
          check: "commands",
          command: "pnpm test",
          reason: "test failed",
          fingerprint: "abc123",
          stdout_excerpt: {
            head: "OUT",
            tail: "",
            captured_bytes: 3,
            omitted_bytes: 0,
            truncated: false,
          },
          stderr_excerpt: {
            head: "ERR",
            tail: "",
            captured_bytes: 3,
            omitted_bytes: 0,
            truncated: false,
          },
          evidence_ref: `evidence:sha256:${"a".repeat(64)}`,
          retrieve_command: `code-pact evidence show evidence:sha256:${"a".repeat(64)} --json`,
        },
        verify: {
          ok: false,
          checks: [{ name: "commands", ok: false, reason: "test failed" }],
          successful_commands: [],
        },
      },
    });
    const envelope = JSON.parse(line) as {
      data: {
        omitted_fields?: string[];
        failure: {
          command?: string;
          reason?: string;
          stdout_excerpt?: { head: string };
          stderr_excerpt?: { head: string };
          retrieve_command?: string;
        };
      };
    };

    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(24 * 1024);
    expect(envelope.data.omitted_fields).toEqual(expect.arrayContaining([
      "suggested_next_command",
      "task_id",
    ]));
    expect(envelope.data.failure.command).toBe("pnpm test");
    expect(envelope.data.failure.reason).toBe("test failed");
    expect(envelope.data.failure.stdout_excerpt?.head).toBe("OUT");
    expect(envelope.data.failure.stderr_excerpt?.head).toBe("ERR");
    expect(envelope.data.failure.retrieve_command).toMatch(/^code-pact evidence show /);
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

  it("normalizes repository roots in commands without replacing path prefixes", () => {
    const repoA = "/tmp/code-pact-a";
    const repoB = "/tmp/code-pact-b";
    const commandA = fingerprintFailure(
      {
        ...base,
        command: `${repoA}/node_modules/.bin/vitest run`,
        stderr: `${repoA}/src/a.ts failed`,
      },
      repoA,
    );
    const commandB = fingerprintFailure(
      {
        ...base,
        command: `${repoB}/node_modules/.bin/vitest run`,
        stderr: `${repoB}/src/a.ts failed`,
      },
      repoB,
    );
    const prefixPath = fingerprintFailure(
      {
        ...base,
        command: "/tmp/app/bin/test",
        stderr: "/tmp/application failed",
      },
      "/tmp/app",
    );
    const repoPath = fingerprintFailure(
      {
        ...base,
        command: "/tmp/app/bin/test",
        stderr: "/tmp/app failed",
      },
      "/tmp/app",
    );

    expect(commandA).toBe(commandB);
    expect(prefixPath).not.toBe(repoPath);
  });

  it("normalizes Windows command roots case-insensitively at path boundaries", () => {
    const upper = fingerprintFailure(
      {
        ...base,
        command: "C:\\Repo\\node.exe C:\\Repo\\test.js",
        stderr: "C:\\Repo\\src\\a.ts failed",
      },
      "C:\\Repo",
    );
    const lower = fingerprintFailure(
      {
        ...base,
        command: "c:/repo/node.exe c:/repo/test.js",
        stderr: "c:/repo/src/a.ts failed",
      },
      "C:\\Repo",
    );
    const prefix = fingerprintFailure(
      {
        ...base,
        command: "c:/repo-tools/node.exe",
        stderr: "c:/repo-tools failed",
      },
      "C:\\Repo",
    );

    expect(upper).toBe(lower);
    expect(prefix).not.toBe(upper);
  });

  it("does not normalize repository root substrings inside unrelated paths", () => {
    const outsideA = fingerprintFailure(
      { ...base, stderr: "/var/tmp/app/a failed" },
      "/tmp/app",
    );
    const outsideB = fingerprintFailure(
      { ...base, stderr: "/var/tmp/other/a failed" },
      "/tmp/other",
    );
    const prefixed = fingerprintFailure(
      { ...base, stderr: "prefix/tmp/app/a failed" },
      "/tmp/app",
    );
    const repoPath = fingerprintFailure(
      { ...base, stderr: "/tmp/app/a failed" },
      "/tmp/app",
    );

    expect(outsideA).not.toBe(outsideB);
    expect(prefixed).not.toBe(repoPath);
  });

  it("normalizes repository roots after command delimiters", () => {
    const configA = fingerprintFailure(
      {
        ...base,
        command: "--config=/tmp/app/config.json",
        stderr: "failed",
      },
      "/tmp/app",
    );
    const configB = fingerprintFailure(
      {
        ...base,
        command: "--config=/tmp/other/config.json",
        stderr: "failed",
      },
      "/tmp/other",
    );
    const fileUriA = fingerprintFailure(
      {
        ...base,
        command: "node file:///tmp/app/config.js",
        stderr: "failed",
      },
      "/tmp/app",
    );
    const fileUriB = fingerprintFailure(
      {
        ...base,
        command: "node file:///tmp/other/config.js",
        stderr: "failed",
      },
      "/tmp/other",
    );

    expect(configA).toBe(configB);
    expect(fileUriA).toBe(fileUriB);
  });

  it("does not treat file:// inside custom URI schemes as repository roots", () => {
    expect(normalizeFailureText("profile:///tmp/app/src/a.ts failed", "/tmp/app")).toBe(
      "profile:///tmp/app/src/a.ts failed",
    );
    expect(normalizeFailureText("profile:/tmp/app/src/a.ts failed", "/tmp/app")).toBe(
      "profile:/tmp/app/src/a.ts failed",
    );
    expect(normalizeFailureText("myfile:///tmp/app/src/a.ts failed", "/tmp/app")).toBe(
      "myfile:///tmp/app/src/a.ts failed",
    );
    expect(normalizeFailureText("myfile:/tmp/app/src/a.ts failed", "/tmp/app")).toBe(
      "myfile:/tmp/app/src/a.ts failed",
    );
    expect(normalizeFailureText("notfile:///tmp/app/src/a.ts failed", "/tmp/app")).toBe(
      "notfile:///tmp/app/src/a.ts failed",
    );
    expect(normalizeFailureText("urn:/tmp/app/src/a.ts failed", "/tmp/app")).toBe(
      "urn:/tmp/app/src/a.ts failed",
    );
  });

  it("does not collapse different custom URI schemes into repository fingerprints", () => {
    const customTripleA = fingerprintFailure(
      { ...base, stderr: "profile:///tmp/app/src/a.ts failed" },
      "/tmp/app",
    );
    const customTripleB = fingerprintFailure(
      { ...base, stderr: "profile:///opt/other/src/a.ts failed" },
      "/opt/other",
    );
    const customSingleA = fingerprintFailure(
      { ...base, stderr: "profile:/tmp/app/src/a.ts failed" },
      "/tmp/app",
    );
    const customSingleB = fingerprintFailure(
      { ...base, stderr: "profile:/opt/other/src/a.ts failed" },
      "/opt/other",
    );
    const standardFileUrl = fingerprintFailure(
      { ...base, stderr: "file:///tmp/app/src/a.ts failed" },
      "/tmp/app",
    );

    expect(customTripleA).not.toBe(customTripleB);
    expect(customTripleA).not.toBe(standardFileUrl);
    expect(customSingleA).not.toBe(customSingleB);
    expect(customSingleA).not.toBe(standardFileUrl);
  });

  it("normalizes single-slash POSIX file URLs at repository roots", () => {
    const singleSlashA = fingerprintFailure(
      { ...base, stderr: "at file:/tmp/app/src/a.ts:1:1" },
      "/tmp/app",
    );
    const singleSlashB = fingerprintFailure(
      { ...base, stderr: "at file:/opt/other/src/a.ts:1:1" },
      "/opt/other",
    );
    const tripleSlashA = fingerprintFailure(
      { ...base, stderr: "at file:///tmp/app/src/a.ts:1:1" },
      "/tmp/app",
    );
    const tripleSlashB = fingerprintFailure(
      { ...base, stderr: "at file:///opt/other/src/a.ts:1:1" },
      "/opt/other",
    );

    expect(singleSlashA).toBe(singleSlashB);
    expect(tripleSlashA).toBe(tripleSlashB);
    expect(singleSlashA).toBe(tripleSlashA);
  });

  it("normalizes Windows ESM file URLs at repository roots", () => {
    const repoA = fingerprintFailure(
      {
        ...base,
        stderr: "at file:///c:/repo/src/a.ts:1:1",
      },
      "C:/Repo",
    );
    const repoB = fingerprintFailure(
      {
        ...base,
        stderr: "at file:///D:/Other/src/a.ts:1:1",
      },
      "D:/Other",
    );
    const outside = fingerprintFailure(
      {
        ...base,
        stderr: "at file:///C:/Other/src/a.ts:1:1",
      },
      "C:/Repo",
    );
    const sibling = fingerprintFailure(
      {
        ...base,
        stderr: "at file:///C:/Repo-tools/src/a.ts:1:1",
      },
      "C:/Repo",
    );
    const singleSlashA = fingerprintFailure(
      {
        ...base,
        stderr: "at file:/C:/Repo/src/a.ts:1:1",
      },
      "C:/Repo",
    );
    const singleSlashB = fingerprintFailure(
      {
        ...base,
        stderr: "at file:/D:/Other/src/a.ts:1:1",
      },
      "D:/Other",
    );

    expect(repoA).toBe(repoB);
    expect(singleSlashA).toBe(singleSlashB);
    expect(singleSlashA).toBe(repoA);
    expect(outside).not.toBe(repoA);
    expect(sibling).not.toBe(repoA);
  });

  it("normalizes percent-encoded file URLs at repository roots", () => {
    const repoA = fingerprintFailure(
      {
        ...base,
        stderr: "at file:///tmp/app%20one/src/a.ts:1:1",
      },
      "/tmp/app one",
    );
    const repoB = fingerprintFailure(
      {
        ...base,
        stderr: "at file:///opt/app%20two/src/a.ts:1:1",
      },
      "/opt/app two",
    );

    expect(repoA).toBe(repoB);
  });

  it("strips ANSI control sequences before fingerprint path normalization", () => {
    const coloredA = fingerprintFailure(
      {
        ...base,
        stderr: "\u001b[31m/tmp/app/src/a.ts failed\u001b[0m",
      },
      "/tmp/app",
    );
    const coloredB = fingerprintFailure(
      {
        ...base,
        stderr: "\u001b[31m/opt/other/src/a.ts failed\u001b[0m",
      },
      "/opt/other",
    );
    const differentMessage = fingerprintFailure(
      {
        ...base,
        stderr: "\u001b[31m/opt/other/src/a.ts different\u001b[0m",
      },
      "/opt/other",
    );

    expect(coloredA).toBe(coloredB);
    expect(differentMessage).not.toBe(coloredA);
  });

  it("strips OSC hyperlinks before fingerprint path normalization", () => {
    const linkedA = fingerprintFailure(
      {
        ...base,
        stderr: "\u001b]8;;file:///tmp/app/src/a.ts\u0007/tmp/app/src/a.ts\u001b]8;;\u0007 failed",
      },
      "/tmp/app",
    );
    const linkedB = fingerprintFailure(
      {
        ...base,
        stderr: "\u001b]8;;file:///opt/other/src/a.ts\u0007/opt/other/src/a.ts\u001b]8;;\u0007 failed",
      },
      "/opt/other",
    );

    expect(linkedA).toBe(linkedB);
  });

  it("does not normalize Windows roots inside unrelated path strings", () => {
    const embedded = fingerprintFailure(
      { ...base, command: "xC:/Repo/file.js", stderr: "failed" },
      "C:/Repo",
    );
    const repoPath = fingerprintFailure(
      { ...base, command: "C:/Repo/file.js", stderr: "failed" },
      "C:/Repo",
    );
    const sibling = fingerprintFailure(
      { ...base, command: "C:/Repo-tools/file.js", stderr: "failed" },
      "C:/Repo",
    );

    expect(embedded).not.toBe(repoPath);
    expect(sibling).not.toBe(repoPath);
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
