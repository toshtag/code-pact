import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";

// `state archive-retention` CLI surface (dry-run + destructive `--write`) through the real built CLI.

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

describe("state archive-retention — CLI surface (dry-run + --write)", () => {
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
    const results = body.data?.results as {
      kind: string;
      deleted: string[];
      recovered: { id: string; intent_kind: "loose_pair" | "bundle_pair" }[];
      vanished: string[];
      skipped: unknown[];
    }[];
    expect(results.map((x) => x.kind).sort()).toEqual(["decision_record", "event_pack", "phase_snapshot"]);
    for (const x of results) {
      expect(x.deleted).toEqual([]); // fresh project: nothing unreferenced to drop
      // The CLI envelope carries `recovered` (recovery-completed drops of old truth) — the field is
      // present on every result so a recovery-completed deletion is never reported silently.
      expect(x.recovered).toEqual([]);
    }
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

  it("a CORRUPT delete-intent journal → DELETE_INTENT_RECOVERY_FAILED (journal_status corrupt; guidance is inspect/repair, not blind re-run)", async () => {
    await init();
    await mkdir(join(tmpDir, ".code-pact", "state", "archive"), { recursive: true });
    await writeFile(join(tmpDir, ".code-pact", "state", "archive", "delete-intent.json"), "{ not valid json", "utf8");
    const r = run(["state", "archive-retention", "--write", "--json"]);
    expect(r.code).toBe(2);
    const body = json(r);
    expect(body.error?.code).toBe("DELETE_INTENT_RECOVERY_FAILED");
    expect((body.data as { journal_status?: string }).journal_status).toBe("corrupt");
    // Human must NOT tell the operator to blindly re-run a journal a re-run cannot recover.
    const human = run(["state", "archive-retention", "--write"]).stderr;
    expect(human).toMatch(/inspect\/repair/);
    expect(human).not.toMatch(/re-run .* to complete it/);
  });
});
