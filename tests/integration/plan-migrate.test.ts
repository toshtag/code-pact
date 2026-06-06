import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";

let tmpDir: string;

function run(args: string[]): RunResult {
  return cliRun(tmpDir, args);
}

async function writeProgress(yaml: string): Promise<void> {
  await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
  await writeFile(join(tmpDir, ".code-pact", "state", "progress.yaml"), yaml, "utf8");
}

const PROGRESS = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T10:00:00.000Z"
    actor: agent
  - task_id: P1-T1
    status: done
    at: "2026-05-18T11:00:00.000Z"
    actor: agent
    source: loop
`;

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-plan-migrate-int-"));
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

type MigrateJson = {
  ok: boolean;
  data: {
    dry_run: boolean;
    legacy_events: number;
    written: number;
    already_present: number;
    state_changes: { task_id: string; before: string; after: string }[];
  };
};

describe("plan migrate (B4)", () => {
  it("dry run writes nothing", async () => {
    await writeProgress(PROGRESS);
    const r = run(["plan", "migrate", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as MigrateJson;
    expect(j.data.dry_run).toBe(true);
    expect(j.data.legacy_events).toBe(2);
    expect(j.data.written).toBe(0);
    await expect(readdir(join(tmpDir, ".code-pact", "state", "events"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("--write migrates to event files and is idempotent on re-run", async () => {
    await writeProgress(PROGRESS);
    const first = JSON.parse(run(["plan", "migrate", "--write", "--json"]).stdout) as MigrateJson;
    expect(first.data.written).toBe(2);
    expect(
      (await readdir(join(tmpDir, ".code-pact", "state", "events"))).filter((f) =>
        f.endsWith(".yaml"),
      ).length,
    ).toBe(2);

    const second = JSON.parse(run(["plan", "migrate", "--write", "--json"]).stdout) as MigrateJson;
    expect(second.data.written).toBe(0);
    expect(second.data.already_present).toBe(2);
  });

  it("reports a derived-state change when array order disagrees with `at` order", async () => {
    await writeProgress(`events:
  - task_id: P1-T1
    status: done
    at: "2026-05-18T11:00:00.000Z"
    actor: agent
    source: loop
  - task_id: P1-T1
    status: started
    at: "2026-05-18T10:00:00.000Z"
    actor: agent
`);
    const j = JSON.parse(run(["plan", "migrate", "--json"]).stdout) as MigrateJson;
    expect(j.data.state_changes).toEqual([{ task_id: "P1-T1", before: "started", after: "done" }]);
  });
});
