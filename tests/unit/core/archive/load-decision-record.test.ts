import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadDecisionRecord,
  resolveArchiveDecisionRecord,
} from "../../../../src/core/archive/load-decision-record.ts";
import { writeDecisionRecord } from "../../../../src/core/archive/decision-record.ts";
import {
  archiveBundlesDir,
  decisionRecordPath,
  sha256Hex,
} from "../../../../src/core/archive/paths.ts";
import { decisionRecordStem } from "../../../../src/core/archive/archive-bundle-binding.ts";
import { computeMemberIdsSha256 } from "../../../../src/core/archive/archive-bundle-reader.ts";
import { ARCHIVE_BUNDLE_SCHEMA_VERSION } from "../../../../src/core/schemas/archive-bundle.ts";

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

// ---------------------------------------------------------------------------
// resolveArchiveDecisionRecord — loose ∪ bundle (reader-loose-wins). A retired +
// compacted decision resolves from its decision_record bundle member.
// ---------------------------------------------------------------------------

/** Write a decision_record bundle holding `members`, Tier-1-canonical. */
async function writeDecisionBundle(
  name: string,
  members: { id: string; bytes: string }[],
): Promise<void> {
  const dir = archiveBundlesDir(cwd);
  await mkdir(dir, { recursive: true });
  const full = members
    .map((m) => ({ id: m.id, sha256: sha256Hex(m.bytes), bytes: m.bytes }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await writeFile(
    join(dir, name),
    JSON.stringify({
      schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
      kind: "decision_record",
      member_ids_sha256: computeMemberIdsSha256(full.map((m) => m.id)),
      members: full,
    }),
    "utf8",
  );
}

/** Write the ADR + record, read its canonical bytes, then DELETE the loose record
 *  (compact it away — the live .md is left to the caller). Returns the bytes. */
async function recordBytesThenCompact(adr: string): Promise<string> {
  const p = await writeRecord(adr);
  const bytes = await readFile(p, "utf8");
  await rm(p);
  return bytes;
}

describe("resolveArchiveDecisionRecord — loose ∪ bundle", () => {
  it("bundle-only (loose compacted away) → valid", async () => {
    const bytes = await recordBytesThenCompact(ACCEPTED_ADR);
    await writeDecisionBundle("bundle-a.json", [{ id: decisionRecordStem(REF), bytes }]);
    const res = await resolveArchiveDecisionRecord(cwd, REF);
    expect(res.kind).toBe("valid");
    if (res.kind === "valid") expect(res.record.canonical_ref).toBe(REF);
  });

  it("loose present → loose wins; bundle not consulted (valid)", async () => {
    const p = await writeRecord(ACCEPTED_ADR);
    const bytes = await readFile(p, "utf8"); // loose stays
    await writeDecisionBundle("bundle-a.json", [{ id: decisionRecordStem(REF), bytes }]);
    expect((await resolveArchiveDecisionRecord(cwd, REF)).kind).toBe("valid");
  });

  it("loose present is ISOLATED from an unrelated Tier-1-corrupt bundle (valid)", async () => {
    await writeRecord(ACCEPTED_ADR); // loose stays
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    await writeFile(join(archiveBundlesDir(cwd), "bad.json"), "{ not json", "utf8");
    expect((await resolveArchiveDecisionRecord(cwd, REF)).kind).toBe("valid");
  });

  it("bundle member filed under REF's stem but body canonical_ref differs → invalid (self-bind)", async () => {
    const bytes = await recordBytesThenCompact(ACCEPTED_ADR);
    // Filed under REF's stem, but the body's canonical_ref points elsewhere — the id
    // is never trusted over the record's own identity, so bindBundleMember rejects it.
    const tampered = bytes.replace(REF, "design/decisions/bar-rfc.md");
    await writeDecisionBundle("bundle-a.json", [{ id: decisionRecordStem(REF), bytes: tampered }]);
    expect((await resolveArchiveDecisionRecord(cwd, REF)).kind).toBe("invalid");
  });

  it("referenced stem absent from loose AND bundle → absent", async () => {
    const bytes = await recordBytesThenCompact(ACCEPTED_ADR);
    // Bundle holds a different decision, not REF's stem.
    await writeDecisionBundle("bundle-a.json", [{ id: "other-cafef00d", bytes }]);
    expect((await resolveArchiveDecisionRecord(cwd, REF)).kind).toBe("absent");
  });

  it("same stem in two bundles with different bytes → invalid (duplicate_member_conflict)", async () => {
    const bytes = await recordBytesThenCompact(ACCEPTED_ADR);
    const other = bytes.replace(REF, "design/decisions/zzz-rfc.md"); // canonical_ref is in the JSON
    expect(other).not.toBe(bytes);
    await writeDecisionBundle("bundle-a.json", [{ id: decisionRecordStem(REF), bytes }]);
    await writeDecisionBundle("bundle-b.json", [{ id: decisionRecordStem(REF), bytes: other }]);
    expect((await resolveArchiveDecisionRecord(cwd, REF)).kind).toBe("invalid");
  });

  it("loose absent + a Tier-1-corrupt bundle in the store → invalid (fail-closed)", async () => {
    const bytes = await recordBytesThenCompact(ACCEPTED_ADR);
    await writeDecisionBundle("good.json", [{ id: decisionRecordStem(REF), bytes }]);
    await writeFile(join(archiveBundlesDir(cwd), "bad.json"), "{ not json", "utf8");
    expect((await resolveArchiveDecisionRecord(cwd, REF)).kind).toBe("invalid");
  });

  it("tampered path_sha256 (still canonical, valid schema) → valid: self-bind PASSES; path_sha256 authority is the CALLER's", async () => {
    // Only path_sha256 is changed (same-length hex), so the bytes stay canonical and
    // the schema (which enforces canonical_ref===original_path, NOT path_sha256) still
    // accepts. The resolver returns `valid` — proving bindBundleMember is not full
    // authority; recordMatchingRef is what rejects path_sha256 ≠ ref (see the gate test).
    const bytes = await recordBytesThenCompact(ACCEPTED_ADR);
    const tampered = bytes.replace(sha256Hex(REF), sha256Hex("design/decisions/elsewhere.md"));
    expect(tampered).not.toBe(bytes);
    await writeDecisionBundle("bundle-a.json", [{ id: decisionRecordStem(REF), bytes: tampered }]);
    expect((await resolveArchiveDecisionRecord(cwd, REF)).kind).toBe("valid");
  });
});
