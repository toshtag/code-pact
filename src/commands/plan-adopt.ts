// `plan adopt` (Narrow MVP) — deterministically convert an existing plan
// file into the `phase import` input shape, with a dry-run default and a
// --write mode that reuses applyParsedPhaseImport.
//
// Input detection order:
//   1. phase_import_yaml  — top-level `phases:` matching PhaseImportInput
//   2. single_phase_yaml  — one Phase-shaped object (accepts verify_commands
//                           OR legacy verification.commands, normalised)
//   3. markdown           — narrow list parser (parseAdoptMarkdown)
//   else                  — CONFIG_ERROR / no_plan_items_detected
//
// code-pact never calls an LLM here. Narrative roadmaps whose tasks live in
// prose produce no list items and fall to no_plan_items_detected — the
// honest signal to use `plan prompt --schema-only` + an agent instead.

import { readFile } from "../core/project-fs/index.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  assertSafeRelativePath,
  resolveWithinProject,
} from "../core/path-safety.ts";
import {
  PhaseImportInput,
  type PhaseImportEntry,
} from "../core/schemas/phase-import.ts";
import { loadRoadmap } from "../core/plan/roadmap.ts";
import {
  applyParsedPhaseImport,
  collectMisshapeWarnings,
  type ImportWarning,
  type PhaseImportResult,
} from "./phase-import.ts";
import {
  parseAdoptMarkdown,
  type AdoptedPhase,
  type AdoptParserWarning,
} from "../core/plan-adopt/markdown-parser.ts";

export type PlanAdoptDetail =
  | "unsafe_path"
  | "file_not_found"
  | "unreadable"
  | "no_plan_items_detected";

export class PlanAdoptError extends Error {
  readonly code = "CONFIG_ERROR";
  readonly detail: PlanAdoptDetail;
  readonly sourcePath?: string;
  constructor(detail: PlanAdoptDetail, message: string, sourcePath?: string) {
    super(message);
    this.name = "PlanAdoptError";
    this.detail = detail;
    this.sourcePath = sourcePath;
  }
}

export type AdoptSourceType =
  | "phase_import_yaml"
  | "single_phase_yaml"
  | "markdown";

export type AdoptWarning = {
  code: string;
  message: string;
  line?: number;
};

export type PlanAdoptResult = {
  kind: "would_adopt" | "adopted";
  source_path: string;
  source_type: AdoptSourceType;
  phases_detected: number;
  tasks_detected: number;
  generated_import_yaml: string;
  warnings: AdoptWarning[];
  import_result: PhaseImportResult | null;
  suggested_next_steps: string[];
};

export type PlanAdoptOptions = {
  cwd: string;
  fromPath: string;
  write: boolean;
  /** Scaffold `proposed` ADR stubs for requires_decision tasks. */
  scaffoldDecisions?: boolean;
};

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

type Detected = {
  sourceType: AdoptSourceType;
  input: PhaseImportInput;
  /** Top-level advisories surfaced to the user. */
  adoptWarnings: AdoptWarning[];
  /** Advisories carried into applyParsedPhaseImport (e.g. mis-shape). */
  importWarnings: ImportWarning[];
};

function toAdoptWarning(w: ImportWarning): AdoptWarning {
  return { code: w.code, message: w.message };
}

/**
 * Try to read `parsed` as a single Phase-shaped object. Accepts the
 * canonical `verify_commands` and the legacy nested `verification.commands`
 * (normalising to the former, with a mis-shape advisory). Returns null when
 * the object is not phase-shaped enough to be unambiguous.
 */
function trySinglePhase(
  parsed: Record<string, unknown>,
): { entry: PhaseImportEntry; warnings: AdoptWarning[] } | null {
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.name !== "string" ||
    typeof parsed.objective !== "string"
  ) {
    return null;
  }

  const hasTasks = Array.isArray(parsed.tasks);
  const verifyFlat = Array.isArray(parsed.verify_commands)
    ? (parsed.verify_commands as string[])
    : undefined;
  const verification = parsed.verification;
  const verifyNested =
    isPlainObject(verification) && Array.isArray(verification.commands)
      ? (verification.commands as string[])
      : undefined;

  // Require at least tasks or a verify list — otherwise it's too thin to be
  // confidently a phase, and markdown parsing is the safer fallback.
  if (!hasTasks && !verifyFlat && !verifyNested) return null;

  const warnings: AdoptWarning[] = [];
  let verify = verifyFlat;
  if (verifyNested !== undefined) {
    warnings.push({
      code: "PHASE_VERIFY_COMMANDS_MISSHAPED",
      message: verifyFlat
        ? "Single-phase YAML declares both `verify_commands` and legacy `verification.commands`. `verify_commands` is canonical; the nested block is ignored."
        : "Single-phase YAML uses legacy `verification.commands`; normalised to `verify_commands`.",
    });
    if (verify === undefined) verify = verifyNested;
  }

  const entry: Record<string, unknown> = {
    id: parsed.id,
    name: parsed.name,
    objective: parsed.objective,
    weight:
      typeof parsed.weight === "number" && parsed.weight > 0
        ? parsed.weight
        : 20,
    ...(parsed.confidence !== undefined
      ? { confidence: parsed.confidence }
      : {}),
    ...(parsed.risk !== undefined ? { risk: parsed.risk } : {}),
    ...(verify !== undefined && verify.length > 0
      ? { verify_commands: verify }
      : {}),
    ...(Array.isArray(parsed.definition_of_done)
      ? { definition_of_done: parsed.definition_of_done }
      : {}),
    ...(Array.isArray(parsed.non_goals) ? { non_goals: parsed.non_goals } : {}),
    ...(hasTasks ? { tasks: parsed.tasks } : {}),
  };

  // Validate the wrapped entry. If it doesn't conform (e.g. malformed
  // tasks), give up on the single-phase reading rather than emit invalid
  // YAML — the caller falls through to markdown.
  const wrapped = PhaseImportInput.safeParse({ phases: [entry] });
  if (!wrapped.success) return null;
  return { entry: wrapped.data.phases[0]!, warnings };
}

const TYPE_RULES: { re: RegExp; type: string }[] = [
  { re: /\b(docs?|document(ation)?|readme)\b/i, type: "docs" },
  { re: /\b(tests?|spec|coverage)\b/i, type: "test" },
  { re: /\brefactor\b/i, type: "refactor" },
  {
    re: /\b(architecture|schema|contract|foundation|scaffold)\b/i,
    type: "architecture",
  },
];

function inferType(text: string): string {
  for (const rule of TYPE_RULES) {
    if (rule.re.test(text)) return rule.type;
  }
  return "feature";
}

/**
 * Build a PhaseImportInput from the markdown parser's phase blocks. Assigns
 * sequential ids starting at `seed` (computed from the existing roadmap so
 * adopted phases never collide with P-numbered phases already present).
 */
function buildInputFromMarkdown(
  phases: AdoptedPhase[],
  parserWarnings: AdoptParserWarning[],
  seed: number,
  sourcePath: string,
): { input: PhaseImportInput; warnings: AdoptWarning[] } {
  const warnings: AdoptWarning[] = [];

  for (const w of parserWarnings) {
    warnings.push({
      code: w.code,
      message:
        "A checked (done) task was skipped — design `done` state comes from task finalize, not import.",
      line: w.line,
    });
  }

  const entries: PhaseImportEntry[] = [];
  let pnum = seed;
  for (const p of phases) {
    const id = `P${pnum++}`;
    const tasks = p.tasks.map((t, idx) => ({
      id: `${id}-T${idx + 1}`,
      description: t.text,
      type: inferType(t.text),
    }));
    entries.push({
      id,
      name: p.title ?? "Imported plan",
      weight: 20,
      confidence: "medium",
      risk: "medium",
      objective:
        p.objectiveHint ??
        `Imported from ${sourcePath} via \`code-pact plan adopt\`. Review the objective, definition_of_done, and verification commands before merging.`,
      verify_commands: ["pnpm test"],
      definition_of_done: [
        "Review each imported task and adjust its type / fields to match reality",
        "Add reads / writes / acceptance_refs before implementation",
      ],
      tasks: tasks as PhaseImportEntry["tasks"],
    });
    if (p.inferred) {
      warnings.push({
        code: "PHASE_ID_INFERRED",
        message: `No phase-marker heading found; inferred phase ${id}.`,
        ...(p.headingLine !== null ? { line: p.headingLine } : {}),
      });
    }
  }

  // One advisory for the whole source, not one per task (avoids noise).
  warnings.push({
    code: "READINESS_FIELDS_NOT_INFERRED",
    message:
      "depends_on / reads / writes / acceptance_refs / decision_refs were not inferred — add them before implementation.",
  });

  // Validate the assembled input so a malformed build fails loudly here
  // rather than at write time.
  const parsed = PhaseImportInput.parse({ phases: entries });
  return { input: parsed, warnings };
}

async function nextPhaseSeed(cwd: string): Promise<number> {
  try {
    // Contained roadmap seam; a missing / unsafe / malformed roadmap degrades to
    // "start numbering at P1" (best-effort), never an out-of-project read.
    const roadmap = await loadRoadmap(cwd);
    let max = 0;
    for (const ref of roadmap.phases) {
      const m = ref.id.match(/^P(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  } catch {
    // No readable / safe roadmap → start numbering at P1.
    return 1;
  }
}

async function detect(
  raw: string,
  fromPath: string,
  cwd: string,
): Promise<Detected> {
  let parsed: unknown;
  let yamlOk = true;
  try {
    parsed = parseYaml(raw);
  } catch {
    yamlOk = false;
  }

  if (yamlOk && isPlainObject(parsed)) {
    // 1. phase_import_yaml
    const pi = PhaseImportInput.safeParse(parsed);
    if (pi.success) {
      const importWarnings = collectMisshapeWarnings(parsed);
      return {
        sourceType: "phase_import_yaml",
        input: pi.data,
        adoptWarnings: importWarnings.map(toAdoptWarning),
        importWarnings,
      };
    }
    // 2. single_phase_yaml
    const single = trySinglePhase(parsed);
    if (single) {
      return {
        sourceType: "single_phase_yaml",
        input: { phases: [single.entry] },
        adoptWarnings: single.warnings,
        importWarnings: [],
      };
    }
  }

  // 3. markdown
  const md = parseAdoptMarkdown(raw);
  const withTasks = md.phases.filter(p => p.tasks.length > 0);
  if (withTasks.length === 0) {
    throw new PlanAdoptError(
      "no_plan_items_detected",
      `plan adopt: no importable plan items found in ${fromPath}. The file is neither a phase-import / single-phase YAML nor a plan with recognisable task bullets. For a narrative roadmap, use \`plan prompt --schema-only\` and have an agent emit YAML.`,
      fromPath,
    );
  }
  const seed = await nextPhaseSeed(cwd);
  const { input, warnings } = buildInputFromMarkdown(
    withTasks,
    md.warnings,
    seed,
    fromPath,
  );
  return {
    sourceType: "markdown",
    input,
    adoptWarnings: warnings,
    importWarnings: [],
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function countTasks(input: PhaseImportInput): number {
  return input.phases.reduce((acc, p) => acc + (p.tasks?.length ?? 0), 0);
}

function buildNextSteps(
  write: boolean,
  importResult: PhaseImportResult | null,
): string[] {
  if (!write) {
    return [
      "Review the generated phase-import YAML above — plan adopt does no semantic filtering, so confirm every task is real (lists like Risks / Non-goals are picked up too).",
      "Re-run with `--write` to create the phase(s) and tasks.",
    ];
  }
  const steps = [
    "Run `code-pact plan lint --include-quality --json` to validate the imported phase(s) and surface clarify advisories.",
  ];
  const firstTask = importResult?.imported_tasks[0];
  if (firstTask !== undefined) {
    steps.push(
      `Run \`code-pact task prepare ${firstTask} --agent <agent> --json\` to start the first task.`,
    );
  }
  return steps;
}

export async function runPlanAdopt(
  opts: PlanAdoptOptions,
): Promise<PlanAdoptResult> {
  const { cwd, fromPath, write } = opts;
  const scaffoldDecisions = opts.scaffoldDecisions === true;

  try {
    assertSafeRelativePath(fromPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PlanAdoptError(
      "unsafe_path",
      `plan adopt: path is unsafe: ${msg}`,
      fromPath,
    );
  }

  // fs-authority: containment-only
  // reason: explicit user-selected input path (--from)
  let raw: string;
  try {
    raw = await readFile(await resolveWithinProject(cwd, fromPath), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "PATH_OUTSIDE_PROJECT") {
      throw new PlanAdoptError(
        "unsafe_path",
        `plan adopt: path is unsafe: ${(err as Error).message}`,
        fromPath,
      );
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new PlanAdoptError(
        "file_not_found",
        `plan adopt: file not found: ${fromPath}`,
        fromPath,
      );
    }
    throw new PlanAdoptError(
      "unreadable",
      `plan adopt: cannot read ${fromPath}: ${err instanceof Error ? err.message : String(err)}`,
      fromPath,
    );
  }

  const detected = await detect(raw, fromPath, cwd);
  const generatedYaml = stringifyYaml(detected.input);

  let importResult: PhaseImportResult | null = null;
  if (write) {
    importResult = await applyParsedPhaseImport({
      cwd,
      input: detected.input,
      warnings: detected.importWarnings,
      scaffoldDecisions,
    });
  }

  return {
    kind: write ? "adopted" : "would_adopt",
    source_path: fromPath,
    source_type: detected.sourceType,
    phases_detected: detected.input.phases.length,
    tasks_detected: countTasks(detected.input),
    generated_import_yaml: generatedYaml,
    warnings: detected.adoptWarnings,
    import_result: importResult,
    suggested_next_steps: buildNextSteps(write, importResult),
  };
}
