import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeMarkdownContent,
  normalizeYamlContent,
  runNormalize,
} from "../../../../src/core/plan/normalize.ts";

describe("normalizeYamlContent", () => {
  it("returns the input unchanged when already normalized", () => {
    const input = "id: P1\nname: P1\n";
    const result = normalizeYamlContent(input);
    expect(result.content).toBe(input);
    expect(result.reasons).toEqual([]);
  });

  it("converts CRLF and CR to LF", () => {
    const input = "id: P1\r\nname: P1\r\n";
    const result = normalizeYamlContent(input);
    expect(result.content).toBe("id: P1\nname: P1\n");
    expect(result.reasons).toContain("crlf");
  });

  it("strips trailing whitespace per line", () => {
    const input = "id: P1   \nname: P1\t\n";
    const result = normalizeYamlContent(input);
    expect(result.content).toBe("id: P1\nname: P1\n");
    expect(result.reasons).toContain("trailing whitespace");
  });

  it("collapses multiple trailing newlines to exactly one", () => {
    const input = "id: P1\n\n\n";
    const result = normalizeYamlContent(input);
    expect(result.content).toBe("id: P1\n");
    expect(result.reasons).toContain("final newline");
  });

  it("adds a missing trailing newline", () => {
    const input = "id: P1";
    const result = normalizeYamlContent(input);
    expect(result.content).toBe("id: P1\n");
    expect(result.reasons).toContain("final newline");
  });

  // CRITICAL property: line-based normalization must never destroy
  // YAML comments. Mangling a comment is a worse user experience than
  // leaving a tab at end of line.
  it("preserves YAML comments byte-for-byte", () => {
    const input =
      "# top-level comment\nid: P1  # inline note\nname: P1\n# trailing comment\n";
    const result = normalizeYamlContent(input);
    expect(result.content).toContain("# top-level comment");
    expect(result.content).toContain("# inline note");
    expect(result.content).toContain("# trailing comment");
  });

  it("is idempotent: normalize(normalize(x)) === normalize(x)", () => {
    const dirty = "id: P1   \r\nname: P1\t\r\n\r\n";
    const once = normalizeYamlContent(dirty);
    const twice = normalizeYamlContent(once.content);
    expect(twice.content).toBe(once.content);
    expect(twice.reasons).toEqual([]);
  });
});

describe("normalizeMarkdownContent", () => {
  it("converts CRLF to LF", () => {
    const input = "line 1\r\nline 2\r\n";
    const result = normalizeMarkdownContent(input);
    expect(result.content).toBe("line 1\nline 2\n");
    expect(result.reasons).toContain("crlf");
  });

  it("adds a missing trailing newline", () => {
    const input = "line 1";
    const result = normalizeMarkdownContent(input);
    expect(result.content).toBe("line 1\n");
  });

  // CRITICAL property: two trailing spaces are a meaningful Markdown
  // hard line break. Stripping them would silently change rendered
  // output, so normalizeMarkdownContent must leave them alone.
  it("preserves trailing two-space hard line breaks", () => {
    const input = "line 1  \nline 2\n";
    const result = normalizeMarkdownContent(input);
    expect(result.content).toBe("line 1  \nline 2\n");
    expect(result.reasons).toEqual([]);
  });

  it("preserves trailing single spaces too (we cannot know intent)", () => {
    const input = "line 1 \nline 2\n";
    const result = normalizeMarkdownContent(input);
    expect(result.content).toBe(input);
  });

  it("is idempotent", () => {
    const dirty = "line 1\r\nline 2\r\n\r\n";
    const once = normalizeMarkdownContent(dirty);
    const twice = normalizeMarkdownContent(once.content);
    expect(twice.content).toBe(once.content);
  });
});

describe("runNormalize", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "code-pact-normalize-"));
    await mkdir(join(cwd, "design", "phases"), { recursive: true });
  });

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it("reports zero changes for an already-normalized tree", async () => {
    await writeFile(
      join(cwd, "design", "roadmap.yaml"),
      "phases: []\n",
      "utf8",
    );
    const result = await runNormalize({ cwd, mode: "check" });
    expect(result.changes).toEqual([]);
    expect(result.written).toEqual([]);
  });

  it("check mode never writes, even when files would change", async () => {
    const path = join(cwd, "design", "roadmap.yaml");
    const dirty = "phases: []  \n\n\n";
    await writeFile(path, dirty, "utf8");

    const result = await runNormalize({ cwd, mode: "check" });
    expect(result.changes.length).toBe(1);
    expect(result.written).toEqual([]);

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toBe(dirty);
  });

  it("write mode rewrites only the files that need it", async () => {
    const dirtyPath = join(cwd, "design", "phases", "P1.yaml");
    const cleanPath = join(cwd, "design", "phases", "P2.yaml");
    await writeFile(dirtyPath, "id: P1  \n", "utf8");
    await writeFile(cleanPath, "id: P2\n", "utf8");

    const result = await runNormalize({ cwd, mode: "write" });
    expect(result.changes.length).toBe(1);
    expect(result.written).toEqual([
      `design/phases/${"P1.yaml"}`,
    ]);

    expect(await readFile(dirtyPath, "utf8")).toBe("id: P1\n");
    expect(await readFile(cleanPath, "utf8")).toBe("id: P2\n");
  });

  it("a second write is a no-op (idempotency)", async () => {
    await writeFile(
      join(cwd, "design", "phases", "P1.yaml"),
      "id: P1  \n\n\n",
      "utf8",
    );

    const first = await runNormalize({ cwd, mode: "write" });
    expect(first.written.length).toBe(1);

    const second = await runNormalize({ cwd, mode: "write" });
    expect(second.changes).toEqual([]);
    expect(second.written).toEqual([]);
  });

  it("check after write reports a clean tree", async () => {
    await writeFile(
      join(cwd, "design", "phases", "P1.yaml"),
      "id: P1  \r\n",
      "utf8",
    );

    await runNormalize({ cwd, mode: "write" });
    const check = await runNormalize({ cwd, mode: "check" });
    expect(check.changes).toEqual([]);
  });

  it("preserves YAML comments end-to-end through --write", async () => {
    const path = join(cwd, "design", "phases", "P1.yaml");
    const original =
      "# Comment kept\nid: P1\n# Another comment  \nname: P1\n";
    await writeFile(path, original, "utf8");

    await runNormalize({ cwd, mode: "write" });
    const after = await readFile(path, "utf8");
    expect(after).toContain("# Comment kept");
    expect(after).toContain("# Another comment");
  });

  it("preserves Markdown hard line breaks end-to-end through --write", async () => {
    const path = join(cwd, "design", "notes.md");
    const original = "line 1  \nline 2\r\n";
    await writeFile(path, original, "utf8");

    await runNormalize({ cwd, mode: "write" });
    const after = await readFile(path, "utf8");
    expect(after).toBe("line 1  \nline 2\n");
  });

  it("does not blow up on a project without a design directory", async () => {
    await rm(join(cwd, "design"), { recursive: true });
    const result = await runNormalize({ cwd, mode: "check" });
    expect(result.changes).toEqual([]);
  });
});
