import { describe, it, expect } from "vitest";
import {
  DecisionRefPath,
  isDecisionRefPath,
  decisionRefPathReason,
} from "../../../src/core/schemas/decision-ref.ts";

// The single source-of-truth validator for `decision_refs`. Every consumer
// (Task/phase-import schemas, gate, pack loader, plan lint, context-fit) routes
// through these exports, so pinning the contract here pins it everywhere.
describe("decision-ref validator (security)", () => {
  const ACCEPT = [
    "design/decisions/ADR-001.md",
    "design/decisions/stability-taxonomy.md",
    "design/decisions/2026/ADR-001.md",
    "design/decisions/a/b/c/deep.md",
  ];
  const REJECT: [string, string][] = [
    [".env", "arbitrary local file"],
    [".npmrc", "credential config"],
    ["docs/cli-contract.md", "outside the namespace"],
    ["design/decisions/README.md", "the index"],
    ["design/decisions/PRUNED.md", "the tombstone ledger"],
    ["design/decisions/nested/README.md", "README at any depth"],
    ["design/decisions/nested/PRUNED.md", "PRUNED at any depth"],
    ["design/decisions/secret", "not a .md"],
    ["design/decisions/", "no file"],
    ["design/decisionsX/ADR.md", "prefix is not a path boundary"],
    ["/etc/passwd", "absolute path"],
    ["design/decisions/../../secret.md", "traversal escape"],
    ["../design/decisions/ADR.md", "leading traversal"],
    ["design\\decisions\\ADR.md", "backslash"],
    ["C:/design/decisions/ADR.md", "drive letter"],
    ["", "empty string"],
  ];

  for (const ok of ACCEPT) {
    it(`accepts ${ok}`, () => {
      expect(isDecisionRefPath(ok)).toBe(true);
      expect(decisionRefPathReason(ok)).toBe("");
      expect(DecisionRefPath.safeParse(ok).success).toBe(true);
    });
  }

  for (const [bad, why] of REJECT) {
    it(`rejects ${JSON.stringify(bad)} (${why})`, () => {
      expect(isDecisionRefPath(bad)).toBe(false);
      expect(decisionRefPathReason(bad)).not.toBe("");
      expect(DecisionRefPath.safeParse(bad).success).toBe(false);
    });
  }

  it("the schema, the predicate, and the reason never disagree", () => {
    for (const v of [...ACCEPT, ...REJECT.map(([p]) => p)]) {
      const schemaOk = DecisionRefPath.safeParse(v).success;
      const predicateOk = isDecisionRefPath(v);
      const reasonOk = decisionRefPathReason(v) === "";
      expect(schemaOk).toBe(predicateOk);
      expect(predicateOk).toBe(reasonOk);
    }
  });
});
