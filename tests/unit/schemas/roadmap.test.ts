import { describe, it, expect } from "vitest";
import { Roadmap, PhaseRef } from "../../../src/core/schemas/roadmap.ts";

describe("PhaseRef", () => {
  it("accepts valid ref", () => {
    const ref = PhaseRef.parse({ id: "P1", path: "design/phases/P1.yaml", weight: 12 });
    expect(ref.id).toBe("P1");
    expect(ref.weight).toBe(12);
  });

  it("rejects zero weight", () => {
    expect(() => PhaseRef.parse({ id: "P1", path: "design/phases/P1.yaml", weight: 0 })).toThrow();
  });

  it("rejects negative weight", () => {
    expect(() =>
      PhaseRef.parse({ id: "P1", path: "design/phases/P1.yaml", weight: -5 }),
    ).toThrow();
  });
});

describe("Roadmap", () => {
  it("accepts empty phases array", () => {
    // A freshly initialized roadmap has no phases yet
    const r = Roadmap.parse({ phases: [] });
    expect(r.phases).toHaveLength(0);
  });

  it("accepts multiple phase refs", () => {
    const r = Roadmap.parse({
      phases: [
        { id: "P1", path: "design/phases/P1.yaml", weight: 10 },
        { id: "P2", path: "design/phases/P2.yaml", weight: 20 },
      ],
    });
    expect(r.phases).toHaveLength(2);
  });

  it("rejects missing phases key", () => {
    expect(() => Roadmap.parse({})).toThrow();
  });
});
