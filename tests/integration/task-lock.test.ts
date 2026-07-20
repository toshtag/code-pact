import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
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

async function setupTask(): Promise<
  Awaited<ReturnType<typeof createTempProject>>
> {
  const p = await createTempProject();
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
      "Lockable task",
      "--json",
    ]),
  );
  return p;
}

describe("task lock", () => {
  it("creates a contract lock and refuses to overwrite it", async () => {
    project = await setupTask();

    git(project.dir, ["init", "--quiet"]);
    git(project.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
    git(project.dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);

    const first = expectJsonOk(
      project.run(["task", "lock", "P1-T1", "--json"]),
    );
    expect(first.data).toMatchObject({
      task_id: "P1-T1",
      phase_id: "P1",
    });
    expect(
      typeof (first.data as { contract_digest?: string }).contract_digest,
    ).toBe("string");
    expect(typeof (first.data as { base_sha?: string }).base_sha).toBe(
      "string",
    );

    const second = expectJsonErr(
      project.run(["task", "lock", "P1-T1", "--json"]),
      "TASK_CONTRACT_LOCK_EXISTS",
    );
    expect(second.error.message).toContain("already exists");
  });

  it("refuses to lock when the working tree is not clean", async () => {
    project = await setupTask();

    const res = expectJsonErr(
      project.run(["task", "lock", "P1-T1", "--json"]),
      "WORKTREE_NOT_CLEAN",
    );
    expect(res.error.message).toContain("working tree is not clean");
  });
});
