import { describe, it, expect } from "vitest";
import { BaselineSnapshot } from "../../../src/core/schemas/baseline-snapshot.ts";

const VALID = {
  name: "initial",
  created_at: "2026-05-15T09:00:00+09:00",
  total_weight: 30,
  phases: [
    { id: "P1", path: "design/phases/P1-foundation.yaml", weight: 12 },
    { id: "P2", path: "design/phases/P2-core.yaml", weight: 18 },
  ],
};

describe("BaselineSnapshot", () => {
  it("accepts a valid initial snapshot", () => {
    const s = BaselineSnapshot.parse(VALID);
    expect(s.name).toBe("initial");
    expect(s.total_weight).toBe(30);
    expect(s.phases).toHaveLength(2);
  });

  it("accepts a zero total_weight for an empty project", () => {
    const s = BaselineSnapshot.parse({ ...VALID, total_weight: 0, phases: [] });
    expect(s.total_weight).toBe(0);
  });

  it("rejects negative total_weight", () => {
    expect(() => BaselineSnapshot.parse({ ...VALID, total_weight: -1 })).toThrow();
  });

  it("rejects invalid created_at", () => {
    expect(() => BaselineSnapshot.parse({ ...VALID, created_at: "yesterday" })).toThrow();
  });

  it("rejects missing name", () => {
    const { name: _, ...rest } = VALID as Record<string, unknown>;
    expect(() => BaselineSnapshot.parse(rest)).toThrow();
  });
});
