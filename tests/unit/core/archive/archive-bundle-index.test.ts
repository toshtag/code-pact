import { describe, expect, it } from "vitest";
import {
  buildBundleMemberIndex,
  reconcileLooseAndBundle,
} from "../../../../src/core/archive/archive-bundle-index.ts";
import type { LoadedArchiveBundle } from "../../../../src/core/archive/archive-bundle-reader.ts";
import type { ArchiveBundleKind } from "../../../../src/core/schemas/archive-bundle.ts";

// Layer 1c-i: pure cross-bundle index + loose∪bundle reconcile. No I/O.

const m = (id: string, sha256: string, bytes: string) => ({ id, sha256, bytes });
const loaded = (kind: ArchiveBundleKind, members: { id: string; sha256: string; bytes: string }[]): LoadedArchiveBundle => ({ kind, members });
const wrap = (file: string, l: LoadedArchiveBundle) => ({ file, loaded: l });

describe("buildBundleMemberIndex — cross-bundle global uniqueness", () => {
  it("indexes members per kind", () => {
    const idx = buildBundleMemberIndex([
      wrap("b1.json", loaded("phase_snapshot", [m("P1", "h1", "a"), m("P2", "h2", "b")])),
      wrap("b2.json", loaded("decision_record", [m("d-1", "h3", "c")])),
    ]);
    expect(idx.get("phase_snapshot")!.get("P1")).toEqual({ sha256: "h1", bytes: "a" });
    expect(idx.get("phase_snapshot")!.get("P2")!.bytes).toBe("b");
    expect(idx.get("decision_record")!.get("d-1")!.bytes).toBe("c");
  });

  it("same id in two bundles with IDENTICAL sha256 → deduped (ok)", () => {
    const idx = buildBundleMemberIndex([
      wrap("b1.json", loaded("phase_snapshot", [m("P1", "h1", "a")])),
      wrap("b2.json", loaded("phase_snapshot", [m("P1", "h1", "a")])),
    ]);
    expect(idx.get("phase_snapshot")!.get("P1")).toEqual({ sha256: "h1", bytes: "a" });
  });

  it("same id in two bundles with DIFFERENT sha256 → fail-closed duplicate_member_conflict", () => {
    expect(() =>
      buildBundleMemberIndex([
        wrap("b1.json", loaded("phase_snapshot", [m("P1", "h1", "a")])),
        wrap("b2.json", loaded("phase_snapshot", [m("P1", "h2", "DIFFERENT")])),
      ]),
    ).toThrow(/duplicate_member_conflict/);
  });

  it("same id across DIFFERENT kinds is not a conflict (separate namespaces)", () => {
    const idx = buildBundleMemberIndex([
      wrap("b1.json", loaded("phase_snapshot", [m("X", "h1", "a")])),
      wrap("b2.json", loaded("event_pack", [m("X", "h2", "b")])),
    ]);
    expect(idx.get("phase_snapshot")!.get("X")!.sha256).toBe("h1");
    expect(idx.get("event_pack")!.get("X")!.sha256).toBe("h2");
  });
});

describe("reconcileLooseAndBundle — loose ∪ bundle", () => {
  const entry = (sha256: string, bytes: string) => ({ sha256, bytes });

  it("loose only → loose bytes", () => {
    expect(reconcileLooseAndBundle("P1", "loose", null, "f")).toBe("loose");
  });
  it("bundle only → bundle bytes", () => {
    expect(reconcileLooseAndBundle("P1", null, entry("h", "bundled"), "f")).toBe("bundled");
  });
  it("neither → null (caller decides if that's a fault)", () => {
    expect(reconcileLooseAndBundle("P1", null, null, "f")).toBeNull();
  });
  it("both, byte-identical → that value (loose wins, no conflict)", () => {
    expect(reconcileLooseAndBundle("P1", "same", entry("h", "same"), "f")).toBe("same");
  });
  it("both, differing bytes → fail-closed bundle_stale", () => {
    expect(() => reconcileLooseAndBundle("P1", "loose", entry("h", "bundled"), "f")).toThrow(/bundle_stale/);
  });
});
