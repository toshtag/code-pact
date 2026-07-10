import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonErr,
  expectJsonOk,
} from "../helpers/cli.ts";

type Project = Awaited<ReturnType<typeof createTempProject>>;

let project: Project | null = null;

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

afterEach(async () => {
  await project?.cleanup();
  project = null;
});

async function setupFailingTask(): Promise<Project> {
  project = await createTempProject({ prefix: "code-pact-evidence-cli-" });
  expectJsonOk(
    project.run([
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--objective",
      "Foundation phase for evidence integration",
      "--weight",
      "10",
      "--verify-command",
      "node --version",
      "--json",
    ]),
  );

  const phasePath = join(project.dir, "design", "phases", "P1-foundation.yaml");
  const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<string, unknown>;
  doc.verification = {
    commands: [
      "node -e \"process.stdout.write('OUT'.repeat(4096)); process.stderr.write('ERR'.repeat(4096)); process.exit(1)\"",
    ],
  };
  doc.tasks = [
    {
      id: "P1-T1",
      type: "feature",
      ambiguity: "low",
      risk: "low",
      context_size: "small",
      write_surface: "low",
      verification_strength: "weak",
      expected_duration: "short",
      status: "planned",
      description: "evidence integration task",
    },
  ];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");
  return project;
}

describe("agent detail evidence envelope", () => {
  it("verify --detail agent emits a compact failure and retrievable evidence", async () => {
    const p = await setupFailingTask();
    const failed = p.run([
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--json",
      "--detail",
      "agent",
    ]);
    expect(failed.code).toBe(1);
    const env = expectJsonErr(failed, "VERIFICATION_FAILED") as {
      data: {
        failure: {
          kind: string;
          evidence_ref: string;
          retrieve_command: string;
          stdout_excerpt: { head: string; tail: string };
          stderr_excerpt: { head: string; tail: string };
        };
        verify: { checks: Array<{ name: string; ok: boolean }> };
      };
    };

    expect(env.data.failure.kind).toBe("command_failed");
    expect(env.data.failure.evidence_ref).toMatch(/^evidence:sha256:[0-9a-f]{64}$/);
    expect(env.data.failure.retrieve_command).toContain("code-pact evidence show");
    expect(failed.stdout.length).toBeLessThan(24 * 1024);
    expect(failed.stdout).not.toContain('"stdout":');
    expect(failed.stdout).not.toContain('"stderr":');
    expect(env.data.verify.checks[0]).toEqual({
      name: "commands",
      ok: false,
      reason: expect.any(String),
    });

    const shown = p.run([
      "evidence",
      "show",
      env.data.failure.evidence_ref,
      "--stream",
      "stderr",
      "--json",
    ]);
    const shownEnv = expectJsonOk<{ artifact: { stderr: string } }>(shown);
    expect(shownEnv.data.artifact.stderr).toContain("ERRERRERR");
  });
});
