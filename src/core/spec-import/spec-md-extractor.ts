export interface BriefCandidates {
  what?: string;
  who?: string;
  differentiator?: string;
}

export interface ConstitutionCandidates {
  description?: string;
  principles?: string[];
}

export interface SpecMdExtractResult {
  brief_candidates: BriefCandidates;
  constitution_candidates: ConstitutionCandidates;
  recognised_sections: string[];
  skipped_sections: string[];
}

interface Section {
  title: string;
  normalised: string;
  body: string[];
}

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;

const BRIEF_WHAT_HEADINGS = new Set([
  "problem statement",
  "problem",
  "what",
  "overview",
  "summary",
  "goal",
  "goals",
  "objective",
  "objectives",
]);

const BRIEF_WHO_HEADINGS = new Set([
  "audience",
  "users",
  "user persona",
  "user personas",
  "personas",
  "stakeholders",
  "who",
  "target users",
]);

const BRIEF_DIFFERENTIATOR_HEADINGS = new Set([
  "differentiator",
  "differentiation",
  "why now",
  "value proposition",
  "unique value",
  "positioning",
]);

const CONSTITUTION_DESCRIPTION_HEADINGS = new Set([
  "background",
  "context",
  "rationale",
  "motivation",
  "vision",
  "philosophy",
]);

const CONSTITUTION_PRINCIPLES_HEADINGS = new Set([
  "principles",
  "constraints",
  "tenets",
  "non-goals",
  "non goals",
  "guidelines",
  "design principles",
  "guiding principles",
]);

export function extractSpecMd(input: string): SpecMdExtractResult {
  const sections = parseSections(input);

  const brief: BriefCandidates = {};
  const constitution: ConstitutionCandidates = {};
  const recognised: string[] = [];
  const skipped: string[] = [];

  for (const section of sections) {
    if (BRIEF_WHAT_HEADINGS.has(section.normalised)) {
      if (brief.what === undefined) brief.what = paragraph(section.body);
      recognised.push(section.title);
      continue;
    }
    if (BRIEF_WHO_HEADINGS.has(section.normalised)) {
      if (brief.who === undefined) brief.who = paragraph(section.body);
      recognised.push(section.title);
      continue;
    }
    if (BRIEF_DIFFERENTIATOR_HEADINGS.has(section.normalised)) {
      if (brief.differentiator === undefined) brief.differentiator = paragraph(section.body);
      recognised.push(section.title);
      continue;
    }
    if (CONSTITUTION_DESCRIPTION_HEADINGS.has(section.normalised)) {
      if (constitution.description === undefined) constitution.description = paragraph(section.body);
      recognised.push(section.title);
      continue;
    }
    if (CONSTITUTION_PRINCIPLES_HEADINGS.has(section.normalised)) {
      const items = bulletItems(section.body);
      if (items.length > 0 && constitution.principles === undefined) {
        constitution.principles = items;
      }
      recognised.push(section.title);
      continue;
    }
    skipped.push(section.title);
  }

  return {
    brief_candidates: brief,
    constitution_candidates: constitution,
    recognised_sections: recognised,
    skipped_sections: skipped,
  };
}

function parseSections(input: string): Section[] {
  const lines = input.split(/\r\n|\n|\r/);
  const out: Section[] = [];
  let current: Section | null = null;
  let inCodeFence = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      if (current) current.body.push(line);
      continue;
    }
    if (inCodeFence) {
      if (current) current.body.push(line);
      continue;
    }
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const title = headingMatch[2] ?? "";
      current = { title, normalised: normaliseHeading(title), body: [] };
      out.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  return out;
}

function normaliseHeading(title: string): string {
  return title
    .toLowerCase()
    .replace(/[#*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function paragraph(body: string[]): string {
  const lines: string[] = [];
  for (const raw of body) {
    const line = raw.trim();
    if (line.length === 0) {
      if (lines.length > 0) break;
      continue;
    }
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      if (lines.length === 0) {
        lines.push(line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""));
        continue;
      }
      break;
    }
    lines.push(line);
  }
  return lines.join(" ").trim();
}

function bulletItems(body: string[]): string[] {
  const items: string[] = [];
  for (const raw of body) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = line.match(/^[-*]\s+(.*\S)/);
    if (m && m[1]) {
      items.push(m[1].trim());
      continue;
    }
    const num = line.match(/^\d+\.\s+(.*\S)/);
    if (num && num[1]) {
      items.push(num[1].trim());
    }
  }
  return items;
}
