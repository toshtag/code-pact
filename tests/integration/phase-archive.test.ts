import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";
import { seedDurableEvents } from "../helpers/seed-events.ts";

// design-docs-ephemeral step 7 PR-B1 — `phase archive --write`, the first
// destructive verb. End-to-end via the real CLI: dry-run is lock-free and writes
// nothing; `--write` writes the phase snapshot then deletes the YAML in
// least-harmful order (readback verify + stale guard between), and the archived
// phase stays resolvable (A2). Refuses fail-closed on every unsafe path.

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
  - id: P2
    path: design/phases/P2-y.yaml
    weight: 1
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
const P1_IN_PROGRESS = P1_DONE.replace("status: done\nobjective", "status: in_progress\nobjective");
const P2_DEP = `id: P2
name: Next
weight: 1
confidence: high
risk: low
status: in_progress
objective: Build the next increment of work
definition_of_done:
  - The next increment is implemented and its tests pass
verification:
  commands:
    - "true"
tasks:
  - id: P2-T1
    type: feature
${TASK_FIELDS}
    status: in_progress
    depends_on:
      - P1-T1
`;
const PROGRESS = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
  - task_id: P2-T1
    status: started
    at: 2026-06-02T00:00:00.000Z
    actor: agent
`;

async function scaffold(opts: { p1?: string } = {}): Promise<void> {
  const init = run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(tmpDir, "design", "phases", "P1-x.yaml"), opts.p1 ?? P1_DONE, "utf8");
  await writeFile(join(tmpDir, "design", "phases", "P2-y.yaml"), P2_DEP, "utf8");
  await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
  await seedDurableEvents(tmpDir, PROGRESS);
}

const P1_YAML = () => join(tmpDir, "design", "phases", "P1-x.yaml");
const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

beforeAll(() => ensureCliBuilt(), 60_000);
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-phase-archive-int-"));
});
afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("phase archive — dry-run", () => {
  it("eligible → would_archive, snapshot NOT written, YAML still present", async () => {
    await scaffold();
    const r = run(["phase", "archive", "P1", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r).data?.kind).toBe("would_archive");
    expect(await fileExists(P1_YAML())).toBe(true);
    expect(await fileExists(join(tmpDir, ".code-pact", "state", "archive", "phases", "P1.json"))).toBe(false);
  });

  it("ineligible (phase in_progress) → PHASE_ARCHIVE_INELIGIBLE, nothing written", async () => {
    await scaffold({ p1: P1_IN_PROGRESS });
    const r = run(["phase", "archive", "P1", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("PHASE_ARCHIVE_INELIGIBLE");
    expect(await fileExists(P1_YAML())).toBe(true);
  });

  it("final-component symlink → NOT would_archive (PHASE_ARCHIVE_STALE)", async () => {
    await scaffold();
    const realTarget = join(tmpDir, "design", "phases", "real-P1.yaml");
    await writeFile(realTarget, P1_DONE, "utf8");
    await rm(P1_YAML());
    await symlink(realTarget, P1_YAML());
    const r = run(["phase", "archive", "P1", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("PHASE_ARCHIVE_STALE");
  });
});

describe("phase archive --write", () => {
  it("happy path → snapshot written, YAML deleted; archived phase stays resolvable (A2)", async () => {
    await scaffold();
    const r = run(["phase", "archive", "P1", "--write", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r).data?.kind).toBe("archived");
    expect(await fileExists(P1_YAML())).toBe(false);
    expect(await fileExists(join(tmpDir, ".code-pact", "state", "archive", "phases", "P1.json"))).toBe(true);
    // A2: control plane stays green; the dependent task still resolves its dep.
    expect(json(run(["validate", "--json"])).ok).toBe(true);
    expect(json(run(["plan", "lint", "--strict", "--json"])).ok).toBe(true);
    const prep = run(["task", "prepare", "P2-T1", "--agent", "claude-code", "--json"]);
    expect(prep.stdout).not.toContain("wait_for_dependencies");
  });

  it("idempotent re-run → already_archived, exit 0, no error", async () => {
    await scaffold();
    expect(run(["phase", "archive", "P1", "--write", "--json"]).code).toBe(0);
    const again = run(["phase", "archive", "P1", "--write", "--json"]);
    expect(again.code).toBe(0);
    expect(json(again).data?.kind).toBe("already_archived");
  });

  it("missing YAML + NO snapshot → PHASE_ARCHIVE_NOT_ARCHIVED (fail-closed, not already_archived)", async () => {
    await scaffold();
    await rm(P1_YAML()); // delete by hand, never archived → no snapshot
    const r = run(["phase", "archive", "P1", "--write", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("PHASE_ARCHIVE_NOT_ARCHIVED");
  });

  it("dangling final symlink + valid snapshot → STALE, not already_archived; symlink remains", async () => {
    await scaffold();
    // First archive legitimately so a valid snapshot exists.
    expect(run(["phase", "archive", "P1", "--write", "--json"]).code).toBe(0);
    // Now the YAML is gone; recreate it as a DANGLING symlink at the same path.
    await symlink(join(tmpDir, "design", "phases", "does-not-exist.yaml"), P1_YAML());
    const r = run(["phase", "archive", "P1", "--write", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("PHASE_ARCHIVE_STALE");
    // The symlink entry itself is untouched (lstat still sees it).
    const lst = await import("node:fs/promises").then((m) => m.lstat(P1_YAML()));
    expect(lst.isSymbolicLink()).toBe(true);
  });

  it("dangling ANCESTOR symlink + valid snapshot → STALE, NOT already_archived (fail-closed)", async () => {
    // Codex finding: a dangling ANCESTOR symlink (design/phases -> /nonexistent)
    // makes the lexical lstat ENOENT, which must NOT read as a true-absent
    // "already archived" phase. Archive legitimately first so a valid snapshot
    // exists, then replace the phases dir with a dangling symlink.
    await scaffold();
    expect(run(["phase", "archive", "P1", "--write", "--json"]).code).toBe(0);
    await rm(join(tmpDir, "design", "phases"), { recursive: true, force: true });
    await symlink(join(tmpDir, "design", "no-such-dir"), join(tmpDir, "design", "phases"));
    const r = run(["phase", "archive", "P1", "--write", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("PHASE_ARCHIVE_STALE");
    // A TRUE absent (real dir, YAML gone) still resolves as already_archived.
    await rm(join(tmpDir, "design", "phases"));
    await mkdir(join(tmpDir, "design", "phases"), { recursive: true });
    const ok = run(["phase", "archive", "P1", "--write", "--json"]);
    expect(ok.code).toBe(0);
    expect(json(ok).data?.kind).toBe("already_archived");
  });

  it("dangling FINAL symlink + NO snapshot → STALE (not NOT_ARCHIVED — it's an unsafe path, not a missing-archive)", async () => {
    await scaffold();
    await rm(P1_YAML()); // YAML gone, never archived → no snapshot
    await symlink(join(tmpDir, "design", "phases", "does-not-exist.yaml"), P1_YAML());
    const r = run(["phase", "archive", "P1", "--write", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("PHASE_ARCHIVE_STALE");
  });

  it("DRY-RUN dangling final symlink + valid snapshot → STALE (not would_already_archived; lstat-first parity with --write)", async () => {
    await scaffold();
    expect(run(["phase", "archive", "P1", "--write", "--json"]).code).toBe(0); // valid snapshot now exists
    await symlink(join(tmpDir, "design", "phases", "does-not-exist.yaml"), P1_YAML());
    const r = run(["phase", "archive", "P1", "--json"]); // dry-run
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("PHASE_ARCHIVE_STALE");
  });

  it("final-component symlink to a regular file → refuse before unlink; neither file deleted", async () => {
    await scaffold();
    const realTarget = join(tmpDir, "design", "phases", "real-P1.yaml");
    await writeFile(realTarget, P1_DONE, "utf8");
    await rm(P1_YAML());
    await symlink(realTarget, P1_YAML());
    const r = run(["phase", "archive", "P1", "--write", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("PHASE_ARCHIVE_STALE");
    expect(await fileExists(realTarget)).toBe(true); // target untouched
  });

  it("lock contention → LOCK_HELD exit 2", async () => {
    await scaffold();
    await mkdir(join(tmpDir, ".code-pact", "locks"), { recursive: true });
    await writeFile(
      join(tmpDir, ".code-pact", "locks", "write.lock"),
      JSON.stringify({ pid: 999999, hostname: "other", cmd: "x", created_at: "2026-06-01T00:00:00.000Z" }),
      { flag: "wx" },
    );
    // The suite sets CODE_PACT_DISABLE_LOCKS=1 (tests/setup.ts); clear it for THIS
    // subprocess so the real lock is acquired and the held lock is observed.
    const r = cliRun(tmpDir, ["phase", "archive", "P1", "--write", "--json"], {
      env: { CODE_PACT_DISABLE_LOCKS: "" },
    });
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("LOCK_HELD");
  });

  it("check:docs-relevant: no dangling docs after archive (phases aren't .md)", async () => {
    await scaffold();
    expect(run(["phase", "archive", "P1", "--write", "--json"]).code).toBe(0);
    // The roadmap ref is KEPT (no roadmap edit) and still lists P1.
    const roadmap = await readFile(join(tmpDir, "design", "roadmap.yaml"), "utf8");
    expect(roadmap).toContain("id: P1");
  });
});

// Regression: archiving one phase must NOT break archiving the NEXT one. The snapshot
// producer reads every roadmap-listed sibling phase (to run its duplicate-task-id and
// active-dependant scans); it must tolerate a sibling whose YAML was already archived
// away (resolve it from its snapshot), not crash with ENOENT on the gone file. Before
// the fix, the FIRST archive succeeded but every SUBSEQUENT archive died — which would
// have blocked the dogfood durable-truth migration after a single phase.
describe("phase archive — an archived sibling does not break later archives (ENOENT regression)", () => {
  const ROADMAP_AB = `phases:
  - id: PA
    path: design/phases/PA.yaml
    weight: 1
  - id: PB
    path: design/phases/PB.yaml
    weight: 1
`;
  const donePhase = (id: string): string => `id: ${id}
name: ${id}
weight: 1
confidence: high
risk: low
status: done
objective: Build the ${id} increment
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
  const PROGRESS_AB = `events:
  - task_id: PA-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
  - task_id: PB-T1
    status: done
    at: 2026-06-01T01:00:00.000Z
    actor: agent
`;
  async function scaffoldAB(): Promise<void> {
    const init = run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
    await writeFile(join(tmpDir, "design", "roadmap.yaml"), ROADMAP_AB, "utf8");
    await writeFile(join(tmpDir, "design", "phases", "PA.yaml"), donePhase("PA"), "utf8");
    await writeFile(join(tmpDir, "design", "phases", "PB.yaml"), donePhase("PB"), "utf8");
    await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
    await seedDurableEvents(tmpDir, PROGRESS_AB);
  }

  it("archive PA, then PB still archives (no internal ENOENT on the gone PA YAML)", async () => {
    await scaffoldAB();
    expect(run(["phase", "archive", "PA", "--write", "--json"]).code).toBe(0);
    expect(await fileExists(join(tmpDir, "design", "phases", "PA.yaml"))).toBe(false); // PA gone
    // PB dry-run must succeed — before the fix this exited non-zero with an internal
    // ENOENT on design/phases/PA.yaml while building the sibling scans.
    const dry = run(["phase", "archive", "PB", "--json"]);
    expect(dry.code).toBe(0);
    expect(json(dry).data?.kind).toBe("would_archive");
    // And PB actually archives.
    const wr = run(["phase", "archive", "PB", "--write", "--json"]);
    expect(wr.code).toBe(0);
    expect(json(wr).data?.kind).toBe("archived");
    expect(await fileExists(join(tmpDir, "design", "phases", "PB.yaml"))).toBe(false);
    // Control plane green with BOTH phases archived (resolved from snapshots).
    expect(json(run(["validate", "--json"])).ok).toBe(true);
  });

  it("a live target task-id that collides with an ARCHIVED sibling → duplicate_task_id, fail-closed", async () => {
    await scaffoldAB();
    // Archive PA cleanly (PA-T1 vs PB-T1 — no collision at this point).
    expect(run(["phase", "archive", "PA", "--write", "--json"]).code).toBe(0);
    // Now give PB a SECOND task whose id collides with archived PA's task (PA-T1).
    await writeFile(
      join(tmpDir, "design", "phases", "PB.yaml"),
      donePhase("PB") + `  - id: PA-T1\n    type: feature\n${TASK_FIELDS}\n    status: done\n`,
      "utf8",
    );
    // Archiving PB must be REFUSED: the duplicate-task-id scan sees PB's live PA-T1 AND
    // archived PA's PA-T1 (resolved from its snapshot), so the graph is ambiguous — a
    // snapshot must never be minted from it. This pins the fix's central safety claim:
    // an archived sibling's task-ids still participate in the collision scan.
    const r = run(["phase", "archive", "PB", "--json"]);
    expect(r.code).toBe(2);
    const body = json(r);
    expect(body.error?.code).toBe("PHASE_ARCHIVE_INELIGIBLE");
    const blocks = (body.data?.blocks ?? []) as { kind: string; task_id?: string }[];
    expect(blocks.some((b) => b.kind === "duplicate_task_id" && b.task_id === "PA-T1")).toBe(true);
    // Fail-closed: nothing written for PB.
    expect(await fileExists(join(tmpDir, ".code-pact", "state", "archive", "phases", "PB.json"))).toBe(false);
  });

  it("a sibling YAML missing with NO snapshot → fail-closed (not tolerated), nothing mutated", async () => {
    await scaffoldAB();
    // Delete PA's YAML BY HAND without archiving — there is no snapshot for it.
    await rm(join(tmpDir, "design", "phases", "PA.yaml"));
    // Archiving PB must fail closed: the sibling scan hits PA's missing YAML and
    // resolveMissingPhaseRef finds no valid snapshot, so it does NOT tolerate — a
    // genuinely-broken sibling ref is never silently skipped.
    const r = run(["phase", "archive", "PB", "--json"]);
    expect(r.code).not.toBe(0);
    // Nothing mutated: PB stays live, no PB snapshot written.
    expect(await fileExists(join(tmpDir, "design", "phases", "PB.yaml"))).toBe(true);
    expect(await fileExists(join(tmpDir, ".code-pact", "state", "archive", "phases", "PB.json"))).toBe(false);
  });
});
