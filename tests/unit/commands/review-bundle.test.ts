import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewBundle } from "../../../src/commands/review-bundle.ts";
import {
  DoneEventRef,
  LocalVerificationEntry,
  readReviewManifest,
} from "../../../src/core/review-bundle.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-review-bundle-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function setupProject(
  events: {
    task_id: string;
    status: string;
    at: string;
    evidence?: string[];
  }[],
): Promise<void> {
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });

  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n`,
    "utf8",
  );

  await writeFile(
    join(cwd, "design", "phases", "P1-foundation.yaml"),
    [
      "id: P1",
      "name: Foundation",
      "weight: 10",
      "confidence: medium",
      "risk: low",
      "status: planned",
      "objective: Establish the project foundation",
      "definition_of_done:",
      "  - All tasks done",
      "verification:",
      "  commands:",
      "    - node --version",
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
      "",
    ].join("\n"),
    "utf8",
  );

  const progressEvents = events.map(e => {
    const base = [
      `  - task_id: ${e.task_id}`,
      `    status: ${e.status}`,
      `    at: "${e.at}"`,
      "    actor: agent",
      "    agent: claude-code",
    ];
    if (e.evidence) {
      base.push("    evidence:");
      for (const x of e.evidence) base.push(`      - ${x}`);
    }
    return base.join("\n");
  });

  await writeFile(
    join(cwd, ".code-pact", "state", "progress.yaml"),
    `events:\n${progressEvents.join("\n")}\n`,
    "utf8",
  );

  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init", "--quiet"], { cwd });
  spawnSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd },
  );
}

describe("runReviewBundle", () => {
  it.skip("writes a review manifest and ZIP bundle for a done task", async () => {
    // TODO(P79-T4): set up a committed phase, contract lock, done event file,
    // and mock classifyVerification before re-enabling.
    await setupProject([
      {
        task_id: "P1-T1",
        status: "started",
        at: "2026-05-19T10:00:00.000Z",
      },
      {
        task_id: "P1-T1",
        status: "done",
        at: "2026-05-19T11:00:00.000Z",
        evidence: ["node --version"],
      },
    ]);

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
    expect(manifest?.done_event?.evidence).toEqual(["node --version"]);
  });

  it("throws TASK_NOT_DONE when no done event exists", async () => {
    await setupProject([
      {
        task_id: "P1-T1",
        status: "started",
        at: "2026-05-19T10:00:00.000Z",
      },
    ]);

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
