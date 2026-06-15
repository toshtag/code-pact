import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";
import { seedDurableEvents } from "../helpers/seed-events.ts";
import { buildValidEventPack } from "../helpers/event-pack-fixture.ts";
import { ProgressLog } from "../../src/core/schemas/progress-event.ts";
import { parse as parseYaml } from "yaml";
import { sha256Hex } from "../../src/core/archive/paths.ts";
import { computeMemberIdsSha256 } from "../../src/core/archive/archive-bundle-reader.ts";
import { ARCHIVE_BUNDLE_SCHEMA_VERSION } from "../../src/core/schemas/archive-bundle.ts";

/** Write a Tier-1-VALID bundle file directly (the member bytes may be semantically
 *  invalid for the kind — bundle Tier-1 only checks sha / order / set). */
async function writeRawBundle(dir: string, name: string, kind: string, members: { id: string; bytes: string }[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const full = members
    .map((m) => ({ id: m.id, sha256: sha256Hex(m.bytes), bytes: m.bytes }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await writeFile(
    join(dir, name),
    JSON.stringify({
      schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
      kind,
      member_ids_sha256: computeMemberIdsSha256(full.map((m) => m.id)),
      members: full,
    }),
    "utf8",
  );
}

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

  it("an EXISTING bundle member that is not foldable (Tier-1-invalid event_pack) → build fault in BOTH dry-run and --write; nothing retired/deleted", async () => {
    await scaffoldArchivedSnapshot(); // gives the on-disk snapshot buildValidEventPack needs
    const events = ProgressLog.parse(parseYaml(PROGRESS)).events;
    const pack = await buildValidEventPack(tmpDir, "P1", events);
    // A canonical event_pack with a WRONG event_ids_sha256: bundle Tier-1 passes (sha
    // matches its bytes), but it is NOT foldable (event_pack Tier-1 rejects it).
    const tamperedBytes = JSON.stringify({ ...pack, event_ids_sha256: "0".repeat(64) }, null, 2) + "\n";
    await writeRawBundle(BUNDLES_DIR(), "ep.json", "event_pack", [{ id: "P1", bytes: tamperedBytes }]);

    const dry = run(["state", "compact-archive", "event_pack", "--json"]); // dry-run lies if unfixed
    expect(dry.code).toBe(2);
    expect(json(dry).error?.code).toBe("ARCHIVE_BUNDLE_WRITE_FAILED");
    expect(json(dry).data?.phase).toBe("build");

    const w = run(["state", "compact-archive", "event_pack", "--write", "--json"]);
    expect(w.code).toBe(2);
    expect(json(w).error?.code).toBe("ARCHIVE_BUNDLE_WRITE_FAILED");
    expect(json(w).data?.phase).toBe("build");
    // The bad bundle is untouched — no retire, no consolidated write.
    expect(await fileExists(join(BUNDLES_DIR(), "ep.json"))).toBe(true);
    expect(await bundleCount()).toBe(1); // only the bad one; no consolidated bundle written
  });

  it("a Tier-1-valid but writer-NON-canonical bundle at its OWN content-address path → write_bundle conflict in BOTH dry-run and --write; nothing retired/deleted", async () => {
    await scaffoldArchivedSnapshot(); // canonical loose P1.json — a foldable phase snapshot
    const memberBytes = await readFile(LOOSE_SNAPSHOT(), "utf8");
    // The consolidation for the {P1} set targets exactly this content-addressed filename.
    const name = `phase_snapshot-${computeMemberIdsSha256(["P1"]).slice(0, 16)}.json`;
    // writeRawBundle emits a COMPACT (no-indent) wrapper — Tier-1-valid and the member is
    // foldable, but it is NOT the writer's canonical 2-space+newline serialization. So the
    // build succeeds, then the content-address target already holds DIFFERENT raw bytes →
    // the writer (and now the dry-run) must fail closed at write_bundle, not overwrite it.
    await writeRawBundle(BUNDLES_DIR(), name, "phase_snapshot", [{ id: "P1", bytes: memberBytes }]);
    await rm(LOOSE_SNAPSHOT()); // no loose — the conflict is bundle-only
    const before = await readFile(join(BUNDLES_DIR(), name), "utf8");

    const dry = run(["state", "compact-archive", "phase_snapshot", "--json"]); // dry-run lies if unfixed
    expect(dry.code).toBe(2);
    expect(json(dry).error?.code).toBe("ARCHIVE_BUNDLE_WRITE_FAILED");
    expect(json(dry).data?.phase).toBe("write_bundle");

    const w = run(["state", "compact-archive", "phase_snapshot", "--write", "--json"]);
    expect(w.code).toBe(2);
    expect(json(w).error?.code).toBe("ARCHIVE_BUNDLE_WRITE_FAILED");
    expect(json(w).data?.phase).toBe("write_bundle");

    // The non-canonical bundle is untouched — not retired, not overwritten; no second bundle.
    expect(await readFile(join(BUNDLES_DIR(), name), "utf8")).toBe(before);
    expect(await bundleCount()).toBe(1);
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
