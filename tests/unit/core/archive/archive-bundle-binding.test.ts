import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bindBundleMember, decisionRecordStem } from "../../../../src/core/archive/archive-bundle-binding.ts";
import { sha256Hex } from "../../../../src/core/archive/paths.ts";
import type { ArchiveBundleKind } from "../../../../src/core/schemas/archive-bundle.ts";
import type { LoadedBundleMember } from "../../../../src/core/archive/archive-bundle-reader.ts";

// Layer 1b: Tier-2 per-member binding. Fixtures are REAL committed archive records —
// they are exactly the per-item writer's canonical output, so a faithful member binds and
// re-serialization equals the stored bytes. Each kind reads the first file in its archive
// dir (skips if the dir is empty/absent, e.g. after retention prunes a kind to zero), so
// the test never goes stale on a specific id.

const ARCHIVE = ".code-pact/state/archive";
function firstFile(dir: string): string | null {
  try {
    const f = readdirSync(join(ARCHIVE, dir)).filter((n) => n.endsWith(".json")).sort()[0];
    return f ? join(ARCHIVE, dir, f) : null;
  } catch {
    return null;
  }
}
function memberOf(bytes: string, id: string): LoadedBundleMember {
  return { id, sha256: sha256Hex(bytes), bytes };
}
const FILE = "bundles/x.json";

const KINDS: { kind: ArchiveBundleKind; dir: string; idOf: (rec: any) => string }[] = [
  { kind: "phase_snapshot", dir: "phases", idOf: (r) => r.phase_id },
  { kind: "event_pack", dir: "event-packs", idOf: (r) => r.phase_id },
  { kind: "decision_record", dir: "decisions", idOf: (r) => decisionRecordStem(r.canonical_ref) },
];

for (const { kind, dir, idOf } of KINDS) {
  const path = firstFile(dir);
  describe(`bindBundleMember — ${kind}`, () => {
    it.skipIf(!path)("a real canonical record binds (id === internal identity, bytes canonical)", () => {
      const bytes = readFileSync(path!, "utf8");
      const id = idOf(JSON.parse(bytes));
      const bound = bindBundleMember(kind, memberOf(bytes, id), FILE);
      expect(bound.kind).toBe(kind);
      expect(bound.id).toBe(id);
    });

    it.skipIf(!path)("wrong member id (≠ internal identity) → fail-closed", () => {
      const bytes = readFileSync(path!, "utf8");
      expect(() => bindBundleMember(kind, memberOf(bytes, "WRONG-ID"), FILE)).toThrow(/does not match its own/);
    });

    it.skipIf(!path)("non-canonical bytes (reformatted) → fail-closed", () => {
      const bytes = readFileSync(path!, "utf8");
      const id = idOf(JSON.parse(bytes));
      const reformatted = JSON.stringify(JSON.parse(bytes)); // compact, not 2-space + newline
      expect(() => bindBundleMember(kind, memberOf(reformatted, id), FILE)).toThrow(/canonical output/);
    });

    it.skipIf(!path)("bytes that are not a valid record of this kind → fail-closed", () => {
      // A decision record is never a valid phase_snapshot, etc. Use a trivially-wrong shape.
      expect(() => bindBundleMember(kind, memberOf('{"not":"a record"}\n', "x"), FILE)).toThrow(
        kind === "phase_snapshot" ? /not a valid phase_snapshot/ : kind === "event_pack" ? /not a valid event_pack/ : /not a valid decision_record/,
      );
    });
  });
}

describe("decisionRecordStem", () => {
  it("derives <basename>-<hash8> the same way the filename does", () => {
    const stem = decisionRecordStem("design/decisions/foo-rfc.md");
    expect(stem).toMatch(/^foo-rfc-[0-9a-f]{8}$/);
  });
});
