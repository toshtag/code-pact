import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  runReviewBundle,
  readReviewManifest,
} from "../../../src/core/review-bundle.ts";
import { createTaskContractLock } from "../../../src/core/contract-lock.ts";
import { writeEventFile } from "../../../src/core/progress/events-io.ts";
import { storeEvidenceArtifact } from "../../../src/core/evidence/evidence-store.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-review-bundle-core-"));
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
    "objective: test",
    "definition_of_done:",
    "  - ok",
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
    "    description: test",
    "    writes:",
    "      - src/example.ts",
    "",
  ].join("\n");
}

async function setupDoneTaskProject(): Promise<string> {
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
    scope: {
      changedFiles: [], docs: false, standard: true, toolchain: false,
      processControl: false, generic: true, workflow: false, releaseScript: false,
      sharedTestInfra: false, unknown: false, highRisk: false, fallbackFull: false,
      fallbackReason: null, mode: "focused", reason: "standard",
      mergeBase: values.base ?? null,
    },
    commands: [["git", "--version"]],
    failSafe: false,
  }));
} else {
  process.stdout.write("ok\\n");
}
`,
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

  const lock = await createTaskContractLock({ cwd, taskId: "P1-T1" });

  await writeEventFile(cwd, {
    task_id: "P1-T1",
    status: "started",
    at: "2026-05-19T10:00:00.000Z",
    actor: "agent",
    agent: "claude-code",
  });

  await writeFile(
    join(cwd, "src", "example.ts"),
    "export const x = 2;\n",
    "utf8",
  );

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

  return lock.base_sha;
}

describe("runReviewBundle audit base", () => {
  it("uses lock.base_sha as the write audit base", async () => {
    const lockBase = await setupDoneTaskProject();

    await runReviewBundle({ cwd, taskId: "P1-T1" });

    const manifest = await readReviewManifest(cwd, "P1-T1");
    expect(manifest).not.toBeNull();
    expect(manifest?.write_audit.base_ref).toBe(lockBase);
  });
});

// ---------------------------------------------------------------------------
// The classifier emits `[program, ...args]`. A consumer that read the second
// element as an argument LIST spread the string "--version" one character at a
// time, so every classifier command was unrunnable and the bundle refused with
// a VERIFICATION_FAILED naming a command nobody wrote. The fixture command
// above exits non-zero when split, so a regression fails the run, not just
// this assertion.
// ---------------------------------------------------------------------------

describe("runReviewBundle classifier verification", () => {
  it("records the classifier command as argv, not as its characters", async () => {
    await setupDoneTaskProject();

    await runReviewBundle({ cwd, taskId: "P1-T1" });

    const manifest = await readReviewManifest(cwd, "P1-T1");
    expect(manifest?.classifier_verification.map(e => e.command)).toEqual([
      '"git" "--version"',
    ]);
    expect(manifest?.classifier_verification.every(e => e.exit_code === 0)).toBe(
      true,
    );
  });
});
