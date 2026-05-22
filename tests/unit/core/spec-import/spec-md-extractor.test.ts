import { describe, expect, it } from "vitest";

import { extractSpecMd } from "../../../../src/core/spec-import/spec-md-extractor.js";

describe("extractSpecMd", () => {
  it("returns empty result on empty input", () => {
    const r = extractSpecMd("");
    expect(r.brief_candidates).toEqual({});
    expect(r.constitution_candidates).toEqual({});
    expect(r.skipped_sections).toEqual([]);
    expect(r.recognised_sections).toEqual([]);
  });

  it("extracts what / who / differentiator from typical spec.md headings", () => {
    const md = [
      "# spec",
      "",
      "## Problem statement",
      "Teams need a deterministic control plane.",
      "",
      "## Audience",
      "Senior engineers working with AI coding agents.",
      "",
      "## Positioning",
      "Vendor-neutral, additive, deterministic CLI.",
      "",
    ].join("\n");
    const r = extractSpecMd(md);
    expect(r.brief_candidates.what).toBe("Teams need a deterministic control plane.");
    expect(r.brief_candidates.who).toBe("Senior engineers working with AI coding agents.");
    expect(r.brief_candidates.differentiator).toBe("Vendor-neutral, additive, deterministic CLI.");
    expect(r.recognised_sections).toEqual(["Problem statement", "Audience", "Positioning"]);
  });

  it("extracts description and principles for constitution.md", () => {
    const md = [
      "## Background",
      "Codebase is large.",
      "",
      "## Principles",
      "- Bias for additive change.",
      "- Avoid breaking the public contract.",
      "- Document decisions in RFCs.",
    ].join("\n");
    const r = extractSpecMd(md);
    expect(r.constitution_candidates.description).toBe("Codebase is large.");
    expect(r.constitution_candidates.principles).toEqual([
      "Bias for additive change.",
      "Avoid breaking the public contract.",
      "Document decisions in RFCs.",
    ]);
  });

  it("skipped_sections lists unrecognised headings", () => {
    const md = [
      "## Random",
      "Random content.",
      "",
      "## Implementation details",
      "Implementation details.",
    ].join("\n");
    const r = extractSpecMd(md);
    expect(r.brief_candidates).toEqual({});
    expect(r.constitution_candidates).toEqual({});
    expect(r.skipped_sections).toEqual(["Random", "Implementation details"]);
  });

  it("first match wins for duplicate headings", () => {
    const md = [
      "## Goal",
      "First.",
      "",
      "## Goal",
      "Second.",
    ].join("\n");
    const r = extractSpecMd(md);
    expect(r.brief_candidates.what).toBe("First.");
  });

  it("heading-level agnostic — h1 through h6 all parsed", () => {
    const md = ["#### Problem", "Inline detail."].join("\n");
    const r = extractSpecMd(md);
    expect(r.brief_candidates.what).toBe("Inline detail.");
  });

  it("collapses multi-line paragraph into one space-separated string", () => {
    const md = ["## Problem", "First sentence.", "Second sentence."].join("\n");
    const r = extractSpecMd(md);
    expect(r.brief_candidates.what).toBe("First sentence. Second sentence.");
  });

  it("stops paragraph at blank line", () => {
    const md = [
      "## Problem",
      "First paragraph only.",
      "",
      "Second paragraph dropped.",
    ].join("\n");
    const r = extractSpecMd(md);
    expect(r.brief_candidates.what).toBe("First paragraph only.");
  });

  it("ignores fenced code blocks under recognised heading", () => {
    const md = [
      "## Principles",
      "- Real principle.",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "- Second principle.",
    ].join("\n");
    const r = extractSpecMd(md);
    expect(r.constitution_candidates.principles).toEqual([
      "Real principle.",
      "Second principle.",
    ]);
  });

  it("supports Windows line endings", () => {
    const md = "## Audience\r\nUsers.\r\n";
    const r = extractSpecMd(md);
    expect(r.brief_candidates.who).toBe("Users.");
  });

  it("heading normalisation strips markdown punctuation and case", () => {
    const md = "## **Problem Statement**\nNormalised.";
    const r = extractSpecMd(md);
    expect(r.brief_candidates.what).toBe("Normalised.");
  });

  it("empty principles list does not emit principles field", () => {
    const md = ["## Principles", "", "Some prose, no bullets.", ""].join("\n");
    const r = extractSpecMd(md);
    expect(r.constitution_candidates.principles).toBeUndefined();
  });

  it("recognises Spec Kit goals heading as what", () => {
    const md = "## Goals\nBuild a deterministic control plane.";
    const r = extractSpecMd(md);
    expect(r.brief_candidates.what).toBe("Build a deterministic control plane.");
  });

  it("recognises constraints heading as principles when bulleted", () => {
    const md = ["## Constraints", "- No LLM API calls.", "- Vendor-neutral."].join("\n");
    const r = extractSpecMd(md);
    expect(r.constitution_candidates.principles).toEqual([
      "No LLM API calls.",
      "Vendor-neutral.",
    ]);
  });

  it("Unicode and emoji preserved in extracted text", () => {
    const md = "## 課題\n設計の一貫性を保つ 🛠️";
    const r = extractSpecMd(md);
    expect(r.skipped_sections).toContain("課題");
  });
});
