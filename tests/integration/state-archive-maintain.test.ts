import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";
import { seedDurableEvents } from "../helpers/seed-events.ts";
import { sha256Hex } from "../../src/core/archive/paths.ts";
import { serializeDeleteIntent } from "../../src/core/archive/delete-intent-journal.ts";
import { DELETE_INTENT_SCHEMA_VERSION } from "../../src/core/schemas/delete-intent.ts";
import { deleteBundlePairsJournaled } from "../../src/core/archive/retention-bundle-pair-delete.ts";

// `state archive-maintain` — the high-level operator orchestration over the existing
// archive primitives (RECOVER pending journal → compact → retention → compact-again →
// re-plan → validate → plan lint), end-to-end through the real built CLI. UX/DX-level
// proofs: read-only dry-run, loose-heavy → bundles, honest accounting, honest
// bounded-status (never falsely green), recover-FIRST (no bundle-pair wedge),
// idempotency, determinism across copies, safe design-doc deletion, and the live
// `design/` tree is never touched.

let tmpDir: string;
function run(args: string[], dir = tmpDir): RunResult {
  return cliRun(dir, args);
}
function json(r: RunResult): { ok?: boolean; data?: Record<string, any>; error?: { code?: string } } {
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

function phaseYaml(id: string): string {
  return `id: ${id}
name: Phase ${id}
weight: 2
confidence: high
risk: low
status: done
objective: Build ${id}
definition_of_done:
  - it works
verification:
  commands:
    - "true"
tasks:
  - id: ${id}-T1
    type: feature
${TASK_FIELDS}
    status: done
`;
}
function progressFor(id: string): string {
  return `events:
  - task_id: ${id}-T1
    status: done
    at: 2026-06-01T01:00:00.000Z
    actor: agent
`;
}
function roadmapFor(ids: string[]): string {
  return `phases:\n${ids.map((id) => `  - id: ${id}\n    path: design/phases/${id}-x.yaml\n    weight: 2\n`).join("")}`;
}

const PHASES_DIR = (dir = tmpDir) => join(dir, ".code-pact", "state", "archive", "phases");
const EVENT_PACKS_DIR = (dir = tmpDir) => join(dir, ".code-pact", "state", "archive", "event-packs");
const BUNDLES_DIR = (dir = tmpDir) => join(dir, ".code-pact", "state", "archive", "bundles");
const DESIGN_DIR = (dir = tmpDir) => join(dir, "design");

async function countJson(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function init(dir = tmpDir): Promise<void> {
  const r = run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"], dir);
  if (r.code !== 0) throw new Error(`init failed: ${r.stdout}${r.stderr}`);
}

/** Init + archive each phase to a loose snapshot. The roadmap lists every phase, so the
 *  archived snapshots are REFERENCED (kept by retention) unless the caller empties the
 *  roadmap afterward. */
async function seedArchivedPhases(ids: string[]): Promise<void> {
  await init();
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), roadmapFor(ids), "utf8");
  await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
  // Write ALL phase YAMLs + events first: `phase archive` validates the whole roadmap, so
  // every referenced YAML must exist before the first archive.
  for (const id of ids) {
    await writeFile(join(tmpDir, "design", "phases", `${id}-x.yaml`), phaseYaml(id), "utf8");
    await seedDurableEvents(tmpDir, progressFor(id));
  }
  for (const id of ids) {
    const r = run(["phase", "archive", id, "--write", "--json"]);
    if (r.code !== 0) throw new Error(`archive ${id} failed: ${r.stdout}${r.stderr}`);
  }
}

/** Add ONE new phase to an already-initialized dir (its prior phases already archived) and
 *  archive it — appending to the roadmap, writing the YAML + done event, then `phase archive`.
 *  `priorIds` are the dir's already-archived phases (still roadmap-referenced, resolving from
 *  their snapshots). Used to model a branch archiving its OWN phase on top of a shared base. */
async function addAndArchive(dir: string, priorIds: string[], newId: string): Promise<void> {
  await writeFile(join(dir, "design", "roadmap.yaml"), roadmapFor([...priorIds, newId]), "utf8");
  await writeFile(join(dir, "design", "phases", `${newId}-x.yaml`), phaseYaml(newId), "utf8");
  await seedDurableEvents(dir, progressFor(newId));
  const r = run(["phase", "archive", newId, "--write", "--json"], dir);
  if (r.code !== 0) throw new Error(`archive ${newId} in ${dir} failed: ${r.stdout}${r.stderr}`);
}

/** Drop a set of archived phases from the live reference graph: empty the roadmap of
 *  them and remove their live YAMLs. The snapshots then read as UNREFERENCED. */
async function unreference(keepIds: string[], dropIds: string[]): Promise<void> {
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), roadmapFor(keepIds), "utf8");
  for (const id of dropIds) await rm(join(tmpDir, "design", "phases", `${id}-x.yaml`), { force: true });
}

beforeAll(() => ensureCliBuilt(), 60_000);
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-archive-maintain-int-"));
});
afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("state archive-maintain — dry-run (read-only preview)", () => {
  it("mutates nothing: no bundle written, loose records untouched", async () => {
    await seedArchivedPhases(["P1", "P2"]);
    const looseBefore = await countJson(PHASES_DIR());
    expect(looseBefore).toBe(2);

    const r = run(["state", "archive-maintain", "--json"]);
    expect(r.code).toBe(0);
    expect(await countJson(PHASES_DIR())).toBe(2); // loose untouched
    expect(await countJson(BUNDLES_DIR())).toBe(0); // no bundle written
  });

  it("--json emits mode: dry_run + operator-grade summary + bounded_status fields", async () => {
    await seedArchivedPhases(["P1", "P2"]);
    const body = json(run(["state", "archive-maintain", "--json"]));
    expect(body.ok).toBe(true);
    expect(body.data?.mode).toBe("dry_run");
    const s = body.data!.summary;
    // Operator-grade summary: current counts + planned actions.
    for (const k of ["archive_files", "loose_records", "bundles", "planned_loose_folded", "planned_drop", "planned_compact_skipped"]) {
      expect(s[k]).toBeTypeOf("number");
    }
    expect(s.loose_records).toBe(2);
    expect(s.planned_loose_folded).toBe(2); // both snapshots would fold into a bundle
    const b = body.data!.bounded_status;
    expect(b.bundle_byte_size_bounded).toBe(false);
    expect(b.bundle_byte_size_bound_deferred_to).toBe("sharding");
    expect(b.referenced_truth_retained).toBe(true);
    // Currently NOT file-count-bounded (loose to fold).
    expect(b.file_count_bounded).toBe(false);
  });
});

describe("state archive-maintain --write — compaction + retention", () => {
  it("compacts a loose-heavy archive into bundles; loose folded, bundle written; bounded", async () => {
    await seedArchivedPhases(["P1", "P2", "P3"]);
    expect(await countJson(PHASES_DIR())).toBe(3);

    const r = run(["state", "archive-maintain", "--write", "--json"]);
    expect(r.code).toBe(0);
    const body = json(r);
    expect(body.ok).toBe(true);
    expect(body.data?.mode).toBe("write");
    const s = body.data!.summary;
    expect(s.loose_records_before).toBe(3);
    expect(s.loose_records_after).toBe(0); // all folded
    expect(s.bundles_after).toBeGreaterThanOrEqual(1);
    // `skipped` is the TOTAL across both layers — never just retention (so an inspector reading
    // `skipped === 0` is never misled while a compaction skip lurks).
    expect(s.skipped).toBe(s.compact_skipped + s.retention_skipped);
    expect(await countJson(PHASES_DIR())).toBe(0);
    expect(await countJson(BUNDLES_DIR())).toBe(1); // one phase_snapshot bundle

    // Referenced records → retention drops nothing → bounded.
    const b = body.data!.bounded_status;
    expect(b.file_count_bounded).toBe(true);
    expect(b.unreferenced_old_truth_bounded).toBe(true);
    expect(b.bundle_byte_size_bounded).toBe(false); // ALWAYS false for v2.0.0

    // validate + plan lint stay green after maintenance (run separately — the authoritative gates).
    expect(run(["validate", "--json"]).code).toBe(0);
    expect(run(["plan", "lint", "--include-quality", "--strict", "--json"]).code).toBe(0);
  });

  it("drops unreferenced old truth honestly: deleted bucket populated, others empty, no double-count", async () => {
    // P3 stays referenced (keeps the project valid so the post-checks pass); P1+P2 become
    // unreferenced. keep-latest 1 of the 2 unreferenced → exactly one dropped.
    await seedArchivedPhases(["P1", "P2", "P3"]);
    await unreference(["P3"], ["P1", "P2"]);
    const r = run(["state", "archive-maintain", "--write", "--keep-latest", "1", "--json"]);
    expect(r.code).toBe(0);
    const body = json(r);
    const s = body.data!.summary;
    expect(s.deleted).toBe(1);
    expect(s.bundle_member_removed).toBe(0); // compact-first removed the loose redundancy → no source:both
    expect(s.source_both_follow_up).toBe(0);

    // No id appears in more than one outcome bucket within a kind (the one-bucket invariant).
    const results = body.data!.steps.retention.results as {
      kind: string;
      deleted: string[];
      bundle_member_removed: string[];
      vanished: string[];
      skipped: { id: string }[];
      recovered: { id: string }[];
    }[];
    for (const res of results) {
      const buckets = [res.deleted, res.bundle_member_removed, res.vanished, res.skipped.map((x) => x.id)];
      const all = buckets.flat();
      expect(new Set(all).size).toBe(all.length); // disjoint across buckets
    }
  });

  it("no would_drop record silently disappears: every planned drop lands in a terminal output bucket", async () => {
    await seedArchivedPhases(["P1", "P2", "P3"]);
    await unreference(["P3"], ["P1", "P2"]);
    // What does the planner intend to drop? (dry-run, before any mutation.)
    const dry = json(run(["state", "archive-maintain", "--keep-latest", "1", "--json"]));
    const plannedDrop = new Set(
      (dry.data!.steps.retention.plans as { would_drop: { id: string }[] }[]).flatMap((p) => p.would_drop.map((i) => i.id)),
    );
    expect(plannedDrop.size).toBeGreaterThan(0); // there IS droppable truth to account for

    const w = json(run(["state", "archive-maintain", "--write", "--keep-latest", "1", "--json"]));
    // Collect EVERY id that reached a terminal output bucket across the retention results.
    const accounted = new Set<string>();
    for (const res of w.data!.steps.retention.results as {
      deleted: string[];
      bundle_member_removed: string[];
      vanished: string[];
      skipped: { id: string }[];
      recovered: { id: string }[];
    }[]) {
      for (const id of [
        ...res.deleted,
        ...res.bundle_member_removed,
        ...res.vanished,
        ...res.skipped.map((s) => s.id),
        ...res.recovered.map((x) => x.id),
      ]) {
        accounted.add(id);
      }
    }
    // Every planned drop must appear in some terminal bucket — fail-closed, never a silent drop.
    for (const id of plannedDrop) {
      expect(accounted.has(id), `would_drop id ${id} silently disappeared (in no terminal output bucket)`).toBe(true);
    }
  });

  it("a source:both unreferenced record is resolved in a single run (≤ 2-run convergence); a 2nd run is a clean no-op", async () => {
    // P3 stays referenced (keeps checks green). Fold all into a bundle, then re-materialise a
    // byte-identical loose copy for P1+P2 → source: both. archive-maintain's compact-first deletes
    // the loose redundancy BEFORE retention, so the would_drop record is removed fully in ONE run
    // (no bundle_member_removed / source:both follow-up) — better than standalone retention's 2 runs.
    await seedArchivedPhases(["P1", "P2", "P3"]);
    expect(run(["state", "compact-archive", "phase_snapshot", "--write", "--json"]).code).toBe(0);
    const bundleName = (await readdir(BUNDLES_DIR())).find((n) => n.startsWith("phase_snapshot-"))!;
    const bundle = JSON.parse(await readFile(join(BUNDLES_DIR(), bundleName), "utf8"));
    for (const m of (bundle.members as { id: string; bytes: string }[]).filter((m) => m.id !== "P3")) {
      await writeFile(join(PHASES_DIR(), `${m.id}.json`), m.bytes, "utf8"); // loose ≡ bundle → source: both
    }
    await unreference(["P3"], ["P1", "P2"]);

    const r = run(["state", "archive-maintain", "--write", "--keep-latest", "1", "--json"]);
    expect(r.code).toBe(0);
    const s = json(r).data!.summary;
    expect(s.source_both_follow_up).toBe(0); // compact-first deleted the loose copy → no 2-run follow-up
    expect(s.bundle_member_removed).toBe(0);
    expect(s.deleted).toBe(1); // older dropped fully this run

    // Converged: a 2nd run drops nothing new (idempotent on the bounded tail).
    const r2 = run(["state", "archive-maintain", "--write", "--keep-latest", "1", "--json"]);
    expect(json(r2).data!.summary.deleted).toBe(0);
  });
});

/** Make a committed-but-incomplete LOOSE pair delete-intent journal for `phaseId`: a loose
 *  phase_snapshot ↔ loose event_pack pair whose files are still present (a crash between the
 *  journal commit and the unlinks). Returns once the journal + both loose members are on disk. */
async function seedPendingLoosePairJournal(phaseId: string): Promise<void> {
  await rm(join(tmpDir, "design", "phases", `${phaseId}-x.yaml`), { force: true });
  expect(run(["state", "compact", phaseId, "--write", "--json"]).code).toBe(0); // loose event pack
  const phaseSha = sha256Hex(await readFile(join(PHASES_DIR(), `${phaseId}.json`), "utf8"));
  const packSha = sha256Hex(await readFile(join(EVENT_PACKS_DIR(), `${phaseId}.json`), "utf8"));
  const journal = serializeDeleteIntent({
    schema_version: DELETE_INTENT_SCHEMA_VERSION,
    intents: [{ intent_kind: "loose_pair", phase_id: phaseId, phase_sha256: phaseSha, pack_sha256: packSha }],
  });
  await writeFile(join(tmpDir, ".code-pact", "state", "archive", "delete-intent.json"), journal, "utf8");
}

describe("state archive-maintain — honest bounded-status (never falsely green)", () => {
  it("a pending delete-intent journal makes the dry-run report NOT bounded (a half-settled store is never falsely green)", async () => {
    await seedArchivedPhases(["P1", "P2"]);
    await seedPendingLoosePairJournal("P1");

    const body = json(run(["state", "archive-maintain", "--json"])); // dry-run, read-only
    expect(body.data?.mode).toBe("dry_run");
    // Operator-grade journal status (not just a boolean): status + the pending intent kinds + count.
    const journal = body.data!.steps.journal;
    expect(journal.pending_before).toBe(true);
    expect(journal.status).toBe("present");
    expect(journal.intent_kinds).toEqual(["loose_pair"]);
    expect(journal.count).toBe(1);
    const b = body.data!.bounded_status;
    expect(b.file_count_bounded).toBe(false); // pending journal → unsettled → never falsely bounded
    expect(b.unreferenced_old_truth_bounded).toBe(false);
    expect(b.bundle_byte_size_bounded).toBe(false);
    // Dry-run mutated nothing — the journal is still pending.
    expect(await fileExists(join(tmpDir, ".code-pact", "state", "archive", "delete-intent.json"))).toBe(true);
  });

  it("a mixed-source pair (bundle snapshot + loose pack) is RESOLVED by compact-first in one run — never falsely deferred as bounded", async () => {
    // The scenario the bounded guarantee hinges on: a would-drop phase whose snapshot lives in a
    // bundle but whose event_pack is still loose (a mid-refresh artifact). archive-maintain's
    // compact-first folds the loose pack into a bundle, making the pair UNIFORM, so retention
    // removes it as a clean bundle pair THIS run — it is never left deferred while the status
    // claims bounded.
    await seedArchivedPhases(["P1", "P2", "P3"]); // P3 referenced (keeps checks green)
    expect(run(["state", "compact", "P1", "--write", "--json"]).code).toBe(0); // loose event pack P1
    expect(run(["state", "compact", "P2", "--write", "--json"]).code).toBe(0); // loose event pack P2
    // Fold ONLY the phase snapshots → P1/P2 snapshots are bundle-backed, their packs stay loose → MIXED.
    expect(run(["state", "compact-archive", "phase_snapshot", "--write", "--json"]).code).toBe(0);
    expect(await countJson(PHASES_DIR())).toBe(0); // snapshots folded
    expect(await countJson(EVENT_PACKS_DIR())).toBe(2); // packs still loose → mixed-source pairs
    await unreference(["P3"], ["P1", "P2"]);

    const body = json(run(["state", "archive-maintain", "--write", "--keep-latest", "1", "--json"]));
    expect(body.data?.mode).toBe("write");
    const s = body.data!.summary;
    expect(s.mixed_source_deferred).toBe(0); // compact-first made the pair uniform → NOT deferred
    expect(s.deleted).toBeGreaterThanOrEqual(1); // the dropped pair (snapshot + pack) was really removed
    // Honest bounded status: the dropped record is gone, nothing droppable remains for it.
    expect(body.data!.bounded_status.unreferenced_old_truth_bounded).toBe(true);
    expect(body.data!.bounded_status.file_count_bounded).toBe(true);
  });

  it("final output explicitly says bundle byte-size is NOT solved (sharding deferred), in JSON and human", async () => {
    await seedArchivedPhases(["P1"]);
    const body = json(run(["state", "archive-maintain", "--write", "--json"]));
    expect(body.data!.bounded_status.bundle_byte_size_bounded).toBe(false);
    expect(body.data!.bounded_status.bundle_byte_size_bound_deferred_to).toBe("sharding");
    const human = run(["state", "archive-maintain", "--write"]).stdout;
    expect(human).toMatch(/bundle byte size: not bounded yet; sharding deferred/);
  });
});

describe("state archive-maintain — pending delete-intent recovery is surfaced distinctly", () => {
  it("a pending LOOSE-pair journal is recovered and reported in recovered_loose_pairs (distinct from bundle pairs)", async () => {
    // P2 stays referenced (keeps the project valid after recovery). P1 becomes a pending loose pair.
    await seedArchivedPhases(["P1", "P2"]);
    await seedPendingLoosePairJournal("P1");
    await unreference(["P2"], ["P1"]); // P1 no longer referenced — recovery completes its drop cleanly
    expect(await fileExists(join(PHASES_DIR(), "P1.json"))).toBe(true);
    expect(await fileExists(join(EVENT_PACKS_DIR(), "P1.json"))).toBe(true);

    const r = run(["state", "archive-maintain", "--write", "--json"]);
    const body = json(r);
    expect(body.ok).toBe(true);
    const s = body.data!.summary;
    expect(s.recovered_loose_pairs).toBe(1);
    expect(s.recovered_bundle_pairs).toBe(0); // distinct field — never flattened
    expect(body.data!.steps.journal.recovered).toContainEqual({ id: "P1", intent_kind: "loose_pair" });
    // EXACT accounting: `recovered` carries each completed pair ONCE — no duplicate (id, intent_kind).
    const recoveredKeys = (body.data!.steps.journal.recovered as { id: string; intent_kind: string }[]).map((x) => `${x.intent_kind}:${x.id}`);
    expect(new Set(recoveredKeys).size).toBe(recoveredKeys.length);
    expect(body.data!.steps.journal.recovered).toEqual([{ id: "P1", intent_kind: "loose_pair" }]);
    // The journal completed: both loose files are gone, and the journal is cleared.
    expect(await fileExists(join(PHASES_DIR(), "P1.json"))).toBe(false);
    expect(await fileExists(join(EVENT_PACKS_DIR(), "P1.json"))).toBe(false);
    expect(await fileExists(join(tmpDir, ".code-pact", "state", "archive", "delete-intent.json"))).toBe(false);
    // DECISIVE: a recovered loose pair is "old truth FULLY gone" — P1 must NOT have been folded
    // into a bundle by the compact-before-retention step. (Compaction is reader-aware of the
    // pending delete-intent ids, so it skips P1; recovery then unlinks the loose copies. Without
    // that filter, compact-before-recovery would resurrect P1 into a bundle — this asserts it does not.)
    for (const name of await readdir(BUNDLES_DIR())) {
      const bundle = JSON.parse(await readFile(join(BUNDLES_DIR(), name), "utf8"));
      expect((bundle.members as { id: string }[]).map((m) => m.id)).not.toContain("P1");
    }
    expect(r.code).toBe(0); // P2 still referenced + archive bounded → validate/plan-lint green & exit 0
  });

  it("a pending BUNDLE-pair journal is recovered FIRST (before compaction) — no wedge; the loose survivor is deferred, not double-counted; exit code follows bounded status", async () => {
    // The regression guard for the recover-BEFORE-compact ordering. A crashed bundle-pair removal
    // leaves a journal whose SURVIVOR bundle compaction would retire as "superseded"; if compaction
    // ran first, recovery could NEVER find the survivor again — a permanent wedge
    // (DELETE_INTENT_RECOVERY_FAILED). archive-maintain recovers first, so it heals cleanly.
    await seedArchivedPhases(["P1", "P2", "P3"]); // P3 referenced (keeps validate green); P1,P2 unreferenced
    for (const id of ["P1", "P2", "P3"]) expect(run(["state", "compact", id, "--write", "--json"]).code).toBe(0);
    expect(run(["state", "compact-archive", "--write", "--json"]).code).toBe(0); // all → bundles (both kinds)
    // Re-materialise P1's loose snapshot + pack (byte-identical) → P1 is `source: both`, so the
    // bundle-pair removal leaves a LOOSE survivor (the ≤2-run convergence case).
    for (const [dir, kind] of [[PHASES_DIR(), "phase_snapshot"], [EVENT_PACKS_DIR(), "event_pack"]] as const) {
      const bn = (await readdir(BUNDLES_DIR())).find((n) => n.startsWith(`${kind}-`))!;
      const bundle = JSON.parse(await readFile(join(BUNDLES_DIR(), bn), "utf8"));
      const m = (bundle.members as { id: string; bytes: string }[]).find((x) => x.id === "P1")!;
      await writeFile(join(dir, "P1.json"), m.bytes, "utf8");
    }
    await unreference(["P3"], ["P1", "P2"]);

    // Crash a bundle-pair removal of P1 AFTER the journal commit, BEFORE the retire → a pending
    // journal + the mid-state (old {P1,P2,P3} + reduced {P2,P3} survivor bundles coexist).
    await expect(
      deleteBundlePairsJournaled(tmpDir, [{ phase_id: "P1" }], { beforeRetire: () => { throw new Error("simulated crash after commit"); } }),
    ).rejects.toThrow();
    expect(await fileExists(join(tmpDir, ".code-pact", "state", "archive", "delete-intent.json"))).toBe(true);

    const r = run(["state", "archive-maintain", "--write", "--keep-latest", "1", "--json"]);
    const body = json(r);
    expect(body.ok).toBe(true); // NOT DELETE_INTENT_RECOVERY_FAILED — recovered first, no wedge
    const s = body.data!.summary;
    expect(s.recovered_bundle_pairs).toBe(1); // the bundle pair was completed by recovery
    expect(s.recovered_loose_pairs).toBe(0); // distinct field
    expect(await fileExists(join(tmpDir, ".code-pact", "state", "archive", "delete-intent.json"))).toBe(false); // cleared

    // The recovered bundle pair's id (P1) is NEVER `deleted` the same run — it is `recovered`
    // (one bucket per run); its loose survivor is dropped by a subsequent run.
    for (const res of body.data!.steps.retention.results as { deleted: string[] }[]) {
      expect(res.deleted).not.toContain("P1");
    }
    // Exit code FOLLOWS the v2.0 bounded status (file-count + unreferenced), with validate green:
    // 0 when bounded, 1 when a deferred record leaves it not-yet-bounded. (Which of the two
    // unreferenced records keep-latest drops is timing-dependent, so assert the INVARIANT, not a
    // fixed outcome — the byte-size NON-goal never affects the exit.)
    const b = body.data!.bounded_status;
    expect(b.bundle_byte_size_bounded).toBe(false);
    expect(run(["validate", "--json"]).code).toBe(0); // validate is green → exit reflects bounded status alone
    const v2Bounded = b.file_count_bounded && b.unreferenced_old_truth_bounded;
    expect(r.code).toBe(v2Bounded ? 0 : 1);

    // Converges to bounded within one more run (exit 0).
    const r2 = run(["state", "archive-maintain", "--write", "--keep-latest", "1", "--json"]);
    const b2 = json(r2).data!.bounded_status;
    expect(b2.file_count_bounded && b2.unreferenced_old_truth_bounded).toBe(true);
    expect(r2.code).toBe(0);
  });

  it("the low-level `state compact-archive --write` REFUSES under a pending delete-intent journal (no wedge); archive-maintain still recovers", async () => {
    // The public low-level verb must not be a back door to the same wedge: compaction would retire a
    // crashed bundle-pair's reduced SURVIVOR bundle as superseded, after which even archive-maintain
    // could never recover. So `compact-archive --write` REFUSES; only the high-level verb recovers.
    await seedArchivedPhases(["P1", "P2"]);
    for (const id of ["P1", "P2"]) expect(run(["state", "compact", id, "--write", "--json"]).code).toBe(0);
    expect(run(["state", "compact-archive", "--write", "--json"]).code).toBe(0); // P1,P2 → bundles
    await expect(
      deleteBundlePairsJournaled(tmpDir, [{ phase_id: "P1" }], { beforeRetire: () => { throw new Error("crash"); } }),
    ).rejects.toThrow();
    const journalPath = join(tmpDir, ".code-pact", "state", "archive", "delete-intent.json");
    expect(await fileExists(journalPath)).toBe(true);
    const bundlesBefore = (await readdir(BUNDLES_DIR())).sort();

    // The read-only DRY-RUN surfaces that `--write` would refuse (so the operator isn't surprised).
    const dry = json(run(["state", "compact-archive", "--json"]));
    expect((dry.data!.journal as { status: string; write_will_refuse: boolean }).status).toBe("present");
    expect((dry.data!.journal as { write_will_refuse: boolean }).write_will_refuse).toBe(true);

    // REFUSE — exit 2 PENDING_DELETE_INTENT, and the survivor bundle + journal are UNTOUCHED.
    const refused = run(["state", "compact-archive", "--write", "--json"]);
    expect(refused.code).toBe(2);
    expect(json(refused).error?.code).toBe("PENDING_DELETE_INTENT");
    expect(await fileExists(journalPath)).toBe(true);
    expect((await readdir(BUNDLES_DIR())).sort()).toEqual(bundlesBefore); // nothing retired/folded

    // archive-maintain CAN still recover — the wedge was never created.
    const am = json(run(["state", "archive-maintain", "--write", "--json"]));
    expect(am.ok).toBe(true);
    expect(am.data!.summary.recovered_bundle_pairs).toBe(1);
    expect(await fileExists(journalPath)).toBe(false);
  });

  it("`state compact-archive --write` distinguishes a CORRUPT journal (DELETE_INTENT_RECOVERY_FAILED, not PENDING_DELETE_INTENT) — it cannot be auto-recovered", async () => {
    await seedArchivedPhases(["P1"]);
    // A corrupt delete-intent journal: `archive-maintain` CANNOT auto-recover it, so the low-level
    // verb must NOT tell the operator to "run archive-maintain to recover" — it surfaces the
    // recovery-failed code + journal_status so the next action (inspect/repair) is honest.
    await writeFile(join(tmpDir, ".code-pact", "state", "archive", "delete-intent.json"), "{ not valid json", "utf8");
    const r = run(["state", "compact-archive", "--write", "--json"]);
    expect(r.code).toBe(2);
    const body = json(r);
    expect(body.error?.code).toBe("DELETE_INTENT_RECOVERY_FAILED");
    expect((body.data as { journal_status?: string }).journal_status).toBe("corrupt");
  });

  it("`state archive-maintain --write` on a CORRUPT journal fails honestly (journal_status corrupt; guidance is inspect/repair, NOT blind re-run)", async () => {
    await seedArchivedPhases(["P1"]);
    await writeFile(join(tmpDir, ".code-pact", "state", "archive", "delete-intent.json"), "{ not valid json", "utf8");
    // JSON: the high-level verb surfaces the SAME honesty as the low-level one — a corrupt journal
    // is DELETE_INTENT_RECOVERY_FAILED with journal_status corrupt, and partial_applied false (it
    // throws from readDeleteIntent before any mutation).
    const jr = run(["state", "archive-maintain", "--write", "--json"]);
    expect(jr.code).toBe(2);
    const jbody = json(jr);
    expect(jbody.error?.code).toBe("DELETE_INTENT_RECOVERY_FAILED");
    const data = jbody.data as { journal_status?: string; step?: string; partial_applied?: boolean };
    expect(data.journal_status).toBe("corrupt");
    expect(data.step).toBe("journal_recovery");
    expect(data.partial_applied).toBe(false);
    // Human: must NOT tell the operator to "re-run to complete" a journal a re-run cannot recover.
    const human = run(["state", "archive-maintain", "--write"]).stderr;
    expect(human).toMatch(/inspect\/repair/);
    expect(human).not.toMatch(/re-run .* to complete it/);
  });
});

describe("state archive-maintain — idempotency, determinism + cross-branch merge convergence", () => {
  it("repeated --write runs are idempotent (no new bundle, nothing re-dropped)", async () => {
    await seedArchivedPhases(["P1", "P2"]);
    expect(run(["state", "archive-maintain", "--write", "--json"]).code).toBe(0);
    const bundlesAfter1 = await readdir(BUNDLES_DIR());
    const r2 = json(run(["state", "archive-maintain", "--write", "--json"]));
    expect(r2.data!.summary.deleted).toBe(0);
    expect(r2.data!.summary.loose_records_after).toBe(0);
    expect(await readdir(BUNDLES_DIR())).toEqual(bundlesAfter1); // no new/changed bundle
  });

  it("the SAME archived fixture in two copied worktrees produces byte-identical bundle filenames + bytes", async () => {
    await seedArchivedPhases(["P1", "P2"]);
    // Two independent copies of the same archived (pre-compaction) fixture.
    const a = await mkdtemp(join(tmpdir(), "code-pact-am-detA-"));
    const b = await mkdtemp(join(tmpdir(), "code-pact-am-detB-"));
    try {
      await cp(tmpDir, a, { recursive: true });
      await cp(tmpDir, b, { recursive: true });
      expect(run(["state", "archive-maintain", "--write", "--json"], a).code).toBe(0);
      expect(run(["state", "archive-maintain", "--write", "--json"], b).code).toBe(0);

      const namesA = (await readdir(BUNDLES_DIR(a))).sort();
      const namesB = (await readdir(BUNDLES_DIR(b))).sort();
      expect(namesA).toEqual(namesB); // content-addressed bundle filenames are identical
      expect(namesA.length).toBeGreaterThanOrEqual(1);
      for (const name of namesA) {
        const bytesA = await readFile(join(BUNDLES_DIR(a), name), "utf8");
        const bytesB = await readFile(join(BUNDLES_DIR(b), name), "utf8");
        expect(bytesA).toBe(bytesB); // byte-identical bundle contents (no timestamps/pids/paths)
      }
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it("two branches that archive DIFFERENT phases produce non-colliding bundles; the merge re-converges to one bundle (no conflict on differing records)", async () => {
    // The provable multi-contributor claim: DIFFERENT records on independent branches fold to
    // DIFFERENT-named (content-addressed) bundles, so a merge adds both files with no conflict,
    // and a follow-up archive-maintain re-consolidates them. The SHARED record (P1) is archived in
    // the BASE before the branch copy, so its snapshot bytes are byte-identical on both branches
    // (two branches archiving the same phase INDEPENDENTLY would instead conflict on
    // snapshotted_at — the documented, NOT-claimed-conflict-free case; see cli-contract.md).
    const a = await mkdtemp(join(tmpdir(), "code-pact-am-brA-"));
    const b = await mkdtemp(join(tmpdir(), "code-pact-am-brB-"));
    try {
      // Base: P1 archived ONCE (shared, byte-identical), then copied to both branches.
      await seedArchivedPhases(["P1"]); // tmpDir is the base
      await cp(tmpDir, a, { recursive: true });
      await cp(tmpDir, b, { recursive: true });
      // Each branch adds + archives its OWN unique phase on top of the shared base.
      await addAndArchive(a, ["P1"], "P2");
      await addAndArchive(b, ["P1"], "P3");
      expect(run(["state", "archive-maintain", "--write", "--json"], a).code).toBe(0);
      expect(run(["state", "archive-maintain", "--write", "--json"], b).code).toBe(0);

      const nameA = (await readdir(BUNDLES_DIR(a))).find((n) => n.startsWith("phase_snapshot-"))!;
      const nameB = (await readdir(BUNDLES_DIR(b))).find((n) => n.startsWith("phase_snapshot-"))!;
      expect(nameA).not.toBe(nameB); // {P1,P2} vs {P1,P3} → different content addresses → no filename collision

      // Simulate the git merge of the two archive trees + roadmaps into A: union the roadmap, and
      // add B's bundle file. The two bundles have different names, so a real merge adds BOTH (no
      // conflict); the shared P1 member is byte-identical in both, so even its bytes never conflict.
      await writeFile(join(a, "design", "roadmap.yaml"), roadmapFor(["P1", "P2", "P3"]), "utf8");
      await cp(join(BUNDLES_DIR(b), nameB), join(BUNDLES_DIR(a), nameB));
      expect((await readdir(BUNDLES_DIR(a))).filter((n) => n.startsWith("phase_snapshot-")).length).toBe(2);

      // Re-converge: archive-maintain consolidates the two bundles into one ({P1,P2,P3}).
      const merged = json(run(["state", "archive-maintain", "--write", "--json"], a));
      expect(merged.ok).toBe(true);
      expect((await readdir(BUNDLES_DIR(a))).filter((n) => n.startsWith("phase_snapshot-")).length).toBe(1);
      expect(merged.data!.bounded_status.file_count_bounded).toBe(true);
      const consolidated = (await readdir(BUNDLES_DIR(a))).find((n) => n.startsWith("phase_snapshot-"))!;
      const bundle = JSON.parse(await readFile(join(BUNDLES_DIR(a), consolidated), "utf8"));
      expect((bundle.members as { id: string }[]).map((m) => m.id).sort()).toEqual(["P1", "P2", "P3"]);
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });
});

describe("state archive-maintain — design-doc safety (never touches live design/)", () => {
  it("does not mutate any live design/ doc", async () => {
    await seedArchivedPhases(["P1", "P2"]);
    const snapshot = async (): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      const walk = async (rel: string): Promise<void> => {
        const abs = join(DESIGN_DIR(), rel);
        for (const e of await readdir(abs, { withFileTypes: true })) {
          const childRel = join(rel, e.name);
          if (e.isDirectory()) await walk(childRel);
          else out[childRel] = await readFile(join(DESIGN_DIR(), childRel), "utf8");
        }
      };
      await walk(".");
      return out;
    };
    const before = await snapshot();
    expect(run(["state", "archive-maintain", "--write", "--json"]).code).toBe(0);
    expect(await snapshot()).toEqual(before); // every design/ file byte-identical
  });

  it("safely-removed (archived) design docs stay green: validate + plan lint pass after maintenance", async () => {
    await seedArchivedPhases(["P1"]);
    // The live phase YAML was archived; remove it (safe AFTER archive — the snapshot is the
    // durable record). The roadmap still references P1, which resolves from the archive.
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml"), { force: true });
    expect(run(["validate", "--json"]).code).toBe(0); // safe-delete is green before maintenance

    expect(run(["state", "archive-maintain", "--write", "--json"]).code).toBe(0);
    // Archive maintenance did not resurrect the deleted YAML, and gates stay green.
    expect(await fileExists(join(tmpDir, "design", "phases", "P1-x.yaml"))).toBe(false);
    expect(run(["validate", "--json"]).code).toBe(0);
    expect(run(["plan", "lint", "--include-quality", "--strict", "--json"]).code).toBe(0);
  });
});

describe("state archive-maintain — arg handling", () => {
  it("a positional argument → CONFIG_ERROR (exit 2)", async () => {
    await init();
    const r = run(["state", "archive-maintain", "extra", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("CONFIG_ERROR");
  });

  it("--keep-latest 0 → CONFIG_ERROR (exit 2)", async () => {
    await init();
    const r = run(["state", "archive-maintain", "--keep-latest", "0", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("CONFIG_ERROR");
  });
});
