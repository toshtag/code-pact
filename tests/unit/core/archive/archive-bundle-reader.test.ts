import { describe, expect, it } from "vitest";
import {
  validateArchiveBundleTier1,
  computeMemberIdsSha256,
} from "../../../../src/core/archive/archive-bundle-reader.ts";
import { ARCHIVE_BUNDLE_SCHEMA_VERSION } from "../../../../src/core/schemas/archive-bundle.ts";
import { sha256Hex } from "../../../../src/core/archive/paths.ts";

// Layer 1a: the archive-bundle Tier-1 self/bijection reader (NO Tier-2 binding, NO
// loose∪bundle wiring). A strict load throws ARCHIVE_BUNDLE_INVALID on any internal
// inconsistency; these pin each failure mode + the happy path.

/** Build a member from raw canonical bytes (sha256 computed correctly). */
const member = (id: string, bytes: string) => ({ id, sha256: sha256Hex(bytes), bytes });

/** A valid bundle of `kind` over the given member id→bytes pairs (sorted, checksummed). */
function bundle(kind: string, pairs: [string, string][]): string {
  const members = pairs
    .map(([id, bytes]) => member(id, bytes))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({
    schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
    kind,
    member_ids_sha256: computeMemberIdsSha256(members.map((m) => m.id)),
    members,
  });
}

const FILE = "bundles/phase_snapshot-abc.json";

describe("validateArchiveBundleTier1 — happy path", () => {
  it("a well-formed bundle loads with its members in order", () => {
    const raw = bundle("phase_snapshot", [
      ["P10", '{"phase_id":"P10"}\n'],
      ["P2", '{"phase_id":"P2"}\n'],
    ]);
    const loaded = validateArchiveBundleTier1(raw, FILE);
    expect(loaded.kind).toBe("phase_snapshot");
    expect(loaded.members.map((m) => m.id)).toEqual(["P10", "P2"]); // "P10" < "P2" lexicographically
    expect(loaded.members[0]!.bytes).toBe('{"phase_id":"P10"}\n');
  });

  it("all three kinds parse", () => {
    for (const kind of ["phase_snapshot", "event_pack", "decision_record"]) {
      expect(validateArchiveBundleTier1(bundle(kind, [["x", "{}\n"]]), FILE).kind).toBe(kind);
    }
  });
});

describe("validateArchiveBundleTier1 — fail-closed", () => {
  const expectInvalid = (raw: string, re: RegExp) => {
    try {
      validateArchiveBundleTier1(raw, FILE);
      throw new Error("expected ARCHIVE_BUNDLE_INVALID");
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe("ARCHIVE_BUNDLE_INVALID");
      expect((e as Error).message).toMatch(re);
    }
  };

  it("non-JSON → invalid", () => {
    expectInvalid("not json", /not valid JSON/);
  });

  it("bad schema (unknown key / wrong kind / empty members) → invalid", () => {
    expectInvalid('{"schema_version":1,"kind":"phase_snapshot","member_ids_sha256":"x","members":[],"extra":1}', /schema validation/);
    expectInvalid(JSON.stringify({ schema_version: 1, kind: "nope", member_ids_sha256: "x", members: [member("a", "{}\n")] }), /schema validation/);
  });

  it("member sha256 does not match its bytes → invalid (bijection)", () => {
    const m = member("P1", '{"phase_id":"P1"}\n');
    m.sha256 = sha256Hex("different");
    const raw = JSON.stringify({
      schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
      kind: "phase_snapshot",
      member_ids_sha256: computeMemberIdsSha256(["P1"]),
      members: [m],
    });
    expectInvalid(raw, /sha256 mismatch/);
  });

  it("duplicate member id → invalid", () => {
    const m = member("P1", "{}\n");
    const raw = JSON.stringify({
      schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
      kind: "phase_snapshot",
      member_ids_sha256: computeMemberIdsSha256(["P1", "P1"]),
      members: [m, m],
    });
    expectInvalid(raw, /duplicate member id/);
  });

  it("members out of ascending id order → invalid", () => {
    const members = [member("P2", "{}\n"), member("P1", "{}\n")]; // wrong order, not sorted
    const raw = JSON.stringify({
      schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
      kind: "phase_snapshot",
      member_ids_sha256: computeMemberIdsSha256(["P2", "P1"]),
      members,
    });
    expectInvalid(raw, /ascending id order/);
  });

  it("member_ids_sha256 disagrees with the member set → invalid", () => {
    const raw = JSON.stringify({
      schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
      kind: "phase_snapshot",
      member_ids_sha256: sha256Hex("wrong"),
      members: [member("P1", "{}\n")],
    });
    expectInvalid(raw, /member_ids_sha256 mismatch/);
  });
});

describe("computeMemberIdsSha256", () => {
  it("is order-independent (sorts first)", () => {
    expect(computeMemberIdsSha256(["b", "a", "c"])).toBe(computeMemberIdsSha256(["c", "b", "a"]));
  });
  it("differs when the id set differs", () => {
    expect(computeMemberIdsSha256(["a", "b"])).not.toBe(computeMemberIdsSha256(["a", "c"]));
  });
});
