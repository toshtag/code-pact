import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("a link in a fenced code block → leave_as_is", async () => {
    await write("docs/ex.md", "# E\n\n```md\n[d](../design/decisions/foo-rfc.md)\n```\n");
    const { items } = await collectInboundLinks(cwd, TARGET);
    expect(items).toHaveLength(1);
    expect(items[0]?.rewrite_action).toBe("leave_as_is");
  });

  it("raw_href is the destination token (preserves <…>, excludes title); raw_link keeps the title", async () => {
    await write("docs/t.md", `[a](<../design/decisions/foo-rfc.md> "the title")\n`);
    const { items } = await collectInboundLinks(cwd, TARGET);
    expect(items[0]?.raw_href).toBe("<../design/decisions/foo-rfc.md>");
    expect(items[0]?.raw_link).toBe(`[a](<../design/decisions/foo-rfc.md> "the title")`);
    expect(items[0]?.normalized_target).toBe(TARGET);
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

  it("DOES scan .github .md and .yml sources", async () => {
    await write(".github/PULL_REQUEST_TEMPLATE.md", "[d](../design/decisions/foo-rfc.md)\n");
    await write(".github/x.yml", "body: see [d](../design/decisions/foo-rfc.md)\n");
    const sources = (await collectInboundLinks(cwd, TARGET)).items.map((i) => i.source_file);
    expect(sources).toContain(".github/PULL_REQUEST_TEMPLATE.md");
    expect(sources).toContain(".github/x.yml");
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
});
