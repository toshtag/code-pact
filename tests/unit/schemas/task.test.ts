import { describe, it, expect } from "vitest";
import { Task } from "../../../src/core/schemas/task.ts";

// v1.0.x-shaped task (every required field, no P10 additions). All P10
// Task Readiness Schema tests assert against this baseline so we can
// see additive parses succeed without affecting the existing surface.
const V1_0_X_TASK = {
  id: "P1-T1",
  type: "feature",
  ambiguity: "low",
  risk: "low",
  context_size: "small",
  write_surface: "medium",
  verification_strength: "strong",
  expected_duration: "short",
  status: "planned",
};

describe("Task schema — v1.0.x backward compatibility", () => {
  it("parses a task that uses none of the P10 fields", () => {
    const t = Task.parse(V1_0_X_TASK);
    expect(t.id).toBe("P1-T1");
    expect(t.depends_on).toBeUndefined();
    expect(t.decision_refs).toBeUndefined();
    expect(t.reads).toBeUndefined();
    expect(t.writes).toBeUndefined();
    expect(t.acceptance_refs).toBeUndefined();
  });

  it("parses a task with description and requires_decision only (pre-P10 optional fields)", () => {
    const t = Task.parse({
      ...V1_0_X_TASK,
      description: "do the thing",
      requires_decision: true,
    });
    expect(t.description).toBe("do the thing");
    expect(t.requires_decision).toBe(true);
    expect(t.depends_on).toBeUndefined();
  });
});

describe("Task schema — P10 optional fields accepted", () => {
  it("accepts depends_on as a non-empty string array", () => {
    const t = Task.parse({ ...V1_0_X_TASK, depends_on: ["P1-T2", "P1-T3"] });
    expect(t.depends_on).toEqual(["P1-T2", "P1-T3"]);
  });

  it("accepts decision_refs as a string array", () => {
    const t = Task.parse({
      ...V1_0_X_TASK,
      decision_refs: ["design/decisions/stability-taxonomy.md"],
    });
    expect(t.decision_refs).toEqual(["design/decisions/stability-taxonomy.md"]);
  });

  it("accepts reads as a glob string array", () => {
    const t = Task.parse({
      ...V1_0_X_TASK,
      reads: ["src/commands/*.ts", "tests/**/*.test.ts"],
    });
    expect(t.reads).toEqual(["src/commands/*.ts", "tests/**/*.test.ts"]);
  });

  it("accepts writes as a glob string array", () => {
    const t = Task.parse({
      ...V1_0_X_TASK,
      writes: ["src/core/path-safety.ts"],
    });
    expect(t.writes).toEqual(["src/core/path-safety.ts"]);
  });

  it("accepts acceptance_refs as a string array", () => {
    const t = Task.parse({
      ...V1_0_X_TASK,
      acceptance_refs: ["docs/cli-contract.md"],
    });
    expect(t.acceptance_refs).toEqual(["docs/cli-contract.md"]);
  });

  it("accepts all five P10 fields together", () => {
    const t = Task.parse({
      ...V1_0_X_TASK,
      depends_on: ["P1-T2"],
      decision_refs: ["design/decisions/stability-taxonomy.md"],
      reads: ["src/core/schemas/task.ts"],
      writes: ["src/core/schemas/task.ts"],
      acceptance_refs: ["docs/cli-contract.md"],
    });
    expect(t.depends_on).toEqual(["P1-T2"]);
    expect(t.decision_refs).toEqual(["design/decisions/stability-taxonomy.md"]);
    expect(t.reads).toEqual(["src/core/schemas/task.ts"]);
    expect(t.writes).toEqual(["src/core/schemas/task.ts"]);
    expect(t.acceptance_refs).toEqual(["docs/cli-contract.md"]);
  });

  it("accepts empty arrays for every P10 field (no items declared yet)", () => {
    const t = Task.parse({
      ...V1_0_X_TASK,
      depends_on: [],
      decision_refs: [],
      reads: [],
      writes: [],
      acceptance_refs: [],
    });
    expect(t.depends_on).toEqual([]);
    expect(t.writes).toEqual([]);
  });
});

describe("Task schema — P10 optional fields reject malformed input", () => {
  it("rejects non-string elements in depends_on", () => {
    expect(() =>
      Task.parse({ ...V1_0_X_TASK, depends_on: ["P1-T2", 42] as unknown as string[] }),
    ).toThrow();
  });

  it("rejects empty-string elements in decision_refs", () => {
    expect(() =>
      Task.parse({ ...V1_0_X_TASK, decision_refs: [""] }),
    ).toThrow();
  });

  it("rejects non-array shape for reads", () => {
    expect(() =>
      Task.parse({ ...V1_0_X_TASK, reads: "src/**/*.ts" as unknown as string[] }),
    ).toThrow();
  });

  it("rejects null inside writes", () => {
    expect(() =>
      Task.parse({ ...V1_0_X_TASK, writes: [null] as unknown as string[] }),
    ).toThrow();
  });
});

// SECURITY (Blocker 1 — arbitrary local file read / gate bypass / context leak
// via decision_refs). The decision_refs field carries a NAMESPACE contract,
// enforced at parse time so a hostile checked-in phase YAML can never name an
// arbitrary local file (.env, credentials) as a "decision". The schema is the
// FRONT-LINE layer; the gate and pack loader re-validate independently.
describe("Task schema — decision_refs namespace contract (security)", () => {
  it("accepts a flat ADR under design/decisions/", () => {
    const t = Task.parse({
      ...V1_0_X_TASK,
      decision_refs: ["design/decisions/ADR-001.md"],
    });
    expect(t.decision_refs).toEqual(["design/decisions/ADR-001.md"]);
  });

  it("accepts a nested ADR under design/decisions/", () => {
    const t = Task.parse({
      ...V1_0_X_TASK,
      decision_refs: ["design/decisions/2026/ADR-001.md"],
    });
    expect(t.decision_refs).toEqual(["design/decisions/2026/ADR-001.md"]);
  });

  it("rejects .env (arbitrary local file)", () => {
    expect(() => Task.parse({ ...V1_0_X_TASK, decision_refs: [".env"] })).toThrow();
  });

  it("rejects a non-.md file even inside the namespace", () => {
    expect(() =>
      Task.parse({ ...V1_0_X_TASK, decision_refs: ["design/decisions/secret"] }),
    ).toThrow();
  });

  it("rejects design/decisions/README.md (the index, not a decision)", () => {
    expect(() =>
      Task.parse({ ...V1_0_X_TASK, decision_refs: ["design/decisions/README.md"] }),
    ).toThrow();
  });

  it("rejects design/decisions/PRUNED.md (the tombstone ledger)", () => {
    expect(() =>
      Task.parse({ ...V1_0_X_TASK, decision_refs: ["design/decisions/PRUNED.md"] }),
    ).toThrow();
  });

  it("rejects a path outside the decisions namespace", () => {
    expect(() =>
      Task.parse({ ...V1_0_X_TASK, decision_refs: ["docs/cli-contract.md"] }),
    ).toThrow();
  });

  it("rejects traversal escaping the namespace", () => {
    expect(() =>
      Task.parse({ ...V1_0_X_TASK, decision_refs: ["design/decisions/../../secret.md"] }),
    ).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() =>
      Task.parse({ ...V1_0_X_TASK, decision_refs: ["/etc/passwd"] }),
    ).toThrow();
  });

  it("rejects a backslash path", () => {
    expect(() =>
      Task.parse({ ...V1_0_X_TASK, decision_refs: ["design\\decisions\\ADR.md"] }),
    ).toThrow();
  });

  it("leaves acceptance_refs loose ON PURPOSE (it points at docs / phase YAML)", () => {
    const t = Task.parse({ ...V1_0_X_TASK, acceptance_refs: ["docs/cli-contract.md"] });
    expect(t.acceptance_refs).toEqual(["docs/cli-contract.md"]);
  });
});
