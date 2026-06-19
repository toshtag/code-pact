import { readFile, stat } from "node:fs/promises";
import { stringify as stringifyYaml } from "yaml";

import { atomicWriteText } from "../io/atomic-text.ts";
import { assertSafeRelativePath, resolveWithinProject } from "../core/path-safety.ts";
import { type SpecImportDetail } from "../contracts/spec-import-details.ts";
import { parseTasksMd, type ParserWarning } from "../core/spec-import/tasks-md-parser.ts";
import {
  extractSpecMd,
  type BriefCandidates,
  type ConstitutionCandidates,
} from "../core/spec-import/spec-md-extractor.ts";

// The `data.detail` enum is the typed catalog in src/contracts/spec-import-details.ts
// (kept side-effect-free so the doc generator can read it without dragging this
// handler's deps into check:docs). The runtime consumes it here and in
// src/cli/commands/spec.ts (the two config-layer literals are tied back via
// `satisfies SpecImportDetail`).
export class SpecImportError extends Error {
  readonly detail: SpecImportDetail;
  readonly sourcePath?: string;
  readonly phaseId?: string;
  constructor(detail: SpecImportDetail, message: string, ctx?: { sourcePath?: string; phaseId?: string }) {
    super(message);
    this.name = "SpecImportError";
    this.detail = detail;
    this.sourcePath = ctx?.sourcePath;
    this.phaseId = ctx?.phaseId;
  }
}

export interface SpecImportOptions {
  cwd: string;
  fromPath: string;
  phaseId: string;
  write: boolean;
  force: boolean;
}

export interface SpecImportResult {
  kind: "would_import" | "imported";
  source_path: string;
  phase_id: string;
  sections_imported: number;
  tasks_imported: number;
  skipped_lines: number;
  output_path: string | null;
  phase_yaml: string;
  warnings: string[];
}

const PHASE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

async function resolveSpecPath(
  cwd: string,
  relPath: string,
  ctx: { sourcePath?: string; phaseId?: string; purpose: "input" | "output" },
): Promise<string> {
  try {
    return await resolveWithinProject(cwd, relPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "PATH_OUTSIDE_PROJECT") {
      throw new SpecImportError(
        "unsafe_path",
        `spec import: ${ctx.purpose} path is unsafe: ${(err as Error).message}`,
        { sourcePath: ctx.sourcePath, phaseId: ctx.phaseId },
      );
    }
    throw err;
  }
}

export async function runSpecImport(opts: SpecImportOptions): Promise<SpecImportResult> {
  const { cwd, fromPath, phaseId, write, force } = opts;

  try {
    assertSafeRelativePath(fromPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SpecImportError("unsafe_path", `spec import: --from path is unsafe: ${msg}`, {
      sourcePath: fromPath,
      phaseId,
    });
  }

  if (!PHASE_ID_RE.test(phaseId)) {
    throw new SpecImportError(
      "phase_id_invalid",
      `spec import: --phase-id "${phaseId}" must match /^[A-Za-z][A-Za-z0-9_-]*$/`,
      { sourcePath: fromPath, phaseId },
    );
  }

  const absInput = await resolveSpecPath(cwd, fromPath, {
    sourcePath: fromPath,
    phaseId,
    purpose: "input",
  });
  let raw: string;
  try {
    raw = await readFile(absInput, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SpecImportError("file_not_found", `spec import: file not found: ${fromPath}`, {
        sourcePath: fromPath,
        phaseId,
      });
    }
    throw new SpecImportError(
      "unreadable",
      `spec import: cannot read ${fromPath}: ${err instanceof Error ? err.message : String(err)}`,
      { sourcePath: fromPath, phaseId },
    );
  }

  const parsed = parseTasksMd(raw);
  if (parsed.sections.length === 0) {
    throw new SpecImportError(
      "no_sections_parsed",
      `spec import: no Heading 3 sections recognised in ${fromPath} (supported subset: \`### Section\` + \`- [ ]\` items)`,
      { sourcePath: fromPath, phaseId },
    );
  }

  const tasksTotal = parsed.sections.reduce((acc, s) => acc + s.tasks.length, 0);

  const phaseYamlObj = buildPhaseObject({
    phaseId,
    sourcePath: fromPath,
    sections: parsed.sections,
  });
  const phaseYaml = stringifyYaml(phaseYamlObj);

  const outputRel = `design/phases/${phaseId}-imported.yaml`;
  const outputAbs = await resolveSpecPath(cwd, outputRel, {
    sourcePath: fromPath,
    phaseId,
    purpose: "output",
  });

  if (write) {
    if (!force) {
      try {
        await stat(outputAbs);
        throw new SpecImportError(
          "phase_yaml_exists",
          `spec import: ${outputRel} already exists. Re-run with --force to overwrite.`,
          { sourcePath: fromPath, phaseId },
        );
      } catch (err) {
        if (err instanceof SpecImportError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw new SpecImportError(
            "unreadable",
            `spec import: cannot stat ${outputRel}: ${err instanceof Error ? err.message : String(err)}`,
            { sourcePath: fromPath, phaseId },
          );
        }
      }
    }
    await atomicWriteText(outputAbs, phaseYaml);
  }

  return {
    kind: write ? "imported" : "would_import",
    source_path: fromPath,
    phase_id: phaseId,
    sections_imported: parsed.sections.length,
    tasks_imported: tasksTotal,
    skipped_lines: parsed.skipped_lines,
    output_path: write ? outputRel : null,
    phase_yaml: phaseYaml,
    warnings: summariseWarnings(parsed.warnings),
  };
}

interface BuildPhaseArgs {
  phaseId: string;
  sourcePath: string;
  sections: { title: string; tasks: string[] }[];
}

function buildPhaseObject(args: BuildPhaseArgs): Record<string, unknown> {
  const tasks: Record<string, unknown>[] = [];
  let n = 1;
  for (const section of args.sections) {
    for (const description of section.tasks) {
      tasks.push({
        id: `${args.phaseId}-T${n}`,
        type: "feature",
        ambiguity: "medium",
        risk: "medium",
        context_size: "medium",
        write_surface: "medium",
        verification_strength: "medium",
        expected_duration: "medium",
        status: "planned",
        description: `[${section.title}] ${description}`,
      });
      n++;
    }
  }

  return {
    id: args.phaseId,
    name: args.phaseId,
    weight: 20,
    confidence: "medium",
    risk: "medium",
    status: "planned",
    objective: `Imported from ${args.sourcePath} via \`code-pact spec import\`. Review the objective, non_goals, definition_of_done, and verification commands before merging this phase.`,
    definition_of_done: [
      "Review the imported tasks and adjust types / fields to match the project's reality",
      "Add reads / writes / acceptance_refs to each task before implementation",
    ],
    verification: {
      commands: ["pnpm test"],
    },
    tasks,
  };
}

function summariseWarnings(warnings: ParserWarning[]): string[] {
  if (warnings.length === 0) return [];
  const counts = new Map<string, number>();
  for (const w of warnings) {
    counts.set(w.code, (counts.get(w.code) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const [code, count] of counts) {
    out.push(`${code}: ${count} line(s)`);
  }
  return out;
}

export interface SpecSuggestOptions {
  cwd: string;
  suggestFromPath: string;
}

export interface SpecSuggestResult {
  source_path: string;
  brief_candidates: BriefCandidates;
  constitution_candidates: ConstitutionCandidates;
  recognised_sections: string[];
  skipped_sections: string[];
}

export async function runSpecSuggest(opts: SpecSuggestOptions): Promise<SpecSuggestResult> {
  const { cwd, suggestFromPath } = opts;

  try {
    assertSafeRelativePath(suggestFromPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SpecImportError(
      "unsafe_path",
      `spec import: --suggest-from path is unsafe: ${msg}`,
      { sourcePath: suggestFromPath },
    );
  }

  const absInput = await resolveSpecPath(cwd, suggestFromPath, {
    sourcePath: suggestFromPath,
    purpose: "input",
  });
  let raw: string;
  try {
    raw = await readFile(absInput, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SpecImportError(
        "file_not_found",
        `spec import: file not found: ${suggestFromPath}`,
        { sourcePath: suggestFromPath },
      );
    }
    throw new SpecImportError(
      "unreadable",
      `spec import: cannot read ${suggestFromPath}: ${err instanceof Error ? err.message : String(err)}`,
      { sourcePath: suggestFromPath },
    );
  }

  const extracted = extractSpecMd(raw);
  return {
    source_path: suggestFromPath,
    brief_candidates: extracted.brief_candidates,
    constitution_candidates: extracted.constitution_candidates,
    recognised_sections: extracted.recognised_sections,
    skipped_sections: extracted.skipped_sections,
  };
}
