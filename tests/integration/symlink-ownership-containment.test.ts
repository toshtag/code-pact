import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createTempProject, ensureCliBuilt, expectJsonErr, type RunResult } from "../helpers/cli.ts";
import { seedDurableEvents } from "../helpers/seed-events.ts";

beforeAll(() => ensureCliBuilt(), 60_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) out[abs.slice(root.length + 1)] = await readFile(abs, "utf8");
    }
  }
  await walk(root);
  return out;
}

function expectConfigRefusal(res: RunResult): void {
  expect(res.code).toBe(2);
  expectJsonErr(res, "CONFIG_ERROR");
}

async function outsideTree(prefix: string): Promise<{ dir: string; before: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "marker.txt"), "OUTSIDE_MARKER\n", "utf8");
  return { dir, before: await snapshotTree(dir) };
}

async function projectWithTask(prefix: string): Promise<Awaited<ReturnType<typeof createTempProject>>> {
  const p = await createTempProject({ prefix });
  cleanups.push(p.cleanup);
  const add = p.run([
    "phase",
    "add",
    "--id",
    "P1",
    "--name",
    "Foundation",
    "--objective",
    "Foundation phase for symlink containment tests",
    "--weight",
    "10",
    "--verify-command",
    "node --version",
    "--json",
  ]);
  expect(add.code).toBe(0);

  const phasePath = join(p.dir, "design", "phases", "P1-foundation.yaml");
  const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<string, unknown>;
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
      description: "symlink containment task",
    },
  ];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");
  return p;
}

async function projectReadyForArchive(prefix: string): Promise<Awaited<ReturnType<typeof createTempProject>>> {
  const p = await projectWithTask(prefix);
  const phasePath = join(p.dir, "design", "phases", "P1-foundation.yaml");
  const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<string, unknown>;
  doc.status = "done";
  doc.tasks = (doc.tasks as Array<Record<string, unknown>>).map((task) => ({ ...task, status: "done" }));
  await writeFile(phasePath, stringifyYaml(doc), "utf8");
  await seedDurableEvents(
    p.dir,
    `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`,
  );
  return p;
}

describe("owned symlink containment", () => {
  it("init refuses a symlinked design namespace before creating project files", async () => {
    const p = await createTempProject({ init: false, prefix: "code-pact-init-design-symlink-" });
    cleanups.push(p.cleanup);
    const outside = await outsideTree("code-pact-init-design-outside-");

    await symlink(outside.dir, join(p.dir, "design"));
    const res = p.run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);

    expectConfigRefusal(res);
    expect(await snapshotTree(outside.dir)).toEqual(outside.before);
    await expect(readdir(join(p.dir, ".code-pact"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("init --force refuses a symlinked .code-pact namespace without touching the target", async () => {
    const p = await createTempProject({ init: false, prefix: "code-pact-init-codepact-symlink-" });
    cleanups.push(p.cleanup);
    const outside = await outsideTree("code-pact-init-codepact-outside-");

    await symlink(outside.dir, join(p.dir, ".code-pact"));
    const res = p.run(["init", "--force", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);

    expectConfigRefusal(res);
    expect(await snapshotTree(outside.dir)).toEqual(outside.before);
    await expect(readdir(join(p.dir, "design"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("task start refuses a symlinked progress events directory", async () => {
    const p = await projectWithTask("code-pact-progress-events-symlink-");
    const outside = await outsideTree("code-pact-progress-events-outside-");

    await rm(join(p.dir, ".code-pact", "state", "events"), { recursive: true, force: true });
    await symlink(outside.dir, join(p.dir, ".code-pact", "state", "events"));
    const res = p.run(["task", "start", "P1-T1", "--agent", "claude-code", "--json"]);

    expectConfigRefusal(res);
    expect(await snapshotTree(outside.dir)).toEqual(outside.before);
  });

  it("task status refuses a symlinked legacy progress.yaml instead of reading it", async () => {
    const p = await projectWithTask("code-pact-progress-yaml-symlink-");
    const outside = await outsideTree("code-pact-progress-yaml-outside-");
    await writeFile(
      join(outside.dir, "progress.yaml"),
      `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`,
      "utf8",
    );
    const before = await snapshotTree(outside.dir);

    await rm(join(p.dir, ".code-pact", "state", "progress.yaml"), { force: true });
    await symlink(join(outside.dir, "progress.yaml"), join(p.dir, ".code-pact", "state", "progress.yaml"));
    const res = p.run(["task", "status", "P1-T1", "--json"]);

    expectConfigRefusal(res);
    expect(await snapshotTree(outside.dir)).toEqual(before);
  });

  it("plan normalize --write refuses an in-project symlinked design namespace", async () => {
    const p = await createTempProject({ prefix: "code-pact-design-in-project-symlink-" });
    cleanups.push(p.cleanup);
    await mkdir(join(p.dir, ".github", "workflows"), { recursive: true });
    await writeFile(join(p.dir, ".github", "workflows", "brief.md"), "workflow marker  \n", "utf8");
    const before = await snapshotTree(join(p.dir, ".github"));

    await rm(join(p.dir, "design"), { recursive: true, force: true });
    await symlink(".github/workflows", join(p.dir, "design"));
    const res = p.run(["plan", "normalize", "--write", "--json"]);

    expectConfigRefusal(res);
    expect(await snapshotTree(join(p.dir, ".github"))).toEqual(before);
  });

  it("phase archive --write refuses a symlinked archive root before deleting live design", async () => {
    const p = await projectReadyForArchive("code-pact-archive-root-symlink-");
    const outside = await outsideTree("code-pact-archive-root-outside-");
    const phasePath = join(p.dir, "design", "phases", "P1-foundation.yaml");
    const phaseBefore = await readFile(phasePath, "utf8");

    await rm(join(p.dir, ".code-pact", "state", "archive"), { recursive: true, force: true });
    await symlink(outside.dir, join(p.dir, ".code-pact", "state", "archive"));
    const res = p.run(["phase", "archive", "P1", "--write", "--json"]);

    expectConfigRefusal(res);
    expect(await snapshotTree(outside.dir)).toEqual(outside.before);
    expect(await readFile(phasePath, "utf8")).toBe(phaseBefore);
  });
});
