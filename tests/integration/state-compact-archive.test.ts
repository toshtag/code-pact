import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";
import { seedDurableEvents } from "../helpers/seed-events.ts";
import { buildValidEventPack } from "../helpers/event-pack-fixture.ts";
import { ProgressLog } from "../../src/core/schemas/progress-event.ts";
import { parse as parseYaml } from "yaml";

// Layer 4 entry — `state compact-archive` folds loose archive records into bundles and
// deletes the verified loose copies, end-to-end through the real built CLI. Dry-run
// mutates nothing; --write reduces the loose file count; a re-run is a clean noop.

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

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;
const ROADMAP = `phases:
  - id: P1
    path: design/phases/P1-x.yaml
    weight: 2
`;
const P1_DONE = `id: P1
name: Foundations
weight: 2
confidence: high
risk: low
status: done
objective: Build the base
definition_of_done:
  - it works
verification:
  commands:
    - "true"
tasks:
  - id: P1-T1
    type: feature
${TASK_FIELDS}
    status: done
`;
const PROGRESS = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T01:00:00.000Z
    actor: agent
`;

const LOOSE_SNAPSHOT = () => join(tmpDir, ".code-pact", "state", "archive", "phases", "P1.json");
const BUNDLES_DIR = () => join(tmpDir, ".code-pact", "state", "archive", "bundles");

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};
const bundleCount = async (): Promise<number> => {
  try {
    return (await readdir(BUNDLES_DIR())).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
};

/** Fully-archived P1: a loose phase snapshot on disk (the compaction target). */
async function scaffoldArchivedSnapshot(): Promise<void> {
  const init = run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(tmpDir, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
  await seedDurableEvents(tmpDir, PROGRESS);
  expect(run(["phase", "archive", "P1", "--write", "--json"]).code).toBe(0);
}

beforeAll(() => ensureCliBuilt(), 60_000);
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-compact-archive-int-"));
});
afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("state compact-archive — dry-run (mutates nothing)", () => {
  it("reports would_bundle for the loose snapshot; writes no bundle, deletes nothing", async () => {
    await scaffoldArchivedSnapshot();
    expect(await fileExists(LOOSE_SNAPSHOT())).toBe(true);
    const r = run(["state", "compact-archive", "--json"]);
    expect(r.code).toBe(0);
    const plans = json(r).data?.plans as { kind: string; would_bundle: string[]; would_delete: string[] }[];
    const snap = plans.find((p) => p.kind === "phase_snapshot")!;
    expect(snap.would_bundle).toContain("P1");
    expect(await bundleCount()).toBe(0); // dry-run wrote nothing
    expect(await fileExists(LOOSE_SNAPSHOT())).toBe(true); // loose untouched
  });
});

describe("state compact-archive --write (folds + deletes)", () => {
  it("bundles the loose snapshot AND removes it; truth still resolves; re-run is a clean noop", async () => {
    await scaffoldArchivedSnapshot();
    const r = run(["state", "compact-archive", "--write", "--json"]);
    expect(r.code).toBe(0);
    const body = json(r);
    expect(body.ok).toBe(true);
    const results = body.data?.results as { kind: string; deleted: string[] }[];
    expect(results.find((x) => x.kind === "phase_snapshot")!.deleted).toContain("P1");
    expect(await fileExists(LOOSE_SNAPSHOT())).toBe(false); // loose deleted
    expect(await bundleCount()).toBe(1); // one bundle holds it

    // validate still passes — the bundled snapshot resolves the archived phase.
    expect(run(["validate", "--json"]).code).toBe(0);

    // Re-run: nothing loose left → clean noop.
    const r2 = run(["state", "compact-archive", "--write", "--json"]);
    expect(r2.code).toBe(0);
    const results2 = (json(r2).data?.results as { kind: string; deleted: string[] }[]) ?? [];
    for (const x of results2) expect(x.deleted).toEqual([]);
    expect(await bundleCount()).toBe(1); // no duplicate bundle grown
  });
});

describe("state compact-archive — arg handling", () => {
  it("an unknown kind → CONFIG_ERROR (exit 2)", async () => {
    await scaffoldArchivedSnapshot();
    const r = run(["state", "compact-archive", "not_a_kind", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("CONFIG_ERROR");
  });

  it("restricting to one kind only plans/acts on that kind", async () => {
    await scaffoldArchivedSnapshot();
    const r = run(["state", "compact-archive", "decision_record", "--json"]);
    expect(r.code).toBe(0);
    const plans = json(r).data?.plans as { kind: string }[];
    expect(plans.map((p) => p.kind)).toEqual(["decision_record"]);
  });

  it("a corrupt bundle store → ARCHIVE_BUNDLE_INVALID (exit 2), fail-closed", async () => {
    await scaffoldArchivedSnapshot();
    await mkdir(BUNDLES_DIR(), { recursive: true });
    await writeFile(join(BUNDLES_DIR(), "bad.json"), "{ not json", "utf8");
    const r = run(["state", "compact-archive", "--write", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("ARCHIVE_BUNDLE_INVALID");
    expect(await fileExists(LOOSE_SNAPSHOT())).toBe(true); // nothing deleted
  });

  it("extra positional → CONFIG_ERROR (exit 2)", async () => {
    await scaffoldArchivedSnapshot();
    const r = run(["state", "compact-archive", "phase_snapshot", "garbage", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("CONFIG_ERROR");
  });
});

describe("state compact-archive — build-fault surfacing (P1.1/P1.2)", () => {
  it("a non-canonical loose record → ARCHIVE_BUNDLE_WRITE_FAILED (not ARCHIVE_BUNDLE_INVALID); nothing folded/deleted", async () => {
    await scaffoldArchivedSnapshot();
    // Rewrite the loose snapshot non-canonically (compact JSON ≠ the writer's 2-space form):
    // schema-valid + right phase_id, but bindBundleMember's canonical check fails at build.
    const canonical = await readFile(LOOSE_SNAPSHOT(), "utf8");
    await writeFile(LOOSE_SNAPSHOT(), JSON.stringify(JSON.parse(canonical)), "utf8");
    const r = run(["state", "compact-archive", "phase_snapshot", "--write", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("ARCHIVE_BUNDLE_WRITE_FAILED"); // build fault, NOT a corrupt store
    expect(await fileExists(LOOSE_SNAPSHOT())).toBe(true); // not deleted
    expect(await bundleCount()).toBe(0); // no bad bundle written
  });

  it("dry-run also fails on a non-canonical loose record (no would_bundle lie)", async () => {
    await scaffoldArchivedSnapshot();
    const canonical = await readFile(LOOSE_SNAPSHOT(), "utf8");
    await writeFile(LOOSE_SNAPSHOT(), JSON.stringify(JSON.parse(canonical)), "utf8");
    const r = run(["state", "compact-archive", "phase_snapshot", "--json"]); // dry-run
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("ARCHIVE_BUNDLE_WRITE_FAILED");
  });
});

describe("state compact-archive — partial multi-kind failure is reported, not hidden (P1.3)", () => {
  it("an earlier kind applies, a later kind fails → error envelope carries completed_results + failed_kind + partial_applied", async () => {
    await scaffoldArchivedSnapshot();
    // A non-canonical loose EVENT PACK for P1 (valid pack, compacted bytes): event_pack
    // build fails, but phase_snapshot (processed first) already folded + deleted.
    const events = ProgressLog.parse(parseYaml(PROGRESS)).events;
    const pack = await buildValidEventPack(tmpDir, "P1", events);
    await mkdir(join(tmpDir, ".code-pact", "state", "archive", "event-packs"), { recursive: true });
    await writeFile(
      join(tmpDir, ".code-pact", "state", "archive", "event-packs", "P1.json"),
      JSON.stringify(pack), // compact (non-canonical) → fails the canonical bind at build
      "utf8",
    );
    const r = run(["state", "compact-archive", "--write", "--json"]);
    expect(r.code).toBe(2);
    const body = json(r);
    expect(body.error?.code).toBe("ARCHIVE_BUNDLE_WRITE_FAILED");
    // failed_kind / completed_results / partial_applied live in the top-level envelope data.
    const ed = body.data!;
    expect(ed.failed_kind).toBe("event_pack");
    expect(ed.partial_applied).toBe(true);
    const completed = ed.completed_results as { kind: string; deleted: string[] }[];
    expect(completed.find((c) => c.kind === "phase_snapshot")!.deleted).toContain("P1");
    // The earlier kind's mutation really happened (loose snapshot gone).
    expect(await fileExists(LOOSE_SNAPSHOT())).toBe(false);
  });
});
