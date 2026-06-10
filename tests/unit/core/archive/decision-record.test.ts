import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyDecisionRecordPlan,
  planDecisionRecord,
  writeDecisionRecord,
} from "../../../../src/core/archive/decision-record.ts";
import { DecisionStateRecord } from "../../../../src/core/schemas/decision-state-record.ts";
import { decisionRecordPath, sha256Hex } from "../../../../src/core/archive/paths.ts";

const NOW = new Date("2026-06-10T00:00:00.000Z");
const REF = "design/decisions/foo-rfc.md";

const ACCEPTED_ADR = `# RFC: Foo

**Status:** accepted (P99, 2026-06)

## Summary

Settled.
`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-decrec-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function writeAdr(content: string, ref = REF): Promise<void> {
  await writeFile(join(cwd, ref), content, "utf8");
}

describe("happy path + classification", () => {
  it("table case 1: no record + live accepted ADR → write; may_satisfy_active_gate true; exact canonical_ref", async () => {
    await writeAdr(ACCEPTED_ADR);
    const outcome = await writeDecisionRecord(cwd, REF, { now: NOW, git_ref: "deadbeef" });
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;

    const onDisk = DecisionStateRecord.parse(JSON.parse(await readFile(outcome.path, "utf8")));
    expect(onDisk.canonical_ref).toBe(REF);
    expect(onDisk.original_path).toBe(REF);
    expect(onDisk.path_sha256).toBe(sha256Hex(REF));
    expect(onDisk.title).toBe("RFC: Foo");
    expect(onDisk.adr_status_at_snapshot).toBe("accepted");
    expect(onDisk.may_satisfy_active_gate).toBe(true);
    expect(onDisk.snapshotted_at).toBe(NOW.toISOString());
    expect(onDisk.source_sha256).toBe(sha256Hex(ACCEPTED_ADR));
    expect(onDisk.git_ref).toBe("deadbeef");
  });

  it("a status-less ADR classifies accepted (the classifier's one lenient case) → may_satisfy true", async () => {
    const body = "# Decision: bare\n\nNo status line.\n";
    await writeAdr(body);
    const outcome = await writeDecisionRecord(cwd, REF, { now: NOW });
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;
    expect(outcome.record.adr_status_at_snapshot).toBe("accepted");
    expect(outcome.record.may_satisfy_active_gate).toBe(true);
  });

  it("a proposed ADR classifies blocked → may_satisfy_active_gate false (a record never releases a gate it could not release live)", async () => {
    await writeAdr(ACCEPTED_ADR.replace("accepted (P99, 2026-06)", "proposed"));
    const outcome = await writeDecisionRecord(cwd, REF, { now: NOW });
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;
    expect(outcome.record.adr_status_at_snapshot).toBe("blocked");
    expect(outcome.record.may_satisfy_active_gate).toBe(false);
  });
});

describe("idempotency / staleness table", () => {
  it("table case 2: same source_sha256 → noop_same_source, record byte-identical", async () => {
    await writeAdr(ACCEPTED_ADR);
    const first = await writeDecisionRecord(cwd, REF, { now: NOW });
    expect(first.kind).toBe("written");
    const bytes = await readFile((first as { path: string }).path, "utf8");

    const second = await writeDecisionRecord(cwd, REF, { now: new Date("2027-01-01T00:00:00Z") });
    expect(second.kind).toBe("noop_same_source");
    expect(await readFile((first as { path: string }).path, "utf8")).toBe(bytes);
  });

  it("table case 3: live file edited after record → ineligible (record_stale) by default", async () => {
    await writeAdr(ACCEPTED_ADR);
    await writeDecisionRecord(cwd, REF, { now: NOW });
    const edited = ACCEPTED_ADR + "\nPostscript.\n";
    await writeAdr(edited);

    const outcome = await writeDecisionRecord(cwd, REF, { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks).toContainEqual({
      kind: "record_stale",
      existing_source_sha256: sha256Hex(ACCEPTED_ADR),
      current_source_sha256: sha256Hex(edited),
    });
  });

  it("table case 4: explicit refresh with both hashes matching → rewrite; wrong hash → mismatch", async () => {
    await writeAdr(ACCEPTED_ADR);
    await writeDecisionRecord(cwd, REF, { now: NOW });
    const edited = ACCEPTED_ADR + "\nPostscript.\n";
    await writeAdr(edited);

    const wrong = await writeDecisionRecord(cwd, REF, {
      now: NOW,
      refresh: {
        expected_old_source_sha256: sha256Hex("wrong"),
        expected_new_source_sha256: sha256Hex(edited),
      },
    });
    expect(wrong.kind).toBe("ineligible");

    const ok = await writeDecisionRecord(cwd, REF, {
      now: NOW,
      refresh: {
        expected_old_source_sha256: sha256Hex(ACCEPTED_ADR),
        expected_new_source_sha256: sha256Hex(edited),
      },
    });
    expect(ok.kind).toBe("written");
    if (ok.kind !== "written") return;
    expect(ok.record.source_sha256).toBe(sha256Hex(edited));
  });

  it("table case 5: live file missing + record exists → noop_record_authoritative, never regenerated", async () => {
    await writeAdr(ACCEPTED_ADR);
    const first = await writeDecisionRecord(cwd, REF, { now: NOW });
    expect(first.kind).toBe("written");
    const bytes = await readFile((first as { path: string }).path, "utf8");

    await rm(join(cwd, REF));
    const outcome = await writeDecisionRecord(cwd, REF, {
      now: NOW,
      refresh: {
        expected_old_source_sha256: sha256Hex(ACCEPTED_ADR),
        expected_new_source_sha256: sha256Hex("anything"),
      },
    });
    expect(outcome.kind).toBe("noop_record_authoritative");
    expect(await readFile((first as { path: string }).path, "utf8")).toBe(bytes);
  });

  it("table case 6: live file missing + record missing → ineligible (live_file_missing)", async () => {
    const outcome = await writeDecisionRecord(cwd, REF, { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks).toEqual([{ kind: "live_file_missing", canonical_ref: REF }]);
  });
});

describe("same-source re-validation — the on-disk record must still match the live .md", () => {
  // In every case the .md content (hence source_sha256) is identical to what the
  // record claims; the drift is in the record BODY. A matching source_sha256
  // must NOT short-circuit the comparison.

  async function plantRecord(ref: string, overrides: Record<string, unknown>) {
    const content = await readFile(join(cwd, ref), "utf8");
    const base = {
      schema_version: 1,
      canonical_ref: ref,
      original_path: ref,
      path_sha256: sha256Hex(ref),
      adr_status_at_snapshot: "accepted",
      may_satisfy_active_gate: true,
      snapshotted_at: NOW.toISOString(),
      source_sha256: sha256Hex(content),
    };
    const p = decisionRecordPath(cwd, ref);
    await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), { recursive: true });
    await writeFile(p, JSON.stringify({ ...base, ...overrides }, null, 2) + "\n", "utf8");
    return p;
  }

  it("proposed ADR but the on-disk record claims accepted/may_satisfy=true → record_state_mismatch (no noop), nothing rewritten", async () => {
    await writeAdr(ACCEPTED_ADR.replace("accepted (P99, 2026-06)", "proposed")); // live = blocked
    const p = await plantRecord(REF, { adr_status_at_snapshot: "accepted", may_satisfy_active_gate: true });
    const before = await readFile(p, "utf8");

    const outcome = await writeDecisionRecord(cwd, REF, { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks[0]?.kind).toBe("record_state_mismatch");
    expect(await readFile(p, "utf8")).toBe(before); // untouched
  });

  it("explicit refresh (same source sha old==new) re-records the corrected state", async () => {
    await writeAdr(ACCEPTED_ADR.replace("accepted (P99, 2026-06)", "proposed"));
    await plantRecord(REF, { adr_status_at_snapshot: "accepted", may_satisfy_active_gate: true });
    const sha = sha256Hex(await readFile(join(cwd, REF), "utf8"));
    const outcome = await writeDecisionRecord(cwd, REF, {
      now: NOW,
      refresh: { expected_old_source_sha256: sha, expected_new_source_sha256: sha },
    });
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;
    expect(outcome.record.adr_status_at_snapshot).toBe("blocked");
    expect(outcome.record.may_satisfy_active_gate).toBe(false);
  });

  it("title-only drift in the on-disk record → record_state_mismatch (record is deterministic from the live .md)", async () => {
    await writeAdr(ACCEPTED_ADR); // live title "RFC: Foo"
    const p = await plantRecord(REF, { title: "Stale Title" });
    const before = await readFile(p, "utf8");

    const outcome = await writeDecisionRecord(cwd, REF, { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks[0]?.kind).toBe("record_state_mismatch");
    expect(await readFile(p, "utf8")).toBe(before);
  });

  it("an accepted+may_satisfy=false record on disk cannot even parse (bidirectional schema) → record_invalid, not noop", async () => {
    await writeAdr(ACCEPTED_ADR);
    // Bypass plantRecord's schema-shaped base: write a record the schema rejects.
    const content = await readFile(join(cwd, REF), "utf8");
    const p = decisionRecordPath(cwd, REF);
    await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), { recursive: true });
    await writeFile(
      p,
      JSON.stringify(
        {
          schema_version: 1,
          canonical_ref: REF,
          original_path: REF,
          path_sha256: sha256Hex(REF),
          adr_status_at_snapshot: "accepted",
          may_satisfy_active_gate: false, // contradicts accepted — schema-invalid
          snapshotted_at: NOW.toISOString(),
          source_sha256: sha256Hex(content),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const outcome = await writeDecisionRecord(cwd, REF, { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks[0]?.kind).toBe("record_invalid");
  });

  it("nothing drifted → still a clean noop_same_source", async () => {
    await writeAdr(ACCEPTED_ADR);
    const first = await writeDecisionRecord(cwd, REF, { now: NOW });
    const bytes = await readFile((first as { path: string }).path, "utf8");
    const second = await writeDecisionRecord(cwd, REF, { now: new Date("2027-05-05T00:00:00Z") });
    expect(second.kind).toBe("noop_same_source");
    expect(await readFile((first as { path: string }).path, "utf8")).toBe(bytes);
  });
});

describe("confinement + fail-closed reads", () => {
  it("rejects refs outside top-level design/decisions/*.md", async () => {
    for (const bad of [
      "docs/cli-contract.md",
      "design/decisions/nested/adr.md",
      "design/decisions/README.md",
      "design/decisions/PRUNED.md",
      "../outside.md",
      "/abs.md",
    ]) {
      const plan = await planDecisionRecord(cwd, bad, { now: NOW });
      expect(plan.kind).toBe("ineligible");
      if (plan.kind !== "ineligible") continue;
      expect(plan.blocks[0]?.kind).toBe("invalid_ref");
    }
  });

  it("an invalid existing record fails closed (never silently overwritten)", async () => {
    await writeAdr(ACCEPTED_ADR);
    const first = await writeDecisionRecord(cwd, REF, { now: NOW });
    expect(first.kind).toBe("written");
    await writeFile((first as { path: string }).path, "{ not json", "utf8");

    const outcome = await writeDecisionRecord(cwd, REF, { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks[0]?.kind).toBe("record_invalid");
  });

  it("a valid record for a DIFFERENT decision at this filename → record_identity_mismatch (no noop, no overwrite)", async () => {
    await writeAdr(ACCEPTED_ADR);
    const first = await writeDecisionRecord(cwd, REF, { now: NOW });
    expect(first.kind).toBe("written");

    // Plant foo's (schema-valid) record at bar's record path.
    const barRef = "design/decisions/bar-rfc.md";
    await writeAdr(ACCEPTED_ADR.replace("RFC: Foo", "RFC: Bar"), barRef);
    const fooBytes = await readFile((first as { path: string }).path, "utf8");
    await writeFile(decisionRecordPath(cwd, barRef), fooBytes, "utf8");

    const outcome = await writeDecisionRecord(cwd, barRef, { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks[0]?.kind).toBe("record_identity_mismatch");
    expect(await readFile(decisionRecordPath(cwd, barRef), "utf8")).toBe(fooBytes); // untouched
  });

  it("a record created between plan and apply makes the fresh write THROW, not overwrite", async () => {
    await writeAdr(ACCEPTED_ADR);
    const plan = await planDecisionRecord(cwd, REF, { now: NOW });
    expect(plan.kind).toBe("write");
    if (plan.kind !== "write") return;

    // Concurrent writer lands first.
    await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), { recursive: true });
    await writeFile(plan.path, '{"winner":"other"}\n', "utf8");
    await expect(applyDecisionRecordPlan(plan)).rejects.toThrow(/expected absent/);
    expect(await readFile(plan.path, "utf8")).toBe('{"winner":"other"}\n');
  });

  it("a record changed between refresh-plan and apply makes the refresh THROW, not overwrite", async () => {
    await writeAdr(ACCEPTED_ADR);
    await writeDecisionRecord(cwd, REF, { now: NOW });
    const edited = ACCEPTED_ADR + "\nPostscript.\n";
    await writeAdr(edited);

    const plan = await planDecisionRecord(cwd, REF, {
      now: NOW,
      refresh: {
        expected_old_source_sha256: sha256Hex(ACCEPTED_ADR),
        expected_new_source_sha256: sha256Hex(edited),
      },
    });
    expect(plan.kind).toBe("refresh");
    if (plan.kind !== "refresh") return;

    await writeFile(plan.path, plan.existing_raw + "\n", "utf8"); // concurrent change
    await expect(applyDecisionRecordPlan(plan)).rejects.toThrow(/changed before write/);
  });

  it("schema invariant: original_path must equal canonical_ref in v1", () => {
    const parsed = DecisionStateRecord.safeParse({
      schema_version: 1,
      canonical_ref: REF,
      original_path: "design/decisions/other.md",
      path_sha256: sha256Hex(REF),
      adr_status_at_snapshot: "accepted",
      may_satisfy_active_gate: true,
      snapshotted_at: NOW.toISOString(),
      source_sha256: sha256Hex("x"),
    });
    expect(parsed.success).toBe(false);
  });

  it("schema invariant: unknown keys are rejected (strict control record)", () => {
    const parsed = DecisionStateRecord.safeParse({
      schema_version: 1,
      canonical_ref: REF,
      original_path: REF,
      path_sha256: sha256Hex(REF),
      adr_status_at_snapshot: "accepted",
      may_satisfy_active_gate: true,
      snapshotted_at: NOW.toISOString(),
      source_sha256: sha256Hex("x"),
      retired_at: NOW.toISOString(), // reserved for step 7, schema v2
    });
    expect(parsed.success).toBe(false);
  });

  it("schema invariant: may_satisfy_active_gate=true with a non-accepted status is invalid", () => {
    const parsed = DecisionStateRecord.safeParse({
      schema_version: 1,
      canonical_ref: REF,
      original_path: REF,
      path_sha256: sha256Hex(REF),
      adr_status_at_snapshot: "blocked",
      may_satisfy_active_gate: true,
      snapshotted_at: NOW.toISOString(),
      source_sha256: sha256Hex("x"),
    });
    expect(parsed.success).toBe(false);
  });
});
