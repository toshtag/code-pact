import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";

// `state archive-retention` CLI surface (dry-run only this layer) through the real built CLI.

let tmpDir: string;
function run(args: string[]): RunResult {
  return cliRun(tmpDir, args);
}
function json(r: RunResult): { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string } } {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return {};
  }
}

beforeAll(() => ensureCliBuilt(), 60_000);
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-retention-int-"));
});
afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

async function init(): Promise<void> {
  const r = run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
  if (r.code !== 0) throw new Error(`init failed: ${r.stdout}${r.stderr}`);
}

describe("state archive-retention — dry-run only", () => {
  it("--json emits { mode: dry_run, keep_latest, retention_plans[] } per kind, mutates nothing", async () => {
    await init();
    const r = run(["state", "archive-retention", "--json"]);
    expect(r.code).toBe(0);
    const body = json(r);
    expect(body.ok).toBe(true);
    expect(body.data?.mode).toBe("dry_run");
    expect(body.data?.keep_latest).toBe(20);
    const plans = body.data?.retention_plans as { kind: string }[];
    expect(plans.map((p) => p.kind).sort()).toEqual(["decision_record", "event_pack", "phase_snapshot"]);
  });

  it("--keep-latest sets the resolved N", async () => {
    await init();
    expect((json(run(["state", "archive-retention", "--keep-latest", "5", "--json"])).data as { keep_latest: number }).keep_latest).toBe(5);
  });

  it("--write under the lock emits { mode: written, results[] } (nothing to drop on a fresh project)", async () => {
    await init();
    const r = run(["state", "archive-retention", "--write", "--json"]);
    expect(r.code).toBe(0);
    const body = json(r);
    expect(body.ok).toBe(true);
    expect(body.data?.mode).toBe("written");
    const results = body.data?.results as { kind: string; deleted: string[] }[];
    expect(results.map((x) => x.kind).sort()).toEqual(["decision_record", "event_pack", "phase_snapshot"]);
    for (const x of results) expect(x.deleted).toEqual([]); // fresh project: nothing unreferenced to drop
  });

  it("--keep-latest 0 → CONFIG_ERROR", async () => {
    await init();
    const r = run(["state", "archive-retention", "--keep-latest", "0", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("CONFIG_ERROR");
  });

  it("an extra positional → CONFIG_ERROR", async () => {
    await init();
    const r = run(["state", "archive-retention", "extra", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("CONFIG_ERROR");
  });
});
