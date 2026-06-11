import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock ONLY the reader-contract resolver so we can exercise the post-write
// readback-verify branch (writer succeeds, reader refuses).
const readback = {
  override: null as null | { kind: "fail_invalid"; reason: string } | { kind: "fail_missing" },
  // When set, the tolerated snapshot's source_sha256 is replaced — to drive the
  // snapshot_unverified branch (readback ok but sha != the live YAML bytes).
  forceSourceSha: null as string | null,
};
vi.mock("../../../src/core/archive/load-phase-snapshot.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/core/archive/load-phase-snapshot.ts")>();
  return {
    ...actual,
    resolveMissingPhaseRef: vi.fn(async (cwd: string, ref: { id: string; path: string }) => {
      if (readback.override) return readback.override;
      const res = await actual.resolveMissingPhaseRef(cwd, ref);
      if (readback.forceSourceSha && res.kind === "tolerated") {
        return { kind: "tolerated", snapshot: { ...res.snapshot, source_sha256: readback.forceSourceSha } };
      }
      return res;
    }),
  };
});

// Mock the WRITER module only to run an `afterWrite` hook between the real
// snapshot write and the pre-delete stale guard — so a test can mutate the YAML
// in that window (the race the guard exists to catch) deterministically.
const writeHook = { afterWrite: null as null | (() => Promise<void>) };
vi.mock("../../../src/core/archive/phase-snapshot.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/core/archive/phase-snapshot.ts")>();
  return {
    ...actual,
    writePhaseSnapshot: vi.fn(async (...args: Parameters<typeof actual.writePhaseSnapshot>) => {
      const out = await actual.writePhaseSnapshot(...args);
      if (writeHook.afterWrite) await writeHook.afterWrite();
      return out;
    }),
  };
});

import { runPhaseArchive } from "../../../src/commands/phase-archive.ts";

const NOW = new Date("2026-06-10T00:00:00.000Z");

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
const phaseYaml = (status: "done" | "cancelled", taskStatus: "done" | "cancelled") => `id: P1
name: F
weight: 2
confidence: high
risk: low
status: ${status}
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
    status: ${taskStatus}
`;
const PROGRESS = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`;

let cwd: string;
const P1_PATH = () => join(cwd, "design", "phases", "P1-x.yaml");
const SNAP = () => join(cwd, ".code-pact", "state", "archive", "phases", "P1.json");
const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

async function scaffold(status: "done" | "cancelled" = "done", taskStatus: "done" | "cancelled" = "done") {
  cwd = await mkdtemp(join(tmpdir(), "phase-archive-unit-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(P1_PATH(), phaseYaml(status, taskStatus), "utf8");
  // A cancelled task carries no progress event (cancellation is recorded by the
  // snapshot's design_status evidence, not the ledger); a done task with a done
  // event would otherwise trip the `cancelled_task_with_done_event` gate.
  const progress = taskStatus === "cancelled" ? "events: []\n" : PROGRESS;
  await writeFile(join(cwd, ".code-pact", "state", "progress.yaml"), progress, "utf8");
}

beforeEach(() => {
  readback.override = null;
  readback.forceSourceSha = null;
  writeHook.afterWrite = null;
});
afterEach(async () => {
  readback.override = null;
  readback.forceSourceSha = null;
  writeHook.afterWrite = null;
  vi.clearAllMocks();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("runPhaseArchive — readback verify (the writer is not trusted)", () => {
  it("writer succeeds but readback returns fail_invalid → stale snapshot_unverified, YAML survives", async () => {
    await scaffold();
    readback.override = { kind: "fail_invalid", reason: "corrupt on disk" };
    const res = await runPhaseArchive({ cwd, phaseId: "P1", write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("snapshot_unverified");
    expect(await exists(P1_PATH())).toBe(true); // NOT deleted
  });

  it("writer succeeds but readback returns fail_missing → stale snapshot_unverified, YAML survives", async () => {
    await scaffold();
    readback.override = { kind: "fail_missing" };
    const res = await runPhaseArchive({ cwd, phaseId: "P1", write: true, now: NOW });
    expect(res.kind).toBe("stale");
    expect(await exists(P1_PATH())).toBe(true);
  });
});

describe("runPhaseArchive — stale guard between snapshot write and delete", () => {
  it("source_changed: YAML bytes edited after the write → STALE source_changed, YAML survives", async () => {
    await scaffold();
    writeHook.afterWrite = async () => {
      // Edit the live YAML in the window between snapshot write and the guard.
      await writeFile(P1_PATH(), phaseYaml("done", "done") + "\n# edited\n", "utf8");
    };
    const res = await runPhaseArchive({ cwd, phaseId: "P1", write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("source_changed");
    expect(await exists(P1_PATH())).toBe(true);
  });

  it("identity_changed: same bytes but a different inode (file swap) → STALE identity_changed, YAML survives", async () => {
    await scaffold();
    const original = await readFile(P1_PATH(), "utf8");
    writeHook.afterWrite = async () => {
      // Replace the YAML with a byte-identical file at a NEW inode.
      await rm(P1_PATH());
      await writeFile(P1_PATH(), original, "utf8");
    };
    const res = await runPhaseArchive({ cwd, phaseId: "P1", write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("identity_changed");
    expect(await exists(P1_PATH())).toBe(true);
  });

  it("snapshot_unverified: readback tolerated but source_sha256 != baseline → STALE snapshot_unverified, YAML survives", async () => {
    await scaffold();
    readback.forceSourceSha = "0".repeat(64); // a valid-shaped but wrong hash
    const res = await runPhaseArchive({ cwd, phaseId: "P1", write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("snapshot_unverified");
    expect(await exists(P1_PATH())).toBe(true);
  });
});

describe("runPhaseArchive — happy path & terminal coverage", () => {
  it("done phase → archived: snapshot written, YAML deleted", async () => {
    await scaffold("done", "done");
    const res = await runPhaseArchive({ cwd, phaseId: "P1", write: true, now: NOW });
    expect(res.kind).toBe("archived");
    expect(await exists(P1_PATH())).toBe(false);
    expect(await exists(SNAP())).toBe(true);
  });

  it("cancelled phase (terminal) → archived exactly like done", async () => {
    await scaffold("cancelled", "cancelled");
    const res = await runPhaseArchive({ cwd, phaseId: "P1", write: true, now: NOW });
    expect(res.kind).toBe("archived");
    expect(await exists(P1_PATH())).toBe(false);
    expect(await exists(SNAP())).toBe(true);
  });

  it("dry-run eligible → would_archive, writes nothing", async () => {
    await scaffold();
    const res = await runPhaseArchive({ cwd, phaseId: "P1", write: false, now: NOW });
    expect(res.kind).toBe("would_archive");
    expect(await exists(P1_PATH())).toBe(true);
    expect(await exists(SNAP())).toBe(false);
  });
});

describe("runPhaseArchive — live-absent branch (idempotency, fail-closed)", () => {
  it("already archived (YAML gone, valid snapshot) → already_archived, no writer call", async () => {
    await scaffold();
    expect((await runPhaseArchive({ cwd, phaseId: "P1", write: true, now: NOW })).kind).toBe("archived");
    const again = await runPhaseArchive({ cwd, phaseId: "P1", write: true, now: NOW });
    expect(again.kind).toBe("already_archived");
  });

  it("YAML gone + NO snapshot → not_archived (fail-closed)", async () => {
    await scaffold();
    await rm(P1_PATH()); // hand-deleted, never archived → no snapshot
    const res = await runPhaseArchive({ cwd, phaseId: "P1", write: true, now: NOW });
    expect(res.kind).toBe("not_archived");
  });

  it("YAML gone + INVALID snapshot → not_archived (fail-closed, NOT already_archived)", async () => {
    await scaffold();
    await rm(P1_PATH());
    readback.override = { kind: "fail_invalid", reason: "corrupt / identity-mismatched record" };
    const res = await runPhaseArchive({ cwd, phaseId: "P1", write: true, now: NOW });
    expect(res.kind).toBe("not_archived");
  });
});
