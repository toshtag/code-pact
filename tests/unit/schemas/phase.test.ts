import { describe, it, expect } from "vitest";
import { Phase } from "../../../src/core/schemas/phase.ts";

const VALID_PHASE = {
  id: "P1",
  name: "Foundation",
  weight: 12,
  confidence: "high",
  risk: "low",
  status: "done",
  objective: "Establish project foundation.",
  definition_of_done: ["CI passes", "Tests green"],
  verification: { commands: ["pnpm test"] },
};

describe("Phase", () => {
  it("accepts a minimal valid phase", () => {
    const p = Phase.parse(VALID_PHASE);
    expect(p.id).toBe("P1");
    expect(p.weight).toBe(12);
  });

  it("accepts a phase with inline tasks", () => {
    const p = Phase.parse({
      ...VALID_PHASE,
      tasks: [
        {
          id: "P1-T1",
          type: "feature",
          ambiguity: "low",
          risk: "low",
          context_size: "small",
          write_surface: "medium",
          verification_strength: "strong",
          expected_duration: "short",
          status: "done",
        },
      ],
    });
    expect(p.tasks).toHaveLength(1);
    expect(p.tasks?.[0]?.id).toBe("P1-T1");
  });

  it("accepts optional fields", () => {
    const p = Phase.parse({
      ...VALID_PHASE,
      non_goals: ["No billing"],
      requires_decision: true,
    });
    expect(p.requires_decision).toBe(true);
  });

  it("rejects missing objective", () => {
    const { objective: _, ...rest } = VALID_PHASE as Record<string, unknown>;
    expect(() => Phase.parse(rest)).toThrow();
  });

  it("rejects empty definition_of_done", () => {
    expect(() => Phase.parse({ ...VALID_PHASE, definition_of_done: [] })).toThrow();
  });

  it("rejects empty verification.commands", () => {
    expect(() =>
      Phase.parse({ ...VALID_PHASE, verification: { commands: [] } }),
    ).toThrow();
  });

  it("rejects invalid status", () => {
    expect(() => Phase.parse({ ...VALID_PHASE, status: "unknown" })).toThrow();
  });
});
