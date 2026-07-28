import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonErr,
  expectJsonOk,
} from "../helpers/cli.ts";
import {
  setReviewContractPolicy,
  writeReviewContractFile,
} from "../helpers/review-contract.ts";

// The rollout policy through a real CLI process.
//
// The unit tests pin the decision; this file pins what an agent actually sees:
// the exit code, the envelope, and — the part that matters most — that a
// refusal leaves no lock file and no progress event behind. A gate that
// half-applied would be worse than no gate, because the next command would read
// state for a task the gate had just rejected.

type Project = Awaited<ReturnType<typeof createTempProject>>;

let projects: Project[] = [];

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

afterEach(async () => {
  await Promise.all(projects.map(p => p.cleanup()));
  projects = [];
});

function git(cwd: string, args: string[]): void {
  spawnSync("git", args, { cwd, encoding: "utf8" });
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", message]);
}

/**
 * A project with phase P1 and task P1-T1.
 *
 * `policy` is written explicitly, except for `"absent"`, which strips the field
 * entirely — the state an existing project is in immediately after upgrading.
 */
async function project(opts: {
  policy: "absent" | "advisory" | "required";
  contract: boolean;
}): Promise<Project> {
  const p = await createTempProject({ prefix: "code-pact-review-policy-" });
  projects.push(p);

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
      "Review contract policy fixture",
      "--verify-command",
      "node --version",
      "--json",
    ]),
  );

  const taskArgs = [
    "task",
    "add",
    "P1",
    "--type",
    "feature",
    "--description",
    "Policy fixture task",
    "--write",
    "src/example.ts",
  ];
  if (opts.contract) {
    const contractFile = await writeReviewContractFile(p.dir, {
      id: "P1-T1",
      type: "feature",
      writes: ["src/example.ts"],
    });
    taskArgs.push("--review-contract-file", contractFile);
  }
  expectJsonOk(p.run([...taskArgs, "--json"]));

  if (opts.policy === "absent") {
    const path = join(p.dir, ".code-pact", "project.yaml");
    const raw = await readFile(path, "utf8");
    await writeFile(
      path,
      raw.replace(/^review_contract_policy:.*\n/m, ""),
      "utf8",
    );
  } else {
    await setReviewContractPolicy(p.dir, opts.policy);
  }

  git(p.dir, ["init", "--quiet"]);
  commitAll(p.dir, "init");
  return p;
}

async function lockExists(p: Project): Promise<boolean> {
  return readFile(
    join(p.dir, ".code-pact", "state", "locks", "P1-T1.yaml"),
    "utf8",
  ).then(
    () => true,
    () => false,
  );
}

async function eventCount(p: Project): Promise<number> {
  try {
    return (await readdir(join(p.dir, ".code-pact", "state", "events"))).length;
  } catch {
    return 0;
  }
}

describe("review_contract_policy — existing projects keep working", () => {
  it("locks a contract-less task when the field is absent", async () => {
    const p = await project({ policy: "absent", contract: false });

    expectJsonOk(p.run(["task", "lock", "P1-T1", "--json"]));
    expect(await lockExists(p)).toBe(true);
  });

  it("locks a contract-less task under advisory", async () => {
    const p = await project({ policy: "advisory", contract: false });

    expectJsonOk(p.run(["task", "lock", "P1-T1", "--json"]));
    expect(await lockExists(p)).toBe(true);
  });

  it("starts a contract-less task under advisory", async () => {
    const p = await project({ policy: "advisory", contract: false });

    expectJsonOk(p.run(["task", "start", "P1-T1", "--json"]));
    expect(await eventCount(p)).toBe(1);
  });
});

describe("review_contract_policy — required refuses a missing contract", () => {
  it("refuses an explicit lock and writes no lock file", async () => {
    const p = await project({ policy: "required", contract: false });

    const res = p.run(["task", "lock", "P1-T1", "--json"]);
    expect(res.code).toBe(2);
    const err = expectJsonErr(res, "TASK_REVIEW_CONTRACT_REQUIRED");
    expect(err.data).toMatchObject({
      task_id: "P1-T1",
      review_contract_policy: "required",
    });
    expect(await lockExists(p)).toBe(false);
  });

  it("refuses the start auto-lock and writes no lock and no event", async () => {
    const p = await project({ policy: "required", contract: false });

    const res = p.run(["task", "start", "P1-T1", "--json"]);
    expect(res.code).toBe(2);
    expectJsonErr(res, "TASK_REVIEW_CONTRACT_REQUIRED");
    expect(await lockExists(p)).toBe(false);
    expect(await eventCount(p)).toBe(0);
  });

  it("names the task and the policy in human-readable output", async () => {
    const p = await project({ policy: "required", contract: false });

    const res = p.run(["task", "lock", "P1-T1"]);
    expect(res.code).toBe(2);
    const output = res.stdout + res.stderr;
    expect(output).toContain("P1-T1");
    expect(output).toContain("review_contract_policy: required");
    expect(output).not.toContain("internal error");
  });

  it("refuses an out-of-enum policy instead of falling back to advisory", async () => {
    const p = await project({ policy: "required", contract: false });
    const path = join(p.dir, ".code-pact", "project.yaml");
    const raw = await readFile(path, "utf8");
    await writeFile(
      path,
      raw.replace("review_contract_policy: required", "review_contract_policy: require"),
      "utf8",
    );
    commitAll(p.dir, "typo");

    const res = p.run(["task", "lock", "P1-T1", "--json"]);
    expect(res.code).toBe(2);
    expectJsonErr(res, "CONFIG_ERROR");
    expect(await lockExists(p)).toBe(false);
  });
});

describe("review_contract_policy — required accepts a declared contract", () => {
  it("locks and stores the contract in the lock body", async () => {
    const p = await project({ policy: "required", contract: true });

    expectJsonOk(p.run(["task", "lock", "P1-T1", "--json"]));

    const lock = parseYaml(
      await readFile(
        join(p.dir, ".code-pact", "state", "locks", "P1-T1.yaml"),
        "utf8",
      ),
    ) as { contract: { review_contract?: { mode?: string } } };
    expect(lock.contract.review_contract?.mode).toBe("boundary");
  });

  it("starts through the auto-lock and records the started event", async () => {
    const p = await project({ policy: "required", contract: true });

    expectJsonOk(p.run(["task", "start", "P1-T1", "--json"]));
    expect(await lockExists(p)).toBe(true);
    expect(await eventCount(p)).toBe(1);
  });
});

describe("review_contract_policy — a freshly initialized project", () => {
  it("declares required and can still lock its own sample task", async () => {
    // The self-consistency check: `init` must not ship a sample phase that the
    // policy it just wrote would refuse.
    const p = await createTempProject({
      prefix: "code-pact-review-policy-init-",
      init: [
        "init",
        "--non-interactive",
        "--locale",
        "en-US",
        "--agent",
        "claude-code",
        "--sample-phase",
        "--json",
      ],
    });
    projects.push(p);

    const config = await readFile(
      join(p.dir, ".code-pact", "project.yaml"),
      "utf8",
    );
    expect(config).toContain("review_contract_policy: required");

    git(p.dir, ["init", "--quiet"]);
    commitAll(p.dir, "init");

    const roadmap = parseYaml(
      await readFile(join(p.dir, "design", "roadmap.yaml"), "utf8"),
    ) as { phases: { path: string }[] };
    const phase = parseYaml(
      await readFile(join(p.dir, roadmap.phases[0]!.path), "utf8"),
    ) as { tasks: { id: string }[] };

    expectJsonOk(p.run(["task", "lock", phase.tasks[0]!.id, "--json"]));
  });
});
