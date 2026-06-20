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

async function projectWithSymlinkedPhaseAlias(prefix: string): Promise<{
  p: Awaited<ReturnType<typeof createTempProject>>;
  p2Path: string;
  p2Before: string;
}> {
  const p = await createTempProject({ prefix });
  cleanups.push(p.cleanup);
  await writeFile(
    join(p.dir, "design", "roadmap.yaml"),
    `phases:
  - id: P1
    path: design/phases/P1.yaml
    weight: 10
  - id: P2
    path: design/phases/P2.yaml
    weight: 10
`,
    "utf8",
  );
  const p2 = `id: P2
name: Aliased target
weight: 10
confidence: medium
risk: low
status: planned
objective: Phase used to prove symlink alias writes are refused
definition_of_done:
  - done
verification:
  commands:
    - "true"
tasks:
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short
    status: planned
    description: aliased task
`;
  const p2Path = join(p.dir, "design", "phases", "P2.yaml");
  await writeFile(p2Path, p2, "utf8");
  await symlink("P2.yaml", join(p.dir, "design", "phases", "P1.yaml"));
  return { p, p2Path, p2Before: await readFile(p2Path, "utf8") };
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

  it("write lock refuses a symlinked lock directory before creating an outside lock", async () => {
    const p = await projectWithTask("code-pact-lock-symlink-");
    const outside = await outsideTree("code-pact-lock-outside-");

    await rm(join(p.dir, ".code-pact", "locks"), { recursive: true, force: true });
    await symlink(outside.dir, join(p.dir, ".code-pact", "locks"));
    const res = p.run([
      "phase",
      "add",
      "--id",
      "P2",
      "--name",
      "Lock symlink",
      "--objective",
      "Refuse lock writes through a symlink",
      "--weight",
      "10",
      "--json",
    ], { CODE_PACT_DISABLE_LOCKS: "" });

    expectConfigRefusal(res);
    expect(await snapshotTree(outside.dir)).toEqual(outside.before);
  });

  it("write lock reports CONFIG_ERROR when the locks path is a file", async () => {
    const p = await projectWithTask("code-pact-lock-file-");
    await rm(join(p.dir, ".code-pact", "locks"), { recursive: true, force: true });
    await writeFile(join(p.dir, ".code-pact", "locks"), "not a directory\n", "utf8");

    const res = p.run([
      "phase",
      "add",
      "--id",
      "P2",
      "--name",
      "Lock file",
      "--objective",
      "Refuse invalid lock path types",
      "--weight",
      "10",
      "--json",
    ], { CODE_PACT_DISABLE_LOCKS: "" });

    expectConfigRefusal(res);
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

  it("init refuses wrong path types before partial initialization", async () => {
    const p = await createTempProject({ init: false, prefix: "code-pact-init-type-preflight-" });
    cleanups.push(p.cleanup);
    await mkdir(join(p.dir, "design"), { recursive: true });
    await writeFile(join(p.dir, "design", "rules"), "not a directory\n", "utf8");

    const res = p.run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);

    expectConfigRefusal(res);
    await expect(readdir(join(p.dir, ".code-pact"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("task add refuses an in-project symlinked phase file and leaves the target phase unchanged", async () => {
    const { p, p2Path, p2Before } = await projectWithSymlinkedPhaseAlias("code-pact-task-add-phase-alias-");

    const res = p.run([
      "task",
      "add",
      "P1",
      "--description",
      "must not be written through a symlink alias",
      "--type",
      "feature",
      "--json",
    ]);

    expectConfigRefusal(res);
    expect(await readFile(p2Path, "utf8")).toBe(p2Before);
  });

  it("task finalize --write refuses an in-project symlinked phase file and leaves the target phase unchanged", async () => {
    const { p, p2Path, p2Before } = await projectWithSymlinkedPhaseAlias("code-pact-task-finalize-phase-alias-");
    await seedDurableEvents(
      p.dir,
      `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`,
    );

    const res = p.run(["task", "finalize", "P1-T1", "--write", "--json"]);

    expect(res.code).toBe(2);
    expect(await readFile(p2Path, "utf8")).toBe(p2Before);
  });

  it("task prepare refuses a profile-derived context_dir symlink and does not write into the target", async () => {
    const p = await projectWithTask("code-pact-context-dir-symlink-");
    await mkdir(join(p.dir, "src"), { recursive: true });
    const before = await snapshotTree(join(p.dir, "src"));

    await rm(join(p.dir, ".context", "claude-code"), { recursive: true, force: true });
    await mkdir(join(p.dir, ".context"), { recursive: true });
    await symlink("../src", join(p.dir, ".context", "claude-code"));
    const res = p.run(["task", "prepare", "P1-T1", "--agent", "claude-code", "--json"]);

    expectConfigRefusal(res);
    expect(await snapshotTree(join(p.dir, "src"))).toEqual(before);
  });

  it("adapter install refuses new generated files through a symlinked owned directory", async () => {
    const p = await createTempProject({ prefix: "code-pact-adapter-new-symlink-" });
    cleanups.push(p.cleanup);
    await mkdir(join(p.dir, "src"), { recursive: true });
    await mkdir(join(p.dir, ".claude"), { recursive: true });
    await symlink("../src", join(p.dir, ".claude", "skills"));
    const before = await snapshotTree(join(p.dir, "src"));

    const res = p.run(["adapter", "install", "claude-code", "--json"]);

    expect(res.code).not.toBe(0);
    expect(await snapshotTree(join(p.dir, "src"))).toEqual(before);
  });

  it("adapter upgrade --check reports CONFIG_ERROR when a desired path is a directory", async () => {
    const p = await createTempProject({ prefix: "code-pact-adapter-check-desired-dir-" });
    cleanups.push(p.cleanup);
    const install = p.run(["adapter", "install", "claude-code", "--json"]);
    expect(install.code).toBe(0);
    await rm(join(p.dir, "CLAUDE.md"), { force: true });
    await mkdir(join(p.dir, "CLAUDE.md"));

    const res = p.run(["adapter", "upgrade", "claude-code", "--check", "--json"]);

    expectConfigRefusal(res);
    expect(res.stderr).not.toContain("internal error");
  });

  it("validate --strict refuses an externally symlinked phase without reading its marker", async () => {
    const p = await projectWithTask("code-pact-validate-phase-external-symlink-");
    const outside = await outsideTree("code-pact-validate-phase-outside-");
    await writeFile(
      join(outside.dir, "phase.yaml"),
      `id: EXTERNAL_MARKER_PHASE
name: External marker phase
weight: 10
confidence: medium
risk: low
status: planned
objective: This external marker must never enter validate output
definition_of_done:
  - done
verification:
  commands:
    - "true"
tasks: []
`,
      "utf8",
    );
    await rm(join(p.dir, "design", "phases", "P1-foundation.yaml"), { force: true });
    await symlink(join(outside.dir, "phase.yaml"), join(p.dir, "design", "phases", "P1-foundation.yaml"));

    const res = p.run(["validate", "--strict", "--json"]);

    expect(res.code).toBe(1);
    expectJsonErr(res, "VALIDATE_FAILED");
    expect(res.stdout).toContain("PATH_OUTSIDE_PROJECT");
    expect(res.stdout).not.toContain("EXTERNAL_MARKER_PHASE");
  });

  it("doctor refuses an external context directory without leaking filenames", async () => {
    const p = await projectWithTask("code-pact-doctor-context-external-symlink-");
    const outside = await outsideTree("code-pact-doctor-context-outside-");
    await writeFile(join(outside.dir, "EXTERNAL-STALE-CONTEXT.md"), "secret context\n", "utf8");
    await rm(join(p.dir, ".context", "claude-code"), { recursive: true, force: true });
    await mkdir(join(p.dir, ".context"), { recursive: true });
    await symlink(outside.dir, join(p.dir, ".context", "claude-code"));

    const res = p.run(["doctor", "--json"]);

    expect(res.code).toBe(1);
    expect(res.stdout).toContain("PATH_OUTSIDE_PROJECT");
    expect(res.stdout).not.toContain("EXTERNAL-STALE-CONTEXT");
  });

  it("doctor refuses an external model-profile directory without listing entries", async () => {
    const p = await createTempProject({ prefix: "code-pact-doctor-model-profiles-external-symlink-" });
    cleanups.push(p.cleanup);
    const outside = await outsideTree("code-pact-doctor-model-profiles-outside-");
    await writeFile(join(outside.dir, "EXTERNAL-MODEL.yaml"), "tier: small\n", "utf8");
    await rm(join(p.dir, ".code-pact", "model-profiles"), { recursive: true, force: true });
    await symlink(outside.dir, join(p.dir, ".code-pact", "model-profiles"));

    const res = p.run(["doctor", "--json"]);

    expect(res.code).toBe(1);
    expect(res.stdout).toContain("PATH_OUTSIDE_PROJECT");
    expect(res.stdout).not.toContain("EXTERNAL-MODEL");
  });

  it("global --help does not read locale from an external project.yaml symlink", async () => {
    const p = await createTempProject({ init: false, prefix: "code-pact-help-locale-external-symlink-" });
    cleanups.push(p.cleanup);
    const outside = await outsideTree("code-pact-help-locale-outside-");
    await writeFile(join(outside.dir, "project.yaml"), "locale: ja-JP\n", "utf8");
    await mkdir(join(p.dir, ".code-pact"), { recursive: true });
    await symlink(join(outside.dir, "project.yaml"), join(p.dir, ".code-pact", "project.yaml"));

    const res = p.run(["--help"], { LANG: "C", CODE_PACT_LOCALE: "" });

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage:");
    expect(res.stdout).not.toContain("使い方");
  });

  it("plan lint does not leak a symlinked-outside protected-paths rule", async () => {
    const p = await projectWithTask("code-pact-protected-paths-external-symlink-");
    const outside = await outsideTree("code-pact-protected-paths-outside-");
    await writeFile(
      join(outside.dir, "protected-paths.md"),
      "OUTSIDE_SECRET_PROTECTED_PATTERN/**\n",
      "utf8",
    );
    await mkdir(join(p.dir, "design", "rules"), { recursive: true });
    await symlink(
      join(outside.dir, "protected-paths.md"),
      join(p.dir, "design", "rules", "protected-paths.md"),
    );
    const phasePath = join(p.dir, "design", "phases", "P1-foundation.yaml");
    const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<string, unknown>;
    doc.tasks = (doc.tasks as Array<Record<string, unknown>>).map((task) => ({
      ...task,
      writes: ["**"],
    }));
    await writeFile(phasePath, stringifyYaml(doc), "utf8");

    const json = p.run(["plan", "lint", "--strict", "--json"]);
    expect(json.code).toBe(1);
    expectJsonErr(json, "PLAN_LINT_FAILED");
    expect(json.stdout).toContain("TASK_WRITES_PROTECTED_PATH");
    expect(`${json.stdout}\n${json.stderr}`).not.toContain("OUTSIDE_SECRET_PROTECTED_PATTERN");

    const human = p.run(["plan", "lint", "--strict"]);
    expect(human.code).toBe(1);
    expect(`${human.stdout}\n${human.stderr}`).toContain("TASK_WRITES_PROTECTED_PATH");
    expect(`${human.stdout}\n${human.stderr}`).not.toContain("OUTSIDE_SECRET_PROTECTED_PATTERN");
  });

  it("adapter doctor and validate report unsafe manifest file symlinks without reading targets", async () => {
    const p = await createTempProject({ prefix: "code-pact-adapter-doctor-manifest-file-symlink-" });
    cleanups.push(p.cleanup);
    const install = p.run(["adapter", "install", "claude-code", "--json"]);
    expect(install.code).toBe(0);

    const outside = await outsideTree("code-pact-adapter-doctor-manifest-file-outside-");
    await writeFile(
      join(outside.dir, "CLAUDE.md"),
      "OUTSIDE_ADAPTER_DOCTOR_SECRET_MARKER\n",
      "utf8",
    );
    await rm(join(p.dir, "CLAUDE.md"), { force: true });
    await symlink(join(outside.dir, "CLAUDE.md"), join(p.dir, "CLAUDE.md"));

    const doctor = p.run(["adapter", "doctor", "--agent", "claude-code", "--json"]);
    expect(doctor.code).toBe(1);
    expect(doctor.stdout).toContain("ADAPTER_FILE_PATH_UNSAFE");
    expect(`${doctor.stdout}\n${doctor.stderr}`).not.toContain("OUTSIDE_ADAPTER_DOCTOR_SECRET_MARKER");

    const validate = p.run(["validate", "--json"]);
    expect(validate.code).toBe(1);
    expect(validate.stdout).toContain("ADAPTER_FILE_PATH_UNSAFE");
    expect(`${validate.stdout}\n${validate.stderr}`).not.toContain("OUTSIDE_ADAPTER_DOCTOR_SECRET_MARKER");
  });

  it("plan lint --strict does not satisfy acceptance_refs through an external symlink", async () => {
    const p = await projectWithTask("code-pact-plan-lint-acceptance-external-symlink-");
    const outside = await outsideTree("code-pact-plan-lint-acceptance-outside-");
    await writeFile(join(outside.dir, "acceptance.md"), "external acceptance marker\n", "utf8");
    await mkdir(join(p.dir, "docs"), { recursive: true });
    await symlink(join(outside.dir, "acceptance.md"), join(p.dir, "docs", "acceptance.md"));
    const phasePath = join(p.dir, "design", "phases", "P1-foundation.yaml");
    const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<string, unknown>;
    doc.tasks = (doc.tasks as Array<Record<string, unknown>>).map((task) => ({
      ...task,
      acceptance_refs: ["docs/acceptance.md"],
    }));
    await writeFile(phasePath, stringifyYaml(doc), "utf8");

    const res = p.run(["plan", "lint", "--strict", "--json"]);

    expect(res.code).toBe(1);
    expectJsonErr(res, "PLAN_LINT_FAILED");
    expect(res.stdout).toContain("TASK_ACCEPTANCE_REF_NOT_FOUND");
    expect(res.stdout).not.toContain("external acceptance marker");
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

  it("phase archive --write refuses an in-project symlinked phases directory", async () => {
    const p = await projectReadyForArchive("code-pact-phase-archive-parent-symlink-");
    const phaseRel = "P1-foundation.yaml";
    const alternate = join(p.dir, "alternate-phases");
    await mkdir(alternate, { recursive: true });
    const realPhase = await readFile(join(p.dir, "design", "phases", phaseRel), "utf8");
    await writeFile(join(alternate, phaseRel), realPhase, "utf8");
    await rm(join(p.dir, "design", "phases"), { recursive: true, force: true });
    await symlink("../alternate-phases", join(p.dir, "design", "phases"));
    const before = await snapshotTree(alternate);

    const res = p.run(["phase", "archive", "P1", "--write", "--json"]);

    expect(res.code).toBe(2);
    expect(await snapshotTree(alternate)).toEqual(before);
    await expect(readdir(join(p.dir, ".code-pact", "state", "archive", "phases"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("decision retire --write refuses an in-project symlinked decisions directory", async () => {
    const p = await createTempProject({ prefix: "code-pact-decision-retire-parent-symlink-" });
    cleanups.push(p.cleanup);
    await mkdir(join(p.dir, "docs"), { recursive: true });
    await writeFile(join(p.dir, "docs", "victim.md"), "# RFC\n\n**Status:** accepted\n\n## Decision\n\nKeep me.\n", "utf8");
    await rm(join(p.dir, "design", "decisions"), { recursive: true, force: true });
    await symlink("../docs", join(p.dir, "design", "decisions"));
    const before = await snapshotTree(join(p.dir, "docs"));

    const res = p.run(["decision", "retire", "design/decisions/victim.md", "--write", "--json"]);

    expect(res.code).toBe(2);
    expect(await snapshotTree(join(p.dir, "docs"))).toEqual(before);
    await expect(readdir(join(p.dir, ".code-pact", "state", "archive", "decisions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("decision prune --write refuses an in-project symlinked decisions directory", async () => {
    const p = await createTempProject({ prefix: "code-pact-decision-prune-parent-symlink-" });
    cleanups.push(p.cleanup);
    await mkdir(join(p.dir, "docs"), { recursive: true });
    await writeFile(join(p.dir, "docs", "victim.md"), "# RFC\n\n**Status:** accepted\n\n## Decision\n\nKeep me.\n", "utf8");
    await rm(join(p.dir, "design", "decisions"), { recursive: true, force: true });
    await symlink("../docs", join(p.dir, "design", "decisions"));
    const before = await snapshotTree(join(p.dir, "docs"));

    const res = p.run(["decision", "prune", "design/decisions/victim.md", "--write", "--json"]);

    expect(res.code).toBe(2);
    expect(await snapshotTree(join(p.dir, "docs"))).toEqual(before);
    await expect(readFile(join(p.dir, "docs", "PRUNED.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
