import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { excerptText } from "../../../src/core/evidence/excerpt.ts";
import {
  loadEvidenceArtifact,
  storeEvidenceArtifact,
} from "../../../src/core/evidence/evidence-store.ts";
import { parseEvidenceRef } from "../../../src/core/evidence/evidence-ref.ts";
import { fingerprintFailure } from "../../../src/core/evidence/failure-fingerprint.ts";
import { projectVerifyForAgent } from "../../../src/core/evidence/failure-capsule.ts";
import type { VerifyResult } from "../../../src/commands/verify.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-evidence-"));
  await mkdir(join(dir, ".code-pact"), { recursive: true });
});

afterEach(async () => {
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
});

describe("failure fingerprint", () => {
  it("normalizes repository absolute paths but preserves different messages", () => {
    const base = {
      command: "pnpm test",
      exitCode: 1,
      timedOut: false,
      aborted: false,
      stdout: "",
    };
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
});
