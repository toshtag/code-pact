import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  decisionRecordPath,
  normalizeDecisionRef,
  pathHash8,
  phaseSnapshotPath,
  sha256Hex,
} from "../../../../src/core/archive/paths.ts";

describe("pathHash8", () => {
  it("is the first 8 hex chars of sha256 over the canonical ref, deterministic", () => {
    const ref = "design/decisions/foo-rfc.md";
    expect(pathHash8(ref)).toBe(sha256Hex(ref).slice(0, 8));
    expect(pathHash8(ref)).toBe(pathHash8(ref));
    expect(pathHash8(ref)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("differs for refs that share a stem (the collision the hash exists for)", () => {
    // Same stem "foo-rfc" cannot collide because the hash covers the full ref.
    expect(pathHash8("design/decisions/foo-rfc.md")).not.toBe(
      pathHash8("design/decisions/FOO-RFC.md"),
    );
  });
});

describe("decisionRecordPath", () => {
  it("builds <stem>-<hash8>.json under .code-pact/state/archive/decisions/", () => {
    const ref = "design/decisions/foo-rfc.md";
    expect(decisionRecordPath("/proj", ref)).toBe(
      join(
        "/proj",
        ".code-pact",
        "state",
        "archive",
        "decisions",
        `foo-rfc-${pathHash8(ref)}.json`,
      ),
    );
  });
});

describe("phaseSnapshotPath", () => {
  it("builds <phase-id>.json under .code-pact/state/archive/phases/", () => {
    expect(phaseSnapshotPath("/proj", "P12")).toBe(
      join("/proj", ".code-pact", "state", "archive", "phases", "P12.json"),
    );
  });

  it("rejects an unsafe phase id (path traversal can never reach the fs)", () => {
    expect(() => phaseSnapshotPath("/proj", "../evil")).toThrow();
    expect(() => phaseSnapshotPath("/proj", "-P1")).toThrow();
  });
});

describe("normalizeDecisionRef (canonical confinement)", () => {
  it("accepts a design/decisions/**/*.md and normalizes ./ prefixes", () => {
    expect(normalizeDecisionRef("design/decisions/foo-rfc.md")).toBe(
      "design/decisions/foo-rfc.md",
    );
    expect(normalizeDecisionRef("./design/decisions/foo-rfc.md")).toBe(
      "design/decisions/foo-rfc.md",
    );
  });

  it("accepts nested decision refs and rejects absolute, traversal, outside-dir, and non-decision targets", () => {
    expect(normalizeDecisionRef("/etc/passwd")).toBeNull();
    expect(normalizeDecisionRef("../outside.md")).toBeNull();
    expect(normalizeDecisionRef("design/decisions/../../secret.md")).toBeNull();
    expect(normalizeDecisionRef("docs/cli-contract.md")).toBeNull();
    expect(normalizeDecisionRef("design/phases/P1-x.yaml")).toBeNull();
    expect(normalizeDecisionRef("design/decisions/nested/adr.md")).toBe(
      "design/decisions/nested/adr.md",
    );
    expect(normalizeDecisionRef("design/decisions/README.md")).toBeNull();
    expect(normalizeDecisionRef("design/decisions/PRUNED.md")).toBeNull();
  });

  it("rejects backslash input instead of silently changing the namespace", () => {
    expect(normalizeDecisionRef("design\\decisions\\foo-rfc.md")).toBeNull();
  });
});
