import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../schemas/roadmap.ts";
import { Phase } from "../schemas/phase.ts";
import { AgentProfile } from "../schemas/agent-profile.ts";
import { ProgressLog, type ProgressEvent } from "../schemas/progress-event.ts";
import { parseFrontMatter } from "./front-matter.ts";
import {
  renderMarkdown,
  type DependsOnEntry,
  type DecisionDoc,
  type ReadGlobMatches,
  type RuleDoc,
} from "./formatters/markdown.ts";
import { deriveTaskState } from "../progress/task-state.ts";
import { validateGlobSyntax, walkAndMatch } from "../glob.ts";

export type BuildContextPackOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  agentName: string;
};

export type ContextPackResult = {
  content: string;
  taskId: string;
  phaseId: string;
  agent: string;
  charCount: number;
  includedRules: string[];
  includedDecisions: string[];
  includedConstitution: boolean;
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
  try {
    const raw = await readFile(
      join(cwd, ".code-pact", "agent-profiles", `${agentName}.yaml`),
      "utf8",
    );
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

    const raw = await readFile(join(rulesDir, entry), "utf8");
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

    const raw = await readFile(join(decisionsDir, entry), "utf8");
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
    try {
      const raw = await readFile(join(cwd, ref), "utf8");
      const { body } = parseFrontMatter(raw);
      // Use just the basename for the section header so the rendered
      // pack matches the existing "Related Decisions" presentation
      // (which keys by filename, not full path).
      const filename = ref.split("/").pop() ?? ref;
      docs.push({ filename, body });
    } catch {
      // Skipped silently here — see comment above.
    }
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

  const content = renderMarkdown({
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

  return {
    content,
    taskId,
    phaseId,
    agent: agentName,
    charCount: content.length,
    includedRules: rules.map((r) => r.filename),
    includedDecisions: decisions.map((d) => d.filename),
    includedConstitution: constitution !== null,
  };
}

/**
 * Writes a previously built ContextPackResult to disk under the agent's
 * configured context_dir (or an explicit outputDir override). Returns
 * the resolved outputPath.
 */
export async function writeContextPack(
  pack: ContextPackResult,
  opts: WriteContextPackOptions,
): Promise<WriteContextPackResult> {
  const { cwd, agentName, outputDir } = opts;
  const profile = await loadAgentProfile(cwd, agentName);
  const outDir = outputDir ?? join(cwd, profile?.context_dir ?? join(".context", agentName));
  await mkdir(outDir, { recursive: true });
  const outputPath = join(outDir, `${pack.taskId}.md`);
  await writeFile(outputPath, pack.content, "utf8");
  return { outputPath };
}
