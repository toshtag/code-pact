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

  describe("case-insensitive README / PRUNED exclusion", () => {
    const CASE_VARIANTS: [string, string][] = [
      ["design/decisions/readme.md", "all-lowercase readme"],
      ["design/decisions/ReadMe.md", "mixed-case ReadMe"],
      ["design/decisions/README.md", "uppercase README"],
      ["design/decisions/rEaDmE.md", "random-case rEaDmE"],
      ["design/decisions/pruned.md", "all-lowercase pruned"],
      ["design/decisions/Pruned.md", "capitalized Pruned"],
      ["design/decisions/PRUNED.md", "uppercase PRUNED"],
      ["design/decisions/PrUnEd.md", "random-case PrUnEd"],
      ["design/decisions/nested/readme.md", "nested lowercase readme"],
      ["design/decisions/nested/ReadMe.md", "nested mixed-case ReadMe"],
      ["design/decisions/a/b/c/README.md", "deeply nested uppercase README"],
      ["design/decisions/a/b/c/pRuNeD.md", "deeply nested random-case pRuNeD"],
    ];

    for (const [bad, why] of CASE_VARIANTS) {
      it(`rejects ${JSON.stringify(bad)} (${why})`, () => {
        expect(isDecisionRefPath(bad)).toBe(false);
        expect(decisionRefPathReason(bad)).not.toBe("");
        expect(DecisionRefPath.safeParse(bad).success).toBe(false);
      });
    }
  });

  describe("control character and markdown-significant character rejection", () => {
    const BAD_CHARS: [string, string][] = [
      ["design/decisions/adr\n001.md", "newline in filename"],
      ["design/decisions/adr\t001.md", "tab in filename"],
      ["design/decisions/adr\u0000001.md", "NUL in filename"],
      ["design/decisions/adr\u007f001.md", "DEL in filename"],
      ["design/decisions/adr|001.md", "pipe in filename"],
      ["design/decisions/adr`001.md", "backtick in filename"],
      ["design/decisions/adr#001.md", "hash in filename"],
      ["design/decisions/adr<001.md", "less-than in filename"],
      ["design/decisions/adr>001.md", "greater-than in filename"],
      ['design/decisions/adr"001.md', "double-quote in filename"],
      ["design/decisions/adr:001.md", "colon in filename"],
      ["design/decisions/adr?001.md", "question mark in filename"],
      ["design/decisions/adr*001.md", "asterisk in filename"],
      ["design/decisions/adr\\001.md", "backslash in filename"],
    ];

    for (const [bad, why] of BAD_CHARS) {
      it(`rejects ${JSON.stringify(bad)} (${why})`, () => {
        expect(isDecisionRefPath(bad)).toBe(false);
        expect(decisionRefPathReason(bad)).not.toBe("");
        expect(DecisionRefPath.safeParse(bad).success).toBe(false);
      });
    }
  });

  describe("Windows device name rejection", () => {
    const DEVICE_NAMES = ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"];

    for (const dev of DEVICE_NAMES) {
      it(`rejects design/decisions/${dev}.md (${dev} is a reserved device name)`, () => {
        const path = `design/decisions/${dev}.md`;
        expect(isDecisionRefPath(path)).toBe(false);
        expect(decisionRefPathReason(path)).not.toBe("");
        expect(DecisionRefPath.safeParse(path).success).toBe(false);
      });
    }
  });

  describe("trailing space and dot rejection", () => {
    const BAD_TRAILING: [string, string][] = [
      ["design/decisions/sub /001.md", "trailing space in directory segment"],
      ["design/decisions/adr./001.md", "trailing dot in directory segment"],
      ["design/decisions/ /001.md", "segment is only a space"],
    ];

    for (const [bad, why] of BAD_TRAILING) {
      it(`rejects ${JSON.stringify(bad)} (${why})`, () => {
        expect(isDecisionRefPath(bad)).toBe(false);
        expect(decisionRefPathReason(bad)).not.toBe("");
        expect(DecisionRefPath.safeParse(bad).success).toBe(false);
      });
    }
  });
});
