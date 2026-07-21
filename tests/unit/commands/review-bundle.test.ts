import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runReviewBundle } from "../../../src/commands/review-bundle.ts";
import {
  DoneEventRef,
  LocalVerificationEntry,
  readReviewManifest,
} from "../../../src/core/review-bundle.ts";
import { createTaskContractLock } from "../../../src/core/contract-lock.ts";
import { writeEventFile } from "../../../src/core/progress/events-io.ts";
import { storeEvidenceArtifact } from "../../../src/core/evidence/evidence-store.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-review-bundle-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

function basePhase(): string {
  return [
    "id: P1",
    "name: Foundation",
    "weight: 10",
    "confidence: medium",
    "risk: low",
    "status: in_progress",
    "objective: Establish the project foundation",
    "definition_of_done:",
    "  - All tasks done",
    "verification:",
    "  commands:",
    "    - echo ok",
    "tasks:",
    "  - id: P1-T1",
    "    type: feature",
    "    ambiguity: low",
    "    risk: low",
    "    context_size: small",
    "    write_surface: low",
    "    verification_strength: medium",
    "    expected_duration: short",
    "    status: planned",
    "    description: Test task",
    "    writes:",
    "      - src/example.ts",
    "",
  ].join("\n");
}

async function setupDoneTaskProject(): Promise<void> {
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "scripts"), { recursive: true });

  await writeFile(
    join(cwd, ".gitignore"),
    ["/.code-pact/locks/", "/.code-pact/cache/", ""].join("\n"),
    "utf8",
  );
  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n`,
    "utf8",
  );
  await writeFile(
    join(cwd, "design", "phases", "P1-foundation.yaml"),
    basePhase(),
    "utf8",
  );
  await writeFile(
    join(cwd, "src", "example.ts"),
    "export const x = 1;\n",
    "utf8",
  );
  await writeFile(
    join(cwd, "scripts", "verification-scope.mjs"),
    `#!/usr/bin/env node
import { parseArgs } from "node:util";
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { base: { type: "string" }, commands: { type: "boolean" }, format: { type: "string" } },
  allowPositionals: true,
});
if (values.commands && values.format === "json") {
  process.stdout.write(JSON.stringify({
    scope: { changed: [], added: [], removed: [], mergeBase: values.base ?? null, failSafe: false },
    commands: [["echo", ["ok"]]],
    failSafe: false,
  }));
} else {
  process.stdout.write("ok\\n");
}
`,
    "utf8",
  );

  git(["init", "--quiet"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git([
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);

  // Lock the task contract against the initial commit.
  await createTaskContractLock({ cwd, taskId: "P1-T1" });

  // Record a start event.
  await writeEventFile(cwd, {
    task_id: "P1-T1",
    status: "started",
    at: "2026-05-19T10:00:00.000Z",
    actor: "agent",
    agent: "claude-code",
  });

  // Simulate task implementation.
  await writeFile(
    join(cwd, "src", "example.ts"),
    "export const x = 2;\n",
    "utf8",
  );

  // Store evidence for the done event.
  const stored = await storeEvidenceArtifact(cwd, {
    schema_version: 1,
    command: "echo ok",
    exit_code: 0,
    timed_out: false,
    aborted: false,
    elapsed_ms: 10,
    stdout: "ok\n",
    stderr: "",
    stdout_capture_truncated: false,
    stderr_capture_truncated: false,
  });

  // Record the done event with the evidence reference.
  await writeEventFile(cwd, {
    task_id: "P1-T1",
    status: "done",
    at: "2026-05-19T11:00:00.000Z",
    actor: "agent",
    agent: "claude-code",
    evidence: ["commands"],
    verification_ref: stored.ref,
    source: "loop",
  });

  // Lifecycle-only mutations: flip task and phase status to done.
  const phasePath = join(cwd, "design", "phases", "P1-foundation.yaml");
  const updatedPhase = (await readFile(phasePath, "utf8"))
    .replace("status: in_progress", "status: done")
    .replace("    status: planned", "    status: done");
  await writeFile(phasePath, updatedPhase, "utf8");

  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git([
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--quiet",
    "-m",
    "done",
  ]);
}

describe("runReviewBundle", () => {
  it("writes a review manifest and ZIP bundle for a done task", async () => {
    await setupDoneTaskProject();

    const result = await runReviewBundle({
      cwd,
      taskId: "P1-T1",
    });

    expect(result.task_id).toBe("P1-T1");
    expect(result.phase_id).toBe("P1");
    expect(result.bundle_path).toContain("P1-T1");

    const manifest = await readReviewManifest(cwd, "P1-T1");
    expect(manifest).not.toBeNull();
    expect(manifest?.remote_ci.status).toBe("pending");
    expect(manifest?.done_event?.evidence).toEqual(["commands"]);
    // Lifecycle-only phase status changes are reclassified to
    // lifecycle_control_plane, not treated as outside declared writes.
    expect(manifest?.write_audit.outside_declared).toEqual([]);
    expect(manifest?.write_audit.warnings).toEqual([]);
    expect(manifest?.write_audit.lifecycle_control_plane).toEqual([
      {
        file: "design/phases/P1-foundation.yaml",
        changed_fields: ["status", "tasks[P1-T1].status"],
      },
    ]);
  });

  it("throws TASK_NOT_DONE when no done event exists", async () => {
    await mkdir(join(cwd, "design", "phases"), { recursive: true });
    await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
    await writeFile(
      join(cwd, "design", "roadmap.yaml"),
      `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n`,
      "utf8",
    );
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      basePhase(),
      "utf8",
    );
    await writeEventFile(cwd, {
      task_id: "P1-T1",
      status: "started",
      at: "2026-05-19T10:00:00.000Z",
      actor: "agent",
      agent: "claude-code",
    });

    await expect(
      runReviewBundle({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({ code: "TASK_NOT_DONE" });
  });
});

describe("review-bundle schemas", () => {
  it("accepts a verification_ref on done event refs", () => {
    const parsed = DoneEventRef.safeParse({
      at: "2026-05-19T11:00:00.000Z",
      verification_ref:
        "evidence:sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a verification_ref on done event refs with a bad format", () => {
    const parsed = DoneEventRef.safeParse({
      at: "2026-05-19T11:00:00.000Z",
      verification_ref: "not-a-ref",
    });
    expect(parsed.success).toBe(false);
  });

  it("requires a source on local verification entries", () => {
    const parsed = LocalVerificationEntry.safeParse({
      command: "pnpm test",
      exit_code: 0,
      duration_ms: 1000,
      stdout_excerpt: "ok",
      stderr_excerpt: "",
    });
    expect(parsed.success).toBe(false);
  });
});
