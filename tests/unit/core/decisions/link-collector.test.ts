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

describe("collectInboundLinks", () => {
  it("returns [] when nothing links to the target", async () => {
    await write("docs/x.md", "# X\n\nno links here.");
    expect(await collectInboundLinks(cwd, TARGET)).toEqual([]);
  });

  it("an inline body link → inline / delink, with line + raw_href (resolved relative to the source dir)", async () => {
    await write("docs/concepts/foo.md", "# Foo\n\nl1\nSee [d](../../design/decisions/foo-rfc.md).\n");
    const items = await collectInboundLinks(cwd, TARGET);
    expect(items).toEqual([
      {
        source_file: "docs/concepts/foo.md",
        line: 4,
        raw_href: "../../design/decisions/foo-rfc.md",
        normalized_target: TARGET,
        link_kind: "inline",
        rewrite_action: "delink",
      },
    ]);
  });

  it("a README decision-index row → index_row / tombstone", async () => {
    await write("design/decisions/README.md", "# Index\n\n| D | W |\n| --- | --- |\n| [Foo](foo-rfc.md) | x |\n");
    const items = await collectInboundLinks(cwd, TARGET);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source_file: "design/decisions/README.md",
      link_kind: "index_row",
      rewrite_action: "tombstone",
    });
  });

  it("a reference-style definition → reference_definition / delink", async () => {
    await write("docs/r.md", "# R\n\nUses [foo][f].\n\n[f]: ../design/decisions/foo-rfc.md\n");
    const items = await collectInboundLinks(cwd, TARGET);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ link_kind: "reference_definition", rewrite_action: "delink", line: 5 });
  });

  it("a link inside a fenced code block → leave_as_is (it is an example)", async () => {
    await write(
      "docs/ex.md",
      "# Ex\n\n```md\nSee [d](../design/decisions/foo-rfc.md)\n```\n",
    );
    const items = await collectInboundLinks(cwd, TARGET);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ rewrite_action: "leave_as_is", link_kind: "inline" });
  });

  it("raw_href is the destination token only — excludes an optional title, preserves <…>", async () => {
    await write("docs/t.md", `[a](<../design/decisions/foo-rfc.md> "the title")\n`);
    const items = await collectInboundLinks(cwd, TARGET);
    expect(items[0]?.raw_href).toBe("<../design/decisions/foo-rfc.md>");
    expect(items[0]?.normalized_target).toBe(TARGET);
  });

  it("ignores .md outside the doc surface, and the target file itself", async () => {
    await write("somewhere/else/note.md", "[d](../../design/decisions/foo-rfc.md)\n");
    await write(TARGET, "[self](foo-rfc.md)\n"); // self-link in the target — skipped
    expect(await collectInboundLinks(cwd, TARGET)).toEqual([]);
  });

  it("does not match a different decision (dir-relative resolution is precise)", async () => {
    await write("docs/o.md", "[other](../design/decisions/bar-rfc.md)\n");
    expect(await collectInboundLinks(cwd, TARGET)).toEqual([]);
  });
});
