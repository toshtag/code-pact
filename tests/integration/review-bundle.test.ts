import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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

async function setupDoneTask(): Promise<
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
      "Reviewable task",
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

  return p;
}

describe("task review-bundle", () => {
  it("creates a review bundle for a done task", async () => {
    project = await setupDoneTask();

    const bundle = expectJsonOk(
      project.run(["task", "review-bundle", "P1-T1", "--json"]),
    );
    expect(bundle.data).toMatchObject({
      task_id: "P1-T1",
      phase_id: "P1",
    });
    const data = bundle.data as {
      manifest_path: string;
      bundle_path: string;
    };
    expect(data.manifest_path).toContain(
      ".code-pact/cache/reviews/P1-T1/manifest.json",
    );
    expect(data.bundle_path).toContain(
      ".code-pact/cache/reviews/P1-T1/bundle.zip",
    );
  });

  it("refuses to bundle a task that is not done", async () => {
    project = await createTempProject();
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
        "Not done",
        "--json",
      ]),
    );

    const err = expectJsonErr(
      project.run(["task", "review-bundle", "P1-T1", "--json"]),
      "TASK_NOT_DONE",
    );
    expect(err.error.message).toContain("no done event");
  });
});
