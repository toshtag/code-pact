import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";

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
  await writeFile(join(tmpDir, ".code-pact", "state", "progress.yaml"), PROGRESS, "utf8");
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
