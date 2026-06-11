import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDecisionRecord } from "../../../../src/core/archive/load-decision-record.ts";
import { writeDecisionRecord } from "../../../../src/core/archive/decision-record.ts";
import { decisionRecordPath } from "../../../../src/core/archive/paths.ts";

const NOW = new Date("2026-06-10T00:00:00.000Z");
const REF = "design/decisions/foo-rfc.md";

const ACCEPTED_ADR = `# RFC: Foo

**Status:** accepted (P99, 2026-06)

## Summary

Settled.
`;
const BLOCKED_ADR = `# RFC: Foo

**Status:** proposed

## Summary

Not yet settled.
`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-loaddecrec-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Write the ADR + its decision-state record, returning the record path. */
async function writeRecord(adr: string): Promise<string> {
  await writeFile(join(cwd, REF), adr, "utf8");
  const outcome = await writeDecisionRecord(cwd, REF, { now: NOW });
  expect(outcome.kind).toBe("written");
  return (outcome as { path: string }).path;
}

describe("loadDecisionRecord", () => {
  it("absent file → absent", async () => {
    expect(await loadDecisionRecord(cwd, REF)).toEqual({ kind: "absent" });
  });

  it("valid accepted record → valid with parsed body (may_satisfy_active_gate true)", async () => {
    await writeRecord(ACCEPTED_ADR);
    const res = await loadDecisionRecord(cwd, REF);
    expect(res.kind).toBe("valid");
    if (res.kind !== "valid") return;
    expect(res.record.canonical_ref).toBe(REF);
    expect(res.record.may_satisfy_active_gate).toBe(true);
    expect(res.record.adr_status_at_snapshot).toBe("accepted");
  });

  it("valid non-accepted record → valid (may_satisfy_active_gate false)", async () => {
    await writeRecord(BLOCKED_ADR);
    const res = await loadDecisionRecord(cwd, REF);
    expect(res.kind).toBe("valid");
    if (res.kind !== "valid") return;
    expect(res.record.may_satisfy_active_gate).toBe(false);
  });

  it("JSON garbage → invalid (not absent)", async () => {
    await writeFile(decisionRecordPath(cwd, REF), "{ not json", "utf8");
    expect((await loadDecisionRecord(cwd, REF)).kind).toBe("invalid");
  });

  it("valid JSON but schema-invalid (unknown key, strictObject) → invalid", async () => {
    const p = await writeRecord(ACCEPTED_ADR);
    const obj = JSON.parse(await readFile(p, "utf8"));
    obj.surprise = "extra";
    await writeFile(p, JSON.stringify(obj), "utf8");
    expect((await loadDecisionRecord(cwd, REF)).kind).toBe("invalid");
  });

  it("schema-invalid: may_satisfy contradicts status → invalid (the bidirectional guard)", async () => {
    const p = await writeRecord(ACCEPTED_ADR);
    const obj = JSON.parse(await readFile(p, "utf8"));
    obj.may_satisfy_active_gate = false; // accepted but not gate-usable → schema rejects
    await writeFile(p, JSON.stringify(obj), "utf8");
    expect((await loadDecisionRecord(cwd, REF)).kind).toBe("invalid");
  });

  it("present-but-unreadable (a directory at the path) → invalid, NOT absent", async () => {
    await mkdir(decisionRecordPath(cwd, REF), { recursive: true });
    expect((await loadDecisionRecord(cwd, REF)).kind).toBe("invalid");
  });
});
