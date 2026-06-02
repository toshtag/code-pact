import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../schemas/roadmap.ts";
import { Phase } from "../schemas/phase.ts";
import { AgentProfile } from "../schemas/agent-profile.ts";
import { ProgressLog, type ProgressEvent } from "../schemas/progress-event.ts";
import { parseFrontMatter } from "./front-matter.ts";
import {
  ELISION_ORDER,
  renderSections,
  type DependsOnEntry,
  type DecisionDoc,
  type ReadGlobMatches,
  type RenderedSection,
  type RuleDoc,
} from "./formatters/markdown.ts";
import { deriveTaskState } from "../progress/task-state.ts";
import { validateGlobSyntax, walkAndMatch } from "../glob.ts";
import { assertSafePlanId } from "../schemas/plan-id.ts";
import { resolveWithinProject } from "../path-safety.ts";
import { resolveAgentProfilePath } from "../agent-profile-path.ts";

/**
 * Read a project file only if `relPath` resolves within the project root —
 * rejects `..`/absolute (lexical) AND symlink escape (via resolveWithinProject).
 * Returns null when unsafe or unreadable so callers can skip silently. This is
 * the read-side guard for every file whose path is derived from loaded YAML
 * (decision_refs) or from a readdir entry (which could be a symlink).
 */
async function readWithinProject(cwd: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(await resolveWithinProject(cwd, relPath), "utf8");
  } catch {
    return null;
  }
}

export type BuildContextPackOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  agentName: string;
  /**
   * When true, the result includes section-level metadata (`sections`,
   * `excluded`, `totalBytes`). The rendered `content` string is byte-
   * identical regardless of this flag.
   */
  explain?: boolean;
  /**
   * Optional P24 budget enforcement. When set, sections elide in the
   * priority order locked in `src/core/pack/formatters/markdown.ts`
   * (`ELISION_ORDER`) until the pack's UTF-8 byte length falls at or
   * below `budgetBytes`. When the bound cannot be met after maximal
   * elision, `buildContextPack` throws `ContextOverBudgetError`.
   *
   * The no-flag default path is byte-identical to v1.12 (locked by
   * `tests/integration/pack-byte-identical.test.ts`).
   */
  budgetBytes?: number;
};

/**
 * Thrown by `buildContextPack` when `budgetBytes` is set but maximal
 * elision still leaves the pack above the requested bound. Carries
 * structured details so callers can adjust the budget or split the
 * task.
 */
export class ContextOverBudgetError extends Error {
  readonly code = "CONTEXT_OVER_BUDGET";
  readonly budget_bytes: number;
  readonly minimum_achievable_bytes: number;
  readonly unelidable_sections: ReadonlyArray<string>;
  constructor(
    budget: number,
    minimum: number,
    unelidable: ReadonlyArray<string>,
  ) {
    super(
      `Context pack cannot be reduced below ${minimum} bytes; --budget-bytes ${budget} is unachievable for this task.`,
    );
    this.name = "ContextOverBudgetError";
    this.budget_bytes = budget;
    this.minimum_achievable_bytes = minimum;
    this.unelidable_sections = unelidable;
  }
}

/**
 * Closed enum of reason codes attached to included sections in the
 * explain output. New variants require an RFC.
 *
 * `budget_reserved_for_later` is intentionally absent here — it lives
 * in {@link ContextExcludedReasonCode} and is reserved for P24.
 */
export type ContextSectionReasonCode =
  | "always_included"
  | "declared_by_task"
  | "referenced_decision"
  | "glob_match"
  | "write_surface_high"
  | "context_size_large"
  | "ambiguity_high"
  | "format_overhead";

/**
 * Closed enum of reason codes attached to excluded sections in the
 * explain output. New variants require an RFC.
 *
 * `budget_reserved_for_later` is reserved for P24 (budget enforcement);
 * the P21 implementation MUST NOT emit it. A unit test asserts the
 * absence in every P21 output.
 */
export type ContextExcludedReasonCode =
  | "context_size_small_and_ambiguity_low"
  | "not_declared_by_task"
  | "glob_no_match"
  | "budget_reserved_for_later";

export type ContextExplainSection = {
  name: string;
  bytes: number;
  reason_code: ContextSectionReasonCode;
  details?: Record<string, unknown>;
};

export type ContextExplainExcluded = {
  name: string;
  reason_code: ContextExcludedReasonCode;
  details?: Record<string, unknown>;
};

export type ContextPackResult = {
  content: string;
  taskId: string;
  phaseId: string;
  agent: string;
  charCount: number;
  /**
   * UTF-8 byte length of `content`. Always populated. The acceptance
   * invariant `sum(sections[].bytes) === totalBytes` holds in explain
   * mode (the synthetic `format_overhead` section captures the
   * inter-section newlines).
   */
  totalBytes: number;
  includedRules: string[];
  includedDecisions: string[];
  includedConstitution: boolean;
  /** Present only when `explain: true` was passed to `buildContextPack`. */
  sections?: ContextExplainSection[];
  /** Present only when `explain: true` was passed to `buildContextPack`. */
  excluded?: ContextExplainExcluded[];
};

export type WriteContextPackOptions = {
  cwd: string;
  agentName: string;
  outputDir?: string;
};

export type WriteContextPackResult = {
  outputPath: string;
};

async function loadRoadmap(cwd: string): Promise<Roadmap> {
  const raw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  return Roadmap.parse(parseYaml(raw) as unknown);
}

async function loadPhase(cwd: string, path: string): Promise<Phase> {
  const raw = await readFile(join(cwd, path), "utf8");
  return Phase.parse(parseYaml(raw) as unknown);
}

async function loadAgentProfile(cwd: string, agentName: string): Promise<AgentProfile | null> {
  // Validate the agent name and resolve the path OUTSIDE the try, so an unsafe
  // `agentName` is a hard CONFIG_ERROR rather than being swallowed by the catch
  // (which returns null) — a `../evil` name can never read outside the project.
  // resolveAgentProfilePath honors a non-default `agents[].profile` from
  // project.yaml (matching doctor) and falls back to the conventional path.
  // A missing-but-safe profile still degrades gracefully to null.
  assertSafePlanId(agentName, "Agent");
  const profilePath = await resolveAgentProfilePath(cwd, agentName);
  try {
    const raw = await readFile(profilePath, "utf8");
    return AgentProfile.parse(parseYaml(raw) as unknown);
  } catch {
    return null;
  }
}

async function loadConstitution(cwd: string): Promise<string | null> {
  try {
    return await readFile(join(cwd, "design", "constitution.md"), "utf8");
  } catch {
    return null;
  }
}

// includeAll=true bypasses the applies_to filter (used for write_surface: large)
async function loadRules(
  cwd: string,
  taskType: string,
  includeAll = false,
): Promise<RuleDoc[]> {
  const rulesDir = join(cwd, "design", "rules");
  let entries: string[];
  try {
    entries = await readdir(rulesDir);
  } catch {
    return [];
  }

  const docs: RuleDoc[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    // constitution.md is included via the dedicated constitution slot, not rules
    if (entry === "constitution.md") continue;

    const raw = await readWithinProject(cwd, `design/rules/${entry}`);
    if (raw === null) continue; // unsafe (e.g. symlink escape) or unreadable
    const { frontMatter, body } = parseFrontMatter(raw);
    const tags: string[] = Array.isArray(frontMatter.tags) ? (frontMatter.tags as string[]) : [];
    const appliesTo: string[] = Array.isArray(frontMatter.applies_to)
      ? (frontMatter.applies_to as string[])
      : [];

    if (includeAll || appliesTo.length === 0 || appliesTo.includes(taskType)) {
      docs.push({ filename: entry, tags, applies_to: appliesTo, body });
    }
  }
  return docs;
}

// allDecisions=true returns every decision file (used for context_size: large)
async function loadDecisions(
  cwd: string,
  taskId: string,
  allDecisions = false,
): Promise<DecisionDoc[]> {
  const decisionsDir = join(cwd, "design", "decisions");
  let entries: string[];
  try {
    entries = await readdir(decisionsDir);
  } catch {
    return [];
  }

  const docs: DecisionDoc[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    if (!allDecisions && !entry.includes(taskId)) continue;

    const raw = await readWithinProject(cwd, `design/decisions/${entry}`);
    if (raw === null) continue; // unsafe (e.g. symlink escape) or unreadable
    const { body } = parseFrontMatter(raw);
    docs.push({ filename: entry, body });
  }
  return docs;
}

// Returns the most recent done events for tasks in the given phase (up to 5).
// Used when ambiguity: high to give the agent context on completed similar work.
async function loadDoneEventsInPhase(
  cwd: string,
  phase: Phase,
): Promise<ProgressEvent[]> {
  const taskIds = new Set((phase.tasks ?? []).map((t) => t.id));
  if (taskIds.size === 0) return [];
  try {
    const raw = await readFile(join(cwd, ".code-pact", "state", "progress.yaml"), "utf8");
    const log = ProgressLog.parse(parseYaml(raw) as unknown);
    return log.events
      .filter((e) => e.status === "done" && taskIds.has(e.task_id))
      .slice(-5);
  } catch {
    return [];
  }
}

// Loads every event from .code-pact/state/progress.yaml or returns []
// when the log is missing / unparseable. The pack uses this to derive
// the current state of each id listed in task.depends_on (P10).
async function loadAllProgressEvents(cwd: string): Promise<ProgressEvent[]> {
  try {
    const raw = await readFile(join(cwd, ".code-pact", "state", "progress.yaml"), "utf8");
    const log = ProgressLog.parse(parseYaml(raw) as unknown);
    return log.events;
  } catch {
    return [];
  }
}

// Loads the decision files referenced by task.decision_refs (P10),
// regardless of context_size. Skips entries that do not exist on disk
// — the plan-lint surface (TASK_DECISION_REF_NOT_FOUND) is responsible
// for warning the user about misconfigured refs at lint time; the pack
// renderer just shows what is actually loadable.
async function loadDeclaredDecisions(
  cwd: string,
  refs: readonly string[],
): Promise<DecisionDoc[]> {
  const docs: DecisionDoc[] = [];
  for (const ref of refs) {
    // `ref` comes from task.decision_refs (loaded YAML) and is read into the
    // pack body, so it must be confined to the project root — a value like
    // `../../.ssh/id_rsa` would otherwise exfiltrate an arbitrary file into
    // the context pack. resolveWithinProject also rejects symlink escape. The
    // decision gate (adr.ts) already fail-closes unsafe refs; this is the
    // matching guard on the pack-render path.
    const raw = await readWithinProject(cwd, ref);
    if (raw === null) continue; // unsafe path or not loadable — see comment above
    const { body } = parseFrontMatter(raw);
    // Use just the basename for the section header so the rendered
    // pack matches the existing "Related Decisions" presentation
    // (which keys by filename, not full path).
    const filename = ref.split("/").pop() ?? ref;
    docs.push({ filename, body });
  }
  return docs;
}

// Walks the project for each declared `reads` glob and returns the
// matched paths per glob. Skips any glob that the lint surface would
// reject (path safety / syntax) so the pack renderer never sees a
// half-parsed pattern. Returns [] when task.reads is absent or empty.
async function loadReadMatches(
  cwd: string,
  reads: readonly string[],
): Promise<ReadGlobMatches[]> {
  const result: ReadGlobMatches[] = [];
  for (const glob of reads) {
    if (validateGlobSyntax(glob) !== null) {
      // Pattern lint failed — still surface it in the pack with no
      // matches so the agent sees that this glob was declared.
      result.push({ glob, matches: [] });
      continue;
    }
    let matches: string[];
    try {
      matches = await walkAndMatch(cwd, glob);
    } catch {
      matches = [];
    }
    result.push({ glob, matches });
  }
  return result;
}

/**
 * Pure-ish context pack builder. Reads design files and renders the
 * Markdown content along with metadata. Does NOT write to disk.
 *
 * Content selection is driven by task attributes:
 * - context_size: large  → includes design/constitution.md + all decisions
 * - context_size: small  → minimal (no rules, decisions, or constitution)
 * - ambiguity: high      → includes constitution.md + recent done events in phase
 * - write_surface: large → includes all rule files (bypasses applies_to filter)
 *
 * Throws an error with code "PHASE_NOT_FOUND" or "TASK_NOT_FOUND" when
 * the requested ids do not exist.
 */
export async function buildContextPack(
  opts: BuildContextPackOptions,
): Promise<ContextPackResult> {
  const { cwd, phaseId, taskId, agentName } = opts;

  const roadmap = await loadRoadmap(cwd);
  const ref = roadmap.phases.find((p) => p.id === phaseId);
  if (!ref) {
    const err = new Error(`Phase "${phaseId}" not found in roadmap.yaml.`);
    (err as NodeJS.ErrnoException).code = "PHASE_NOT_FOUND";
    throw err;
  }

  const phase = await loadPhase(cwd, ref.path);

  const task = phase.tasks?.find((t) => t.id === taskId);
  if (!task) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  const isSmall = task.context_size === "small";
  const isLarge = task.context_size === "large";
  const isHighAmbiguity = task.ambiguity === "high";
  const isLargeWriteSurface = task.write_surface === "high";

  const includeConstitution = isLarge || isHighAmbiguity;
  const allDecisions = isLarge;
  const allRules = isLargeWriteSurface;

  // P10 — Task Readiness Schema declared sections. Each branch is a
  // no-op when the corresponding field is absent or empty, so the pack
  // output for a v1.0.2-shaped task (no new fields declared) is
  // byte-identical to v1.0.2 (locked by tests/integration/pack-byte-identical.test.ts).
  const dependsOnIds = task.depends_on ?? [];
  const readGlobs = task.reads ?? [];
  const writeGlobsList = task.writes ?? [];
  const decisionRefs = task.decision_refs ?? [];
  const acceptanceRefsList = task.acceptance_refs ?? [];

  const [rules, decisions, constitution, doneEvents, allEvents, declaredDecisions, readMatches] =
    await Promise.all([
      isSmall ? Promise.resolve([]) : loadRules(cwd, task.type, allRules),
      isSmall ? Promise.resolve([]) : loadDecisions(cwd, taskId, allDecisions),
      includeConstitution ? loadConstitution(cwd) : Promise.resolve(null),
      isHighAmbiguity ? loadDoneEventsInPhase(cwd, phase) : Promise.resolve([]),
      dependsOnIds.length > 0 ? loadAllProgressEvents(cwd) : Promise.resolve([]),
      decisionRefs.length > 0 ? loadDeclaredDecisions(cwd, decisionRefs) : Promise.resolve([]),
      readGlobs.length > 0 ? loadReadMatches(cwd, readGlobs) : Promise.resolve([]),
    ]);

  const dependsOn: DependsOnEntry[] | undefined =
    dependsOnIds.length > 0
      ? dependsOnIds.map((id) => ({ id, current: deriveTaskState(allEvents, id).current }))
      : undefined;

  const allRendered = renderSections({
    phase,
    task,
    agentName,
    rules,
    decisions,
    constitution,
    doneEvents,
    // P10 — only attach the field on the render context when the task
    // actually declared the corresponding optional. Passing undefined
    // (vs an empty array) preserves byte-identical output for v1.0.2-
    // shaped tasks.
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    ...(readMatches.length > 0 ? { readMatches } : {}),
    ...(writeGlobsList.length > 0 ? { writeGlobs: writeGlobsList } : {}),
    ...(declaredDecisions.length > 0 ? { declaredDecisions } : {}),
    ...(acceptanceRefsList.length > 0 ? { acceptanceRefs: acceptanceRefsList } : {}),
  });

  // P24: budget enforcement. When `budgetBytes` is set, elide sections
  // in `ELISION_ORDER` until the pack falls within budget; throw
  // `ContextOverBudgetError` if maximal elision still cannot meet it.
  // The no-budget path is byte-identical to v1.12.
  const budgetResult = applyBudgetElision(allRendered, opts.budgetBytes, {
    isLarge,
    isLargeWriteSurface,
  });
  const renderedSections = budgetResult.sections;
  const elidedNames = budgetResult.elidedNames;
  const elidedSectionsBytes = budgetResult.elidedBytes;

  const content = renderedSections.flatMap((s) => s.lines).join("\n");
  const totalBytes = Buffer.byteLength(content, "utf8");

  const result: ContextPackResult = {
    content,
    taskId,
    phaseId,
    agent: agentName,
    charCount: content.length,
    totalBytes,
    includedRules: rules.map((r) => r.filename),
    includedDecisions: decisions.map((d) => d.filename),
    includedConstitution: constitution !== null,
  };

  if (opts.explain === true) {
    const flags = {
      isSmall,
      isLarge,
      isHighAmbiguity,
      isLargeWriteSurface,
    };
    const declared = {
      dependsOn: dependsOnIds.length > 0,
      reads: readGlobs.length > 0,
      writes: writeGlobsList.length > 0,
      declaredDecisions: decisionRefs.length > 0,
      acceptanceRefs: acceptanceRefsList.length > 0,
    };
    result.sections = computeExplainSections(
      renderedSections,
      flags,
      totalBytes,
    );
    result.excluded = computeExplainExcluded(flags, declared);

    // P24: any section elided by --budget-bytes appears in excluded[]
    // with `reason_code: budget_reserved_for_later`. This activates
    // the value P21 reserved for this work. The new entries are
    // appended after the v1.11 policy-driven exclusions; a single
    // section can only be in one place (elision drops happen on
    // sections that would otherwise have been included, so there is
    // no double-counting).
    if (opts.budgetBytes !== undefined && elidedNames.length > 0) {
      for (const name of elidedNames) {
        result.excluded.push({
          name,
          reason_code: "budget_reserved_for_later",
          details: {
            elided_for_budget_bytes: opts.budgetBytes,
            section_bytes: elidedSectionsBytes.get(name) ?? 0,
          },
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// P24 budget enforcement
//
// Pure helper: given the structured intermediate form from
// `renderSections` and an optional byte budget, return the surviving
// sections, the names of any elided sections (in elision order), and
// a name → byte-size map for the elided sections so the explain
// machinery can surface them.
// ---------------------------------------------------------------------------

type BudgetElisionResult = {
  sections: RenderedSection[];
  elidedNames: string[];
  elidedBytes: Map<string, number>;
};

// P28: the readiness signals that gate conditional elision eligibility.
// `related_decisions` / `rules` are only elidable when they are the
// large-context / high-write-surface expansions — see applyBudgetElision.
type BudgetElisionEligibility = {
  isLarge: boolean;
  isLargeWriteSurface: boolean;
};

function computeRenderedBytes(sections: ReadonlyArray<RenderedSection>): number {
  if (sections.length === 0) return 0;
  return Buffer.byteLength(
    sections.flatMap((s) => s.lines).join("\n"),
    "utf8",
  );
}

function sectionBytes(section: RenderedSection): number {
  return Buffer.byteLength(section.lines.join("\n"), "utf8");
}

function applyBudgetElision(
  rendered: ReadonlyArray<RenderedSection>,
  budgetBytes: number | undefined,
  eligibility: BudgetElisionEligibility,
): BudgetElisionResult {
  if (budgetBytes === undefined) {
    return {
      sections: [...rendered],
      elidedNames: [],
      elidedBytes: new Map(),
    };
  }

  let surviving = [...rendered];
  const elidedNames: string[] = [];
  const elidedBytes = new Map<string, number>();

  if (computeRenderedBytes(surviving) <= budgetBytes) {
    return { sections: surviving, elidedNames, elidedBytes };
  }

  // P28: elision ELIGIBILITY is conditional, per context-budget-rfc.md.
  // `related_decisions` is elidable only when it is the `context_size:
  // large` "all decisions" expansion; `rules` only when it is the
  // `write_surface: high` "all rules" expansion. Outside those
  // expansions the section holds task-id-matched decisions /
  // applies_to-matched rules the RFC marks unelidable — dropping them
  // for budget would silently remove context the task opted into. The
  // priority (ELISION_ORDER) is unchanged; only the eligible subset
  // narrows per invocation.
  const eligibleOrder = ELISION_ORDER.filter((name) => {
    if (name === "related_decisions") return eligibility.isLarge;
    if (name === "rules") return eligibility.isLargeWriteSurface;
    return true;
  });

  for (const name of eligibleOrder) {
    const idx = surviving.findIndex((s) => s.name === name);
    if (idx === -1) continue;
    elidedBytes.set(name, sectionBytes(surviving[idx]!));
    surviving = surviving.filter((_, i) => i !== idx);
    elidedNames.push(name);
    if (computeRenderedBytes(surviving) <= budgetBytes) {
      return { sections: surviving, elidedNames, elidedBytes };
    }
  }

  // Maximal elision performed; still over budget.
  throw new ContextOverBudgetError(
    budgetBytes,
    computeRenderedBytes(surviving),
    surviving.map((s) => s.name),
  );
}

// ---------------------------------------------------------------------------
// P21-T4 explain machinery
//
// `renderSections` returns the structured intermediate form of the
// rendered pack. `computeExplainSections` annotates each section with
// a reason code derived from the task readiness flags, attaches a
// byte count computed with `Buffer.byteLength(..., "utf8")`, and
// appends a synthetic `format_overhead` section that captures the
// inter-section newlines so the acceptance invariant
// `sum(sections[].bytes) === totalBytes` holds.
// ---------------------------------------------------------------------------

type ExplainFlags = {
  isSmall: boolean;
  isLarge: boolean;
  isHighAmbiguity: boolean;
  isLargeWriteSurface: boolean;
};

type ExplainDeclared = {
  dependsOn: boolean;
  reads: boolean;
  writes: boolean;
  declaredDecisions: boolean;
  acceptanceRefs: boolean;
};

function reasonForSection(
  name: string,
  flags: ExplainFlags,
): ContextSectionReasonCode {
  switch (name) {
    case "header":
    case "phase_contract":
    case "task_definition":
    case "verification_commands":
    case "progress_event_schema":
      return "always_included";
    case "constitution":
      // includeConstitution = isLarge || isHighAmbiguity. When both
      // are true, attribute to the more specific signal (isLarge),
      // matching the precedence the renderer uses implicitly.
      return flags.isLarge ? "context_size_large" : "ambiguity_high";
    case "rules":
      return flags.isLargeWriteSurface ? "write_surface_high" : "always_included";
    case "depends_on":
    case "writes":
    case "acceptance_refs":
      return "declared_by_task";
    case "reads":
      return "glob_match";
    case "declared_decisions":
      return "referenced_decision";
    case "related_decisions":
      return flags.isLarge ? "context_size_large" : "always_included";
    case "completed_tasks":
      return "ambiguity_high";
    default:
      return "always_included";
  }
}

function computeExplainSections(
  rendered: RenderedSection[],
  flags: ExplainFlags,
  totalBytes: number,
): ContextExplainSection[] {
  const result: ContextExplainSection[] = [];
  let attributed = 0;
  for (const s of rendered) {
    const sectionContent = s.lines.join("\n");
    const bytes = Buffer.byteLength(sectionContent, "utf8");
    attributed += bytes;
    result.push({
      name: s.name,
      bytes,
      reason_code: reasonForSection(s.name, flags),
      ...(s.details ? { details: s.details } : {}),
    });
  }
  const overhead = totalBytes - attributed;
  // Synthetic format_overhead section captures the `(n-1)` inter-
  // section newlines introduced by the final `flatMap.join("\n")`.
  // For multi-byte UTF-8 content the value is still correct because
  // both totalBytes and the per-section bytes use Buffer.byteLength.
  if (overhead > 0) {
    result.push({
      name: "format_overhead",
      bytes: overhead,
      reason_code: "format_overhead",
      details: { kind: "inter_section_newlines" },
    });
  }
  return result;
}

function computeExplainExcluded(
  flags: ExplainFlags,
  declared: ExplainDeclared,
): ContextExplainExcluded[] {
  const excluded: ContextExplainExcluded[] = [];

  // Constitution is excluded when neither isLarge nor isHighAmbiguity.
  if (!flags.isLarge && !flags.isHighAmbiguity) {
    excluded.push({
      name: "constitution",
      reason_code: "context_size_small_and_ambiguity_low",
    });
  }

  // Rules are excluded when context_size is small (no rules loaded).
  if (flags.isSmall) {
    excluded.push({
      name: "rules",
      reason_code: "context_size_small_and_ambiguity_low",
    });
  }

  // P10 declared-section excluded entries — only emit when the task
  // did not declare the corresponding field.
  if (!declared.dependsOn) {
    excluded.push({ name: "depends_on", reason_code: "not_declared_by_task" });
  }
  if (!declared.reads) {
    excluded.push({ name: "reads", reason_code: "not_declared_by_task" });
  }
  if (!declared.writes) {
    excluded.push({ name: "writes", reason_code: "not_declared_by_task" });
  }
  if (!declared.declaredDecisions) {
    excluded.push({
      name: "declared_decisions",
      reason_code: "not_declared_by_task",
    });
  }
  if (!declared.acceptanceRefs) {
    excluded.push({
      name: "acceptance_refs",
      reason_code: "not_declared_by_task",
    });
  }

  // Completed-task histogram is excluded when ambiguity is not high.
  if (!flags.isHighAmbiguity) {
    excluded.push({
      name: "completed_tasks",
      reason_code: "context_size_small_and_ambiguity_low",
    });
  }

  return excluded;
}

/**
 * Writes a previously built ContextPackResult to disk under the agent's
 * configured context_dir (or an explicit outputDir override). Returns
 * the resolved outputPath.
 *
 * The write goes through `atomicWriteText` (temp-file + rename), so an
 * interrupted process can never leave a half-written pack on disk. The
 * context pack is part of the deterministic agent-facing artifact surface
 * the cli-contract.md "State file write guarantees" section covers, so it
 * uses the same atomic primitive as every other code-pact disk write.
 */
export async function writeContextPack(
  pack: ContextPackResult,
  opts: WriteContextPackOptions,
): Promise<WriteContextPackResult> {
  const { cwd, agentName, outputDir } = opts;
  const profile = await loadAgentProfile(cwd, agentName);
  // An explicit `outputDir` is a deliberate caller/CLI choice (`--output-dir`),
  // left as-is. The profile-derived dir is confined to the project root:
  // context_dir is lexically a RelativePosixPath, but resolveWithinProject also
  // rejects symlink escape (e.g. `.context/<agent>` symlinked outside), so a
  // profile cannot redirect the pack write out of the repo.
  const outDir =
    outputDir ?? (await resolveWithinProject(cwd, profile?.context_dir ?? `.context/${agentName}`));
  const outputPath = join(outDir, `${pack.taskId}.md`);
  // atomicWriteText recursively creates the parent dir before writing, so no
  // separate mkdir(outDir) is needed — the output path is byte-identical to
  // the previous raw-writeFile path.
  await atomicWriteText(outputPath, pack.content);
  return { outputPath };
}
