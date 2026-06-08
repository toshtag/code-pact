import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { collectInboundLinks } from "../../../../src/core/decisions/link-collector.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-linkcol-"));
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = join(cwd, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

const TARGET = "design/decisions/foo-rfc.md";

describe("collectInboundLinks — items", () => {
  it("returns no items/issues when nothing links to the target", async () => {
    await write("docs/x.md", "# X\n\nno links.");
    expect(await collectInboundLinks(cwd, TARGET)).toEqual({ items: [], issues: [] });
  });

  it("an inline body link → inline / delink, with full position + spans (dir-relative)", async () => {
    await write("docs/concepts/foo.md", "# F\n\nl1\nSee [the d](../../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    expect(items).toEqual([
      {
        source_file: "docs/concepts/foo.md",
        line: 4,
        column: 5,
        raw_link: "[the d](../../design/decisions/foo-rfc.md)",
        raw_href: "../../design/decisions/foo-rfc.md",
        link_text: "the d",
        normalized_target: TARGET,
        link_kind: "inline",
        rewrite_action: "delink",
      },
    ]);
  });

  it("a README decision-index row → index_row / tombstone", async () => {
    await write("design/decisions/README.md", "# I\n\n| D | W |\n| --- | --- |\n| [Foo](foo-rfc.md) | x |\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ link_kind: "index_row", rewrite_action: "tombstone" });
  });

  it("two links on one line are distinguished by column; a non-target link is excluded", async () => {
    await write("docs/m.md", "[A](../design/decisions/foo-rfc.md) and [B](../design/decisions/foo-rfc.md) and [C](../design/decisions/bar-rfc.md)\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    expect(items.map((i) => [i.link_text, i.column])).toEqual([
      ["A", 1],
      ["B", 41],
    ]);
  });

  it("a link in a fenced code block is NOT collected (blanked, exactly as check-doc-links ignores it)", async () => {
    await write("docs/ex.md", "# E\n\n```md\n[d](../design/decisions/foo-rfc.md)\n```\n");
    expect((await collectInboundLinks(cwd, TARGET)).items).toEqual([]);
  });

  it("raw_href is the destination token (preserves <…>, excludes title); raw_link keeps the title", async () => {
    await write("docs/t.md", `[a](<../design/decisions/foo-rfc.md> "the title")\n`);
    const { items } = await collectInboundLinks(cwd, TARGET);
    expect(items[0]?.raw_href).toBe("<../design/decisions/foo-rfc.md>");
    expect(items[0]?.raw_link).toBe(`[a](<../design/decisions/foo-rfc.md> "the title")`);
    expect(items[0]?.normalized_target).toBe(TARGET);
  });

  it("collects link forms broader than check-doc-links' LINK_RE (superset: single / parenthesized titles)", async () => {
    await write(
      "docs/forms.md",
      [
        "[a](../design/decisions/foo-rfc.md 'single')",
        "[b](../design/decisions/foo-rfc.md (paren))",
      ].join("\n") + "\n",
    );
    const texts = (await collectInboundLinks(cwd, TARGET)).items.map((i) => i.link_text);
    expect(texts).toEqual(["a", "b"]);
  });

  it("link_text preserves an inline-code label (recovered from the original, not the blanked line)", async () => {
    await write("docs/c.md", "See [use `foo`](../design/decisions/foo-rfc.md).\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    expect(items).toHaveLength(1);
    expect(items[0]?.link_text).toBe("use `foo`");
    expect(items[0]?.raw_link).toBe("[use `foo`](../design/decisions/foo-rfc.md)");
  });

  it("a 4-backtick fence enclosing a nested 3-backtick block — inner link not collected", async () => {
    await write(
      "docs/nested.md",
      "# N\n\n````md\n```md\n[x](../design/decisions/foo-rfc.md)\n```\n````\n",
    );
    expect((await collectInboundLinks(cwd, TARGET)).items).toEqual([]);
  });

  it("an indented fence (matching open/close indent) blanks its link, like check-doc-links", async () => {
    await write("docs/ind.md", "# I\n\n  ```\n  [x](../design/decisions/foo-rfc.md)\n  ```\n");
    expect((await collectInboundLinks(cwd, TARGET)).items).toEqual([]);
  });

  it("skips external / protocol-relative destinations (same test as check-doc-links)", async () => {
    await write(
      "docs/ext.md",
      [
        "[a](//design/decisions/foo-rfc.md)",
        "[b](mailto:design/decisions/foo-rfc.md)",
        "[c](https://example.com/design/decisions/foo-rfc.md)",
      ].join("\n") + "\n",
    );
    expect((await collectInboundLinks(cwd, TARGET)).items).toEqual([]);
  });
});

describe("collectInboundLinks — exclusions (match check:doc-links)", () => {
  it("ignores image embeds ![]()", async () => {
    await write("docs/i.md", "![diagram](../design/decisions/foo-rfc.md)\n");
    expect((await collectInboundLinks(cwd, TARGET)).items).toEqual([]);
  });

  it("ignores links inside inline code spans", async () => {
    await write("docs/c.md", "Use `[x](../design/decisions/foo-rfc.md)` as an example.\n");
    expect((await collectInboundLinks(cwd, TARGET)).items).toEqual([]);
  });

  it("never collects from CHANGELOG.md (durable record)", async () => {
    await write("CHANGELOG.md", "- [foo](design/decisions/foo-rfc.md) shipped\n");
    expect(await collectInboundLinks(cwd, TARGET)).toEqual({ items: [], issues: [] });
  });

  it("ignores .md outside the doc surface, and the target file itself", async () => {
    await write("somewhere/note.md", "[d](../design/decisions/foo-rfc.md)\n");
    await write(TARGET, "[self](foo-rfc.md)\n");
    expect((await collectInboundLinks(cwd, TARGET)).items).toEqual([]);
  });

  it("scans .github .md and .yml (the check:doc-links surface) but NOT .yaml", async () => {
    await write(".github/PULL_REQUEST_TEMPLATE.md", "[d](../design/decisions/foo-rfc.md)\n");
    await write(".github/x.yml", "body: see [d](../design/decisions/foo-rfc.md)\n");
    await write(".github/y.yaml", "body: see [d](../design/decisions/foo-rfc.md)\n");
    const sources = (await collectInboundLinks(cwd, TARGET)).items.map((i) => i.source_file);
    expect(sources).toContain(".github/PULL_REQUEST_TEMPLATE.md");
    expect(sources).toContain(".github/x.yml");
    expect(sources).not.toContain(".github/y.yaml"); // .yaml is not in the check:doc-links surface
  });

  it("skips node_modules / dist / .git subtrees (as check:doc-links does)", async () => {
    await write("docs/node_modules/x.md", "[d](../../design/decisions/foo-rfc.md)\n");
    await write("design/dist/y.md", "[d](../../design/decisions/foo-rfc.md)\n");
    await write("docs/.git/z.md", "[d](../../design/decisions/foo-rfc.md)\n");
    expect((await collectInboundLinks(cwd, TARGET)).items).toEqual([]);
  });
});

describe("collectInboundLinks — fail-closed issues", () => {
  it("a reference-style link to the target → unsupported_reference_style issue (not an item)", async () => {
    await write("docs/r.md", "Uses [foo][f].\n\n[f]: ../design/decisions/foo-rfc.md\n");
    const { items, issues } = await collectInboundLinks(cwd, TARGET);
    expect(items).toEqual([]);
    expect(issues).toEqual([
      { source_file: "docs/r.md", line: 3, reason: "unsupported_reference_style" },
    ]);
  });

  it("a markdown link to the target INSIDE PRUNED.md is protected (issue, never a delink item)", async () => {
    await write("design/decisions/PRUNED.md", "# Ledger\n\n| Decision |\n| --- |\n| [foo](foo-rfc.md) |\n");
    const { items, issues } = await collectInboundLinks(cwd, TARGET);
    expect(items).toEqual([]); // the append-only ledger is never rewritten
    expect(issues).toContainEqual({
      source_file: "design/decisions/PRUNED.md",
      line: 5,
      reason: "protected_ledger",
    });
  });

  it("a code-span / bare path in PRUNED.md is NOT a link → no issue", async () => {
    await write(
      "design/decisions/PRUNED.md",
      "# Ledger\n\n| Decision | Pruned |\n| --- | --- |\n| `design/decisions/foo-rfc.md` | 2026-06-08 |\n",
    );
    expect(await collectInboundLinks(cwd, TARGET)).toEqual({ items: [], issues: [] });
  });

  it("a reference-style definition INSIDE a fenced code block is an example — not an issue", async () => {
    await write("docs/ex.md", "# E\n\n```md\n[f]: ../design/decisions/foo-rfc.md\n```\n");
    expect(await collectInboundLinks(cwd, TARGET)).toEqual({ items: [], issues: [] });
  });

  it("an unreadable source directory → unreadable issue (strict walk, not a silent skip)", async () => {
    // `docs` exists but is a FILE, so readdir fails with ENOTDIR (≠ ENOENT).
    await write("docs", "not a directory");
    const { issues } = await collectInboundLinks(cwd, TARGET);
    expect(issues).toContainEqual({ source_file: "docs", line: null, reason: "unreadable" });
  });

  it("a source root that symlink-escapes the repo → unreadable issue (no external read)", async () => {
    const outside = await mkdtemp(join(tmpdir(), "code-pact-outside-"));
    await writeFile(join(outside, "x.md"), "[d](../design/decisions/foo-rfc.md)\n");
    await symlink(outside, join(cwd, "docs")); // docs -> /outside
    const { items, issues } = await collectInboundLinks(cwd, TARGET);
    expect(items).toEqual([]); // never read the external file
    expect(issues).toContainEqual({ source_file: "docs", line: null, reason: "unreadable" });
    await rm(outside, { recursive: true, force: true });
  });
});
