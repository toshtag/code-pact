import { describe, it, expect } from "vitest";
import { parseAdoptMarkdown } from "../../../../src/core/plan-adopt/markdown-parser.ts";

describe("parseAdoptMarkdown — phase-marker headings", () => {
  it("opens one phase per phase-marker heading and groups tasks under it", () => {
    const md = `# My Plan

## Phase 1: Foundations
Set up the core skeleton.

- Scaffold the package
- Define the schema

## Phase 2: Features
- Implement the CLI
`;
    const { phases } = parseAdoptMarkdown(md);
    expect(phases).toHaveLength(2);
    expect(phases[0]!.title).toContain("Phase 1");
    expect(phases[0]!.inferred).toBe(false);
    expect(phases[0]!.objectiveHint).toBe("Set up the core skeleton.");
    expect(phases[0]!.tasks.map((t) => t.text)).toEqual([
      "Scaffold the package",
      "Define the schema",
    ]);
    expect(phases[1]!.tasks.map((t) => t.text)).toEqual(["Implement the CLI"]);
  });

  it("recognises Milestone / Epic / Sprint / P1 markers", () => {
    for (const heading of ["## Milestone A", "### Epic: Auth", "## Sprint 3", "# P1 Core"]) {
      const { phases } = parseAdoptMarkdown(`${heading}\n- a task\n`);
      expect(phases).toHaveLength(1);
      expect(phases[0]!.inferred).toBe(false);
    }
  });

  it("does NOT open a phase for a non-marker heading", () => {
    const md = `## Overview\n- task under no phase marker\n`;
    const { phases } = parseAdoptMarkdown(md);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.inferred).toBe(true);
  });
});

describe("parseAdoptMarkdown — bullet / checkbox / numbered tasks", () => {
  it("captures unchecked checkbox, plain, and numbered bullets", () => {
    const md = `## Phase 1
- [ ] checkbox task
- dash task
* star task
1. numbered task
2) paren-numbered task
`;
    const { phases } = parseAdoptMarkdown(md);
    expect(phases[0]!.tasks.map((t) => t.text)).toEqual([
      "checkbox task",
      "dash task",
      "star task",
      "numbered task",
      "paren-numbered task",
    ]);
  });

  it("skips checked checkbox tasks with a CHECKED_TASK_SKIPPED warning", () => {
    const md = `## Phase 1
- [x] already done
- [ ] still open
`;
    const { phases, warnings } = parseAdoptMarkdown(md);
    expect(phases[0]!.tasks.map((t) => t.text)).toEqual(["still open"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("CHECKED_TASK_SKIPPED");
  });
});

describe("parseAdoptMarkdown — inferred single phase", () => {
  it("collects a flat task list (no phase headings) into one inferred phase", () => {
    const md = `# TODO

- first
- second
- third
`;
    const { phases } = parseAdoptMarkdown(md);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.inferred).toBe(true);
    expect(phases[0]!.title).toBeNull();
    expect(phases[0]!.tasks).toHaveLength(3);
  });
});

describe("parseAdoptMarkdown — ignored regions", () => {
  it("ignores fenced code blocks, frontmatter, and HTML comments", () => {
    const md = `---
title: ignored frontmatter
- not a task
---

## Phase 1
- real task

\`\`\`text
- fenced not a task
1. fenced not a task
\`\`\`

<!-- - commented not a task -->
`;
    const { phases } = parseAdoptMarkdown(md);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.tasks.map((t) => t.text)).toEqual(["real task"]);
  });

  it("returns no phases for prose with no list items", () => {
    const md = `# Narrative\n\nThis is a paragraph describing the work in prose.\n\nNo bullet lists here.\n`;
    const { phases } = parseAdoptMarkdown(md);
    expect(phases.every((p) => p.tasks.length === 0)).toBe(true);
  });
});
