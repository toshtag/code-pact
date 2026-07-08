import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { repoRoot, run, createTempProject, ensureCliBuilt } from "../helpers/cli.ts";

type Project = Awaited<ReturnType<typeof createTempProject>>;

let project: Project | undefined;

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

function expectOkJson(result: { code: number; stdout: string; stderr: string }) {
  expect(result.code).toBe(0);
  expect(result.stdout.trim().length).toBeGreaterThan(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
}

describe("CI smoke", () => {
  it("covers the smallest built CLI path used by required PR CI", async () => {
    expectOkJson(run(repoRoot, ["--json", "--version"]));

    const humanVersion = run(repoRoot, ["--version"]);
    expect(humanVersion.code).toBe(0);
    expect(humanVersion.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    project = await createTempProject({ init: false, prefix: "code-pact-ci-smoke-" });
    expectOkJson(
      project.run([
        "init",
        "--non-interactive",
        "--locale",
        "en-US",
        "--agent",
        "claude-code",
        "--json",
      ]),
    );
    expectOkJson(project.run(["validate", "--json"]));
    expectOkJson(project.run(["doctor", "--json"]));
    expectOkJson(project.run(["plan", "lint", "--json"]));
    expectOkJson(project.run(["adapter", "list", "--json"]));

    expectOkJson(
      project.run([
        "phase",
        "add",
        "--id",
        "P1",
        "--name",
        "Foundation",
        "--objective",
        "Foundation smoke coverage",
        "--weight",
        "10",
        "--json",
      ]),
    );
    expectOkJson(
      project.run([
        "task",
        "add",
        "P1",
        "--type",
        "feature",
        "--description",
        "Smoke task verifies the required CI CLI path.",
        "--json",
      ]),
    );
    expectOkJson(project.run(["task", "status", "P1-T1", "--json"]));
  });
});
