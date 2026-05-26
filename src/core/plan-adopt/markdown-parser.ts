// Narrow markdown list parser for `plan adopt` (Narrow MVP).
//
// Unlike spec-import's tasks-md-parser (which only recognises H3 sections
// and unchecked `- [ ]` items), this parser is meant to ingest the kind of
// structured plan an agent emits: phase-like headings plus a mix of
// checkbox, plain, and numbered bullets.
//
// Deliberately mechanical. It does NOT try to understand prose — narrative
// roadmaps whose "tasks" live in paragraphs or fenced code blocks will
// yield few or no tasks here, which is the honest signal that the deter-
// ministic path cannot adopt them (use `plan prompt --schema-only` + an
// agent instead). Plain bullets are treated as task candidates with no
// semantic filtering: a "Risks" or "Non-goals" list will be picked up as
// tasks, so callers MUST review the dry-run output before `--write`.

export type AdoptParserWarningCode = "CHECKED_TASK_SKIPPED";

export interface AdoptParserWarning {
  code: AdoptParserWarningCode;
  line: number;
}

export interface AdoptedTask {
  text: string;
  line: number;
}

export interface AdoptedPhase {
  /** Heading text that opened the phase; null for a purely-inferred phase. */
  title: string | null;
  /** True when the phase was NOT opened by a phase-marker heading. */
  inferred: boolean;
  /** First short paragraph after the heading, if any. */
  objectiveHint: string | null;
  tasks: AdoptedTask[];
  headingLine: number | null;
}

export interface AdoptMarkdownResult {
  /** Every phase block discovered, including ones with zero tasks. */
  phases: AdoptedPhase[];
  warnings: AdoptParserWarning[];
}

const FRONTMATTER_DELIMITER = /^---\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
const CHECKBOX_RE = /^\s*[-*]\s+\[( |x|X)\](?:\s+(.*))?$/;
const PLAIN_BULLET_RE = /^\s*[-*]\s+(\S.*)$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(\S.*)$/;
const HTML_COMMENT_OPEN = /<!--/;
const HTML_COMMENT_CLOSE = /-->/;
const CODE_FENCE = /^\s*```/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

// A heading opens a phase when its text names a phase-like unit. Matched
// case-insensitively against the heading title.
const PHASE_MARKER_RE = /\b(?:P\d+|phase\s+\d+|milestone|epic|sprint)\b/i;

// Objective hint capture: ignore paragraphs longer than this (a giant
// narrative block makes a poor objective; fall back to the import default).
const OBJECTIVE_MAX_LEN = 200;

export function parseAdoptMarkdown(input: string): AdoptMarkdownResult {
  const lines = input.split(/\r\n|\n|\r/);
  const phases: AdoptedPhase[] = [];
  const warnings: AdoptParserWarning[] = [];

  let current: AdoptedPhase | null = null;
  let inFrontmatter = false;
  let frontmatterClosed = false;
  let inCodeFence = false;
  let inHtmlComment = false;

  function ensureInferredPhase(): AdoptedPhase {
    // A task seen before any phase-marker heading lands in an implicit
    // inferred phase.
    if (current === null) {
      current = {
        title: null,
        inferred: true,
        objectiveHint: null,
        tasks: [],
        headingLine: null,
      };
      phases.push(current);
    }
    return current;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const lineNo = i + 1;
    const line = raw.replace(/\s+$/, "");

    // ---- skip-states: frontmatter, code fences, HTML comments ----
    if (!frontmatterClosed && i === 0 && FRONTMATTER_DELIMITER.test(line)) {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (FRONTMATTER_DELIMITER.test(line)) {
        inFrontmatter = false;
        frontmatterClosed = true;
      }
      continue;
    }
    if (CODE_FENCE.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (inHtmlComment) {
      if (HTML_COMMENT_CLOSE.test(line)) inHtmlComment = false;
      continue;
    }
    if (HTML_COMMENT_OPEN.test(line)) {
      if (!HTML_COMMENT_CLOSE.test(line)) inHtmlComment = true;
      continue;
    }

    if (line.trim().length === 0) continue;

    // ---- headings ----
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const title = headingMatch[2] ?? "";
      if (PHASE_MARKER_RE.test(title)) {
        current = {
          title,
          inferred: false,
          objectiveHint: null,
          tasks: [],
          headingLine: lineNo,
        };
        phases.push(current);
      }
      // A non-marker heading does not open a phase; tasks that follow keep
      // accruing to the current phase (or an inferred one).
      continue;
    }

    // ---- checkbox bullets (test before plain bullets) ----
    const checkboxMatch = line.match(CHECKBOX_RE);
    if (checkboxMatch) {
      const mark = checkboxMatch[1];
      const text = (checkboxMatch[2] ?? "").trim();
      if (mark === "x" || mark === "X") {
        warnings.push({ code: "CHECKED_TASK_SKIPPED", line: lineNo });
        continue;
      }
      if (text.length === 0) continue;
      ensureInferredPhase().tasks.push({ text, line: lineNo });
      continue;
    }

    // ---- plain bullets ----
    const bulletMatch = line.match(PLAIN_BULLET_RE);
    if (bulletMatch) {
      ensureInferredPhase().tasks.push({ text: (bulletMatch[1] ?? "").trim(), line: lineNo });
      continue;
    }

    // ---- numbered lists ----
    const numberedMatch = line.match(NUMBERED_RE);
    if (numberedMatch) {
      ensureInferredPhase().tasks.push({ text: (numberedMatch[1] ?? "").trim(), line: lineNo });
      continue;
    }

    if (TABLE_ROW.test(line)) continue;

    // ---- objective hint: first short paragraph after a phase heading ----
    if (
      current !== null &&
      !current.inferred &&
      current.objectiveHint === null &&
      current.tasks.length === 0 &&
      line.trim().length <= OBJECTIVE_MAX_LEN
    ) {
      current.objectiveHint = line.trim();
    }
  }

  return { phases, warnings };
}
