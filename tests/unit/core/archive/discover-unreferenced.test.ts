import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Step 4b discovery. The directory-level EACCES case uses an fs mock (NOT chmod —
// deterministic, OS-independent), scoped to the archive phases dir; all other
// reads use the real impl (temp dirs).
const fail = { readdir: false };

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn((...args: Parameters<typeof actual.readdir>) => {
      if (fail.readdir && /archive[\\/]phases/.test(String(args[0]))) {
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      }
      return (actual.readdir as (...a: unknown[]) => unknown)(...(args as unknown[]));
    }),
  };
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverUnreferencedSnapshots,
  resolveUnreferencedSnapshot,
  loadPhaseSnapshot,
} from "../../../../src/core/archive/load-phase-snapshot.ts";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";
import { archivePhasesDir, phaseSnapshotPath } from "../../../../src/core/archive/paths.ts";

const NOW = new Date("2026-06-10T00:00:00.000Z");
const TF = `    ambiguity: low
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
name: F
weight: 2
confidence: high
risk: low
status: done
objective: Build the base layer
definition_of_done:
  - it works
verification:
  commands:
    - pnpm test
tasks:
  - id: P1-T1
    type: feature
${TF}
    status: done
`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-discover-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  fail.readdir = false;
  vi.restoreAllMocks();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Write a valid P1 snapshot to the archive dir (P1 phase exists, gets snapshotted). */
async function writeP1Snapshot(): Promise<void> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await seedDurableEvents(
    cwd,
    `events:\n  - task_id: P1-T1\n    status: done\n    at: 2026-06-01T00:00:00.000Z\n    actor: agent\n`,
  );
  const o = await writePhaseSnapshot(cwd, "P1", { now: NOW });
  expect(o.kind).toBe("written");
}

describe("discoverUnreferencedSnapshots", () => {
  it("absent archive dir (ENOENT) → empty, NO advisory", async () => {
    const r = await discoverUnreferencedSnapshots(cwd, new Set());
    expect(r).toEqual({ entries: [], invalid: [] });
  });

  it("a genuinely unreferenced valid snapshot → its task ids are loaded", async () => {
    await writeP1Snapshot();
    // P1 is NOT in liveRoadmapPhaseIds (simulating its ref removed) → discovered.
    const r = await discoverUnreferencedSnapshots(cwd, new Set());
    expect(r.invalid).toEqual([]);
    expect(r.entries.map((e) => e.task_id)).toEqual(["P1-T1"]);
  });

  it("EXCLUDES a snapshot whose phase_id is a live roadmap phase id (4a's case)", async () => {
    await writeP1Snapshot();
    const r = await discoverUnreferencedSnapshots(cwd, new Set(["P1"]));
    expect(r.entries).toEqual([]);
    expect(r.invalid).toEqual([]);
  });

  it("a corrupt file → file-scope invalid, NOT entries, NO throw", async () => {
    await mkdir(archivePhasesDir(cwd), { recursive: true });
    await writeFile(join(archivePhasesDir(cwd), "PX.json"), "{ corrupt", "utf8");
    const r = await discoverUnreferencedSnapshots(cwd, new Set());
    expect(r.entries).toEqual([]);
    expect(r.invalid).toEqual([{ scope: "file", fileStem: "PX", reason: expect.any(String) }]);
  });

  it("an unsafe filename stem → file-scope invalid + skip, NO throw (blocker 2)", async () => {
    await mkdir(archivePhasesDir(cwd), { recursive: true });
    for (const bad of ["bad name.json", "P 1.json", "-leading.json"]) {
      await writeFile(join(archivePhasesDir(cwd), bad), "{}", "utf8");
    }
    const r = await discoverUnreferencedSnapshots(cwd, new Set());
    expect(r.entries).toEqual([]);
    expect(r.invalid.every((i) => i.scope === "file")).toBe(true);
    expect(r.invalid).toHaveLength(3);
  });

  it("ignores non-.json files and is deterministically sorted (blocker 3)", async () => {
    await mkdir(archivePhasesDir(cwd), { recursive: true });
    await writeFile(join(archivePhasesDir(cwd), "notes.txt"), "x", "utf8");
    // two corrupt json files; their invalid[] order must be sorted by name.
    await writeFile(join(archivePhasesDir(cwd), "B.json"), "{bad", "utf8");
    await writeFile(join(archivePhasesDir(cwd), "A.json"), "{bad", "utf8");
    const r = await discoverUnreferencedSnapshots(cwd, new Set());
    const stems = r.invalid.map((i) => (i.scope === "file" ? i.fileStem : "DIR"));
    expect(stems).toEqual(["A", "B"]); // sorted, .txt ignored
  });

  it("archive/phases is a regular FILE → directory-scope invalid, NO throw", async () => {
    // Create a regular file where the dir should be (its parent must exist first).
    await mkdir(join(cwd, ".code-pact", "state", "archive"), { recursive: true });
    await writeFile(archivePhasesDir(cwd), "i am a file", "utf8");
    const r = await discoverUnreferencedSnapshots(cwd, new Set());
    expect(r.entries).toEqual([]);
    expect(r.invalid).toEqual([{ scope: "directory", reason: expect.any(String) }]);
  });

  it("readdir rejects EACCES (mocked) → directory-scope invalid, NO throw", async () => {
    await mkdir(archivePhasesDir(cwd), { recursive: true });
    fail.readdir = true;
    const r = await discoverUnreferencedSnapshots(cwd, new Set());
    expect(r.entries).toEqual([]);
    expect(r.invalid).toEqual([{ scope: "directory", reason: expect.any(String) }]);
  });
});

describe("resolveUnreferencedSnapshot", () => {
  it("tolerated on a valid terminal snapshot whose filename matches its phase_id", async () => {
    await writeP1Snapshot();
    const res = await loadPhaseSnapshot(cwd, "P1");
    expect(resolveUnreferencedSnapshot("P1", res).kind).toBe("tolerated");
  });

  it("fail_invalid when filename stem != body phase_id", async () => {
    await writeP1Snapshot();
    const res = await loadPhaseSnapshot(cwd, "P1");
    // Pretend the file was named PX.json but the body says P1.
    expect(resolveUnreferencedSnapshot("PX", res).kind).toBe("fail_invalid");
  });

  it("fail_invalid when path_sha256 does not cover original_path", async () => {
    await writeP1Snapshot();
    const p = phaseSnapshotPath(cwd, "P1");
    const obj = JSON.parse(await readFile(p, "utf8"));
    obj.path_sha256 = "0".repeat(64);
    await writeFile(p, JSON.stringify(obj), "utf8");
    const res = await loadPhaseSnapshot(cwd, "P1");
    expect(resolveUnreferencedSnapshot("P1", res).kind).toBe("fail_invalid");
  });

  it("fail_invalid on a corrupt/absent load result", async () => {
    expect(resolveUnreferencedSnapshot("P1", { kind: "invalid", error: new Error("x") }).kind).toBe(
      "fail_invalid",
    );
    expect(resolveUnreferencedSnapshot("P1", { kind: "absent" }).kind).toBe("fail_invalid");
  });
});
