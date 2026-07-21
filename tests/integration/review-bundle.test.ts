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
  // src/example.ts is the only declared write; phase YAML lifecycle changes
  // must be reclassified by review-bundle, not declared by the task.
  expectJsonOk(
    p.run([
      "task",
      "add",
      "P1",
      "--type",
      "feature",
      "--description",
      "Reviewable task",
      "--write",
      "src/example.ts",
      "--json",
    ]),
  );

  await mkdir(join(p.dir, "src"), { recursive: true });
  await writeFile(
    join(p.dir, "src", "example.ts"),
    "export const x = 1;\n",
    "utf8",
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

  // Task implementation happens after start and before complete.
  await writeFile(
    join(p.dir, "src", "example.ts"),
    "export const x = 2;\n",
    "utf8",
  );

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

  // code-pact intentionally does not flip the phase status in phase reconcile;
  // flip it by hand so the review-bundle state consistency gate passes.
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

  return p;
}

describe("task review-bundle", () => {
  it("creates a review bundle for a done task with lifecycle-only phase changes reclassified", async () => {
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

    // The manifest must record the phase status change as a control-plane
    // change, not as an undeclared implementation write.
    const manifestRaw = await readFile(data.manifest_path, "utf8");
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.write_audit.outside_declared).toEqual([]);
    expect(manifest.write_audit.declared_unused).toEqual([]);
    expect(manifest.write_audit.warnings).toEqual([]);
    expect(manifest.write_audit.files_touched).toContain("src/example.ts");
    expect(manifest.write_audit.files_touched).toContain(
      "design/phases/P1-foundation.yaml",
    );
    expect(manifest.write_audit.lifecycle_control_plane).toEqual([
      {
        file: "design/phases/P1-foundation.yaml",
        changed_fields: ["status", "tasks[P1-T1].status"],
      },
    ]);
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
