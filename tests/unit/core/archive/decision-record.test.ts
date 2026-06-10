import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  planDecisionRecord,
  writeDecisionRecord,
} from "../../../../src/core/archive/decision-record.ts";
import { DecisionStateRecord } from "../../../../src/core/schemas/decision-state-record.ts";
import { sha256Hex } from "../../../../src/core/archive/paths.ts";

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
