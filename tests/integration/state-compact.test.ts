import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";
import { seedDurableEvents } from "../helpers/seed-events.ts";

// event-pack compaction Layer 3 — `state compact --write` is the FIRST CLI path
// that DELETES loose event files. End-to-end through the real built CLI: archive
// the phase (snapshot written, YAML deleted), then `--write` packs the loose
// events into the content-addressed pack AND removes them; dry-run mutates
// nothing; a re-run is idempotent (`already_cleaned`).

let tmpDir: string;

function run(args: string[]): RunResult {
  return cliRun(tmpDir, args);
}
function json(r: RunResult): {
  ok?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string };
} {
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
    status: started
    at: 2026-06-01T00:00:00.000Z
    actor: agent
  - task_id: P1-T1
    status: done
    at: 2026-06-01T01:00:00.000Z
    actor: agent
`;

const EVENTS_DIR = () => join(tmpDir, ".code-pact", "state", "events");
const PACK_PATH = () =>
  join(tmpDir, ".code-pact", "state", "archive", "event-packs", "P1.json");

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};
const looseCount = async (): Promise<number> => {
  try {
    return (await readdir(EVENTS_DIR())).filter((f) => f.endsWith(".yaml")).length;
  } catch {
    return 0;
  }
};

/**
 * Fully-archived P1: snapshot written via the real `phase archive --write`
 * (which deletes the YAML), then the roadmap entry retired so no live phase
 * named P1 remains. Loose P1 events stay on disk — the compaction target.
 */
async function scaffoldArchived(): Promise<void> {
  const init = run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(tmpDir, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
  await seedDurableEvents(tmpDir, PROGRESS);
  expect(run(["phase", "archive", "P1", "--write", "--json"]).code).toBe(0);
  // Retire the now-archived phase from the roadmap (no live YAML, no roadmap ref).
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), "phases: []\n", "utf8");
}

beforeAll(() => ensureCliBuilt(), 60_000);
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-state-compact-int-"));
});
afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("state compact — dry-run (mutates nothing)", () => {
  it("eligible → would_pack; no pack written, loose files untouched", async () => {
    await scaffoldArchived();
    const before = await looseCount();
    expect(before).toBe(2);
    const r = run(["state", "compact", "P1", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r).data?.kind).toBe("would_pack");
    expect(await fileExists(PACK_PATH())).toBe(false); // dry-run wrote nothing
    expect(await looseCount()).toBe(before); // loose untouched
  });
});

describe("state compact --write (Layer 3: deletes loose)", () => {
  it("eligible → cleaned; pack written AND every loose file removed", async () => {
    await scaffoldArchived();
    expect(await looseCount()).toBe(2);
    const r = run(["state", "compact", "P1", "--write", "--json"]);
    expect(r.code).toBe(0);
    const body = json(r);
    expect(body.ok).toBe(true);
    expect(body.data?.kind).toBe("cleaned");
    expect(body.data?.loose_deleted_count).toBe(2);
    expect(body.data?.cleanup_remaining_loose).toBe(0);
    expect(await fileExists(PACK_PATH())).toBe(true); // the pack is the durable record
    expect(await looseCount()).toBe(0); // loose files DELETED
    // Control plane stays green after the destructive compaction.
    expect(json(run(["validate", "--json"])).ok).toBe(true);
  });

  it("idempotent re-run → already_cleaned, exit 0", async () => {
    await scaffoldArchived();
    expect(run(["state", "compact", "P1", "--write", "--json"]).code).toBe(0);
    const again = run(["state", "compact", "P1", "--write", "--json"]);
    expect(again.code).toBe(0);
    expect(json(again).data?.kind).toBe("already_cleaned");
    expect(await looseCount()).toBe(0);
  });
});

describe("state compact — ineligible JSON shape: dry-run (legacy) vs --write (CleanupOutcome)", () => {
  const CLEANUP_FIELDS = [
    "cleanup_pending",
    "partial_applied",
    "cleanup_started",
    "loose_deleted_count",
    "cleanup_remaining_loose",
    "vanished_count",
    "skipped",
    "advisories",
  ] as const;
  const blockKind = (data: Record<string, unknown> | undefined): unknown =>
    (data?.block as Record<string, unknown> | undefined)?.kind;

  // A live phase YAML is still present → ineligible(phase_file_still_present), the same
  // block on BOTH paths — but the JSON data shapes deliberately differ.
  async function scaffoldUnarchived(): Promise<void> {
    const init = run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
    if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
    await writeFile(join(tmpDir, "design", "roadmap.yaml"), ROADMAP, "utf8");
    await writeFile(join(tmpDir, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
    await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
    await seedDurableEvents(tmpDir, PROGRESS);
  }

  it("dry-run ineligible → legacy shape (phase_id + block only, NO cleanup fields)", async () => {
    await scaffoldUnarchived();
    const r = run(["state", "compact", "P1", "--json"]);
    expect(r.code).toBe(2);
    const body = json(r);
    expect(body.error?.code).toBe("STATE_COMPACT_INELIGIBLE");
    expect(body.data?.phase_id).toBe("P1");
    expect(blockKind(body.data)).toBe("phase_file_still_present");
    for (const k of CLEANUP_FIELDS) expect(k in (body.data ?? {})).toBe(false);
  });

  it("--write ineligible → CleanupOutcome shape (full contract fields), fail-closed", async () => {
    await scaffoldUnarchived();
    const r = run(["state", "compact", "P1", "--write", "--json"]);
    expect(r.code).toBe(2);
    const body = json(r);
    expect(body.error?.code).toBe("STATE_COMPACT_INELIGIBLE");
    expect(body.data?.phase_id).toBe("P1");
    expect(blockKind(body.data)).toBe("phase_file_still_present");
    for (const k of CLEANUP_FIELDS) expect(k in (body.data ?? {})).toBe(true);
    // `code` is owned by the envelope's error.code — must not be duplicated in data.
    expect("code" in (body.data ?? {})).toBe(false);
    expect(await fileExists(PACK_PATH())).toBe(false); // fail-closed: nothing written
  });
});
