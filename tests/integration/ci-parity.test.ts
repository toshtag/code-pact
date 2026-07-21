import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonOk,
  expectJsonErr,
} from "../helpers/cli.ts";

let project: Awaited<ReturnType<typeof createTempProject>> | undefined;

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

function git(cwd: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

async function writeFakeClassifier(cwd: string): Promise<void> {
  const dir = join(cwd, "scripts");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "verification-scope.mjs"),
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
}

async function setupReviewableTask(): Promise<
  Awaited<ReturnType<typeof createTempProject>>
> {
  const p = await createTempProject();
  await writeFakeClassifier(p.dir);
  expectJsonOk(
    p.run([
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--weight",
      "1",
      "--objective",
      "Test phase",
      "--verify-command",
      "echo ok",
      "--json",
    ]),
  );
  expectJsonOk(
    p.run([
      "task",
      "add",
      "P1",
      "--type",
      "feature",
      "--description",
      "Parity task",
      "--write",
      "design/phases/P1-foundation.yaml",
      "--json",
    ]),
  );

  git(p.dir, ["init", "--quiet"]);
  git(p.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git(p.dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--quiet",
    "-m",
    "init",
  ]);

  expectJsonOk(p.run(["task", "start", "P1-T1", "--json"]));
  git(p.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git(p.dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--quiet",
    "-m",
    "lock",
  ]);

  expectJsonOk(p.run(["task", "complete", "P1-T1", "--json"]));
  git(p.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git(p.dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--quiet",
    "-m",
    "done",
  ]);

  expectJsonOk(p.run(["task", "finalize", "P1-T1", "--write", "--json"]));
  git(p.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git(p.dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--quiet",
    "-m",
    "finalize",
  ]);

  expectJsonOk(p.run(["phase", "reconcile", "P1", "--write", "--json"]));

  // code-pact intentionally does not flip the phase status in phase reconcile.
  const phasePath = join(p.dir, "design", "phases", "P1-foundation.yaml");
  const phaseYaml = (await readFile(phasePath, "utf8")).replace(
    /^status: .*$/m,
    "status: done",
  );
  await writeFile(phasePath, phaseYaml, "utf8");

  git(p.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git(p.dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--quiet",
    "-m",
    "reconcile",
  ]);

  expectJsonOk(p.run(["task", "review-bundle", "P1-T1", "--json"]));
  return p;
}

describe("task ci-parity", () => {
  it("passes when HEAD/tree match the manifest and local verification succeeds", async () => {
    project = await setupReviewableTask();
    const parity = expectJsonOk(
      project.run(["task", "ci-parity", "P1-T1", "--json"]),
    );
    expect(parity.data).toMatchObject({
      task_id: "P1-T1",
      phase_id: "P1",
      local_verification_passed: true,
    });
  });

  it("fails when HEAD has drifted since the manifest was written", async () => {
    project = await setupReviewableTask();

    // Drift HEAD by adding an unrelated file and committing it.
    await writeFile(join(project.dir, "drift.txt"), "drift", "utf8");
    git(project.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
    git(project.dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "drift",
    ]);

    const err = expectJsonErr(
      project.run(["task", "ci-parity", "P1-T1", "--json"]),
      "CI_PARITY_HEAD_MISMATCH",
    );
    expect(err.error.message).toContain("HEAD");
  });

  it("fails when no manifest exists", async () => {
    project = await createTempProject();
    await writeFakeClassifier(project.dir);
    expectJsonOk(
      project.run([
        "phase",
        "add",
        "--id",
        "P1",
        "--name",
        "Foundation",
        "--weight",
        "1",
        "--objective",
        "Test phase",
        "--json",
      ]),
    );
    expectJsonOk(
      project.run([
        "task",
        "add",
        "P1",
        "--type",
        "feature",
        "--description",
        "No manifest",
        "--json",
      ]),
    );

    const err = expectJsonErr(
      project.run(["task", "ci-parity", "P1-T1", "--json"]),
      "CI_PARITY_MANIFEST_MISSING",
    );
    expect(err.error.message).toContain("No review manifest");
  });
});
