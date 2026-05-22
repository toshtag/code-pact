export type ParserWarningCode =
  | "heading_level_dropped"
  | "bullet_without_checkbox_dropped"
  | "numbered_list_dropped"
  | "checked_task_dropped"
  | "checkbox_outside_section_dropped"
  | "frontmatter_dropped"
  | "code_block_dropped"
  | "html_comment_dropped"
  | "table_row_dropped";

export interface ParserWarning {
  code: ParserWarningCode;
  line: number;
  detail?: string;
}

export interface ParsedSection {
  title: string;
  tasks: string[];
}

export interface ParseResult {
  sections: ParsedSection[];
  warnings: ParserWarning[];
  skipped_lines: number;
}

const FRONTMATTER_DELIMITER = /^---\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
const CHECKBOX_RE = /^\s*-\s+\[( |x|X)\](?:\s+(.*))?$/;
const PLAIN_BULLET_RE = /^\s*-\s+\S/;
const NUMBERED_RE = /^\s*\d+\.\s+\S/;
const HTML_COMMENT_OPEN = /<!--/;
const HTML_COMMENT_CLOSE = /-->/;
const CODE_FENCE = /^\s*```/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

export function parseTasksMd(input: string): ParseResult {
  const lines = input.split(/\r\n|\n|\r/);
  const sections: ParsedSection[] = [];
  const warnings: ParserWarning[] = [];
  let skipped = 0;

  let current: ParsedSection | null = null;
  let inFrontmatter = false;
  let frontmatterClosed = false;
  let inCodeFence = false;
  let inHtmlComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const lineNo = i + 1;
    const line = raw.replace(/\s+$/, "");

    if (!frontmatterClosed && i === 0 && FRONTMATTER_DELIMITER.test(line)) {
      inFrontmatter = true;
      skipped++;
      warnings.push({ code: "frontmatter_dropped", line: lineNo });
      continue;
    }
    if (inFrontmatter) {
      skipped++;
      warnings.push({ code: "frontmatter_dropped", line: lineNo });
      if (FRONTMATTER_DELIMITER.test(line)) {
        inFrontmatter = false;
        frontmatterClosed = true;
      }
      continue;
    }

    if (CODE_FENCE.test(line)) {
      inCodeFence = !inCodeFence;
      skipped++;
      warnings.push({ code: "code_block_dropped", line: lineNo });
      continue;
    }
    if (inCodeFence) {
      skipped++;
      warnings.push({ code: "code_block_dropped", line: lineNo });
      continue;
    }

    if (inHtmlComment) {
      skipped++;
      warnings.push({ code: "html_comment_dropped", line: lineNo });
      if (HTML_COMMENT_CLOSE.test(line)) inHtmlComment = false;
      continue;
    }
    if (HTML_COMMENT_OPEN.test(line)) {
      skipped++;
      warnings.push({ code: "html_comment_dropped", line: lineNo });
      if (!HTML_COMMENT_CLOSE.test(line)) inHtmlComment = true;
      continue;
    }

    if (line.trim().length === 0) continue;

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const level = (headingMatch[1] ?? "").length;
      const title = headingMatch[2] ?? "";
      if (level === 3) {
        current = { title, tasks: [] };
        sections.push(current);
      } else {
        current = null;
        skipped++;
        warnings.push({
          code: "heading_level_dropped",
          line: lineNo,
          detail: `h${level}`,
        });
      }
      continue;
    }

    const checkboxMatch = line.match(CHECKBOX_RE);
    if (checkboxMatch) {
      const mark = checkboxMatch[1];
      const text = (checkboxMatch[2] ?? "").trim();
      if (mark === "x" || mark === "X") {
        skipped++;
        warnings.push({ code: "checked_task_dropped", line: lineNo });
        continue;
      }
      if (!current) {
        skipped++;
        warnings.push({
          code: "checkbox_outside_section_dropped",
          line: lineNo,
        });
        continue;
      }
      if (text.length === 0) {
        skipped++;
        warnings.push({
          code: "bullet_without_checkbox_dropped",
          line: lineNo,
          detail: "empty_task_text",
        });
        continue;
      }
      current.tasks.push(text);
      continue;
    }

    if (PLAIN_BULLET_RE.test(line)) {
      skipped++;
      warnings.push({ code: "bullet_without_checkbox_dropped", line: lineNo });
      continue;
    }

    if (NUMBERED_RE.test(line)) {
      skipped++;
      warnings.push({ code: "numbered_list_dropped", line: lineNo });
      continue;
    }

    if (TABLE_ROW.test(line)) {
      skipped++;
      warnings.push({ code: "table_row_dropped", line: lineNo });
      continue;
    }

    skipped++;
  }

  return { sections, warnings, skipped_lines: skipped };
}
