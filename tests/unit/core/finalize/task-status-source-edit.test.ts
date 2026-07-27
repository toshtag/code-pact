import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildTaskStatusSourceEdit } from "../../../../src/core/finalize/task-status-source-edit.ts";
import { Phase } from "../../../../src/core/schemas/phase.ts";

// ---------------------------------------------------------------------------
// The fixture deliberately carries everything the strict `Phase` model does
// NOT carry — a top-level `evidence:` list, an unknown `x-custom:` key, an
// inline comment, a folded block scalar — plus the things a serializer would
// normalize away: key order, quote style, line endings. Losing any of them is
// the bug this module exists to make impossible (issue #560).
// ---------------------------------------------------------------------------

const fixture = `id: P1
name: Evidence preservation fixture
weight: 1
confidence: high
risk: low
status: in_progress
objective: >
  Preserve this exact block formatting.
x-custom:
  nested: keep-me
definition_of_done:
  - Keep all bytes except target status
verification:
  commands:
    - node --version
evidence:
  - "first historical entry"
  - "second historical entry"
tasks:
  - id: P1-T1
    type: bugfix
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: strong
    expected_duration: short
    status: planned # preserve this comment
  - id: P1-T2
    type: docs
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short
    status: done
`;

/** The fixture with `P1-T1`'s status token swapped for `replacement`, nothing else. */
function withT1Status(replacement: string): string {
  return fixture.replace(
    "status: planned # preserve this comment",
    `status: ${replacement} # preserve this comment`,
  );
}

function flipT1ToDone(raw: string) {
  return buildTaskStatusSourceEdit({
    raw,
    taskId: "P1-T1",
    expectedBefore: "planned",
    targetAfter: "done",
  });
}

// ---------------------------------------------------------------------------
// Preservation
// ---------------------------------------------------------------------------

describe("buildTaskStatusSourceEdit — preserves the rest of the source", () => {
  it("changes only the target status token", () => {
    const { candidate } = flipT1ToDone(fixture);
    expect(candidate).toBe(withT1Status("done"));
  });

  it("reports the replaced range and leaves every byte outside it untouched", () => {
    const { candidate, changed_range } = flipT1ToDone(fixture);
    expect(fixture.slice(changed_range.start, changed_range.end)).toBe(
      "planned",
    );
    expect(candidate.slice(0, changed_range.start)).toBe(
      fixture.slice(0, changed_range.start),
    );
    const tailStart = candidate.length - (fixture.length - changed_range.end);
    expect(candidate.slice(tailStart)).toBe(fixture.slice(changed_range.end));
  });

  it("keeps every top-level evidence entry", () => {
    const { candidate } = flipT1ToDone(fixture);
    const parsed = parseYaml(candidate) as { evidence: string[] };
    expect(parsed.evidence).toEqual([
      "first historical entry",
      "second historical entry",
    ]);
  });

  it("keeps a top-level key the Phase schema does not model", () => {
    const { candidate } = flipT1ToDone(fixture);
    const parsed = parseYaml(candidate) as { "x-custom": { nested: string } };
    expect(parsed["x-custom"]).toEqual({ nested: "keep-me" });
  });

  it("keeps the inline comment on the line it rewrites", () => {
    const { candidate } = flipT1ToDone(fixture);
    expect(candidate).toContain("status: done # preserve this comment");
  });

  it("keeps the folded block scalar unwrapped as written", () => {
    const { candidate } = flipT1ToDone(fixture);
    expect(candidate).toContain(
      "objective: >\n  Preserve this exact block formatting.\n",
    );
  });

  it("keeps top-level key order", () => {
    const { candidate } = flipT1ToDone(fixture);
    const keys = candidate
      .split("\n")
      .filter((line) => /^[A-Za-z]/.test(line))
      .map((line) => line.split(":")[0]);
    expect(keys).toEqual([
      "id",
      "name",
      "weight",
      "confidence",
      "risk",
      "status",
      "objective",
      "x-custom",
      "definition_of_done",
      "verification",
      "evidence",
      "tasks",
    ]);
  });

  it("leaves the phase status and the other task's status alone", () => {
    const { candidate } = flipT1ToDone(fixture);
    const phase = Phase.parse(parseYaml(candidate) as unknown);
    expect(phase.status).toBe("in_progress");
    expect(phase.tasks?.find((t) => t.id === "P1-T2")?.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Line endings and quote style
// ---------------------------------------------------------------------------

describe("buildTaskStatusSourceEdit — source style", () => {
  it("preserves LF line endings", () => {
    const { candidate } = flipT1ToDone(fixture);
    expect(candidate).not.toContain("\r\n");
  });

  it("preserves CRLF line endings", () => {
    const crlf = fixture.replace(/\n/g, "\r\n");
    const { candidate } = flipT1ToDone(crlf);
    expect(candidate).toBe(withT1Status("done").replace(/\n/g, "\r\n"));
  });

  it("keeps a plain status plain", () => {
    const { candidate } = flipT1ToDone(fixture);
    expect(candidate).toContain("status: done # preserve this comment");
  });

  it("keeps a double-quoted status double-quoted", () => {
    const raw = withT1Status('"planned"');
    const { candidate } = flipT1ToDone(raw);
    expect(candidate).toBe(withT1Status('"done"'));
  });

  it("keeps a single-quoted status single-quoted", () => {
    const raw = withT1Status("'planned'");
    const { candidate } = flipT1ToDone(raw);
    expect(candidate).toBe(withT1Status("'done'"));
  });
});

// ---------------------------------------------------------------------------
// Refusals — every one of these leaves the caller with no candidate to write
// ---------------------------------------------------------------------------

describe("buildTaskStatusSourceEdit — refusals", () => {
  it("refuses a source that does not parse as YAML", () => {
    expect(() =>
      flipT1ToDone("id: P1\nname: [unclosed bracket\n"),
    ).toThrow(/does not parse as YAML/);
  });

  it("refuses a source that does not validate as a Phase", () => {
    expect(() => flipT1ToDone("id: P1\nname: Foundation\n")).toThrow();
  });

  it("refuses a task id that is absent", () => {
    expect(() =>
      buildTaskStatusSourceEdit({
        raw: fixture,
        taskId: "P1-T99",
        expectedBefore: "planned",
        targetAfter: "done",
      }),
    ).toThrow(/task "P1-T99" not found/);
  });

  it("refuses a duplicated task id rather than guessing which one to flip", () => {
    const duplicated = fixture.replace("  - id: P1-T2", "  - id: P1-T1");
    expect(() => flipT1ToDone(duplicated)).toThrow(/appears 2 times/);
  });

  it("refuses a task with no status key", () => {
    // Phase validation rejects this before the scalar lookup runs; the
    // "no status key" guard in the module is the layer behind that.
    const missing = fixture.replace(
      "    status: planned # preserve this comment\n",
      "",
    );
    expect(() => flipT1ToDone(missing)).toThrow(/tasks/);
  });

  it("refuses a task with two status keys", () => {
    // Duplicate mapping keys are a YAML document error, so this is refused
    // before the ambiguity could reach the scalar lookup.
    const doubled = fixture.replace(
      "    status: planned # preserve this comment\n",
      "    status: planned # preserve this comment\n    status: done\n",
    );
    expect(() => flipT1ToDone(doubled)).toThrow(/does not parse as YAML/);
  });

  it("refuses when the current status is not the expected one", () => {
    expect(() =>
      buildTaskStatusSourceEdit({
        raw: fixture,
        taskId: "P1-T1",
        expectedBefore: "in_progress",
        targetAfter: "done",
      }),
    ).toThrow(/expected "in_progress"/);
  });
});

// ---------------------------------------------------------------------------
// The candidate is what the next reader gets
// ---------------------------------------------------------------------------

describe("buildTaskStatusSourceEdit — candidate re-read", () => {
  it("produces a candidate that re-parses and validates as a Phase", () => {
    const { candidate } = flipT1ToDone(fixture);
    const phase = Phase.parse(parseYaml(candidate) as unknown);
    expect(phase.id).toBe("P1");
    expect(phase.tasks?.find((t) => t.id === "P1-T1")?.status).toBe("done");
  });

  it("is idempotent under a second flip from the new status", () => {
    const first = flipT1ToDone(fixture);
    const second = buildTaskStatusSourceEdit({
      raw: first.candidate,
      taskId: "P1-T1",
      expectedBefore: "done",
      targetAfter: "done",
    });
    expect(second.candidate).toBe(first.candidate);
  });
});
