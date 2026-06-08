import { describe, it, expect } from "vitest";

import {
  escapeRegExp,
  startMarker,
  endMarker,
  renderBlock,
  extractBlock,
  spliceBlock,
  renderDetailTable,
  renderDetailList,
  escapeTableCell,
  BLOCKS,
} from "../../../scripts/gen-doc-blocks.ts";
import { SPEC_IMPORT_DETAILS } from "../../../src/contracts/spec-import-details.ts";
import {
  PLAN_INPUT_FILE_DETAILS,
  PLAN_INPUT_STDIN_DETAILS,
} from "../../../src/contracts/plan-input-details.ts";

const ID = "demo-block";
const SRC = "DEMO in src/x.ts";

describe("renderDetailTable", () => {
  it("renders a markdown table from a catalog", () => {
    const table = renderDetailTable({
      alpha: { when: "first" },
      beta: { when: "second `x`" },
    });
    expect(table).toBe(
      ["| `detail` | When |", "| --- | --- |", "| `alpha` | first |", "| `beta` | second `x` |"].join(
        "\n",
      ),
    );
  });

  it("preserves catalog insertion order", () => {
    const table = renderDetailTable(SPEC_IMPORT_DETAILS);
    const rows = table.split("\n").slice(2).map((r) => r.split("`")[1]);
    expect(rows).toEqual(Object.keys(SPEC_IMPORT_DETAILS));
  });
});

describe("escapeTableCell", () => {
  it("escapes `|` so a cell value can't break the table row", () => {
    expect(escapeTableCell("a|b")).toBe("a\\|b");
    expect(escapeTableCell("plain")).toBe("plain");
  });
});

describe("renderDetailTable escaping", () => {
  it("escapes `|` in both the detail key and the When text", () => {
    const table = renderDetailTable({ "a|b": { when: "x | y" } });
    expect(table).toContain("| `a\\|b` | x \\| y |");
  });
});

describe("renderDetailList", () => {
  it("renders an inline `a | b | c` span from catalog keys, in order", () => {
    expect(renderDetailList({ alpha: {}, beta: {}, gamma: {} })).toBe("`alpha | beta | gamma`");
  });

  it("reproduces the committed plan input enum lists", () => {
    expect(renderDetailList(PLAN_INPUT_FILE_DETAILS)).toBe(
      "`unsafe_path | unreadable | invalid_yaml | schema_invalid`",
    );
    expect(renderDetailList(PLAN_INPUT_STDIN_DETAILS)).toBe(
      "`stdin_read_failed | invalid_yaml | schema_invalid`",
    );
  });
});

describe("renderBlock inline", () => {
  it("keeps markers and body on one line (no surrounding newlines)", () => {
    const block = renderBlock(ID, SRC, "BODY", true);
    expect(block).toBe(`${startMarker(ID, SRC)}BODY${endMarker(ID)}`);
    expect(block).not.toContain("\n");
  });

  it("round-trips an inline block spliced mid-sentence", () => {
    const doc = `Detail enum: ${renderBlock(ID, SRC, "OLD", true)}.`;
    const out = spliceBlock(doc, ID, SRC, "`a | b`", true);
    expect(out).toBe(`Detail enum: ${renderBlock(ID, SRC, "`a | b`", true)}.`);
    expect(out).toContain("Detail enum: <!--");
    expect(out.endsWith("-->.")).toBe(true);
  });

  it("two adjacent inline blocks (the brief/constitution pattern) don't cross-match", () => {
    // file-detail on one line, stdin-detail two lines below — mirrors cli-contract.
    const fileB = renderBlock("plan-x-from-file-detail", SRC, "`a | b`", true);
    const stdinB = renderBlock("plan-x-from-stdin-detail", SRC, "`c | d`", true);
    const doc = `From file: ${fileB}.\n\nFrom stdin: ${stdinB}.`;
    expect(extractBlock(doc, "plan-x-from-file-detail")).toBe(fileB);
    expect(extractBlock(doc, "plan-x-from-stdin-detail")).toBe(stdinB);
    // Regenerating one leaves the other byte-for-byte intact.
    const out = spliceBlock(doc, "plan-x-from-file-detail", SRC, "`NEW`", true);
    expect(out).toContain(stdinB);
    expect(extractBlock(out, "plan-x-from-file-detail")).toBe(
      renderBlock("plan-x-from-file-detail", SRC, "`NEW`", true),
    );
  });
});

describe("spliceBlock", () => {
  const doc = ["before", startMarker(ID, SRC), "OLD BODY", endMarker(ID), "after"].join("\n");

  it("replaces only the region between markers and keeps surrounding text", () => {
    const out = spliceBlock(doc, ID, SRC, "NEW BODY");
    expect(out).toBe(["before", startMarker(ID, SRC), "NEW BODY", endMarker(ID), "after"].join("\n"));
    expect(out.startsWith("before\n")).toBe(true);
    expect(out.endsWith("\nafter")).toBe(true);
  });

  it("is idempotent (splicing the same body twice == once)", () => {
    const once = spliceBlock(doc, ID, SRC, "NEW BODY");
    const twice = spliceBlock(once, ID, SRC, "NEW BODY");
    expect(twice).toBe(once);
  });

  it("throws (never silently no-ops) when markers are absent", () => {
    expect(() => spliceBlock("no markers here", ID, SRC, "X")).toThrow(/markers for "demo-block" not found/);
  });

  it("refreshes the start-marker source note on regenerate", () => {
    const out = spliceBlock(doc, ID, "NEW SOURCE", "BODY");
    expect(out).toContain(startMarker(ID, "NEW SOURCE"));
    expect(out).not.toContain(startMarker(ID, SRC));
  });
});

describe("extractBlock", () => {
  it("returns the marker-wrapped region, or null when absent", () => {
    const block = renderBlock(ID, SRC, "BODY");
    expect(extractBlock(`x\n${block}\ny`, ID)).toBe(block);
    expect(extractBlock("nothing", ID)).toBeNull();
  });

  it("is unaffected by a same-prefix sibling id (no \\b collision)", () => {
    // Hyphenated ids: "foo" must not match the "foo-bar" marker, even when the
    // longer block appears first (a \b regex would span both → corruption).
    const short = renderBlock("foo", SRC, "SHORT");
    const long = renderBlock("foo-bar", SRC, "LONG");
    for (const doc of [`${short}\n${long}`, `${long}\n${short}`]) {
      expect(extractBlock(doc, "foo")).toBe(short);
      expect(extractBlock(doc, "foo-bar")).toBe(long);
    }
  });

  it("splicing one id leaves a same-prefix sibling block intact", () => {
    const doc = `${renderBlock("foo-bar", SRC, "KEEP")}\n${renderBlock("foo", SRC, "OLD")}`;
    const out = spliceBlock(doc, "foo", SRC, "NEW");
    expect(out).toContain(renderBlock("foo-bar", SRC, "KEEP"));
    expect(extractBlock(out, "foo")).toBe(renderBlock("foo", SRC, "NEW"));
  });
});

describe("drift detection (the --check core)", () => {
  it("flags a stale block and clears once regenerated", () => {
    const fresh = renderBlock(ID, SRC, "v1");
    const doc = `head\n${fresh}\ntail`;
    // Catalog now renders "v2" — committed doc still says "v1": drift.
    const expected = renderBlock(ID, SRC, "v2");
    expect(extractBlock(doc, ID)).not.toBe(expected);
    // Regenerate and the committed region matches again.
    const regenerated = spliceBlock(doc, ID, SRC, "v2");
    expect(extractBlock(regenerated, ID)).toBe(expected);
  });
});

describe("escapeRegExp", () => {
  it("escapes regex metacharacters so ids with dots/brackets match literally", () => {
    expect(escapeRegExp("a.b[c]")).toBe("a\\.b\\[c\\]");
  });
});

describe("BLOCKS registry", () => {
  it("every registered block renders non-empty content for a real catalog", () => {
    for (const block of BLOCKS) {
      expect(block.render().length).toBeGreaterThan(0);
      expect(block.id).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
