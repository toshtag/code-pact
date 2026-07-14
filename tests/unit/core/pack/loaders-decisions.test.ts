import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDecisions } from "../../../../src/core/pack/loaders.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-loaders-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("loadDecisions — non-decision exclusion", () => {
  it("never surfaces README.md / PRUNED.md as a decision, even in the allDecisions (context_size: large) path", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "P1-T1-rfc.md"),
      "# Decision\n\nbody",
    );
    await writeFile(join(cwd, "design", "decisions", "README.md"), "# Index");
    await writeFile(join(cwd, "design", "decisions", "PRUNED.md"), "# Ledger");

    const docs = await loadDecisions(cwd, "P1-T1", true);
    const names = docs.map((d) => d.filename);
    expect(names).toContain("design/decisions/P1-T1-rfc.md");
    expect(names).not.toContain("design/decisions/README.md");
    expect(names).not.toContain("design/decisions/PRUNED.md");
  });

  it("keeps duplicate basenames in different directories distinct by full path", async () => {
    await mkdir(join(cwd, "design", "decisions", "security"), { recursive: true });
    await mkdir(join(cwd, "design", "decisions", "payments"), { recursive: true });
    await writeFile(
      join(cwd, "design", "decisions", "security", "P1-T1-rfc.md"),
      "# Security\n\nsecurity body",
    );
    await writeFile(
      join(cwd, "design", "decisions", "payments", "P1-T1-rfc.md"),
      "# Payments\n\npayments body",
    );

    const docs = await loadDecisions(cwd, "P1-T1", true);
    expect(docs.map((d) => d.filename)).toEqual([
      "design/decisions/payments/P1-T1-rfc.md",
      "design/decisions/security/P1-T1-rfc.md",
    ]);
  });
});

describe("loadDecisions — projection metadata", () => {
  it("adds metadata only for accepted ADRs with explicit commitment checkboxes", async () => {
    await writeFile(
      join(cwd, "design", "decisions", "accepted.md"),
      [
        "---",
        "status: accepted",
        "---",
        "# Accepted",
        "",
        "## Implementation commitments",
        "",
        "- [ ] Preserve the old path",
        "- [x] Add the new path",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "design", "decisions", "proposed.md"),
      [
        "# Proposed",
        "",
        "**Status:** proposed",
        "",
        "## Implementation commitments",
        "",
        "- [ ] Not accepted",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "design", "decisions", "prose-only.md"),
      [
        "# Prose",
        "",
        "**Status:** accepted",
        "",
        "## Implementation commitments",
        "",
        "No checkboxes here.",
        "",
      ].join("\n"),
    );

    const docs = await loadDecisions(cwd, "P1-T1", true);
    const byName = new Map(docs.map(doc => [doc.filename, doc]));

    expect(byName.get("design/decisions/accepted.md")?.projection).toEqual({
      accepted: true,
      commitments: [
        { text: "Preserve the old path", done: false },
        { text: "Add the new path", done: true },
      ],
    });
    expect(byName.get("design/decisions/proposed.md")?.projection).toBeUndefined();
    expect(byName.get("design/decisions/prose-only.md")?.projection).toBeUndefined();
  });
});
