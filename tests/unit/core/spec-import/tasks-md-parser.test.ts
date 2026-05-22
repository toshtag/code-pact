import { describe, expect, it } from "vitest";

import { parseTasksMd } from "../../../../src/core/spec-import/tasks-md-parser.js";

describe("parseTasksMd", () => {
  it("returns empty result for empty input", () => {
    const result = parseTasksMd("");
    expect(result.sections).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.skipped_lines).toBe(0);
  });

  it("parses a single section with checkbox tasks", () => {
    const md = ["### Setup", "", "- [ ] Install deps", "- [ ] Configure env"].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([
      { title: "Setup", tasks: ["Install deps", "Configure env"] },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.skipped_lines).toBe(0);
  });

  it("parses multiple sections", () => {
    const md = [
      "### Phase 1",
      "- [ ] Task A",
      "",
      "### Phase 2",
      "- [ ] Task B",
      "- [ ] Task C",
    ].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([
      { title: "Phase 1", tasks: ["Task A"] },
      { title: "Phase 2", tasks: ["Task B", "Task C"] },
    ]);
  });

  it("only-headings input produces sections with empty task lists", () => {
    const md = "### A\n\n### B\n";
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([
      { title: "A", tasks: [] },
      { title: "B", tasks: [] },
    ]);
  });

  it("checkbox without preceding section is dropped with warning", () => {
    const md = "- [ ] orphan task";
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([]);
    expect(result.skipped_lines).toBe(1);
    expect(result.warnings).toEqual([
      { code: "checkbox_outside_section_dropped", line: 1 },
    ]);
  });

  it("checked tasks are skipped with warning", () => {
    const md = ["### S", "- [x] done already", "- [X] also done", "- [ ] pending"].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([{ title: "S", tasks: ["pending"] }]);
    expect(result.skipped_lines).toBe(2);
    expect(result.warnings).toEqual([
      { code: "checked_task_dropped", line: 2 },
      { code: "checked_task_dropped", line: 3 },
    ]);
  });

  it("non-H3 headings reset current section and are warned", () => {
    const md = [
      "# Title",
      "## Subtitle",
      "### Real section",
      "- [ ] keeper",
      "#### inner",
      "- [ ] orphan after h4",
    ].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([{ title: "Real section", tasks: ["keeper"] }]);
    expect(result.warnings.some((w) => w.code === "heading_level_dropped" && w.detail === "h1")).toBe(true);
    expect(result.warnings.some((w) => w.code === "heading_level_dropped" && w.detail === "h2")).toBe(true);
    expect(result.warnings.some((w) => w.code === "heading_level_dropped" && w.detail === "h4")).toBe(true);
    expect(result.warnings.some((w) => w.code === "checkbox_outside_section_dropped")).toBe(true);
  });

  it("plain bullet lines drop with warning", () => {
    const md = ["### S", "- not a checkbox", "- [ ] real task"].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([{ title: "S", tasks: ["real task"] }]);
    expect(result.warnings).toContainEqual({
      code: "bullet_without_checkbox_dropped",
      line: 2,
    });
  });

  it("numbered list lines drop with warning", () => {
    const md = ["### S", "1. first", "- [ ] real task"].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([{ title: "S", tasks: ["real task"] }]);
    expect(result.warnings).toContainEqual({ code: "numbered_list_dropped", line: 2 });
  });

  it("frontmatter at file head is dropped with warnings", () => {
    const md = ["---", "title: spec", "---", "### S", "- [ ] task"].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([{ title: "S", tasks: ["task"] }]);
    expect(result.warnings.filter((w) => w.code === "frontmatter_dropped").length).toBe(3);
  });

  it("code fences are dropped between markers", () => {
    const md = ["### S", "```", "code in here", "```", "- [ ] task"].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([{ title: "S", tasks: ["task"] }]);
    expect(result.warnings.filter((w) => w.code === "code_block_dropped").length).toBe(3);
  });

  it("table rows are dropped with warning", () => {
    const md = ["### S", "| a | b |", "|---|---|", "| 1 | 2 |", "- [ ] task"].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([{ title: "S", tasks: ["task"] }]);
    expect(result.warnings.filter((w) => w.code === "table_row_dropped").length).toBe(3);
  });

  it("HTML comments single and multi-line are dropped", () => {
    const md = ["### S", "<!-- single -->", "<!--", "multi", "-->", "- [ ] task"].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([{ title: "S", tasks: ["task"] }]);
    expect(result.warnings.filter((w) => w.code === "html_comment_dropped").length).toBe(4);
  });

  it("Unicode in task text is preserved verbatim", () => {
    const md = "### セクション\n- [ ] 設計レビューを実施する 🚀";
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([
      { title: "セクション", tasks: ["設計レビューを実施する 🚀"] },
    ]);
  });

  it("Windows line endings parse identically", () => {
    const md = "### S\r\n- [ ] task A\r\n- [ ] task B\r\n";
    const result = parseTasksMd(md);
    expect(result.sections).toEqual([{ title: "S", tasks: ["task A", "task B"] }]);
  });

  it("mixed line endings parse correctly", () => {
    const md = "### S\n- [ ] A\r\n- [ ] B\r- [ ] C\n";
    const result = parseTasksMd(md);
    expect(result.sections[0]?.tasks).toEqual(["A", "B", "C"]);
  });

  it("empty checkbox text is skipped with warning", () => {
    const md = ["### S", "- [ ] ", "- [ ] real"].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections[0]?.tasks).toEqual(["real"]);
    expect(result.warnings).toContainEqual({
      code: "bullet_without_checkbox_dropped",
      line: 2,
      detail: "empty_task_text",
    });
  });

  it("preserves task ordering across sections", () => {
    const md = [
      "### One",
      "- [ ] alpha",
      "- [ ] beta",
      "### Two",
      "- [ ] gamma",
    ].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections[0]?.tasks).toEqual(["alpha", "beta"]);
    expect(result.sections[1]?.tasks).toEqual(["gamma"]);
  });

  it("malformed checkbox like '- [] task' is treated as plain bullet", () => {
    const md = ["### S", "- [] missing space", "- [ ] real"].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections[0]?.tasks).toEqual(["real"]);
    expect(result.warnings.some((w) => w.code === "bullet_without_checkbox_dropped")).toBe(true);
  });

  it("skipped_lines equals total dropped lines", () => {
    const md = [
      "# title",
      "## sub",
      "### keep",
      "- [ ] kept",
      "- not checkbox",
      "1. number",
    ].join("\n");
    const result = parseTasksMd(md);
    expect(result.sections[0]?.tasks).toEqual(["kept"]);
    expect(result.skipped_lines).toBe(4);
  });
});
